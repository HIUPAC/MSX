// pages/demo-reserve/demo-reserve.js
// 文章方案复刻版 Demo 页
//
// 核心:
//  1. 数据通过 wx.cloud.database().collection('seat_demo').get() 读取
//     (article 中 read:true 允许前端读)
//  2. 所有写操作(write)走云函数 reserveSeat-demo / cancelSeat-demo
//  3. 3 秒轮询刷新,实现"多用户实时同步"
//
const POLL_INTERVAL = 3000;

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => (n < 10 ? '0' + n : '' + n);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function maskOpenid(openid) {
  if (!openid || openid.length < 8) return '****';
  return openid.slice(0, 4) + '****' + openid.slice(-4);
}

Page({
  data: {
    seatList: [],
    loading: false,
    myOpenid: '',
    lastSyncAt: 0,
    lastSyncText: '--'
  },

  _pollTimer: null,
  _polling: false,

  async onLoad() {
    // 主动调用云函数拿到当前 openid,用于"我已预约"判断
    try {
      if (wx.cloud && wx.cloud.callFunction) {
        const r = await wx.cloud.callFunction({ name: 'getOpenid-demo' });
        const openid = r && r.result && r.result.data && r.result.data.openid;
        if (openid) {
          this.setData({ myOpenid: openid });
          try { wx.setStorageSync('demo_my_openid', openid); } catch (e) { console.warn("[demo-reserve.onLoad] 操作失败:", e); }
        }
      }
    } catch (e) {
      // 兜底: 读本地缓存
      let cached = '';
      try { cached = wx.getStorageSync('demo_my_openid') || ''; } catch (e2) { console.warn("[demo-reserve.onLoad] 操作失败:", e2); }
      if (cached) this.setData({ myOpenid: cached });
    }
  },

  onShow() {
    this.refresh();
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  // ── 轮询 ──
  startPolling() {
    this.stopPolling();
    if (this._polling) return;
    this._polling = true;
    this._pollTimer = setInterval(() => {
      this.refresh().catch(() => {});
    }, POLL_INTERVAL);
  },

  stopPolling() {
    this._polling = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  // ── 读取座位列表 ──
  async refresh() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      if (!wx.cloud) {
        wx.showToast({ title: '云能力不可用', icon: 'none' });
        return;
      }

      const db = wx.cloud.database();
      const res = await db.collection('seat_demo')
        .orderBy('order', 'asc')
        .get();

      const myOpenid = this.data.myOpenid || this._getOpenid();
      const list = (res.data || []).map(item => ({
        ...item,
        isMine: item.status === 1 && item.userId === myOpenid,
        maskedOwner: maskOpenid(item.userId),
        reserveTimeText: formatTime(item.reserveTime)
      }));

      this.setData({
        seatList: list,
        loading: false,
        myOpenid,
        lastSyncAt: Date.now(),
        lastSyncText: formatTime(Date.now())
      });
    } catch (err) {
      console.error('[demo-reserve] refresh error:', err);
      this.setData({ loading: false });
      // 集合不存在时,引导用户去创建
      if (err.errCode === -501001 || /collection not exists/i.test(err.errMsg || '')) {
        wx.showToast({ title: '请先创建 seat_demo 集合', icon: 'none', duration: 2500 });
      }
    }
  },

  // ── 预约 ──
  async reserveTap(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id) return;

    wx.showLoading({ title: '预约中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'reserveSeat-demo',
        data: { seatId: id }
      });
      wx.hideLoading();

      const result = res && res.result;
      if (result && result.success) {
        wx.showToast({ title: `${name} 预约成功`, icon: 'success' });
      } else {
        wx.showToast({
          title: (result && result.msg) || '预约失败',
          icon: 'none',
          duration: 2000
        });
      }
      this.refresh();
    } catch (err) {
      wx.hideLoading();
      console.error('[demo-reserve] reserve error:', err);
      wx.showToast({ title: '网络异常', icon: 'none' });
    }
  },

  // ── 取消 ──
  async cancelTap(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id) return;

    wx.showLoading({ title: '取消中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'cancelSeat-demo',
        data: { seatId: id }
      });
      wx.hideLoading();

      const result = res && res.result;
      if (result && result.success) {
        wx.showToast({ title: `${name} 已取消`, icon: 'success' });
      } else {
        wx.showToast({
          title: (result && result.msg) || '取消失败',
          icon: 'none',
          duration: 2000
        });
      }
      this.refresh();
    } catch (err) {
      wx.hideLoading();
      console.error('[demo-reserve] cancel error:', err);
      wx.showToast({ title: '网络异常', icon: 'none' });
    }
  },

  // ── 工具方法 ──
  _getOpenid() {
    // 兜底: 从本地缓存读(每次 onLoad 拉取后会被持久化)
    let openid = '';
    try { openid = wx.getStorageSync('demo_my_openid') || ''; } catch (e) { console.warn("[demo-reserve._getOpenid] 操作失败:", e); }
    return openid || this.data.myOpenid || '';
  }
});
