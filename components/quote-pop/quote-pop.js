/**
 * quote-pop 组件 —— 首页「点击弹出一句孤立的话」交互动画
 *
 * 交互:
 *  - 点击右下角浮动圆形触发器:弹出气泡,随机展示一句语录;
 *  - 每点一次换一句,连续两次不会重复;
 *  - 气泡 4.5 秒后自动收起,点击气泡可提前收起;
 *  - 首次进入展示一次引导提示,点击后不再出现。
 *
 * 隐私:
 *  - 组件不读取、不展示任何用户信息(语录为本地静态文案)。
 */
const QuoteBank = require('../../utils/home-quotes');

const BUBBLE_TTL = 4500;      // 气泡自动收起时间(毫秒)
const HINT_STORAGE_KEY = 'home_quote_hint_shown';

Component({
  data: {
    bubbleVisible: false,  // 气泡是否可见
    popAnim: false,        // 是否重触发弹出动画(连续点击也有反馈)
    quoteText: '',         // 当前弹出的那句话
    hintVisible: false,    // 首次引导提示
    pressed: false         // 触发器按压形变
  },

  lifetimes: {
    attached() {
      this._bubbleTimer = null;
      this._pressedTimer = null;
      this.setData({ hintVisible: !this._readHintFlag() });
    },

    detached() {
      this._clearTimers();
    }
  },

  methods: {
    /** 读取引导提示是否已展示过（读取失败视为已展示，避免打扰） */
    _readHintFlag() {
      try {
        return Boolean(wx.getStorageSync(HINT_STORAGE_KEY));
      } catch (err) {
        console.warn('[QuotePop] 读取引导提示状态失败:', err);
        return true;
      }
    },

    /** 标记引导提示已展示 */
    _markHintSeen() {
      try {
        wx.setStorageSync(HINT_STORAGE_KEY, 1);
      } catch (err) {
        console.warn('[QuotePop] 保存引导提示状态失败:', err);
      }
    },

    _clearTimers() {
      if (this._bubbleTimer) {
        clearTimeout(this._bubbleTimer);
        this._bubbleTimer = null;
      }
      if (this._pressedTimer) {
        clearTimeout(this._pressedTimer);
        this._pressedTimer = null;
      }
    },

    /** 点击触发器:换一句孤立的话并弹出 */
    onTap() {
      this._markHintSeen();
      if (this.data.hintVisible) this.setData({ hintVisible: false });

      const quote = QuoteBank.pickQuote(this.data.quoteText);
      this.setData({ quoteText: quote.text, bubbleVisible: true, popAnim: false });

      // 下一渲染帧重触发弹出动画,保证连续点击都有"弹一下"的反馈
      const retrigger = () => this.setData({ popAnim: true });
      if (typeof wx.nextTick === 'function') {
        wx.nextTick(retrigger);
      } else {
        setTimeout(retrigger, 30);
      }

      // 轻震动反馈(设备支持时)
      try {
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      } catch (err) {
        console.warn('[QuotePop] 震动反馈不可用:', err);
      }

      // 按压形变
      this.setData({ pressed: true });
      if (this._pressedTimer) clearTimeout(this._pressedTimer);
      this._pressedTimer = setTimeout(() => {
        this.setData({ pressed: false });
        this._pressedTimer = null;
      }, 180);

      // 重置自动收起
      if (this._bubbleTimer) clearTimeout(this._bubbleTimer);
      this._bubbleTimer = setTimeout(() => {
        this.setData({ bubbleVisible: false, popAnim: false });
        this._bubbleTimer = null;
      }, BUBBLE_TTL);
    },

    /** 点击气泡提前收起 */
    onDismiss() {
      if (this._bubbleTimer) {
        clearTimeout(this._bubbleTimer);
        this._bubbleTimer = null;
      }
      this.setData({ bubbleVisible: false, popAnim: false });
    }
  }
});
