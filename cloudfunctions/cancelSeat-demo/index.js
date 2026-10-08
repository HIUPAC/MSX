/**
 * 取消预约云函数（文章复刻版）
 *
 * 核心: 仅 userId === openid 的座位可被释放,防止误操作他人座位。
 *
 * 入参: { seatId: string }
 * 返回: { success, msg }
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { seatId } = event || {};

  if (!seatId) {
    return { success: false, code: 'INVALID_PARAMS', msg: '缺少 seatId' };
  }

  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) {
    return { success: false, code: 'LOGIN_REQUIRED', msg: '请先登录' };
  }

  try {
    // 原子更新: 仅当前用户持有的座位可取消
    const res = await db.collection('seat_demo')
      .doc(seatId)
      .where({ userId: openid })
      .update({
        data: {
          status: 0,
          userId: '',
          reserveTime: null
        }
      });

    if (res.stats && res.stats.updated > 0) {
      return { success: true, msg: '取消成功' };
    }

    return { success: false, code: 'NOT_OWNER', msg: '无法取消,不是你的座位' };
  } catch (err) {
    console.error('[cancelSeat-demo] error:', err);
    return { success: false, code: 'SYSTEM_ERROR', msg: '取消失败,请重试' };
  }
};
