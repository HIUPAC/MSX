// pages/profile/profile.js
// 账户信息、信用记录与预约入口；保留现有登录注册流程。
const AppState = require('../../utils/app-state');
const Auth = require('../../utils/auth');
const CloudAPI = require('../../utils/cloud-api');
const ReservationStats = require('../../utils/reservation-stats');
const FavoriteSeats = require('../../utils/favorite-seats');
const PageLifecycle = require('../../utils/page-lifecycle');
const NavigationContext = require('../../utils/navigation-context');

// 学院列表（与login页保持一致）
const COLLEGE_LIST = [
  '软件学院', '计算机学院', '信息工程学院', '数学学院', '物理学院',
  '化学学院', '文学院', '法学院', '经济管理学院', '外语学院',
  '机械工程学院', '电子工程学院', '土木工程学院', '建筑学院',
  '医学院', '药学院', '生命科学学院', '环境学院', '材料学院',
  '马克思主义学院', '艺术学院', '体育学院', '教育学院', '其他'
];

Page({
  data: {
    userInfo: null,
    creditScore: 100,
    isBanned: false,
    banRemainDays: 0,
    isAdmin: false,

    // 头像上传状态
    avatarUploading: false,

    // 真实统计 - 来自 ReservationStats
    stats: {
      totalReservations: 0,
      completedCount: 0,
      violationCount: 0,
      todayCount: 0,
      weekCount: 0,
      monthCount: 0,
      favoriteCount: 0,
      completionRate: 0
    },

    // 手机号登录/注册表单
    showLoginForm: false,
    loginPhone: '',
    loginName: '',
    loginStudentId: '',
    isRegisterMode: true,

    // 学院编辑
    showCollegePicker: false,
    collegeList: COLLEGE_LIST,
    collegeIndex: -1,
    editCollege: '',
    useCustomCollege: false,
    customCollege: '',
    collegeSaving: false,

    menus: [
      { icon: 'app', label: '我的预约', note: '查看当前与历史预约', path: '/pages/record/record', tab: 'current' },
      { icon: 'star', label: '收藏座位', note: '下次快速找到喜欢的位置', path: '/pkgUser/favorites/favorites' },
      { icon: 'time', label: '番茄钟', note: '把时间切成小块,一段一段来', path: '/pkgTools/pomodoro/pomodoro' },
      { icon: 'edit', label: '日记本', note: '今日一页,写下来的日子才算数', path: '/pkgTools/diary/diary' },
      { icon: 'location', label: '定位签到', note: '到达图书馆后使用', path: '', type: 'gps_checkin' },
      { icon: 'info-circle', label: '违规记录', note: '查看记录与申诉进度', path: '/pages/record/record', tab: 'violation' }
    ]
  },

  onLoad() {
    // 初始化 PageLifecycle
    this._lc = new PageLifecycle(this);

    // 订阅预约统计（自动跟随页面生命周期退订）
    this._lc.addSubscribe(ReservationStats.subscribe(s => this._applyStats(s)));
  },

  onShow() {
    // onShow 不需要显式 activate（profile 页面无轮询/定时器）
    this.loadUserInfo();
    ReservationStats.refresh();
    this.setData({
      'stats.favoriteCount': FavoriteSeats.count()
    });
    if (typeof this.getTabBar === 'function') {
      const tabBar = this.getTabBar();
      if (tabBar) tabBar.setData({ selected: 3 });
    }
  },

  onUnload() {
    if (this._lc) this._lc.dispose();
  },

  /** 弹窗防穿透占位 */
  noop() {},

  /** 点击头像 → 选择图片并上传到云存储 */
  async onAvatarTap() {
    if (this.data.avatarUploading) return;

    // 1. 选择图片
    let tempPath;
    try {
      const res = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject
        });
      });
      tempPath = res.tempFiles[0].tempFilePath;
    } catch (e) {
      wx.showToast({ title: '未选择图片', icon: 'none' });
      return;
    }

    // 2. 上传到云存储（如果有云能力），否则直接用本地路径
    this.setData({ avatarUploading: true });
    wx.showLoading({ title: '上传中...', mask: true });

    let avatarUrl = tempPath; // 默认使用本地临时路径

    if (wx.cloud) {
      try {
        const userInfo = AppState.getUserInfo() || {};
        const userId = userInfo._id || userInfo.phone || 'unknown';
        const timestamp = Date.now();
        // 云存储路径：avatars/{userId}_{timestamp}.jpg
        const cloudPath = `avatars/${userId}_${timestamp}.jpg`;

        const uploadRes = await wx.cloud.uploadFile({
          cloudPath,
          filePath: tempPath
        });

        // 获取永久链接（cloud:// 格式，在 image 组件中可直接使用）
        avatarUrl = uploadRes.fileID;

        // 尝试获取临时下载链接（部分场景需要 http 链接）
        try {
          const urlRes = await wx.cloud.getTempFileURL({
            fileList: [uploadRes.fileID]
          });
          if (urlRes.fileList && urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) {
            // 优先使用 http 链接，更通用
            avatarUrl = urlRes.fileList[0].tempFileURL;
          }
        } catch (e) {
          // 获取临时链接失败时，使用 cloud:// fileID（在小程序 image 组件中也能显示）
          console.warn('[Profile] 获取临时下载链接失败，使用 fileID:', e);
        }
      } catch (uploadErr) {
        console.warn('[Profile] 云上传失败，使用本地路径:', uploadErr);
        // 云上传失败时，降级使用本地临时路径
        avatarUrl = tempPath;
      }
    }

    // 3. 更新本地状态 + 同步云端用户信息
    const userInfo = AppState.getUserInfo() || {};
    userInfo.avatarUrl = avatarUrl;
    AppState.setUserInfo(userInfo);
    this.setData({ userInfo, avatarUploading: false });
    wx.hideLoading();

    // 4. 同步到本地用户表（关键修复：防止退出登录后头像丢失）
    Auth.updateLocalUser({ avatarUrl });

    // 5. 同步到云数据库
    if (wx.cloud && userInfo._id) {
      try {
        await CloudAPI.updateUserInfo({ avatarUrl });
      } catch (e) {
        console.warn('[Profile] 云端头像同步失败:', e);
      }
    }

    wx.showToast({ title: '头像已更新', icon: 'success' });
  },

  loadUserInfo() {
    const userInfo = AppState.getUserInfo();
    const creditScore = AppState.getCreditScore();
    const isBanned = AppState.isBanned();
    const banRemainDays = AppState.getBanRemainDays();

    this.setData({
      userInfo: userInfo || null,
      creditScore,
      isBanned,
      banRemainDays,
      isAdmin: Auth.isAdmin()
    });

    // 加载统计
    this._applyStats(ReservationStats.get());
    this.setData({ 'stats.favoriteCount': FavoriteSeats.count() });
  },

  /**
   * 应用统计数据到页面
   * @private
   */
  _applyStats(s) {
    this.setData({
      'stats.totalReservations': s.total || 0,
      'stats.completedCount': s.completed || 0,
      'stats.violationCount': s.violation || 0,
      'stats.todayCount': s.today || 0,
      'stats.weekCount': s.week || 0,
      'stats.monthCount': s.month || 0,
      'stats.completionRate': s.total > 0 ? Math.min(100, Math.round((s.completed / s.total) * 100)) : 0
    });
  },

  /**
   * 编辑学院
   */
  onEditCollege() {
    const college = this.data.userInfo?.college || '';
    this.setData({ collegeIndex: -1, editCollege: '', useCustomCollege: false, customCollege: '' });
    if (college) {
      const idx = COLLEGE_LIST.indexOf(college);
      if (idx >= 0) {
        this.setData({ collegeIndex: idx, editCollege: college, useCustomCollege: false });
      } else {
        this.setData({ useCustomCollege: true, customCollege: college, collegeIndex: -1, editCollege: '' });
      }
    }
    this.setData({ showCollegePicker: true });
  },

  onCollegePickerChange(e) {
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= COLLEGE_LIST.length) {
      console.warn('[Profile] 无效学院选项:', e.detail.value);
      return;
    }
    const college = COLLEGE_LIST[index];
    this.setData({ collegeIndex: index, editCollege: college, useCustomCollege: college === '其他' });
  },

  onCustomCollegeInput(e) {
    this.setData({ customCollege: e.detail.value });
  },

  toggleCustomInput() {
    this.setData({
      useCustomCollege: !this.data.useCustomCollege,
      customCollege: '',
      collegeIndex: -1,
      editCollege: ''
    });
  },

  async saveCollege() {
    if (this.data.collegeSaving) return;
    const college = this.data.useCustomCollege
      ? this.data.customCollege.trim()
      : this.data.editCollege;

    if (!college) {
      wx.showToast({ title: '请输入学院', icon: 'none' });
      return;
    }
    this.setData({ collegeSaving: true });

    try {
      const userInfo = AppState.getUserInfo() || {};
      userInfo.college = college;
      AppState.setUserInfo(userInfo);

      // 关键修复：同步更新本地用户表（防止退出登录后学院信息丢失）
      Auth.updateLocalUser({ college });

      if (wx.cloud) {
        try {
          await CloudAPI.updateUserInfo({ college });
        } catch (error) {
          console.warn('[Profile] 学院信息云端同步失败，保留本地修改:', error);
        }
      }

      this.setData({ showCollegePicker: false });
      this.loadUserInfo();
      wx.showToast({ title: '学院信息已更新', icon: 'success' });
    } catch (e) {
      console.warn('[Profile] 学院信息保存失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this.setData({ collegeSaving: false });
    }
  },

  closeCollegePicker() {
    this.setData({ showCollegePicker: false });
  },

  onMenuTap(e) {
    const { path, type, tab } = e.currentTarget.dataset;

    if (type === 'gps_checkin') {
      wx.navigateTo({ url: '/pkgUser/checkin/checkin?mode=gps' });
      return;
    }

    if (path === '/pages/record/record') {
      NavigationContext.setRecordTab(tab || 'current');
      wx.switchTab({
        url: path,
        fail: error => {
          NavigationContext.consumeRecordTab();
          console.warn('[Profile] 预约记录跳转失败:', error);
          wx.showToast({ title: '记录页打开失败', icon: 'none' });
        }
      });
      return;
    }

    if (!path) {
      wx.showToast({ title: '功能开发中', icon: 'none' });
      return;
    }
    if (path === '/pages/reserve/reserve') {
      wx.switchTab({ url: path });
    } else {
      wx.navigateTo({ url: path });
    }
  },

  goAdmin() {
    wx.navigateTo({ url: '/pkgAdmin/admin/admin' });
  },

  // ======== 手机号登录 / 注册 ========

  showLogin() {
    this.setData({
      showLoginForm: true,
      loginPhone: '',
      loginName: '',
      loginStudentId: '',
      isRegisterMode: true
    });
  },

  toggleLoginMode() {
    this.setData({
      isRegisterMode: !this.data.isRegisterMode,
      loginStudentId: ''
    });
  },

  onLoginPhoneInput(e) {
    this.setData({ loginPhone: e.detail.value });
  },

  onLoginNameInput(e) {
    this.setData({ loginName: e.detail.value });
  },

  onLoginStudentIdInput(e) {
    this.setData({ loginStudentId: e.detail.value });
  },

  submitLogin() {
    const { loginPhone, loginName, loginStudentId, isRegisterMode } = this.data;
    let result;

    if (isRegisterMode) {
      result = Auth.registerByPhone(loginPhone, loginName, loginStudentId);
    } else {
      result = Auth.loginByPhone(loginPhone, loginName);
    }

    if (!result.success) {
      wx.showToast({ title: result.error, icon: 'none' });
      return;
    }

    this.setData({ showLoginForm: false });
    this.loadUserInfo();

    if (result.isNew) {
      wx.showToast({ title: '注册成功！欢迎使用', icon: 'success' });
    } else {
      wx.showToast({ title: `欢迎回来，${result.data.name}`, icon: 'success' });
    }
  },

  closeLoginForm() {
    this.setData({ showLoginForm: false });
  },

  async handleLogout() {
    const res = await new Promise(r => wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success: r
    }));

    if (res.confirm) {
      Auth.logout();
      this.setData({ userInfo: null, isAdmin: false });
      // 重置统计展示
      this.setData({
        stats: {
          totalReservations: 0,
          completedCount: 0,
          violationCount: 0,
          todayCount: 0,
          weekCount: 0,
          monthCount: 0,
          favoriteCount: 0,
          completionRate: 0
        }
      });
      wx.showToast({ title: '已退出', icon: 'success' });
    }
  }
});
