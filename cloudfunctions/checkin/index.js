/**
 * 云函数 - checkin（文档 5.1.4 节 / 5.4.3 节）
 * 支持扫码签到 + GPS 定位签到
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event = {}) => {
  const { type = 1, qrContent, latitude, longitude, distance } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!openid) {
    return { success: false, code: 'LOGIN_REQUIRED', message: '请先登录' };
  }
  if (![1, 2].includes(type) || (type === 1 && (typeof qrContent !== 'string' || !qrContent.trim())) ||
      (type === 2 && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180))) {
    return { success: false, code: 'INVALID_PARAMS', message: '签到参数无效' };
  }

  try {
    // 1. 查找用户
    const userRes = await db.collection('users').where({ openid }).get();
    if (userRes.data.length === 0) {
      return { success: false, code: 'LOGIN_REQUIRED', message: '用户不存在' };
    }
    const user = userRes.data[0];

    const now = Date.now();
    const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    // Select today's reservation rather than whichever document happens to be first.
    const reservationRes = await db.collection('reservations').where({
      userId: user._id,
      date: today,
      status: _.in(['pending', 'checked_in'])
    }).get();

    if (reservationRes.data.length === 0) {
      return { success: false, code: 'NO_RESERVATION', message: '没有待签到的预约' };
    }

    const startOf = record => Date.parse(`${record.date}T${record.startTime || getSlotStart(record.timeSlot)}:00+08:00`);
    const ordered = reservationRes.data.filter(record => Number.isFinite(startOf(record))).sort((a, b) => startOf(b) - startOf(a));
    const reservation = ordered.find(record => startOf(record) <= now && now <= startOf(record) + 15 * 60 * 1000) || ordered.find(record => startOf(record) <= now);
    if (!reservation) return { success: false, code: 'CHECKIN_EARLY', message: '请在预约开始后签到' };

    // 3. 校验签到类型
    if (reservation.status === 'checked_in') {
      return { success: false, code: 'CHECKIN_DUPLICATE', message: '已签到，无需重复签到' };
    }

    // 4. 扫码签到时校验座位匹配
    if (type === 1 && qrContent) {
      const seatRes = await db.collection('seats').doc(reservation.seatId).get();
      if (!seatRes.data || seatRes.data.seatNumber !== qrContent) {
        return { success: false, code: 'CHECKIN_WRONG_SEAT', message: '请到预约座位签到' };
      }
    }

    // 5. 检查签到时限（预约开始 15 分钟内）
    const startTime = reservation.startTime || getSlotStart(reservation.timeSlot);
    const [dateStr] = (reservation.date || '').split('T');
    const deadline = Date.parse(`${dateStr}T${startTime}:00+08:00`) + 15 * 60 * 1000;

    if (now > deadline) {
      // 超时未签到 → 取消预约 + 违规记录
      await db.collection('reservations').doc(reservation._id).update({
        data: { status: 'violation', updatedAt: now }
      });
      await db.collection('seats').doc(reservation.seatId).update({
        data: { seatStatus: 'free', updatedAt: now }
      });
      await db.collection('violations').add({
        data: {
          userId: user._id,
          reservationId: reservation._id,
          violationType: 1,      // 未签到
          penaltyScore: 5,
          description: '预约后超时未签到',
          isAppealed: 0,
          createdAt: now
        }
      });
      await db.collection('users').doc(user._id).update({ data: { creditScore: _.inc(-5), updatedAt: now } });
      return { success: false, code: 'CHECKIN_TIMEOUT', message: '签到已超时，预约已取消并扣 5 分' };
    }

    // 6. 更新预约状态
    await db.collection('reservations').doc(reservation._id).update({
      data: { status: 'checked_in', checkinTime: now, updatedAt: now }
    });

    // 7. 更新座位状态
    await db.collection('seats').doc(reservation.seatId).update({
      data: { seatStatus: 'in_use', updatedAt: now }
    });

    // 8. 记录签到
    await db.collection('checkin_records').add({
      data: {
        reservationId: reservation._id,
        checkinType: type,
        checkinTime: now,
        checkoutTime: null,
        checkoutType: null,
        // GPS 签到时记录位置
        ...(type === 2 ? { latitude, longitude, distance } : {}),
        createdAt: now
      }
    });

    return {
      success: true,
      code: 0,
      message: '签到成功',
      data: { reservationId: reservation._id, checkinTime: now }
    };

  } catch (err) {
    console.error('[checkin] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', message: '签到失败，请重试' };
  }
};

function getSlotStart(timeSlot) {
  const slots = {
    morning: '08:00',
    afternoon: '12:00',
    evening: '18:00'
  };
  return slots[timeSlot] || '08:00';
}
