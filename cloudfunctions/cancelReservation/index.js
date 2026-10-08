/**
 * 云函数 - cancelReservation
 *
 * 解决"取消预约后记录仍然存在"问题:
 *  - 预约由云函数 createReservation 在服务端创建,文档没有客户端 _openid;
 *    若客户端直接 wx.cloud.database().doc().update() 改状态,在 reservations
 *    集合"仅创建者可读写"权限下会被拒绝,云端记录仍保持 pending/checked_in,
 *    记录页重新拉取时预约依旧存在。
 *  - 本云函数在服务端用管理员权限更新,并通过 OPENID 校验预约归属,
 *    确保取消操作真正生效,同时释放该座位的预选锁。
 *
 * 入参(event):
 *   reservationId: string  预约文档 _id(以 'local_' 开头的本地预约由客户端处理)
 *
 * 返回:
 *   { success: true, data: { reservationId, status: 'cancelled', reservation } }
 *   { success: true, code: 'ALREADY_CANCELLED', data: { already: true } }
 *   { success: false, code: 'INVALID_PARAMS' | 'LOGIN_REQUIRED' | 'NOT_FOUND'
 *      | 'PERMISSION_DENIED' | 'SYSTEM_ERROR', message }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const { reservationId } = event || {};

  if (!reservationId || typeof reservationId !== 'string' || reservationId.startsWith('local_')) {
    return { success: false, code: 'INVALID_PARAMS', message: '预约参数不完整' };
  }

  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) {
    return { success: false, code: 'LOGIN_REQUIRED', message: '请先登录' };
  }

  try {
    // ─── 1. 读取预约 ───
    let reservation;
    try {
      const res = await db.collection('reservations').doc(reservationId).get();
      reservation = res.data;
    } catch (err) {
      console.warn('[cancelReservation] 预约不存在或已删除:', err.message || err.errMsg);
      return { success: false, code: 'NOT_FOUND', message: '预约记录不存在' };
    }
    if (!reservation) {
      return { success: false, code: 'NOT_FOUND', message: '预约记录不存在' };
    }

    // ─── 2. 归属校验:仅允许取消自己的预约 ───
    let userId = '';
    try {
      const usersRes = await db.collection('users').where({ openid }).limit(1).get();
      const user = usersRes.data && usersRes.data[0];
      if (user) userId = user._id || '';
    } catch (err) {
      console.warn('[cancelReservation] 用户查询失败,仅按 openid 校验:', err.message || err.errMsg);
    }
    // 归属口径:预约.openid === OPENID(新口径)
    //          || 预约.userId === 用户文档 _id(服务端创建口径)
    //          || 预约.userId === OPENID(历史遗留口径)
    const isOwner =
      reservation.openid === openid ||
      (userId && reservation.userId === userId) ||
      reservation.userId === openid;
    if (!isOwner) {
      return { success: false, code: 'PERMISSION_DENIED', message: '无权取消该预约' };
    }

    // ─── 3. 幂等:已取消直接返回成功 ───
    if (reservation.status === 'cancelled') {
      return {
        success: true,
        code: 'ALREADY_CANCELLED',
        data: {
          already: true,
          reservation: {
            seatId: reservation.seatId, date: reservation.date, timeSlot: reservation.timeSlot
          }
        }
      };
    }
    if (!['pending', 'checked_in'].includes(reservation.status)) return { success: false, code: 'INVALID_STATE', message: '已结束的预约不能取消' };

    // ─── 4. 更新状态为 cancelled ───
    const now = Date.now();
    await db.collection('reservations').doc(reservationId).update({
      data: { status: 'cancelled', updatedAt: now, cancelledAt: now }
    });

    // Await owned-lock cleanup before a synchronized statistics read.
    if (reservation.seatId && reservation.date && reservation.timeSlot) {
      try {
        const locks = await db.collection('seat_locks').where({ seatId: reservation.seatId, date: reservation.date,
          timeSlot: reservation.timeSlot, userId: db.command.in([userId, openid].filter(Boolean)) }).limit(20).get();
        const removed = await Promise.allSettled((locks.data || []).map(lock => db.collection('seat_locks').doc(lock._id).remove()));
        removed.forEach(result => { if (result.status === 'rejected') console.warn('[cancelReservation] 释放锁失败:', result.reason); });
      } catch (error) { console.warn('[cancelReservation] 释放锁失败:', error); }
    }

    return {
      success: true,
      data: {
        reservationId,
        status: 'cancelled',
        reservation: { ...reservation, status: 'cancelled', cancelledAt: now, updatedAt: now }
      }
    };
  } catch (err) {
    console.error('[cancelReservation] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', message: '取消失败,请稍后重试' };
  }
};
