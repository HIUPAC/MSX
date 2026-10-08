/** Daily snapshots share calculations with the real-time overview. */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const core = require('./statistics-core');

async function aggregateDaily(date, totals) {
  const stats = await core.readDaily(db, date, Date.now(), totals);
  // A deterministic ID makes concurrent aggregation idempotent.
  await db.collection('statistics').doc('stats_' + date).set({ data: stats });
  return stats;
}

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;
    const timer = !openid && event.Type === 'Timer' && event.TriggerName === 'dailyAggregate';
    if (!timer && !await core.checkAdmin(db, openid)) return { success: false, code: 'PERMISSION_DENIED', message: '无管理员权限' };
    const action = timer ? 'aggregate' : (event.action || 'aggregate');
    if (!['aggregate', 'aggregateAll', 'query', 'queryByDate'].includes(action)) return { success: false, code: 'INVALID_PARAMS', message: '未知统计操作' };
    const today = core.chinaDate();
    const date = timer ? core.chinaDate(Date.now() - core.DAY_MS) : (event.date || today);
    if (!core.validDate(date) || date > today) return { success: false, code: 'INVALID_PARAMS', message: '请选择有效的历史日期或今日' };
    const days = event.days === undefined ? 7 : Number(event.days);
    if (['aggregateAll', 'query'].includes(action) && (!Number.isInteger(days) || days < 1 || days > 31)) return { success: false, code: 'INVALID_PARAMS', message: '统计天数须为 1 至 31 的整数' };
    if (action === 'aggregate') return { success: true, data: await aggregateDaily(date) };
    if (action === 'aggregateAll') {
      const [users, reservations, seats] = await Promise.all([db.collection('users').count(), db.collection('reservations').count(), core.fetchAll(db, 'seats', {}, { seatStatus: true, status: true })]);
      const processed = [];
      for (let offset = 0; offset < days; offset += 3) {
        const batch = Array.from({ length: Math.min(3, days - offset) }, (_, index) => offset + index);
        const results = await Promise.all(batch.map(async i => {
          const target = core.chinaDate(core.dateTimestamp(date) - i * core.DAY_MS);
          try {
            await aggregateDaily(target, { totalUsers: users.total, totalReservations: reservations.total, seats });
            return { date: target, success: true };
          } catch (error) {
            console.error('[aggregateStats] 单日聚合失败:', target, error);
            return { date: target, success: false };
          }
        }));
        processed.push(...results);
      }
      const count = processed.filter(result => result.success).length;
      return { success: count === days, code: count === days ? 0 : 'PARTIAL_FAILURE',
        message: count === days ? '计算同步完成' : `完成 ${count}/${days} 天，请重试失败日期`, data: { processed, count, failedCount: days - count } };
    }
    if (action === 'queryByDate') {
      const result = await db.collection('statistics').where({ date, schemaVersion: core.SCHEMA_VERSION }).orderBy('updatedAt', 'desc').limit(1).get();
      return { success: true, data: result.data[0] || null };
    }
    const start = core.chinaDate(core.dateTimestamp(date) - (days - 1) * core.DAY_MS);
    const rows = await core.fetchAll(db, 'statistics', { date: db.command.gte(start).and(db.command.lte(date)), schemaVersion: core.SCHEMA_VERSION });
    const byDate = new Map();
    rows.forEach(row => { if (!byDate.has(row.date) || row.updatedAt > byDate.get(row.date).updatedAt) byDate.set(row.date, row); });
    return { success: true, data: { list: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)) } };
  } catch (error) {
    console.error('[aggregateStats] 失败:', error);
    return { success: false, code: 'SYSTEM_ERROR', message: '统计计算失败，请稍后重试' };
  }
};
