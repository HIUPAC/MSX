/**
 * 云函数 - clearUsers
 *
 * ⚠️ 危险操作：清空数据库所有用户信息和座位状态
 * 仅管理员可调用，需传入确认码 + admin 角色校验
 *
 * 调用方式：
 *   wx.cloud.callFunction({
 *     name: 'clearUsers',
 *     data: { confirm: 'CLEAR_ALL_DATA' }
 *   })
 *
 * 清空范围：
 *   1. users         — 删除全部用户资料
 *   2. seats         — 删除全部座位数据
 *   3. seat_locks    — 删除全部预选锁
 *   4. reservations  — 删除全部预约记录
 *   5. violations    — 删除全部违规记录
 *   6. checkin_records — 删除全部签到记录
 *   7. notices       — 删除全部公告（可选）
 *   8. statistics    — 删除全部聚合统计数据
 *   9. error_logs    — 删除全部错误日志
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ─── 工具函数：分批删除集合中的所有文档 ───
async function clearCollection(collectionName, batchSize = 100) {
  const collection = db.collection(collectionName);
  let deleted = 0;
  let errors = 0;

  try {
    const countRes = await collection.count();
    const total = countRes.total || 0;
    if (total === 0) return { deleted: 0, errors: 0, total: 0 };

    // 分批拉取 + 并发删除
    while (true) {
      const batch = await collection.limit(batchSize).get();
      if (!batch.data || batch.data.length === 0) break;

      const results = await Promise.allSettled(
        batch.data.map(doc =>
          collection.doc(doc._id).remove()
        )
      );

      results.forEach(r => {
        if (r.status === 'fulfilled') deleted++;
        else errors++;
      });

      if (batch.data.length < batchSize) break;
    }

    return { deleted, errors, total };
  } catch (err) {
    return { deleted, errors, total: 0, fatalError: err.message };
  }
}

exports.main = async (event, context) => {
  const now = Date.now();

  // ─── 1. 二次验证：必须传入确认码 ───
  const { confirm } = event;
  if (confirm !== 'CLEAR_ALL_DATA') {
    return {
      success: false,
      code: 'CONFIRM_REQUIRED',
      message: '需要 confirm=CLEAR_ALL_DATA 才能执行此操作'
    };
  }

  // ─── 2. 校验调用方 openid（仅 admin 角色可执行）───
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) {
    return { success: false, code: 'NO_OPENID', message: '无法识别调用方' };
  }

  try {
    const callerRes = await db.collection('users').where({ openid }).get();
    const caller = callerRes.data[0];
    if (!caller || caller.role !== 'admin') {
      return {
        success: false,
        code: 'FORBIDDEN',
        message: '权限不足：仅管理员可执行清空操作'
      };
    }
  } catch (err) {
    return { success: false, code: 'AUTH_QUERY_FAIL', message: '权限校验失败' };
  }

  console.log(`[clearUsers] 管理员 ${openid} 请求清空全部数据 — ${new Date(now).toISOString()}`);

  // ─── 3. 清空所有集合 ───
  const collectionsToClear = [
    'seat_locks',      // 预选锁
    'reservations',    // 预约记录
    'violations',      // 违规记录
    'checkin_records', // 签到记录
    'notices',         // 公告
    'statistics',      // 聚合统计数据
    'error_logs',      // 错误日志
    'seats',           // 座位（最后清空，因为 seats 是基础数据）
    'users'            // 用户（最后清空）
  ];

  const results = {};
  let totalDeleted = 0;
  let totalErrors = 0;

  for (const name of collectionsToClear) {
    console.log(`[clearUsers] 正在清空 ${name}...`);
    const result = await clearCollection(name, 100);
    results[name] = result;
    totalDeleted += result.deleted;
    totalErrors += result.errors;
    console.log(`[clearUsers] ${name}: 删除 ${result.deleted} 条, 失败 ${result.errors}, 原有 ${result.total}`);
  }

  // ─── 4. 汇总返回 ───
  console.log(`[clearUsers] 清空完成: 总计删除 ${totalDeleted} 条, 失败 ${totalErrors}`);
  console.log(`[clearUsers] 详情: ${JSON.stringify(results)}`);

  return {
    success: true,
    timestamp: now,
    totalDeleted,
    totalErrors,
    details: results,
    message: `已清空全部数据：共删除 ${totalDeleted} 条记录`
  };
};
