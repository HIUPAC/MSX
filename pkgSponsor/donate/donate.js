// pages/donate/donate.js
// 赞助页面 - 切换支付方式 / 预览二维码
Page({
  data: {
    payType: 'alipay' // 'alipay' | 'wechat'
  },

  /**
   * 切换支付方式
   */
  switchPayType(e) {
    const { type } = e.currentTarget.dataset;
    if (type && type !== this.data.payType) {
      this.setData({ payType: type });
    }
  },

  /**
   * 预览二维码图片（支持长按识别 / 全屏查看）
   */
  previewImage(e) {
    const url = e.currentTarget.dataset.url || (
      this.data.payType === 'alipay'
        ? '/pkgSponsor/images/donate-alipay.jpg'
        : '/pkgSponsor/images/donate-wechat.jpg'
    );
    wx.previewImage({
      urls: [url],
      current: url
    });
  }
});
