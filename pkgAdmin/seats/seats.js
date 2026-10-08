// pkgAdmin/seats/seats.js
// 高级座位管理 - 支持按楼层管理座位状态、生成二维码
const RouteGuard = require('../../utils/route-guard');
const CloudAPI = require('../../utils/cloud-api');

Page({
  data: {
    floors: [],
    loading: true,
    currentFloor: 1
  },

  onLoad() {
    if (!RouteGuard.checkAdmin()) {
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this.loadFloors();
  },

  onShow() {
    if (this.data.floors.length > 0) {
      this.loadFloors();
    }
  },

  /**
   * 加载所有楼层与座位数据
   */
  async loadFloors() {
    this.setData({ loading: true });
    try {
      if (wx.cloud) {
        const res = await wx.cloud.database().collection('seats')
          .limit(200).get();
        const list = res.data || [];
        if (list.length > 0) {
          const floorsMap = {};
          list.forEach(s => {
            const f = s.floor || 1;
            if (!floorsMap[f]) {
              floorsMap[f] = { floor: f, label: `${f}F`, tables: {} };
            }
            const tNo = s.tableNo || s.tableNumber || 'T01';
            if (!floorsMap[f].tables[tNo]) {
              floorsMap[f].tables[tNo] = { _id: tNo, tableNo: tNo, seats: [] };
            }
            floorsMap[f].tables[tNo].seats.push({
              _id: s._id,
              seatNo: s.seatNo || s.seatNumber,
              status: s.seatStatus || s.status || 'enabled'
            });
          });

          const floors = Object.values(floorsMap).map(f => ({
            ...f,
            tables: Object.values(f.tables)
          })).sort((a, b) => a.floor - b.floor);

          this.setData({ floors, loading: false });
          return;
        }
      }
    } catch (e) {
      console.warn('[AdminSeats] 加载座位失败:', e);
    }

    // 兜底演示数据
    this.setData({
      floors: [
        { floor: 1, label: '1F', tables: [
          { _id: 't1', tableNo: 'T01', seats: [
            { _id: 's1-1', seatNo: 1, status: 'enabled' },
            { _id: 's1-2', seatNo: 2, status: 'enabled' },
            { _id: 's1-3', seatNo: 3, status: 'disabled' },
            { _id: 's1-4', seatNo: 4, status: 'enabled' }
          ]},
          { _id: 't2', tableNo: 'T02', seats: [
            { _id: 's1-5', seatNo: 1, status: 'enabled' },
            { _id: 's1-6', seatNo: 2, status: 'enabled' }
          ]}
        ]},
        { floor: 2, label: '2F', tables: [
          { _id: 't3', tableNo: 'T01', seats: [
            { _id: 's2-1', seatNo: 1, status: 'enabled' },
            { _id: 's2-2', seatNo: 2, status: 'enabled' },
            { _id: 's2-3', seatNo: 3, status: 'enabled' },
            { _id: 's2-4', seatNo: 4, status: 'disabled' }
          ]}
        ]},
        { floor: 3, label: '3F', tables: [
          { _id: 't4', tableNo: 'T01', seats: [
            { _id: 's3-1', seatNo: 1, status: 'enabled' },
            { _id: 's3-2', seatNo: 2, status: 'enabled' }
          ]}
        ]}
      ],
      loading: false
    });
  },

  /**
   * 切换单个座位状态（同步到云端）
   */
  async toggleSeat(e) {
    const { floor, table, seat } = e.currentTarget.dataset;
    const newStatus = e.detail.value ? 'enabled' : 'disabled';

    // 找到对应座位更新本地
    const floors = this.data.floors.map(f => {
      if (f.floor !== floor) return f;
      return {
        ...f,
        tables: f.tables.map(t => {
          if (t.tableNo !== table) return t;
          return {
            ...t,
            seats: t.seats.map(s => {
              if (s.seatNo !== seat) return s;
              return { ...s, status: newStatus };
            })
          };
        })
      };
    });
    this.setData({ floors });

    try {
      if (wx.cloud) {
        // 通过 _id 精确更新数据库
        const targetSeat = this._findSeat(floor, table, seat);
        if (targetSeat && targetSeat._id) {
          await wx.cloud.database().collection('seats').doc(targetSeat._id).update({
            data: { seatStatus: newStatus, updatedAt: Date.now() }
          });
        }
      }
      wx.showToast({ title: `${floor}F-${table}-座${seat} 已${newStatus === 'enabled' ? '启用' : '禁用'}`, icon: 'success' });
    } catch (err) {
      console.warn('[AdminSeats] 同步座位状态失败:', err);
      wx.showToast({ title: '同步失败，请重试', icon: 'none' });
    }
  },

  /**
   * 辅助：根据楼层/桌号/座位号查找座位对象
   */
  _findSeat(floor, table, seat) {
    const f = this.data.floors.find(x => x.floor === floor);
    if (!f) return null;
    const t = f.tables.find(x => x.tableNo === table);
    if (!t) return null;
    return t.seats.find(s => s.seatNo === seat) || null;
  },

  /**
   * 生成座位二维码（跳转到工具分包使用 webview 生成）
   */
  generateQR(e) {
    const { table } = e.currentTarget.dataset;
    wx.showLoading({ title: '生成中...', mask: true });
    // 优先调用云函数生成真实二维码
    if (wx.cloud) {
      wx.cloud.callFunction({
        name: 'generateSeatQR',
        data: { tableNo: table }
      }).then(res => {
        wx.hideLoading();
        if (res && res.result && res.result.success) {
          const qrUrl = res.result.qrCode || res.result.url;
          if (qrUrl) {
            wx.previewImage({ urls: [qrUrl], current: qrUrl });
            return;
          }
        }
        // 云端未实现时使用 webview 工具页
        wx.navigateTo({ url: `/pkgTools/webview/webview?url=${encodeURIComponent('https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(`seat:${table}`))}` });
      }).catch(() => {
        wx.hideLoading();
        wx.navigateTo({ url: `/pkgTools/webview/webview?url=${encodeURIComponent('https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(`seat:${table}`))}` });
      });
    } else {
      setTimeout(() => {
        wx.hideLoading();
        wx.navigateTo({ url: `/pkgTools/webview/webview?url=${encodeURIComponent('https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(`seat:${table}`))}` });
      }, 600);
    }
  },

  /**
   * 切换显示的楼层
   */
  switchFloor(e) {
    const { floor } = e.currentTarget.dataset;
    this.setData({ currentFloor: floor });
  }
});