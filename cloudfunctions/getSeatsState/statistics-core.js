/** Shared statistics implementation. Run tooling/scripts/sync-statistics-core.js after edits. */
const DAY_MS = 86400000;
const CHINA_OFFSET = 8 * 3600000;
const SCHEMA_VERSION = 2;
const ACTIVE_STATUSES = ['pending', 'checked_in'];
const STATUS_NAMES = ['pending', 'checked_in', 'completed', 'cancelled', 'violation'];

function chinaDate(timestamp = Date.now()) {
  return new Date(timestamp + CHINA_OFFSET).toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00+08:00');
  return Number.isFinite(timestamp) && chinaDate(timestamp) === value;
}

function dateTimestamp(date) { return Date.parse(date + 'T00:00:00+08:00'); }

function weekStart(date) {
  const timestamp = dateTimestamp(date);
  const day = new Date(timestamp + CHINA_OFFSET).getUTCDay();
  return chinaDate(timestamp - ((day + 6) % 7) * DAY_MS);
}

function currentSlot(timestamp = Date.now()) {
  const hour = new Date(timestamp + CHINA_OFFSET).getUTCHours();
  return hour >= 18 ? 'evening' : hour >= 12 ? 'afternoon' : 'morning';
}

function percent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(numerator / denominator * 100)));
}

function hasCheckedIn(record) {
  return record.status !== 'cancelled' && (record.status === 'checked_in' || record.status === 'completed' || Boolean(record.checkinTime));
}

// A cursor avoids truncation and the shifting offsets of skip() pagination.
async function fetchAll(db, collection, where = {}, fields) {
  const records = [];
  let cursor;
  while (true) {
    let query = db.collection(collection).where(cursor ? db.command.and([where, { _id: db.command.gt(cursor) }]) : where);
    if (fields) query = query.field({ ...fields, _id: true });
    const result = await query.orderBy('_id', 'asc').limit(100).get();
    const batch = result.data || [];
    records.push(...batch);
    if (batch.length < 100) return records;
    const next = batch[batch.length - 1]._id;
    if (!next || next === cursor) throw new Error('统计分页游标无效');
    cursor = next;
  }
}

function seatSummary(seats, reservations, locks) {
  const occupied = new Set(reservations.filter(record => ACTIVE_STATUSES.includes(record.status)).map(record => record.seatId));
  locks.forEach(lock => occupied.add(lock.seatId));
  let occupiedSeats = 0;
  let maintenanceSeats = 0;
  seats.forEach(seat => {
    const status = seat.seatStatus || seat.status || 'free';
    if (status === 'maintenance' || status === 'disabled') maintenanceSeats++;
    else if (occupied.has(seat._id)) occupiedSeats++;
  });
  return { totalSeats: seats.length, occupiedSeats, maintenanceSeats,
    remainingSeats: Math.max(0, seats.length - occupiedSeats - maintenanceSeats), usageRate: percent(occupiedSeats, seats.length) };
}

function dailyStats(date, reservations, seats, summary, now = Date.now()) {
  const statusDistribution = Object.fromEntries(STATUS_NAMES.map(status => [status, 0]));
  const hourDistribution = new Array(24).fill(0);
  const areaStats = Object.create(null);
  const usedSeats = new Set();
  let checkedIn = 0;
  reservations.forEach(record => {
    if (Object.prototype.hasOwnProperty.call(statusDistribution, record.status)) statusDistribution[record.status]++;
    if (hasCheckedIn(record)) { checkedIn++; if (record.seatId) usedSeats.add(record.seatId); }
    const createdAt = record.createdAt instanceof Date ? record.createdAt.getTime() : Number(record.createdAt);
    if (Number.isFinite(createdAt) && createdAt > 0) hourDistribution[new Date(createdAt + CHINA_OFFSET).getUTCHours()]++;
    const floor = /^f(\d+)_/.exec(record.seatId || '');
    const area = record.areaName || record.areaId || (floor ? floor[1] + 'F' : '未分区');
    if (!areaStats[area]) areaStats[area] = { count: 0, checkedIn: 0, completed: 0, cancelled: 0, violation: 0 };
    areaStats[area].count++;
    if (hasCheckedIn(record)) areaStats[area].checkedIn++;
    if (['completed', 'cancelled', 'violation'].includes(record.status)) areaStats[area][record.status]++;
  });
  const effective = reservations.length - statusDistribution.cancelled;
  return { schemaVersion: SCHEMA_VERSION, date,
    dayReservations: reservations.length, dayEffectiveReservations: effective,
    dayCompleted: statusDistribution.completed, dayCheckedIn: checkedIn,
    dayCancelled: statusDistribution.cancelled, dayViolations: statusDistribution.violation,
    usageRate: summary ? summary.usageRate : percent(usedSeats.size, seats.length), usageKind: summary ? 'current' : 'daily',
    checkinRate: percent(checkedIn, effective), violationRate: percent(statusDistribution.violation, effective),
    hourDistribution, areaStats, statusDistribution, updatedAt: now };
}

function userStats(records, now = Date.now()) {
  const today = chinaDate(now);
  const start = weekStart(today);
  const byTimeSlot = { morning: 0, afternoon: 0, evening: 0 };
  const byFloor = { 1: 0, 2: 0, 3: 0 };
  let completed = 0, cancelled = 0, violation = 0, todayCount = 0, todayCompleted = 0, week = 0, month = 0;
  records.forEach(record => {
    if (record.status === 'completed') completed++;
    if (record.status === 'cancelled') cancelled++;
    if (record.status === 'violation') violation++;
    if (record.date === today) { todayCount++; if (record.status === 'completed') todayCompleted++; }
    if (record.date >= start && record.date <= today) week++;
    if (typeof record.date === 'string' && record.date.slice(0, 7) === today.slice(0, 7) && record.date <= today) month++;
    if (Object.prototype.hasOwnProperty.call(byTimeSlot, record.timeSlot)) byTimeSlot[record.timeSlot]++;
    const floor = Number(record.floor) || Number((/^f(\d+)_/.exec(record.seatId || '') || [])[1]);
    if (Object.prototype.hasOwnProperty.call(byFloor, floor)) byFloor[floor]++;
  });
  return { total: records.length, completed, cancelled, violation, today: todayCount, todayCompleted,
    todayDate: today, week, weekStart: start, month, monthKey: today.slice(0, 7), byTimeSlot, byFloor, updatedAt: now };
}

async function checkAdmin(db, openid) {
  if (!openid) return false;
  const result = await db.collection('users').where({ openid, role: db.command.in(['admin', 'super_admin']) }).limit(1).get();
  return Boolean(result.data && result.data.length);
}

async function readDaily(db, date, now = Date.now(), totals) {
  const today = chinaDate(now);
  const tasks = [totals?.seats ? Promise.resolve(totals.seats) : fetchAll(db, 'seats', {}, { seatStatus: true, status: true }), fetchAll(db, 'reservations', { date }),
    date === today ? fetchAll(db, 'seat_locks', { date, timeSlot: currentSlot(now), expireTime: db.command.gt(now) }) : Promise.resolve([])];
  if (!totals) tasks.push(db.collection('users').count(), db.collection('reservations').count());
  const [seats, reservations, locks, users, allReservations] = await Promise.all(tasks);
  const summary = date === today ? seatSummary(seats, reservations.filter(record => record.timeSlot === currentSlot(now)), locks) : null;
  return { ...dailyStats(date, reservations, seats, summary, now), totalSeats: seats.length,
    totalUsers: totals ? totals.totalUsers : users.total, totalReservations: totals ? totals.totalReservations : allReservations.total,
    ...(summary ? { currentUsage: summary.occupiedSeats, maintenanceSeats: summary.maintenanceSeats, remainingSeats: summary.remainingSeats } : {}) };
}

module.exports = { DAY_MS, SCHEMA_VERSION, ACTIVE_STATUSES, chinaDate, validDate, dateTimestamp, weekStart,
  currentSlot, percent, fetchAll, seatSummary, dailyStats, userStats, checkAdmin, readDaily };
