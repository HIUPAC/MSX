/**
 * 云函数 - getSeatsState
 *
 * 解决"不同用户看到不同座位状态"问题。
 *
 * 背景:
 *  - 客户端 wx.cloud.database() 受集合权限限制,如果 reservations/seat_locks
 *    集合权限为"仅创建者可读写",则每个用户只能看到自己创建的记录,
 *    导致不同用户看到的座位占用/剩余情况完全不同。
 *  - 本云函数在服务端用管理员权限查询,确保返回"全量"状态,所有用户一致。
 *
 * 入参(event):
 *   date:         string  YYYY-MM-DD
 *   timeSlot:     string  'morning' | 'afternoon' | 'evening'
 *   floor:        number  楼层(可选,用于限定查询范围);
 *                 缺省或 'all' 时聚合全馆,并额外返回 summary 汇总
 *
 * 返回:
 *   {
 *     success: true,
 *     data: {
 *       version:           number,                  // 当前时间戳
 *       seatReservationCount: { [seatId]: number }, // 每个座位的活跃预约数
 *       activeLocks:         { [seatId]: { ... } },  // 每个座位的预选锁(仅保留一个)
 *       todayReservations:   number,                 // 今日总预约数(全平台共享)
 *       todayOccupied:       number,                 // 今日已签到数
 *       seatStaticStatus:    { [seatId]: 'free'|'maintenance'|... }, // 座位静态状态
 *       summary:             object|null,            // 仅 floor 缺省/'all' 时返回:
 *         {
 *           totalSeats:       number,  // 全馆座位总数(以 seats 集合为准)
 *           occupiedSeats:    number,  // 已占用数(活跃预约 ∪ 预选锁)
 *           maintenanceSeats: number,  // 维护中座位数
 *           remainingSeats:   number,  // 剩余可预约 = total - occupied - maintenance
 *           usageRate:        number   // 使用率(%)= occupied / total,四舍五入
 *         }
 *     }
 *   }
 *
 * 注意:
 *  - 不返回具体用户信息,只返回聚合后的状态,避免越权
 *  - 不返回 reservations 明细,只返回每个座位的计数
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const core = require('./statistics-core');

// 占用座位的活跃状态：已结束(completed)的预约不应继续占用座位
const ACTIVE_RESERVATION_STATUSES = ['pending', 'checked_in'];
// 今日预约统计：包含已结束的预约，保证"今日预约数"口径准确

exports.main = async (event, context) => {
  const { date, timeSlot, floor } = event || {};

  if (!core.validDate(date) || !['morning', 'afternoon', 'evening'].includes(timeSlot) || (floor != null && floor !== 'all' && (!Number.isInteger(Number(floor)) || Number(floor) < 1))) {
    return { success: false, code: 'INVALID_PARAMS', message: '日期、时段或楼层无效' };
  }

  try {
    const now = Date.now();

    // ─── 1. 并行查询:座位预约 + 预选锁 + 今日统计 + 座位静态状态 ───
    const reservationWhere = {
      date,
      timeSlot,
      status: _.in(ACTIVE_RESERVATION_STATUSES)
    };

    // 收集需要并行发起的 promise
    const tasks = [
      core.fetchAll(db, 'reservations', reservationWhere, { seatId: true, status: true }).then(data => ({ data })),
      core.fetchAll(db, 'seat_locks', { date, timeSlot, expireTime: _.gt(now) }).then(data => ({ data })),
      db.collection('reservations')
        .where({ date })
        .count(),
      db.collection('reservations')
        .where({ date, status: 'checked_in' })
        .count()
    ];

    // 楼层过滤语义:
    //  - floor 为数字:仅聚合该楼层,并返回该楼层座位静态状态;
    //  - floor 缺省或 'all':聚合全馆,返回全馆座位静态状态与 summary 汇总。
    const floorNum = (floor == null || floor === 'all') ? null : Number(floor);

    // 查询座位静态状态(数字 floor 只查该楼层,缺省/'all' 查全馆)
    let floorSeatIds = null;
    if (floorNum != null) {
      tasks.push(
        core.fetchAll(db, 'seats', { floor: floorNum }, { seatStatus: true, status: true }).then(data => ({ data }))
      );
    } else {
      tasks.push(
        core.fetchAll(db, 'seats', {}, { seatStatus: true, status: true }).then(data => ({ data }))
      );
    }

    const results = await Promise.all(tasks);
    const [reservationRes, lockRes, todayCountRes, todayOccupiedRes] = results;
    const seatsRes = results[4] || null;
    const seatsData = (seatsRes && seatsRes.data) || [];

    if (floorNum != null && seatsData.length > 0) {
      // seats 已初始化:仅聚合该楼层座位。
      // seats 未初始化/为空时 floorSeatIds 保持 null,
      // 退化为不过滤楼层,客户端按自身 floor 的 seatId 自行取用。
      floorSeatIds = new Set(seatsData.map(s => s._id));
    }

    // ─── 2. 聚合:每个 seatId 的活跃预约数 ───
    const seatReservationCount = {};
    for (const r of (reservationRes.data || [])) {
      if (!r || !r.seatId) continue;
      if (floorSeatIds && !floorSeatIds.has(r.seatId)) continue;
      seatReservationCount[r.seatId] = (seatReservationCount[r.seatId] || 0) + 1;
    }

    // ─── 3. 聚合:每个 seatId 的预选锁(同座位多锁时,取最新的一个)───
    const activeLocks = {};
    for (const l of (lockRes.data || [])) {
      if (!l || !l.seatId) continue;
      if (floorSeatIds && !floorSeatIds.has(l.seatId)) continue;
      const cur = activeLocks[l.seatId];
      // 同一座位只保留一个锁(取 updatedAt 最新的)
      if (!cur || (l.updatedAt || 0) > (cur.updatedAt || 0)) {
        activeLocks[l.seatId] = l;
      }
    }

    // ─── 4. 全馆汇总(floor 缺省或 'all' 时,且 seats 已初始化)───
    // 剩余可预约 = 总数 - 已占用(活跃预约 ∪ 预选锁) - 维护中。
    let summary = null;
    if (floorNum == null) {
      summary = core.seatSummary(seatsData, reservationRes.data || [], lockRes.data || []);
    }

    return {
      success: true,
      data: {
        version: now,
        seatReservationCount,
        activeLocks,
        todayReservations: todayCountRes.total || 0,
        todayOccupied: todayOccupiedRes.total || 0,
        // 座位静态状态:{ seatId: 'free'|'maintenance'|... }
        seatStaticStatus: seatsRes
          ? seatsData.reduce((acc, s) => {
              if (s && s._id) acc[s._id] = s.seatStatus || s.status || 'free';
              return acc;
            }, {})
          : null,
        // 全馆汇总(仅 floor 缺省/'all' 时返回)
        summary
      }
    };
  } catch (err) {
    console.error('[getSeatsState] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', message: '查询失败: ' + (err.message || 'unknown') };
  }
};
