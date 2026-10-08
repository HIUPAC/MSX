/**
 * 云函数 - dailyReset
 *
 * 定时任务：每天 23:00 执行
 * 清除所有座位占用信息，统一恢复为可预约状态。
 *
 * 清理范围：
 *   1. seat_locks     — 删除所有预选锁
 *   2. seats          — 将所有座位状态重置为 'free'
 *   3. reservations   — 将当天 pending/checked_in 未完成的预约标记为 'completed'
 *
 * 触发器配置（微信云开发控制台）：
 *   触发器类型：定时触发器
 *   触发周期：每天 23:00
 *   Cron 表达式：0 0 23 * * * *
 *
 * 性能注意：
 *   - seat_locks 通常数据量不大（锁有 TTL），直接全量删除
 *   - seats 一般几百条以内，逐条更新没问题
 *   - 如果数据量极大，可考虑分批处理（batch 模式）
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

/**
 * 分批获取数据（突破云数据库默认 100 条限制）
 * @param {object} collection 数据库集合引用
 * @param {object} where      查询条件
 * @param {number} batchSize  每批数量
 * @returns {Array} 所有匹配的数据
 */
async function fetchAll(collection, where = {}, batchSize = 200) {
  const countRes = await collection.where(where).count();
  const total = countRes.total;
  if (total === 0) return [];

  const maxConcurrent = 3;
  const times = Math.ceil(total / batchSize);
  const tasks = [];

  for (let i = 0; i < times; i++) {
    tasks.push(
      collection.where(where)
        .skip(i * batchSize)
        .limit(batchSize)
        .get()
    );
  }

  // 分批并发，控制并发数
  const allData = [];
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    const results = await Promise.all(batch);
    results.forEach(res => {
      allData.push(...(res.data || []));
    });
  }

  return allData;
}

/**
 * 分批执行操作（避免一次性操作过多）
 * @param {Array} items         数据列表
 * @param {Function} processor  处理函数，接收单条 item，返回 Promise
 * @param {number} concurrency  并发数
 */
async function batchProcess(items, processor, concurrency = 10) {
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(item => processor(item))
    );

    results.forEach(r => {
      if (r.status === 'fulfilled') successCount++;
      else errorCount++;
    });
  }

  return { successCount, errorCount };
}

exports.main = async (event, context) => {
  const now = Date.now();
  const nowStr = new Date(now).toISOString();
  console.log(`[dailyReset] 开始执行 — ${nowStr}`);

  const stats = {
    locksDeleted: 0,
    seatsReset: 0,
    reservationsCompleted: 0,
    errors: 0
  };

  try {
    // ═══════════════════════════════════
    // 1. 删除所有 seat_locks（预选锁全部清空）
    // ═══════════════════════════════════
    console.log('[dailyReset] 步骤1: 清除所有预选锁...');
    try {
      const allLocks = await fetchAll(db.collection('seat_locks'), {}, 200);

      if (allLocks.length > 0) {
        const { successCount, errorCount } = await batchProcess(
          allLocks,
          async (lock) => {
            await db.collection('seat_locks').doc(lock._id).remove();
          },
          10
        );
        stats.locksDeleted = successCount;
        stats.errors += errorCount;
      }
      console.log(`[dailyReset] 清除预选锁: ${stats.locksDeleted} 条, 失败: ${stats.errors}`);
    } catch (e) {
      console.error('[dailyReset] 清除预选锁失败:', e);
      stats.errors++;
    }

    // ═══════════════════════════════════
    // 2. 将所有座位状态重置为 'free'
    // ═══════════════════════════════════
    console.log('[dailyReset] 步骤2: 重置所有座位状态...');
    try {
      const allSeats = await fetchAll(db.collection('seats'), {}, 200);

      if (allSeats.length > 0) {
        const { successCount, errorCount } = await batchProcess(
          allSeats,
          async (seat) => {
            await db.collection('seats').doc(seat._id).update({
              data: {
                seatStatus: 'free',
                status: 'free',
                updatedAt: now
              }
            });
          },
          10
        );
        stats.seatsReset = successCount;
        stats.errors += errorCount;
      }
      console.log(`[dailyReset] 重置座位: ${stats.seatsReset} 个, 失败: ${errorCount}`);
    } catch (e) {
      console.error('[dailyReset] 重置座位状态失败:', e);
      stats.errors++;
    }

    // ═══════════════════════════════════
    // 3. 将今天所有 pending/checked_in 的预约标记为 completed
    //    （一天结束后，未完成的预约全部归档）
    // ═══════════════════════════════════
    console.log('[dailyReset] 步骤3: 归档未完成预约...');
    try {
      // 获取今天的日期字符串 (YYYY-MM-DD)
      const today = new Date();
      const dateStr = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0')
      ].join('-');

      const activeReservations = await fetchAll(
        db.collection('reservations'),
        {
          date: dateStr,
          status: _.in(['pending', 'checked_in'])
        },
        200
      );

      if (activeReservations.length > 0) {
        const { successCount, errorCount } = await batchProcess(
          activeReservations,
          async (reservation) => {
            await db.collection('reservations').doc(reservation._id).update({
              data: {
                status: 'completed',
                updatedAt: now
              }
            });
          },
          10
        );
        stats.reservationsCompleted = successCount;
        stats.errors += errorCount;
      }
      console.log(`[dailyReset] 归档预约: ${stats.reservationsCompleted} 条, 失败: ${errorCount}`);
    } catch (e) {
      console.error('[dailyReset] 归档预约失败:', e);
      stats.errors++;
    }

    console.log(`[dailyReset] 执行完成 — ${new Date().toISOString()}`);
    console.log(`[dailyReset] 统计: ${JSON.stringify(stats)}`);

    return {
      success: true,
      data: {
        message: '每日重置完成',
        timestamp: now,
        stats
      }
    };

  } catch (err) {
    console.error('[dailyReset] 致命错误:', err);
    return {
      success: false,
      error: err.message,
      stats
    };
  }
};
