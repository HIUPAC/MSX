/**
 * 云函数 - acquireSeatLock
 *
 * 原子性的"座位预选"分布式锁（云数据库级别）。
 *
 * 实现要点：
 *  1. 查 seat_locks 中未过期锁；
 *  2. 如果被别人占用 → 拒绝（OCCUPIED）；
 *  3. 如果是自己 → 续期；
 *  4. 如果没有 → 插入新锁。
 *
 * 原子性保证：
 *   - 步骤 1-4 整体在云函数中执行，云函数调用本身在微信云开发内是顺序化；
 *   - 唯一复合索引 ({ seatId, date, timeSlot }) 在数据库层兜底
 *     防止两个并发请求都通过"未找到"分支后同时 add —— 第二个会因
 *     唯一索引冲突而失败，调用方据此区分"自己赢得锁 / 输给了别人"。
 *
 * 数据库索引建议（云开发控制台手动添加）：
 *   - db.seat_locks.createIndex({ seatId: 1, date: 1, timeSlot: 1 }, { unique: true })
 *   - db.seat_locks.createIndex({ expireTime: 1 })
 *
 * 入参（event）：
 *   seatId:    string  座位 ID
 *   date:      string  YYYY-MM-DD
 *   timeSlot:  string  'morning' | 'afternoon' | 'evening'
 *   userId:    string  当前用户 ID（前端从 openid 解析得到）
 *   ttl:       number? 可选，默认 30000ms
 *
 * 返回值：
 *   { success: true,  data: { lockId, action: 'created'|'refreshed', expireTime } }
 *   { success: false, code: 'OCCUPIED'|'RACE_LOST'|'NO_PARAMS', message }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const DEFAULT_LOCK_TTL = 30 * 1000;
const MAX_LOCK_TTL = 5 * 60 * 1000; // 上限 5 分钟，防止误传

exports.main = async (event, context) => {
  const { seatId, date, timeSlot, userId } = event;
  let { ttl } = event;

  // ─── 1. 入参校验 ───
  if (!seatId || !date || !timeSlot || !userId) {
    return { success: false, code: 'NO_PARAMS', message: '缺少必要参数' };
  }

  if (typeof ttl !== 'number' || ttl <= 0) ttl = DEFAULT_LOCK_TTL;
  if (ttl > MAX_LOCK_TTL) ttl = MAX_LOCK_TTL;

  const now = Date.now();
  const expireTime = now + ttl;

  try {
    // ─── 2. 查询未过期锁（只用一条记录，依赖唯一索引）───
    const lockRes = await db.collection('seat_locks').where({
      seatId,
      date,
      timeSlot
    }).get();

    // 清理过期的（即便有唯一索引兜底，库内也允许临时有过期记录）
    const aliveLocks = (lockRes.data || []).filter(l => l.expireTime > now);

    if (aliveLocks.length > 0) {
      const exist = aliveLocks[0];
      if (exist.userId === userId) {
        // 3a. 自己是当前持有人 → 续期
        await db.collection('seat_locks').doc(exist._id).update({
          data: { expireTime, updatedAt: now }
        });
        return {
          success: true,
          data: { lockId: exist._id, action: 'refreshed', expireTime }
        };
      }
      // 3b. 别人占着 → 拒绝
      return {
        success: false,
        code: 'OCCUPIED',
        message: '座位已被其他用户预选',
        data: { holderUserId: exist.userId, expireTime: exist.expireTime }
      };
    }

    // ─── 4. 没有活跃锁 → 尝试插入新锁（依赖唯一索引兜底并发）───
    const lockDoc = {
      seatId,
      date,
      timeSlot,
      userId,
      expireTime,
      createdAt: now,
      updatedAt: now
    };

    try {
      const addRes = await db.collection('seat_locks').add({ data: lockDoc });
      return {
        success: true,
        data: { lockId: addRes._id, action: 'created', expireTime }
      };
    } catch (addErr) {
      // 唯一索引冲突：另一个并发请求在我们之前成功 add 了
      // 重新查一次判断输赢
      const recheck = await db.collection('seat_locks').where({
        seatId, date, timeSlot
      }).get();
      const recheckAlive = (recheck.data || []).filter(l => l.expireTime > now);
      if (recheckAlive.length > 0) {
        const winner = recheckAlive[0];
        if (winner.userId === userId) {
          // 罕见但可能：唯一索引冲突但赢家是自己（说明秒级时序内自己赢了）
          await db.collection('seat_locks').doc(winner._id).update({
            data: { expireTime, updatedAt: now }
          });
          return {
            success: true,
            data: { lockId: winner._id, action: 'refreshed', expireTime }
          };
        }
        return {
          success: false,
          code: 'OCCUPIED',
          message: '座位刚被其他用户预选',
          data: { holderUserId: winner.userId, expireTime: winner.expireTime }
        };
      }
      // 不是唯一索引冲突（可能是网络/权限），上抛
      throw addErr;
    }
  } catch (err) {
    console.error('[acquireSeatLock] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', message: '加锁失败' };
  }
};
