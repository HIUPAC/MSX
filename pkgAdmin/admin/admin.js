// pkgAdmin/admin/admin.js
// 管理员后台（文档 5.2 节）
// 集成：座位管理 / 违规处理 / 申诉审核 / 公告管理 / 数据统计
const RouteGuard = require('../../utils/route-guard');
const CloudAPI = require('../../utils/cloud-api');
const Auth = require('../../utils/auth');
const Numbers = require('../../utils/statistics');
const { VIOLATION_TYPE_LABEL } = require('../../utils/constants');

Page({
  data: {
    tabs: ['座位管理', '违规处理', '申诉审核', '公告管理', '统计'],
    adminTabItems: [
      { label: '座位管理', value: 0 },
      { label: '违规处理', value: 1 },
      { label: '申诉审核', value: 2 },
      { label: '公告管理', value: 3 },
      { label: '统计', value: 4 }
    ],
    activeTab: 0,
    seats: [],
    violations: [],
    appeals: [],
    notices: [],
    stats: { usageRate: 0, checkinRate: 0, violationRate: 0 },
    latestStat: null,
    statsReady: false, statsError: '', statsRefreshing: false, aggregating: false, updatingSeat: '', dataError: '',
    loading: false,

    // 违规过滤
    violationFilters: [
      { value: 'all', label: '全部' },
      { value: 'pending', label: '未处理' },
      { value: 'appealed', label: '申诉中' }
    ],
    currentViolationFilter: 'all',
    filteredViolations: []
  },

  onLoad() {
    this._authorized = RouteGuard.checkAdmin();
    if (!this._authorized) {
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
  },

  async onShow() {
    if (!this._authorized || !RouteGuard.checkAdmin()) return;
    await this.loadData();
  },

  async loadData() {
    if (!this._authorized || this.data.loading) return;
    this.setData({ loading: true, dataError: '' });
    try {
      await Promise.all([
        this.loadSeats(),
        this.loadViolations(),
        this.loadAppeals(),
        this.loadNotices(),
        this.loadQuickStats(),
        this.loadLatestStat()
      ]);
    } catch (e) {
      console.warn('[Admin] 加载数据失败:', e);
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadSeats() {
    try {
      if (wx.cloud) {
        const res = await wx.cloud.database().collection('seats')
          .limit(50).get();
        const seats = (res.data || []).map(s => ({
          _id: s._id,
          areaName: s.areaName || s.area || '默认区域',
          tableNo: s.tableNo || s.tableNumber || '-',
          seatNo: s.seatNo || s.seatNumber || '-',
          status: s.seatStatus || s.status || 'free',
          seatNumber: s.seatNumber || s.seatNo
        }));
        this.setData({ seats });
        return;
      }
    } catch (e) {
      console.warn('[Admin] 加载座位失败:', e);
    }
    this.setData({ dataError: '座位加载失败，请稍后刷新' });
  },

  async loadViolations() {
    try {
      if (wx.cloud) {
        const res = await wx.cloud.database().collection('violations')
          .orderBy('createdAt', 'desc')
          .limit(50).get();

        const violations = (res.data || []).map(v => ({
          ...v,
          typeLabel: VIOLATION_TYPE_LABEL[v.violationType] || '其他',
          appealStatus: v.isAppealed || 0
        }));
        this.setData({ violations });
        this._applyViolationFilter();
        return;
      }
    } catch (e) {
      console.warn('[Admin] 加载违规记录失败:', e);
    }
    this.setData({ dataError: '违规记录加载失败，请稍后刷新' });
  },

  /**
   * 加载待处理申诉列表
   */
  async loadAppeals() {
    try {
      if (wx.cloud) {
        const result = await CloudAPI.getAppealList();
        if (result && result.success) {
          const appeals = (result.data?.list || []).map(a => ({
            ...a,
            typeLabel: VIOLATION_TYPE_LABEL[a.violationType] || '违规'
          }));
          this.setData({ appeals });
          return;
        }
      }
    } catch (e) {
      console.warn('[Admin] 加载申诉列表失败:', e);
    }
    this.setData({ appeals: [] });
  },

  async loadNotices() {
    try {
      if (wx.cloud) {
        const res = await wx.cloud.database().collection('notices')
          .orderBy('createdAt', 'desc')
          .limit(20).get();
        this.setData({ notices: res.data || [] });
        return;
      }
    } catch (e) {
      console.warn('[Admin] 加载公告失败:', e);
    }
    this.setData({ dataError: '公告加载失败，请稍后刷新' });
  },

  async loadQuickStats() {
    try {
      if (wx.cloud) {
        const result = await CloudAPI.getStatistics();
        if (result && result.success && result.data) {
          const overview = Numbers.normalizeOverview(result.data.overview || result.data);
          this.setData({
            stats: overview, statsReady: true, statsError: ''
          });
          return true;
        }
      }
    } catch (error) { console.warn('[Admin] 加载统计失败:', error); }
    this.setData({ statsError: '统计更新失败，请稍后重试' });
    return false;
  },

  /**
   * 加载最新聚合数据（statistics 集合）
   */
  async loadLatestStat() {
    try {
      if (wx.cloud) {
        const result = await CloudAPI.aggregateStats({ action: 'query', days: 1 });
        if (result && result.success) {
          const row = result.data?.list?.[0] || null;
          this.setData({ latestStat: row ? { ...row, usageRate: Numbers.percentage(row.usageRate) } : null });
          return true;
        }
      }
    } catch (e) {
      console.warn('[Admin] 加载聚合数据失败:', e);
    }
    return false;
  },

  onTabChange(e) {
    this.setData({ activeTab: e.detail.value });
  },

  /**
   * 违规过滤切换
   */
  onViolationFilterChange(e) {
    const { value } = e.currentTarget.dataset;
    this.setData({ currentViolationFilter: value }, () => this._applyViolationFilter());
  },

  _applyViolationFilter() {
    const { violations, currentViolationFilter } = this.data;
    let filtered = violations;
    if (currentViolationFilter === 'pending') {
      filtered = violations.filter(v => !v.isAppealed || v.isAppealed === 0);
    } else if (currentViolationFilter === 'appealed') {
      filtered = violations.filter(v => v.isAppealed === 1);
    }
    this.setData({ filteredViolations: filtered });
  },

  /**
   * 格式化时间戳
   */
  formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  async toggleSeat(e) {
    if (this.data.updatingSeat || !this._authorized) return;
    const { id } = e.currentTarget.dataset;
    const seat = this.data.seats.find(item => item._id === id);
    if (!seat) return;
    const status = e.detail.value ? 'free' : 'disabled';
    this.setData({ updatingSeat: id });
    try {
      const result = await CloudAPI.manageSeat({ seatId: id, status });
      if (!result?.success) throw new Error(result?.message || '同步失败');
      this.setData({ seats: this.data.seats.map(item => item._id === id ? { ...item, status } : item) });
      await this.loadQuickStats();
      wx.showToast({ title: '操作成功', icon: 'success' });
    } catch (error) {
      console.warn('[Admin] 同步座位状态失败:', error);
      wx.showToast({ title: '同步失败，请重试', icon: 'none' });
    } finally { this.setData({ updatingSeat: '' }); }
  },

  async handleViolation(e) {
    const { id } = e.currentTarget.dataset;
    const res = await new Promise(r => wx.showActionSheet({
      itemList: ['确认违规记录', '撤销违规', '调整扣分'],
      success: r, fail: () => r({ tapIndex: -1 })
    }));
    if (res.tapIndex < 0) return;

    try {
      const result = await CloudAPI.handleViolation({ violationId: id, action: res.tapIndex });
      if (!result?.success) throw new Error(result?.message || '处理失败');
      wx.showToast({ title: '处理完成', icon: 'success' });
      this.loadData();
    } catch (e) {
      wx.showToast({ title: '处理失败', icon: 'none' });
    }
  },

  /**
   * 申诉审核处理
   */
  async onHandleAppeal(e) {
    const { id, approved, reply } = e.currentTarget.dataset;
    let replyText = '';

    if (reply) {
      // 单独回复
      const modal = await new Promise(r => wx.showModal({
        title: '回复申诉',
        editable: true,
        placeholderText: '请输入回复内容',
        success: r, fail: () => r({ confirm: false })
      }));
      if (!modal.confirm) return;
      replyText = modal.content || '';
      try {
        const result = await CloudAPI.handleAppeal(id, false, replyText);
        if (!result?.success) throw new Error(result?.message || '回复失败');
        wx.showToast({ title: '已回复', icon: 'success' });
        this.loadAppeals();
      } catch (e) {
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
      return;
    }

    // 通过 / 驳回
    const actionText = approved ? '通过' : '驳回';
    const confirm = await new Promise(r => wx.showModal({
      title: `${actionText}申诉`,
      content: `确定要${actionText}这条申诉吗？${approved ? '通过后将恢复用户积分。' : ''}`,
      success: r, fail: () => r({ confirm: false })
    }));
    if (!confirm.confirm) return;

    try {
      if (wx.cloud) {
        const result = await CloudAPI.handleAppeal(id, approved, replyText);
        if (result && result.success) {
          wx.showToast({ title: `${actionText}成功`, icon: 'success' });
          this.loadAppeals();
          this.loadViolations();
        } else {
          wx.showToast({ title: result?.message || '操作失败', icon: 'none' });
        }
      }
    } catch (e) {
      console.error('[Admin] 申诉处理失败:', e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  /**
   * 刷新统计
   */
  async onRefreshStats() {
    if (this.data.statsRefreshing || this.data.aggregating) return;
    this.setData({ statsRefreshing: true });
    try {
      const results = await Promise.all([this.loadQuickStats(), this.loadLatestStat()]);
      wx.showToast({ title: results.every(Boolean) ? '已刷新' : '部分数据更新失败', icon: results.every(Boolean) ? 'success' : 'none' });
    } finally { this.setData({ statsRefreshing: false }); }
  },

  /**
   * 手动触发聚合（statistics 集合）
   */
  async onTriggerAggregate() {
    if (this.data.aggregating || this.data.statsRefreshing) return;
    this.setData({ aggregating: true });
    wx.showLoading({ title: '聚合中...', mask: true });
    try {
      const result = await CloudAPI.aggregateStats({ action: 'aggregate' });
      if (result && result.success) {
        const results = await Promise.all([this.loadQuickStats(), this.loadLatestStat()]);
        wx.showToast({ title: results.every(Boolean) ? '计算同步完成' : '计算完成，请刷新', icon: results.every(Boolean) ? 'success' : 'none' });
      } else {
        wx.showToast({ title: result?.message || '聚合失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '聚合失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ aggregating: false });
    }
  },

  publishNotice() {
    wx.showModal({
      title: '发布公告',
      editable: true,
      placeholderText: '请输入公告内容',
      success: async (res) => {
        if (res.confirm && res.content) {
          try {
            const result = await CloudAPI.manageNotice({ action: 'create', content: res.content });
            if (!result?.success) throw new Error(result?.message || '发布失败');
            wx.showToast({ title: '发布成功', icon: 'success' });
            this.loadData();
          } catch (e) {
            wx.showToast({ title: '发布失败', icon: 'none' });
          }
        }
      }
    });
  },

  goSeats() {
    // 跳转到高级座位管理页面（分包）
    wx.navigateTo({ url: '/pkgAdmin/seats/seats' });
  },

  goStats() {
    // 跳转到详细统计页面（分包）
    wx.navigateTo({ url: '/pkgAdmin/stats/stats' });
  },

  /**
   * 危险操作：清空全部数据（带二次确认）
   */
  async onClearAllUsers() {
    if (!RouteGuard.checkAdmin()) {
      wx.showToast({ title: '无权限', icon: 'none' });
      return;
    }

    const res1 = await new Promise(r => wx.showModal({
      title: '⚠️ 危险操作：清空所有数据',
      content: '此操作将清空以下集合中的所有文档，且不可恢复：\n📁 users（用户）\n📁 seats（座位）\n📁 seat_locks（预选锁）\n📁 reservations（预约）\n📁 violations（违规）\n📁 checkin_records（签到）\n📁 notices（公告）\n📁 statistics（聚合统计）\n\n确认要继续吗？',
      confirmText: '继续',
      cancelText: '取消',
      confirmColor: '#D54941',
      success: r
    }));
    if (!res1.confirm) return;

    const res2 = await new Promise(r => wx.showModal({
      title: '请输入确认码',
      editable: true,
      placeholderText: '请输入"清空全部"',
      confirmText: '确认清空',
      cancelText: '取消',
      confirmColor: '#D54941',
      success: r
    }));
    if (!res2.confirm) return;
    if ((res2.content || '').trim() !== '清空全部') {
      wx.showToast({ title: '确认码错误，操作已取消', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在清空全部数据...', mask: true });
    let cloudResult = null;

    try {
      if (wx.cloud) {
        cloudResult = await wx.cloud.callFunction({
          name: 'clearUsers',
          data: { confirm: 'CLEAR_ALL_DATA' }
        });
      }
    } catch (e) {
      console.error('[Admin] 清空数据失败:', e);
    }

    Auth.clearAllLocalUsers();
    this._clearAllLocalCache();

    wx.hideLoading();

    if (cloudResult && cloudResult.result && cloudResult.result.success) {
      const details = cloudResult.result.details || {};
      const totalDeleted = cloudResult.result.totalDeleted || 0;
      const totalErrors = cloudResult.result.totalErrors || 0;

      let detailText = '';
      for (const [name, r] of Object.entries(details)) {
        detailText += `• ${name}: ${r.deleted || 0} 条\n`;
      }

      wx.showModal({
        title: '清空完成',
        content: `共清空 ${totalDeleted} 条记录${totalErrors > 0 ? `，失败 ${totalErrors} 条` : ''}\n\n详情：\n${detailText}\n本地缓存已同步清除。`,
        showCancel: false,
        confirmText: '知道了'
      });
    } else if (cloudResult && cloudResult.result) {
      wx.showModal({
        title: '清空失败',
        content: `原因：${cloudResult.result.message || '未知错误'}\n本地缓存已清除。`,
        showCancel: false,
        confirmText: '知道了'
      });
    } else {
      wx.showModal({
        title: '清空失败',
        content: '云函数调用失败，请检查网络或确认 clearUsers 云函数已部署。\n本地缓存已清除。',
        showCancel: false,
        confirmText: '知道了'
      });
    }

    this.loadData();
  },

  _clearAllLocalCache() {
    try {
      const AppState = require('../../utils/app-state');
      AppState.clearAll();

      wx.removeStorageSync('local_reservations');
      wx.removeStorageSync('current_reservation');
      wx.removeStorageSync('my_reserved_seats');
      wx.removeStorageSync('favorite_seats');
      wx.removeStorageSync('reservation_stats');

      const CacheManager = require('../../utils/cache-manager');
      CacheManager.clearAll();

      AppState.init();
    } catch (e) {
      console.warn('[Admin] 本地缓存清除失败:', e);
    }
  }
});
