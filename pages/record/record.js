const CloudAPI = require('../../utils/cloud-api');
const Auth = require('../../utils/auth');
const AppState = require('../../utils/app-state');
const ReservationStats = require('../../utils/reservation-stats');
const DateUtil = require('../../utils/date-util');
const { CHECKIN_TIMEOUT, VIOLATION_TYPE_LABEL, TIME_SLOT_LIST, RESERVATION_STATUS_CODE } = require('../../utils/constants');
const NavigationContext = require('../../utils/navigation-context');

const CACHE_TTL = 30000;
const APPEAL_MIN_LEN = 10;

function readStorage(key, fallback) {
  try {
    return wx.getStorageSync(key) || fallback;
  } catch (error) {
    console.warn('[Record] 读取本地数据失败:', key, error);
    return fallback;
  }
}

function getOwnerId() {
  const user = AppState.getUserInfo() || {};
  return user._id || user.openid || '';
}

Page({
  data: {
    activeTab: 'current',
    tabs: [{ label: '当前预约', value: 'current' }, { label: '历史', value: 'history' }, { label: '违规', value: 'violation' }],
    currentList: [], historyList: [], violationList: [],
    loading: true, refreshing: false, needLogin: false,
    loadError: '', offlineNotice: '',
    showAppealDialog: false, appealingViolationId: '', appealReason: '',
    submittingAppeal: false, submittingCancelId: ''
  },

  onShow() {
    this._viewActive = true;
    if (typeof this.getTabBar === 'function') {
      const tabBar = this.getTabBar();
      if (tabBar && typeof tabBar.setData === 'function') tabBar.setData({ selected: 2 });
    }
    const tab = NavigationContext.consumeRecordTab();
    if (tab) this.setData({ activeTab: tab });
    this.loadData();
  },

  onHide() {
    this._viewActive = false;
    this._loadRequest = (this._loadRequest || 0) + 1;
    this._stopCountdown();
  },

  onUnload() {
    this.onHide();
    this._disposed = true;
  },

  async onPullDownRefresh() {
    this.setData({ refreshing: true });
    try {
      await this.loadData(true);
    } finally {
      wx.stopPullDownRefresh();
      if (!this._disposed) this.setData({ refreshing: false });
    }
  },

  async loadData(forceRefresh = false) {
    const request = this._loadRequest = (this._loadRequest || 0) + 1;
    this._stopCountdown();
    if (!Auth.isLoggedIn()) {
      this.setData({ needLogin: true, loading: false, currentList: [], historyList: [], violationList: [], loadError: '', offlineNotice: '' });
      return;
    }
    const ownerId = getOwnerId();
    this.setData({ loading: true, needLogin: false, loadError: '', offlineNotice: '' });
    const now = Date.now();
    const cache = readStorage('record_cloud_cache', null);
    const cacheValid = cache && cache.ownerId === ownerId && Number.isFinite(cache.timestamp) && now - cache.timestamp >= 0 && now - cache.timestamp < CACHE_TTL;
    let result;
    let offlineNotice = '';
    let loadError = '';
    try {
      if (cacheValid && !forceRefresh) {
        result = { current: cache.currentList, history: cache.historyList, violations: cache.violationList };
      } else {
        result = await CloudAPI.getMyReservations();
        if (!result || result.success === false) throw new Error((result && result.message) || '记录加载失败');
        if (result.source === 'local') {
          offlineNotice = '暂未连接云端，以下为本机保存的记录';
          if (result.readError && !(result.current && result.current.length) && !(result.history && result.history.length)) loadError = '暂时无法加载记录，请检查网络后重试';
        } else {
          try {
            wx.setStorageSync('record_cloud_cache', {
              timestamp: Date.now(), ownerId,
              currentList: result.current || [], historyList: result.history || [], violationList: result.violations || []
            });
          } catch (error) {
            console.warn('[Record] 保存记录缓存失败:', error);
          }
        }
      }
    } catch (error) {
      console.warn('[Record] 加载预约记录失败:', error);
      const stored = readStorage('local_reservations', []);
      const user = AppState.getUserInfo() || {};
      const ownerIds = [user._id, user.openid].filter(Boolean);
      const local = Array.isArray(stored) ? stored.filter(item => item && ownerIds.includes(item.userId)) : [];
      result = {
        current: local.filter(item => ['pending', 'checked_in'].includes(item.status)),
        history: local.filter(item => ['completed', 'cancelled', 'violation'].includes(item.status)), violations: []
      };
      if (local.length) offlineNotice = '云端暂不可用，以下为本机保存的记录';
      else loadError = '暂时无法加载记录，请检查网络后重试';
    }
    if (request !== this._loadRequest || this._disposed || this._viewActive === false || ownerId !== getOwnerId()) return;
    const rawCurrent = Array.isArray(result.current) ? result.current : (result.current ? [result.current] : []);
    const currentList = rawCurrent.filter(Boolean).map(item => this.enrichRecord(item));
    const historyList = (Array.isArray(result.history) ? result.history : []).filter(Boolean).map(item => this.enrichRecord(item));
    const violationList = (Array.isArray(result.violations) ? result.violations : []).filter(Boolean).map(item => this.enrichViolation(item));
    this.setData({ currentList, historyList, violationList, loading: false, offlineNotice, loadError }, () => this._startCountdown());
    if (result.source !== 'local') ReservationStats.refresh();
  },

  retryLoad() {
    this.loadData(true);
  },

  enrichRecord(record) {
    const status = RESERVATION_STATUS_CODE[record.status] || record.status;
    const slot = TIME_SLOT_LIST.find(item => item.key === record.timeSlot) || {};
    const startTime = record.startTime || slot.start || '';
    const endTime = record.endTime || slot.end || '';
    const match = /^f(\d+)_r(\d+)_c(\d+)$/.exec(record.seatId || '');
    const groupNo = record.groupNo || (match ? Math.floor((Number(match[2]) - 1) / 2) * 4 + Math.floor((Number(match[3]) - 1) / 2) + 1 : 0);
    const seatLabel = record.seatLabel || (match ? ['A', 'B', 'C', 'D'][((Number(match[2]) - 1) % 2) * 2 + (Number(match[3]) - 1) % 2] : '');
    const seatTitle = groupNo && seatLabel ? `第 ${groupNo} 组 · ${seatLabel} 座` : (String(record.tableNo || '').includes('座') ? record.tableNo : `${record.tableNo || '--'} 桌 · ${record.seatNo || '--'} 号座`);
    let deadline = Number(record.checkinDeadline) || 0;
    if (status === 'pending' && !deadline && record.date && startTime) {
      const startMs = DateUtil.parseDateTime(record.date, startTime).getTime();
      if (Number.isFinite(startMs)) deadline = startMs + CHECKIN_TIMEOUT;
    }
    const countdownRemain = status === 'pending' && deadline ? Math.max(0, deadline - Date.now()) : 0;
    return {
      ...record, status, startTime, endTime, seatTitle,
      locationLabel: record.areaName || (match ? `${match[1]}F · 图书馆` : '图书馆'),
      timeLabel: startTime && endTime ? `${startTime}–${endTime}` : '时段待确认',
      statusLabel: { pending: '待签到', checked_in: '使用中', completed: '已完成', cancelled: '已取消', violation: '已失效' }[status] || '状态待确认',
      statusTheme: { pending: 'warning', checked_in: 'success', completed: 'success', cancelled: 'default', violation: 'danger' }[status] || 'default',
      checkinDeadline: deadline, countdownRemain, countdownText: DateUtil.formatCountdown(countdownRemain)
    };
  },

  _startCountdown() {
    this._stopCountdown();
    if (this._viewActive === false || !this.data.currentList.some(item => item.status === 'pending' && item.countdownRemain > 0)) return;
    this._countdownTimer = setInterval(() => {
      const updates = {};
      let running = false;
      this.data.currentList.forEach((item, index) => {
        if (item.status !== 'pending' || !item.checkinDeadline) return;
        const remain = Math.max(0, item.checkinDeadline - Date.now());
        if (remain > 0) running = true;
        updates[`currentList[${index}].countdownRemain`] = remain;
        updates[`currentList[${index}].countdownText`] = DateUtil.formatCountdown(remain);
      });
      if (Object.keys(updates).length) this.setData(updates);
      if (!running) this._stopCountdown();
    }, 1000);
  },

  _stopCountdown() {
    if (this._countdownTimer != null) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  enrichViolation(violation) {
    const appealStatus = Number(violation.isAppealed) || 0;
    const createdAt = Number(violation.createdAt);
    return {
      ...violation,
      typeLabel: VIOLATION_TYPE_LABEL[violation.violationType] || '违规记录',
      appealStatusLabel: { 1: '审核中', 2: '已通过', 3: '已驳回' }[appealStatus] || '',
      appealStatusTheme: { 1: 'warning', 2: 'success', 3: 'danger' }[appealStatus] || 'default',
      dateLabel: violation.date || (Number.isFinite(createdAt) ? DateUtil.formatDate(createdAt) : ''),
      canAppeal: appealStatus === 0
    };
  },

  onTabChange(event) {
    this.setData({ activeTab: event.detail.value });
  },

  goCheckin() {
    wx.navigateTo({ url: '/pkgUser/checkin/checkin' });
  },

  _invalidateCaches() {
    ['record_cloud_cache', 'reserve_existing_cache'].forEach(key => {
      try { wx.removeStorageSync(key); } catch (error) { console.warn('[Record] 清理页面缓存失败:', key, error); }
    });
  },

  async cancelReservation(event) {
    if (this._cancelPending || this.data.submittingCancelId) return;
    const id = event.currentTarget.dataset.id;
    const item = this.data.currentList.find(record => record._id === id);
    if (!item) return;
    this._cancelPending = true;
    try {
      const modal = await new Promise((resolve, reject) => wx.showModal({ title: '取消预约', content: `确认取消 ${item.seatTitle} 的预约？`, confirmText: '取消预约', success: resolve, fail: reject }));
      if (!modal.confirm) return;
      this.setData({ submittingCancelId: id });
      const result = await CloudAPI.cancelReservation(id);
      if (!result || !result.success) {
        wx.showModal({ title: '取消未完成', content: (result && result.message) || '请稍后重试', showCancel: false });
        this._invalidateCaches();
        // 重新拉取真实状态,避免界面残留"已取消"的假象或过期列表
        await this.loadData(true);
        return;
      }
      ReservationStats.bumpCancelled();
      this._clearReservedFromLocal(item);
      try {
        const stored = readStorage('local_reservations', []);
        const records = Array.isArray(stored) ? stored : [];
        const remaining = records.filter(record => record._id !== id);
        remaining.unshift({ ...item, status: 'cancelled', cancelledAt: Date.now() });
        wx.setStorageSync('local_reservations', remaining);
      } catch (error) {
        console.warn('[Record] 保存取消记录失败:', error);
      }
      this._invalidateCaches();
      wx.showToast({ title: '已取消预约', icon: 'success' });
      await this.loadData(true);
    } catch (error) {
      console.warn('[Record] 取消预约失败:', error);
      wx.showToast({ title: '取消失败，请重试', icon: 'none' });
    } finally {
      this._cancelPending = false;
      if (!this._disposed) this.setData({ submittingCancelId: '' });
    }
  },

  _clearReservedFromLocal(item) {
    if (!item.seatId || !item.date || !item.timeSlot) return;
    try {
      const stored = readStorage('my_reserved_seats', {});
      const key = `${item.date}_${item.timeSlot}`;
      if (Array.isArray(stored[key])) {
        stored[key] = stored[key].filter(id => id !== item.seatId);
        if (!stored[key].length) delete stored[key];
        wx.setStorageSync('my_reserved_seats', stored);
      }
    } catch (error) {
      console.warn('[Record] 清理目标时段座位失败:', error);
    }
  },

  onAppealTap(event) {
    if (this.data.submittingAppeal) return;
    this.setData({ showAppealDialog: true, appealingViolationId: event.currentTarget.dataset.id, appealReason: '' });
  },

  onAppealReasonInput(event) {
    this.setData({ appealReason: event.detail.value });
  },

  cancelAppeal() {
    if (this.data.submittingAppeal) return;
    this.setData({ showAppealDialog: false, appealingViolationId: '', appealReason: '' });
  },

  async submitAppeal() {
    if (this.data.submittingAppeal) return;
    const reason = (this.data.appealReason || '').trim();
    const id = this.data.appealingViolationId;
    if (!id || reason.length < APPEAL_MIN_LEN) {
      wx.showToast({ title: `请填写不少于 ${APPEAL_MIN_LEN} 字的申诉理由`, icon: 'none' });
      return;
    }
    this.setData({ submittingAppeal: true });
    try {
      const result = await CloudAPI.submitAppeal(id, reason);
      if (!result || !result.success) throw new Error((result && result.message) || '申诉未提交，请重试');
      this._invalidateCaches();
      this.setData({ showAppealDialog: false, appealingViolationId: '', appealReason: '' });
      wx.showToast({ title: '申诉已提交', icon: 'success' });
      await this.loadData(true);
    } catch (error) {
      console.warn('[Record] 提交申诉失败:', error);
      wx.showToast({ title: error.message || '提交失败，请重试', icon: 'none' });
    } finally {
      if (!this._disposed) this.setData({ submittingAppeal: false });
    }
  },

  goLogin() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  goReserve() {
    wx.switchTab({ url: '/pages/reserve/reserve' });
  }
});
