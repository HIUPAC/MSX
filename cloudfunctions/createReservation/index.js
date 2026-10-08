/**
 * 云函数 - createReservation
 *
 * 优化目标:
 *  1. 减少数据库查询次数:从 4 次降到 2 次(用户+一次性聚合预约信息)
 *  2. 放宽时段冲突:同用户同时段已有预约时,自动改签到新座位(更新而非新增)
 *  3. 保持座位容量限制:同一座位同时段仍最多 2 人
 *  4. 用 wxContext.OPENID 识别用户(避免客户端伪造 userId)
 *
 * 入参(event):同前
 *
 * 返回:同前
 *
 * 错误码:
 *   INVALID_PARAMS, LOGIN_REQUIRED, USER_NOT_FOUND,
 *   BANNED, CREDIT_INSUFFICIENT, DAILY_LIMIT,
 *   SEAT_FULL, RACE_LOST, SYSTEM_ERROR
 *
 * 注:原 TIME_CONFLICT 已移除——改为"自动改签"模式,客户端无需特殊处理。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ACTIVE_STATUSES = ['pending', 'checked_in'];
const MAX_DAILY_RESERVATIONS = 2;
const MAX_SEAT_CAPACITY = 2;
const SEAT_BAN_THRESHOLD = 80;
const VALID_TIME_SLOTS = new Set(['morning', 'afternoon', 'evening']);

exports.main = async (event, context) => {
  const {
    seatId, tableId, tableNo, seatNo,
    areaId, areaName,
    date, timeSlot, startTime, endTime
  } = event || {};

  // ─── 1. 参数校验 ───
  if (!seatId || !date || !timeSlot || !startTime || !endTime) {
    return { success: false, code: 'INVALID_PARAMS', message: '缺少必要参数' };
  }
  if (!VALID_TIME_SLOTS.has(timeSlot)) {
    return { success: false, code: 'INVALID_PARAMS', message: '时段参数不合法' };
  }

  // ─── 2. 身份校验 ───
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) {
    return { success: false, code: 'LOGIN_REQUIRED', message: '请先登录' };
  }

  try {
    const now = Date.now();

    // ─── 3. 并行获取用户 + 当日预约 + 座位容量(3 次查询并行)───
    const [userRes, seatFullRes] = await Promise.all([
      db.collection('users').where({ openid }).limit(1).get(),
      db.collection('reservations').where({
        seatId, date, timeSlot,
        status: _.in(ACTIVE_STATUSES)
      }).count()
    ]);

    // 3a. 用户(自动兜底创建)
    let user = userRes.data && userRes.data[0];
    if (!user) {
      try {
        const newUser = {
          openid, role: 'user', creditScore: 100,
          createdAt: now, updatedAt: now
        };
        const addRes = await db.collection('users').add({ data: newUser });
        user = { _id: addRes._id, ...newUser };
      } catch (e) {
        return { success: false, code: 'USER_NOT_FOUND', message: '用户不存在' };
      }
    }
    const userId = user._id;
    // Scope the query before pagination; global first-20 results could miss this user's bookings.
    const myTodayRes = await db.collection('reservations').where({
      userId, date, status: _.in(['pending', 'checked_in', 'completed'])
    }).limit(20).get();

    // 3b. 禁预约/积分校验
    if (user.banExpireTime && user.banExpireTime > now) {
      const remainDays = Math.ceil((user.banExpireTime - now) / 86400000);
      return {
        success: false, code: 'BANNED',
        message: `您当前处于禁预约期,还剩 ${remainDays} 天`
      };
    }
    if ((user.creditScore ?? 100) < SEAT_BAN_THRESHOLD) {
      return {
        success: false, code: 'CREDIT_INSUFFICIENT',
        message: `信用积分不足(当前 ${user.creditScore ?? 100},需要 ${SEAT_BAN_THRESHOLD})`
      };
    }

    // 3c. 解析当日我的预约(从并行查询的结果中过滤)
    const myTodayAll = (myTodayRes.data || []).filter(r => r.userId === userId);
    const myTodayActive = myTodayAll.filter(r => ACTIVE_STATUSES.includes(r.status));

    // 找到同时段已存在的预约(用于改签)
    const sameSlotExisting = myTodayActive.find(r =>
      r.date === date && r.timeSlot === timeSlot
    );

    // ─── 4. 当日次数校验:如果同时段已有预约,改签不计入次数 ───
    // 同时段已存在预约 → 这是改签场景,不计入新预约次数
    const isReschedule = !!sameSlotExisting;
    if (sameSlotExisting?.status === 'checked_in') return { success: false, code: 'RESERVATION_IN_USE', message: '已签到的预约不能改签' };
    if (!isReschedule && myTodayAll.length >= MAX_DAILY_RESERVATIONS) {
      return {
        success: false, code: 'DAILY_LIMIT',
        message: `今日预约次数已达上限(${MAX_DAILY_RESERVATIONS} 次)`
      };
    }

    // ─── 5. 座位容量校验 ───
    // 如果是改签到同一个座位,不算占用新名额
    const seatFull = seatFullRes.total;
    const isSameSeatReschedule = isReschedule && sameSlotExisting.seatId === seatId;
    if (!isSameSeatReschedule && seatFull >= MAX_SEAT_CAPACITY) {
      return {
        success: false, code: 'SEAT_FULL',
        message: '该座位已被预约满,请选择其他座位'
      };
    }

    // ─── 6. 写入/更新预约 ───
    const reservationData = {
      userId, openid, seatId,
      tableId: tableId || '',
      tableNo: tableNo || '',
      seatNo: seatNo != null ? String(seatNo) : '',
      areaId: areaId || '',
      areaName: areaName || '',
      date, timeSlot, startTime, endTime,
      status: 'pending',
      updatedAt: now
    };

    let resultRecord;
    let isUpdate = false;

    if (isReschedule) {
      // ★ 改签:更新原预约
      try {
        await db.collection('reservations').doc(sameSlotExisting._id).update({
          data: reservationData
        });
        resultRecord = { _id: sameSlotExisting._id, createdAt: sameSlotExisting.createdAt, ...reservationData };
        isUpdate = true;
      } catch (updateErr) {
        console.warn('[createReservation] update fail:', updateErr);
        return { success: false, code: 'SYSTEM_ERROR', message: '改签失败,请重试' };
      }
    } else {
      // ★ 新建预约
      reservationData.createdAt = now;
      try {
        const addRes = await db.collection('reservations').add({ data: reservationData });
        resultRecord = { _id: addRes._id, ...reservationData };
      } catch (addErr) {
        // 唯一索引冲突 → 重新查座位
        console.warn('[createReservation] insert conflict:', addErr);
        const recheck = await db.collection('reservations').where({
          seatId, date, timeSlot, status: _.in(ACTIVE_STATUSES)
        }).count();
        if (recheck.total >= MAX_SEAT_CAPACITY) {
          return { success: false, code: 'SEAT_FULL', message: '该座位已被预约满' };
        }
        return { success: false, code: 'RACE_LOST', message: '并发冲突,请重试' };
      }
    }

    // Await owned-lock cleanup so the next statistics read sees the committed booking.
    try {
      const locks = await db.collection('seat_locks').where({ seatId, date, timeSlot, userId: _.in([userId, openid]) }).limit(20).get();
      const removed = await Promise.allSettled((locks.data || []).map(lock => db.collection('seat_locks').doc(lock._id).remove()));
      removed.forEach(result => { if (result.status === 'rejected') console.warn('[createReservation] 清理预选锁失败:', result.reason); });
    } catch (error) { console.warn('[createReservation] 清理预选锁失败:', error); }

    return {
      success: true,
      data: resultRecord,
      isUpdate
    };
  } catch (err) {
    console.error('[createReservation] error:', err);
    return {
      success: false, code: 'SYSTEM_ERROR',
      message: '预约失败,请稍后重试'
    };
  }
};
