const DateUtil = require('../../utils/date-util');
const CloudAPI = require('../../utils/cloud-api');
const RouteGuard = require('../../utils/route-guard');
const NavigationContext = require('../../utils/navigation-context');
const Statistics = require('../../utils/statistics');

const TOTAL_SEATS = 192;
const STATS_POLL_INTERVAL = 15000; // 实时座位统计轮询间隔(毫秒)
const FLOOR_CONFIG = [
  { floor: 1, areaName: '静音自习区', description: '安静阅读，专注学习', totalSeats: 64 },
  { floor: 2, areaName: '电子阅览区', description: '查阅资料，使用电脑', totalSeats: 64 },
  { floor: 3, areaName: '小组讨论区', description: '交流想法，一起学习', totalSeats: 64 }
];

function cloudCallWithTimeout(fn, timeout = 5000) {
  let timer;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('cloud_timeout')), timeout);
  });
  return Promise.race([Promise.resolve().then(fn), timeoutPromise])
    .finally(() => clearTimeout(timer));
}

function isCloudReady() {
  try {
    return Boolean(wx.cloud && wx.cloud.database && wx.cloud.database());
  } catch (error) {
    console.warn('[Home] 云能力不可用:', error);
    return false;
  }
}

function padTwo(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 首页 —— 匿名公共入口
 *
 * 隐私约定:本页面不展示任何学生个人信息(姓名、头像、收藏数量、
 * 禁预约状态等);预约/签到等操作入口在点击时才做登录校验。
 */
Page({
  data: {
    greetingText: '欢迎来学习',
    noticeTitle: '',
    todayReservations: 0,
    statsReady: false,
    statsError: '',
    statsUpdatedText: '--:--',
    statsSlotLabel: '—',
    totalSeats: TOTAL_SEATS,
    occupiedCount: 0,
    remainingSeats: TOTAL_SEATS,
    usageRate: 0,
    usageLevel: 'low',
    remainingPop: false,
    floors: FLOOR_CONFIG,
    loading: false
  },

  onLoad() {
    this._pageGone = false;
    this._statsTimer = null;
    this._pulseTimer = null;
    this._statsLoading = false;
  },

  onShow() {
    this._pageGone = false;
    this.setData({ greetingText: this.buildGreeting() });
    this.loadData();
    this.startStatsPolling();
    if (typeof this.getTabBar === 'function') {
      const tabBar = this.getTabBar();
      if (tabBar) tabBar.setData({ selected: 0 });
    }
  },

  onHide() {
    this.stopStatsPolling();
  },

  onUnload() {
    this._pageGone = true;
    this.stopStatsPolling();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  /** 时段问候语(不含任何用户信息) */
  buildGreeting() {
    const hour = new Date().getHours();
    if (hour < 6) return '夜深了，欢迎来学习';
    if (hour < 12) return '早上好，欢迎来学习';
    if (hour < 14) return '中午好，欢迎来学习';
    if (hour < 18) return '下午好，欢迎来学习';
    return '晚上好，欢迎来学习';
  },

  // ── 实时统计轮询 ──

  startStatsPolling() {
    this.stopStatsPolling();
    this._statsTimer = setInterval(() => {
      this.loadStats().catch(error => console.warn('[Home] 统计刷新失败:', error));
    }, STATS_POLL_INTERVAL);
  },

  stopStatsPolling() {
    if (this._statsTimer !== null && this._statsTimer !== undefined) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  },

  async loadData() {
    if (this._loading) return;
    this._loading = true;
    this.setData({ loading: true });
    try {
      const results = await Promise.allSettled([this.loadNotices(), this.loadStats()]);
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn('[Home] 页面数据加载失败:', index === 0 ? '公告' : '统计', result.reason);
        }
      });
    } finally {
      this._loading = false;
      if (!this._pageGone) this.setData({ loading: false });
    }
  },

  async loadNotices() {
    let noticeTitle = '请在预约时段开始后 15 分钟内完成签到';
    if (isCloudReady()) {
      try {
        const result = await cloudCallWithTimeout(() =>
          wx.cloud.database().collection('notices')
            .orderBy('priority', 'desc').orderBy('createdAt', 'desc').limit(1).get()
        );
        const notice = result && Array.isArray(result.data) && result.data[0];
        if (notice && typeof notice.title === 'string' && notice.title.trim()) {
          noticeTitle = notice.title.trim();
        }
      } catch (error) {
        console.warn('[Home] 公告加载失败，展示签到提醒:', error);
      }
    }
    if (!this._pageGone) this.setData({ noticeTitle });
  },

  /**
   * 实时座位统计:总座位数 / 剩余座位 / 使用率
   *
   * 数据来源:getSeatsState 云函数(不传 floor → 全馆聚合,所有用户看到一致数据)。
   *  - 新云函数:直接使用服务端 summary(计入维护座位);
   *  - 旧云函数:客户端用 seatReservationCount ∪ activeLocks 聚合(相同口径)。
   */
  async loadStats() {
    if (this._statsLoading) return;
    if (!isCloudReady()) { if (!this._pageGone) this.setData({ statsError: '暂时无法连接，请稍后重试' }); return; }
    this._statsLoading = true;
    try {
      const result = await cloudCallWithTimeout(() =>
        CloudAPI.getSeatsState({
          date: DateUtil.getToday(),
          timeSlot: DateUtil.getCurrentTimeSlot()
        }), 5000);

      if (!result || !result.success || !result.data) {
        throw new Error((result && result.message) || '座位统计不可用');
      }

      const data = result.data;
      const summary = data.summary || null;

      let occupiedCount;
      let remainingSeats;
      let usageRate;
      let totalSeats = this.data.totalSeats;

      if (summary && typeof summary.occupiedSeats === 'number' && typeof summary.remainingSeats === 'number') {
        // 服务端汇总(维护座位已剔除)
        occupiedCount = Statistics.integer(summary.occupiedSeats);
        remainingSeats = Statistics.integer(summary.remainingSeats);
        usageRate = Statistics.percentage(summary.usageRate);
        if (typeof summary.totalSeats === 'number' && summary.totalSeats >= 0) {
          totalSeats = Statistics.integer(summary.totalSeats);
        }
      } else {
        // 客户端聚合:活跃预约 ∪ 预选锁 = 不可用座位
        const occupiedSet = {};
        const counts = data.seatReservationCount || {};
        const locks = data.activeLocks || {};
        Object.keys(counts).forEach(id => { occupiedSet[id] = true; });
        Object.keys(locks).forEach(id => { occupiedSet[id] = true; });
        occupiedCount = Object.keys(occupiedSet).length;
        remainingSeats = Math.max(0, TOTAL_SEATS - occupiedCount);
        usageRate = TOTAL_SEATS > 0 ? Math.round((occupiedCount / TOTAL_SEATS) * 100) : 0;
      }

      const now = new Date();
      const updatedText = `${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(now.getSeconds())}`;
      const todayReservations = typeof data.todayReservations === 'number'
        ? data.todayReservations
        : this.data.todayReservations;
      const prevRemaining = this.data.remainingSeats;

      if (this._pageGone) return;

      this.setData({
        totalSeats,
        todayReservations,
        occupiedCount,
        remainingSeats,
        usageRate,
        usageLevel: this.usageLevelOf(usageRate),
        statsSlotLabel: DateUtil.getCurrentTimeSlotLabel(),
        statsUpdatedText: updatedText,
        statsReady: true,
        statsError: ''
      });

      // 剩余座位变化时触发一次数字"弹跳"动画
      if (remainingSeats !== prevRemaining) this.pulseRemaining();
    } catch (error) {
      console.warn('[Home] 座位统计加载失败:', error);
      if (!this._pageGone) this.setData({ statsError: this.data.statsReady ? '更新失败，保留上次数据' : '统计加载失败，点击重试' });
    } finally {
      this._statsLoading = false;
    }
  },

  usageLevelOf(rate) {
    if (rate >= 85) return 'high';
    if (rate >= 60) return 'mid';
    return 'low';
  },

  pulseRemaining() {
    if (this._pulseTimer) clearTimeout(this._pulseTimer);
    this.setData({ remainingPop: true });
    this._pulseTimer = setTimeout(() => {
      if (!this._pageGone) this.setData({ remainingPop: false });
      this._pulseTimer = null;
    }, 420);
  },

  goReserve() {
    if (!RouteGuard.checkReservationAllowed()) return;
    wx.switchTab({
      url: '/pages/reserve/reserve',
      fail: error => {
        console.warn('[Home] 选座页跳转失败:', error);
        wx.showToast({ title: '暂时无法打开选座页', icon: 'none' });
      }
    });
  },

  onQuickAction(event) {
    if (!RouteGuard.requireLogin('请先登录')) return;
    const key = event.currentTarget.dataset.key;
    const paths = {
      checkin: '/pkgUser/checkin/checkin',
      fav: '/pkgUser/favorites/favorites'
    };
    if (!paths[key]) return;
    wx.navigateTo({
      url: paths[key],
      fail: error => {
        console.warn('[Home] 快捷入口打开失败:', error);
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      }
    });
  },

  onFloorTap(event) {
    if (!RouteGuard.requireLogin('请先登录')) return;
    const floor = Number(event.currentTarget.dataset.floor);
    if (!NavigationContext.setReserveTarget({ floor })) return;
    wx.switchTab({
      url: '/pages/reserve/reserve',
      fail: error => {
        NavigationContext.consumeReserveTarget();
        console.warn('[Home] 楼层跳转失败:', error);
        wx.showToast({ title: '暂时无法打开该楼层', icon: 'none' });
      }
    });
  }
});
