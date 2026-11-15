// The light bench's panel: a drawer on the right with sections of controls, each with a line that says what it does and
// which part of the API it is, a code box, and the overlay that marks the selected element and the lamps on the canvas.
// Plain DOM, made on the page only (the workers import this module with the scene and never construct it).

const PANEL_CSS =
  'position:fixed;top:0;right:0;bottom:0;z-index:940;width:372px;box-sizing:border-box;overflow-y:auto;' +
  'color:#e8e8ee;font:12px/1.35 system-ui,sans-serif;background:rgba(10,12,20,0.86);padding:8px 10px 24px;' +
  'border-left:1px solid #334;';
const HEAD_CSS = 'font-weight:600;font-size:13px;margin:2px 0 4px;';
const READOUT_CSS = 'white-space:pre;font-variant-numeric:tabular-nums;color:#cfd3e6;margin-bottom:4px;';
const SECTION_CSS = 'border-top:1px solid #334;margin-top:6px;padding-top:4px;';
const SUMMARY_CSS = 'cursor:pointer;font-weight:600;color:#fff;padding:2px 0;user-select:none;';
const ROW_CSS = 'margin:5px 0 2px;';
const LABEL_CSS = 'display:flex;align-items:center;gap:6px;justify-content:space-between;';
const NOTE_CSS = 'display:block;color:#9aa0b8;font-size:11px;line-height:1.25;margin-top:1px;';
const CONTROL_CSS =
  'font:inherit;color:#eee;background:#1b1f2e;border:1px solid #556;border-radius:4px;padding:1px 4px;max-width:190px;';
const BUTTON_CSS =
  'font:inherit;color:#eee;background:rgba(255,255,255,0.07);border:1px solid #556;border-radius:5px;padding:3px 8px;' +
  'cursor:pointer;margin:2px 4px 2px 0;';
const CODE_CSS =
  'margin:4px 0 0;padding:6px 8px;background:#06070c;border:1px solid #334;border-radius:5px;color:#d7e3ff;' +
  'font:11px/1.4 ui-monospace,Consolas,monospace;white-space:pre;overflow:auto;max-height:46vh;';
const KEYS_CSS = 'white-space:pre;font:11px/1.45 ui-monospace,Consolas,monospace;color:#cfd3e6;';

/** No focus from a click: Space or an arrow would press it again, or move the person and the control at once. */
function noFocus(el) {
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

function note(text) {
  const n = document.createElement('span');
  n.style.cssText = NOTE_CSS;
  n.textContent = text;
  return n;
}

/** A section's body: its controls go in it, in order. */
class Section {
  constructor(details) {
    this.details = details;
    this.body = document.createElement('div');
    details.append(this.body);
  }

  _row(labelText, control, noteText) {
    const row = document.createElement('div');
    row.style.cssText = ROW_CSS;
    const label = document.createElement('label');
    label.style.cssText = LABEL_CSS;
    const name = document.createElement('span');
    name.textContent = labelText;
    label.append(name, control);
    row.append(label);
    if (noteText) row.append(note(noteText));
    this.body.append(row);
    return { row, name };
  }

  /**
   * @param {{ label: string, note?: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void }} o
   */
  select(o) {
    const s = document.createElement('select');
    s.style.cssText = CONTROL_CSS;
    for (const [value, text] of o.options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      s.append(opt);
    }
    s.value = o.value;
    s.addEventListener('change', () => {
      s.blur();
      o.onChange(s.value);
    });
    const { row } = this._row(o.label, s, o.note);
    return {
      el: s,
      row,
      set: (v) => {
        s.value = v;
      },
      enable: (value, on) => {
        for (const opt of s.options) if (opt.value === value) opt.disabled = !on;
      },
    };
  }

  /**
   * @param {{ label: string, note?: string, min: number, max: number, step: number, value: number,
   *   format?: (v: number) => string, onInput?: (v: number) => void, onChange?: (v: number) => void }} o
   */
  range(o) {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const r = document.createElement('input');
    r.type = 'range';
    r.min = String(o.min);
    r.max = String(o.max);
    r.step = String(o.step);
    r.value = String(o.value);
    r.style.cssText = 'width:120px;';
    const out = document.createElement('span');
    out.style.cssText = 'min-width:46px;text-align:right;font-variant-numeric:tabular-nums;';
    const fmt = o.format ?? ((v) => String(v));
    out.textContent = fmt(o.value);
    wrap.append(r, out);
    r.addEventListener('input', () => {
      const v = Number(r.value);
      out.textContent = fmt(v);
      o.onInput?.(v);
    });
    r.addEventListener('change', () => {
      r.blur();
      o.onChange?.(Number(r.value));
    });
    this._row(o.label, wrap, o.note);
    return {
      el: r,
      set: (v) => {
        r.value = String(v);
        out.textContent = fmt(v);
      },
    };
  }

  /** @param {{ label: string, note?: string, value: boolean, onChange: (v: boolean) => void }} o */
  toggle(o) {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!o.value;
    c.addEventListener('change', () => {
      c.blur();
      o.onChange(c.checked);
    });
    this._row(o.label, c, o.note);
    return {
      el: c,
      set: (v) => {
        c.checked = !!v;
      },
    };
  }

  /** A row of buttons: [{ label, onClick }], with one note under them. */
  buttons(list, noteText) {
    const row = document.createElement('div');
    row.style.cssText = ROW_CSS;
    const made = [];
    for (const b of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = BUTTON_CSS;
      btn.textContent = b.label;
      noFocus(btn);
      btn.addEventListener('click', b.onClick);
      row.append(btn);
      made.push(btn);
    }
    if (noteText) row.append(note(noteText));
    this.body.append(row);
    return made;
  }

  text(t) {
    const p = note(t);
    p.style.margin = '4px 0';
    this.body.append(p);
    return p;
  }

  pre(t, css = KEYS_CSS) {
    const p = document.createElement('div');
    p.style.cssText = css;
    p.textContent = t;
    this.body.append(p);
    return p;
  }

  clear() {
    this.body.replaceChildren();
  }
}

export class BenchPanel {
  constructor(title) {
    this.el = document.createElement('div');
    this.el.style.cssText = PANEL_CSS;
    // The engine turns the window's wheel into camera zoom and keeps the page from scrolling: a wheel over the panel
    // scrolls the panel and stops here.
    this.el.addEventListener('wheel', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.style.cssText = HEAD_CSS;
    head.textContent = title;
    this.readout = document.createElement('div');
    this.readout.style.cssText = READOUT_CSS;
    this.el.append(head, this.readout);
    document.body.append(this.el);
  }

  /** A section, open or closed. */
  section(title, { open = true } = {}) {
    const d = document.createElement('details');
    d.open = open;
    d.style.cssText = SECTION_CSS;
    const s = document.createElement('summary');
    s.style.cssText = SUMMARY_CSS;
    s.textContent = title;
    d.append(s);
    this.el.append(d);
    const section = new Section(d);
    section.summary = s;
    return section;
  }

  /** The code box (in its own section), with a button that copies it. */
  codeBox(section) {
    const [copy] = section.buttons([{ label: 'Copy', onClick: () => navigator.clipboard?.writeText(this._code.textContent) }]);
    this._copy = copy;
    this._code = section.pre('', CODE_CSS);
    return this._code;
  }

  setCode(text) {
    if (this._code && this._code.textContent !== text) this._code.textContent = text;
  }

  get visible() {
    return this.el.style.display !== 'none';
  }

  toggle() {
    this.el.style.display = this.visible ? 'none' : '';
  }

  hide() {
    this.el.style.display = 'none';
  }

  remove() {
    this.el.remove();
  }
}

/**
 * Marks on the canvas: a dashed box around the selected element and a dot on each lamp (its bulb, raised by its
 * elevation). Positions are world points: Camera.worldToScreen maps them to the canvas, and the canvas's box to the page.
 */
export class BenchOverlay {
  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:930;pointer-events:none;';
    this.box = document.createElement('div');
    this.box.style.cssText =
      'position:fixed;border:1px dashed #ffd36a;box-shadow:0 0 0 1px rgba(0,0,0,0.6);display:none;border-radius:3px;';
    this.label = document.createElement('div');
    this.label.style.cssText =
      'position:fixed;color:#ffd36a;font:11px/1.2 system-ui,sans-serif;text-shadow:0 1px 2px #000;display:none;white-space:nowrap;';
    this.el.append(this.box, this.label);
    this.dots = [];
    document.body.append(this.el);
  }

  /** The dashed box from page px; null hides it. */
  showBox(rect, text) {
    if (rect === null) {
      this.box.style.display = 'none';
      this.label.style.display = 'none';
      return;
    }
    Object.assign(this.box.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(2, rect.right - rect.left)}px`,
      height: `${Math.max(2, rect.bottom - rect.top)}px`,
    });
    this.label.textContent = text;
    Object.assign(this.label.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top - 15}px` });
  }

  /** One dot per lamp: [{ x, y, color, selected, on }] in page px. */
  showDots(list) {
    while (this.dots.length < list.length) {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;width:10px;height:10px;margin:-6px 0 0 -6px;border-radius:50%;border:1px solid #000;';
      this.el.append(d);
      this.dots.push(d);
    }
    for (let k = 0; k < this.dots.length; k++) {
      const d = this.dots[k];
      const p = list[k];
      if (!p) {
        d.style.display = 'none';
        continue;
      }
      d.style.display = 'block';
      d.style.left = `${p.x}px`;
      d.style.top = `${p.y}px`;
      d.style.background = `#${(p.color >>> 0).toString(16).padStart(6, '0')}`;
      d.style.opacity = p.on ? '1' : '0.45';
      d.style.outline = p.selected ? '2px solid #ffd36a' : 'none';
    }
  }

  hide() {
    this.el.style.display = 'none';
  }

  remove() {
    this.el.remove();
  }
}
