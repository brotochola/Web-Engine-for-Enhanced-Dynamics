// FloatingPanel.js — Reusable draggable popup window for debug panels.
//
// A small "OS window" primitive: title bar (drag handle) + close (×) button +
// a `.body` element the caller fills with whatever content it wants. Used by
// LayersPanel (Uniforms / Compute passes popups) and any future panel that
// needs a floating, movable, closable window instead of a fixed docked panel.
//
// Stops wheel/pointerdown from bubbling to the canvas so interacting with the
// panel (dragging a slider, scrolling a list) doesn't fight the free camera's
// pan/zoom.

let zCounter = 950;

export class FloatingPanel {
  /**
   * @param {Object} opts
   * @param {string} [opts.title]
   * @param {number} [opts.left=12]
   * @param {number} [opts.top=48]
   * @param {number} [opts.width=300]
   * @param {() => void} [opts.onClose] Called once, right before the panel is removed from the DOM.
   */
  constructor({ title = '', left = 12, top = 48, width = 300, onClose = null } = {}) {
    this.onClose = onClose;
    this._dragOffset = null;
    this._onPointerMove = (e) => this._handleDragMove(e);
    this._onPointerUp = () => this._endDrag();

    const el = document.createElement('div');
    el.style.cssText =
      `position:fixed;left:${left}px;top:${top}px;width:${width}px;max-height:calc(100vh - 60px);z-index:${++zCounter};` +
      'display:flex;flex-direction:column;overflow:hidden;color:#e8e8e8;font:12px/1.35 system-ui,sans-serif;' +
      'background:rgba(12,14,20,0.92);border:1px solid #3a4254;border-radius:10px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,0.45);';
    el.addEventListener('wheel', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;flex:none;gap:8px;' +
      'padding:8px 10px 8px 12px;cursor:move;user-select:none;touch-action:none;' +
      'border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);';
    head.addEventListener('pointerdown', (e) => this._startDrag(e));

    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    titleEl.style.cssText =
      'font-weight:600;font-size:13px;color:#fff;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Close';
    closeBtn.style.cssText =
      'background:none;border:none;color:rgba(255,255,255,0.6);font-size:16px;cursor:pointer;padding:0 2px;line-height:1;flex:none';
    closeBtn.onclick = () => this.close();

    head.appendChild(titleEl);
    head.appendChild(closeBtn);
    el.appendChild(head);

    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;padding:10px 12px 14px';
    el.appendChild(body);

    this.el = el;
    this.head = head;
    this.titleEl = titleEl;
    this.closeBtn = closeBtn;
    this.body = body;
  }

  setTitle(text) {
    this.titleEl.textContent = text;
  }

  /** Append to the DOM and bring to front. Returns `this` for chaining. */
  mount(parent = document.body) {
    this._bringToFront();
    parent.appendChild(this.el);
    return this;
  }

  /** Remove from the DOM. Safe to call multiple times. */
  close() {
    if (!this.el.parentNode) return;
    if (this.onClose) this.onClose();
    this.el.parentNode.removeChild(this.el);
  }

  _bringToFront() {
    this.el.style.zIndex = String(++zCounter);
  }

  _startDrag(e) {
    if (e.target === this.closeBtn) return;
    e.preventDefault();
    e.stopPropagation();
    this._bringToFront();
    const rect = this.el.getBoundingClientRect();
    this._dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  }

  _handleDragMove(e) {
    if (!this._dragOffset) return;
    const x = Math.max(0, Math.min(e.clientX - this._dragOffset.x, window.innerWidth - 60));
    const y = Math.max(0, Math.min(e.clientY - this._dragOffset.y, window.innerHeight - 32));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  _endDrag() {
    this._dragOffset = null;
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
  }
}
