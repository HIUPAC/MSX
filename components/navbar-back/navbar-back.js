// components/navbar-back/navbar-back.js
Component({
  properties: {
    // 是否显示返回按钮（在 tabBar 页面或首页时不显示）
    showBack: {
      type: Boolean,
      value: false
    }
  },
  methods: {
    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/home' }) });
      } else {
        wx.switchTab({ url: '/pages/home/home' });
      }
    }
  }
})