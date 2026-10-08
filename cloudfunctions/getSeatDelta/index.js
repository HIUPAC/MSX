/**
 * 云函数 - getSeatDelta
 *
 * 增量轮询接口：返回 (date, timeSlot, floor) 中，
 * 自 sinceTimestamp 以来发生变化（lock / 预约 / 座位 status）的座位列表。
 *
 * 入参：
 *   date:         string  YYYY-MM-DD
 *   timeSlot:     string  'morning' | 'afternoon' | 'evening'
 *   floor:        number  楼层
 *   sinceVersion: number? 上次响应返回的 version，0 表示"全量首屏"
 *
 * 返回：
 *   {
 *     success: true,
 *     data: {
 *       version:  number,   // 当前时间戳，作为下次 sinceVersion
 *       changes:  [
 *         { seatId, status, lockUserId?, updatedAt }
 *       ]
 *     }
 *   }
 *
 * 性能优化建议（云开发控制台手动添加索引）：
 *   - seat_locks:    { date: 1, timeSlot: 1, expireTime: 1 }
 *   - reservations:  { date: 1, timeSlot: 1, status: 1, updatedAt: 1 }
 *   - seats:         { floor: 1, updatedAt: 1 }
 *
 * 注意：
 *   - "变化"指 lock / reservation 的 expireTime/createdAt/updatedAt 大于 sinceVersion，
 *     或者 seat 记录的 updatedAt 大于 sinceVersion；
 *   - 首屏（sinceVersion=0）只返回前 N 条，超出 N 不保证完整，调用方应再做全量回退。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const DEFAULT_LIMIT = 100;

exports.main = async (event, context) => {
  const { date, timeSlot, floor, sinceVersion = 0 } = event;
  let { limit = DEFAULT_LIMIT } = event;

  if (!date || !timeSlot || floor == null) {
    return { success: false, code: 'NO_PARAMS', message: '缺少必要参数' };
  }
  if (limit > 500) limit = 500;

  try {
    const now = Date.now();
    const changes = [];
    const seen = new Set();

    // ─── 1. reservation 变化（优先处理：正式预约 > 预选锁）───
    // 首先查所有相关状态的 reservation（包括 cancelled/violation 的增量变化）
    const activeStatuses = new Set(['pending', 'checked_in']);
    const nonActiveStatuses = new Set(['cancelled', 'violation', 'completed']);
    const allReservationStatuses = ['pending', 'checked_in', 'completed', 'cancelled', 'violation'];

    const reservationQuery = sinceVersion === 0
      ? { date, timeSlot, status: _.in(allReservationStatuses) }
      : {
          date,
          timeSlot,
          status: _.in(allReservationStatuses),
          updatedAt: _.gt(sinceVersion)
        };

    const reservationRes = await db.collection('reservations')
      .where(reservationQuery)
      .field({ seatId: true, status: true, updatedAt: true })
      .limit(limit).get();

    for (const r of reservationRes.data || []) {
      if (!r.seatId) continue;
      const isActive = activeStatuses.has(r.status);
      const isNowFree = nonActiveStatuses.has(r.status);

      if (isNowFree) {
        // 取消/违规 → 释放座位
        seen.add(r.seatId);
        changes.push({
          seatId: r.seatId,
          status: 'free',
          updatedAt: r.updatedAt || now
        });
      } else if (isActive) {
        seen.add(r.seatId);
        changes.push({
          seatId: r.seatId,
          status: r.status === 'pending' ? 'reserved' : 'in_use',
          updatedAt: r.updatedAt || now
        });
      }
    }

    // ─── 2. lock 变化（只在没有被 reservation 覆盖时才生效）───
    // 任何 expireTime > sinceVersion 的锁都算"现在或将来活跃"
    // 但为了 delta 语义，我们用 updatedAt > sinceVersion（创建/续期）
    const lockRes = await db.collection('seat_locks').where({
      date,
      timeSlot,
      updatedAt: _.gt(sinceVersion),
      expireTime: _.gt(now) // 只关心未过期的
    }).limit(limit).get();

    // 注意：首屏必须把当前所有未过期锁都返回，否则会漏掉
    // 处理：sinceVersion === 0 时忽略 updatedAt 过滤
    let locks = [];
    if (sinceVersion === 0) {
      const allLocks = await db.collection('seat_locks').where({
        date,
        timeSlot,
        expireTime: _.gt(now)
      }).limit(limit).get();
      locks = allLocks.data || [];
    } else {
      locks = lockRes.data || [];
    }

    for (const lock of locks) {
      if (seen.has(lock.seatId)) continue; // reservation 已覆盖，跳过锁状态
      seen.add(lock.seatId);
      changes.push({
        seatId: lock.seatId,
        status: 'preselected',
        lockUserId: lock.userId,
        updatedAt: lock.updatedAt || lock.createdAt || now
      });
    }

    // ─── 3. seat 静态 status 变化（maintenance 等）───
    const seatsRes = sinceVersion === 0
      ? await db.collection('seats').where({ floor }).limit(limit).get()
      : await db.collection('seats').where({
          floor,
          updatedAt: _.gt(sinceVersion)
        }).limit(limit).get();

    for (const s of seatsRes.data || []) {
      if (seen.has(s._id)) continue; // 已被 lock/reservation 覆盖，跳过
      seen.add(s._id);
      const seatStatus = s.seatStatus || s.status;
      changes.push({
        seatId: s._id,
        status: seatStatus || 'free',
        updatedAt: s.updatedAt || now
      });
    }

    return {
      success: true,
      data: {
        version: now,
        changes
      }
    };
  } catch (err) {
    console.error('[getSeatDelta] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', message: '查询失败' };
  }
};
