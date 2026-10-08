/**
 * 云函数 - autoCheckout（文档 5.4.2 节）
 * 定时任务：每 5 分钟扫描一次
 * 1. 自动签退已到结束时间的预约
 * 2. 检测超时未签到的预约并标记违规
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

exports.main = async (event, context) => {
  const now = Date.now();
  const stats = { autoCheckouts: 0, violations: 0, errors: 0 };

  try {
    // ═══════════════════════════════════
    // 1. 检测超时未签到的预约
    //    规则：status='pending' 且 (startTime + 15分钟) < now
    // ═══════════════════════════════════
    const pendingRes = await db.collection('reservations')
      .where({ status: 'pending' })
      .get();

    for (const r of pendingRes.data) {
      try {
        // 构建预约开始时间
        const dateStr = typeof r.date === 'string' ? r.date.substring(0, 10) : '';
        const startTime = getStartTime(r.timeSlot || 'morning');
        const deadline = new Date(`${dateStr}T${startTime}:00+08:00`).getTime() + 15 * 60 * 1000;

        if (now > deadline) {
          // 超时 → 取消预约 + 记录违规
          await db.collection('reservations').doc(r._id).update({
            data: { status: 'violation', updatedAt: now }
          });

          // 释放座位
          if (r.seatId) {
            await db.collection('seats').doc(r.seatId).update({
              data: { seatStatus: 'free', updatedAt: now }
            });
          }

          // 记录违规
          await db.collection('violations').add({
            data: {
              userId: r.userId,
              reservationId: r._id,
              violationType: 1,
              penaltyScore: 5,
              description: '预约后超时未签到（系统自动检测）',
              isAppealed: 0,
              createdAt: now
            }
          });

          // 扣减积分
          await db.collection('users').doc(r.userId).update({
            data: {
              creditScore: _.inc(-5),
              updatedAt: now
            }
          });

          stats.violations++;
        }
      } catch (e) {
        console.error('[autoCheckout] violation processing error:', r._id, e);
        stats.errors++;
      }
    }

    // ═══════════════════════════════════
    // 2. 自动签退已结束的预约
    //    规则：status='checked_in' 且 endTime < now
    // ═══════════════════════════════════
    const checkedInRes = await db.collection('reservations')
      .where({ status: 'checked_in' })
      .get();

    for (const r of checkedInRes.data) {
      try {
        const dateStr = typeof r.date === 'string' ? r.date.substring(0, 10) : '';
        const endTime = getEndTime(r.timeSlot || 'morning');
        const endTimestamp = new Date(`${dateStr}T${endTime}:00+08:00`).getTime();

        if (now > endTimestamp) {
          // 自动签退
          await db.collection('reservations').doc(r._id).update({
            data: { status: 'completed', updatedAt: now }
          });

          // 释放座位
          if (r.seatId) {
            await db.collection('seats').doc(r.seatId).update({
              data: { seatStatus: 'free', updatedAt: now }
            });
          }

          // 更新签到记录
          const checkinRecords = await db.collection('checkin_records')
            .where({ reservationId: r._id }).get();
          if (checkinRecords.data.length > 0) {
            await db.collection('checkin_records').doc(checkinRecords.data[0]._id).update({
              data: { checkoutTime: now, checkoutType: 2 }
            });
          }

          // 正常完成 +1 积分
          await db.collection('users').doc(r.userId).update({
            data: {
              creditScore: _.inc(1),
              updatedAt: now
            }
          });

          stats.autoCheckouts++;
        }
      } catch (e) {
        console.error('[autoCheckout] checkout processing error:', r._id, e);
        stats.errors++;
      }
    }

    console.log('[autoCheckout] completed:', stats);
    return { success: true, data: stats };

  } catch (err) {
    console.error('[autoCheckout] fatal error:', err);
    return { success: false, error: err.message };
  }
};

function getStartTime(slot) {
  const slots = {
    morning: '08:00',
    afternoon: '12:00',
    evening: '18:00'
  };
  return slots[slot] || '08:00';
}

function getEndTime(slot) {
  const slots = {
    morning: '12:00',
    afternoon: '18:00',
    evening: '22:00'
  };
  return slots[slot] || '22:00';
}
