/**
 * 获取当前用户 openid
 *
 * Demo 用途: 前端无法直接读 openid,让云函数代为查询并返回。
 * 生产环境要做登录态校验,这里是简化版。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const appid = wxContext.APPID || '';
  const unionid = wxContext.UNIONID || '';
  return { success: true, data: { openid, appid, unionid } };
};
