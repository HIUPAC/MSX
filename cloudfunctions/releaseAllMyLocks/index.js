/**
 * 云函数 - releaseAllMyLocks
 *
 * 释放当前用户的所有未过期座位预选锁（用于切换楼层/退出小程序）。
 *
 * 入参：
 *   userId: string
 *
 * 返回：
 *   { success: true, data: { released: number } }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { userId } = event;
  if (!userId) {
    return { success: false, code: 'NO_PARAMS', message: '缺少 userId' };
  }

  try {
    const now = Date.now();
    const res = await db.collection('seat_locks').where({
      userId,
      expireTime: _.gt(now)
    }).get();

    let released = 0;
    for (const lock of res.data || []) {
      try {
        await db.collection('seat_locks').doc(lock._id).remove();
        released++;
      } catch (e) { console.warn("[index.operation] 操作失败:", e); }
    }

    return { success: true, data: { released } };
  } catch (err) {
    console.error('[releaseAllMyLocks] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', message: '释放失败' };
  }
};
