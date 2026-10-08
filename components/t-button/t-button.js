Component({
  options: { multipleSlots: true },
  properties: {
    theme: { type: String, value: 'default' },
    size: { type: String, value: 'medium' },
    block: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    loading: { type: Boolean, value: false },
    variant: { type: String, value: 'base' },
    icon: { type: String, value: '' }
  },
  methods: {
    onTap() {
      if (this.data.disabled || this.data.loading) return;
      this.triggerEvent('tap');
    }
  }
});