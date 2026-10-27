// inspectorSection.js — the inspector's sections that fold (VISUAL_EDITOR_PLAN.md ED-54), as Unity's component
// headers: a header line (▾ or ▸, the title, a short note, actions on the right) over a body. A click on the header
// folds or opens it; each section's fold is remembered per viewer (localStorage, every access guarded) across
// selections and reloads. A section whose open state follows the entity (Joints opens when there are joints) is
// shown so without remembering it.
//
// Cost: made once with the inspector; a fold writes two styles.

const FOLDS_KEY = 'weed.editor.inspectorFolds';

/** The remembered folds, read once: key → open. */
let folds = null;

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function rememberedFolds() {
  if (folds !== null) return folds;
  folds = {};
  try {
    const parsed = JSON.parse(storage()?.getItem(FOLDS_KEY) || '{}');
    if (parsed && typeof parsed === 'object') folds = parsed;
  } catch {
    // blocked or not JSON: the defaults
  }
  return folds;
}

/** Forget what was read (tests: another storage). */
export function resetRememberedFolds() {
  folds = null;
}

export class InspectorSection {
  /**
   * @param {string} key - what its fold is remembered by
   * @param {string} title
   * @param {{ open?: boolean, onToggle?: (open: boolean) => void }} [options] - open: the first time it is shown
   */
  constructor(key, title, { open = true, onToggle = null } = {}) {
    this.key = key;
    this.onToggle = onToggle;
    const remembered = rememberedFolds()[key];
    this.open = typeof remembered === 'boolean' ? remembered : open;

    this.el = document.createElement('section');
    this.el.dataset.section = key;
    this.el.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08);padding:4px 0 2px';
    this.head = document.createElement('div');
    this.head.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;min-height:20px';
    this.head.title = 'Fold or open (remembered)';
    this._arrow = document.createElement('span');
    this._arrow.style.cssText = 'width:10px;color:#8a90a0;font-size:10px;flex:none';
    this._title = document.createElement('span');
    this._title.textContent = title;
    this._title.style.cssText = 'font-size:11px;font-weight:bold;color:#dfe3ee;letter-spacing:0.02em';
    this.note = document.createElement('span');
    this.note.style.cssText = 'font-size:10px;color:#777;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    /** Buttons on the header's right (they do not fold it). */
    this.actions = document.createElement('span');
    this.actions.style.cssText = 'display:flex;gap:4px;flex:none';
    this.head.append(this._arrow, this._title, this.note, this.actions);
    this.head.onclick = (e) => {
      if (e.target !== this.head && this.actions.contains?.(e.target)) return;
      this.setOpen(!this.open, true);
    };
    this.body = document.createElement('div');
    this.body.style.cssText = 'padding:4px 0 2px 2px';
    this.el.append(this.head, this.body);
    this._show();
  }

  set title(text) {
    this._title.textContent = text;
  }

  /** Show or hide the whole section (an entity it has nothing for). */
  set visible(visible) {
    this.el.style.display = visible ? '' : 'none';
  }

  /**
   * @param {boolean} open
   * @param {boolean} remember - a click on its header: kept for the next selection and the next visit
   */
  setOpen(open, remember) {
    if (remember) {
      const remembered = rememberedFolds();
      remembered[this.key] = open;
      try {
        storage()?.setItem(FOLDS_KEY, JSON.stringify(remembered));
      } catch {
        // full or blocked: this page remembers
      }
    }
    if (open === this.open) return;
    this.open = open;
    this._show();
    this.onToggle?.(open);
  }

  /** The fold the author chose last, or `fallback` when they never chose. */
  rememberedOpen(fallback) {
    const remembered = rememberedFolds()[this.key];
    return typeof remembered === 'boolean' ? remembered : fallback;
  }

  _show() {
    this._arrow.textContent = this.open ? '▾' : '▸';
    this.body.style.display = this.open ? '' : 'none';
  }
}
