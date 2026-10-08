/** Real-time admin overview and authenticated personal statistics. */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const core = require('./statistics-core');

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { success: false, code: 'LOGIN_REQUIRED', message: '请先登录' };
  try {
    if (event.action === 'user') {
      const user = await db.collection('users').where({ openid }).limit(1).get();
      if (!user.data.length) return { success: false, code: 'LOGIN_REQUIRED', message: '用户不存在' };
      const records = await core.fetchAll(db, 'reservations', db.command.or([{ userId: user.data[0]._id }, { openid }]));
      return { success: true, data: core.userStats(records) };
    }
    if (!await core.checkAdmin(db, openid)) return { success: false, code: 'PERMISSION_DENIED', message: '无管理员权限' };
    const now = Date.now();
    const today = core.chinaDate(now);
    const [daily, week, month, violations] = await Promise.all([
      core.readDaily(db, today, now),
      db.collection('reservations').where({ date: db.command.gte(core.weekStart(today)).and(db.command.lte(today)) }).count(),
      db.collection('reservations').where({ date: db.command.gte(today.slice(0, 7) + '-01').and(db.command.lte(today)) }).count(),
      db.collection('violations').count()
    ]);
    return { success: true, data: { overview: {
      ...daily, todayReservations: daily.dayReservations, todayCheckedIn: daily.dayCheckedIn,
      todayCompleted: daily.dayCompleted, todayCancelled: daily.dayCancelled,
      todayViolations: daily.dayViolations, todayEffectiveReservations: daily.dayEffectiveReservations,
      weekReservations: week.total, monthReservations: month.total, totalViolations: violations.total
    } } };
  } catch (error) {
    console.error('[getStatistics] 查询失败:', error);
    return { success: false, code: 'SYSTEM_ERROR', message: '统计查询失败，请稍后重试' };
  }
};
