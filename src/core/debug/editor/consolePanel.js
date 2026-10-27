// consolePanel.js — the editor page's console (VISUAL_EDITOR_PLAN.md ED-18): what the game page and its workers log
// while the editor page shows it (consoleForward.js), and the game code errors the workers report (entityError: one
// row per distinct error, its count kept up to date; a click selects the entity that threw). Levels can be hidden,
// the text filtered, the list cleared.
//
// Cost: an entry is kept in a list of at most MAX_ENTRIES; its row is drawn at the debug UI's next tick, with the
// others that came since, so a burst of logs is one DOM write. The same line again (level, source and text) only
// counts on its row.

/** Rows kept; older ones go. */
export const MAX_ENTRIES = 1000;

const LEVEL_COLORS = { error: '#f87171', warn: '#fbbf24', info: '#93c5fd', log: '#d6d9e2', debug: '#8a90a0' };
const ROW_STYLE = 'display:flex;gap:8px;padding:2px 8px;border-bottom:1px solid rgba(255,255,255,0.04);font:11px/1.45 monospace';

/** Which filter a level is under: errors, warnings, or the rest. */
const groupOf = (level) => (level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log');

export class ConsolePanel {
  /** @param {object} debugUI */
  constructor(debugUI) {
    this.debugUI = debugUI;
    /** Kept entries, oldest first: { level, source, text, count, entityIndex, row, countEl }. */
    this.entries = [];
    /** Entries not drawn yet. */
    this._pending = [];
    /** entityError key → its entry. */
    this._errors = new Map();
    this._shown = { error: true, warn: true, log: true };
    this._filter = '';

    this.el = document.createElement('div');
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.08);flex:none';
    const clear = this._button('Clear', () => this.clear());
    this._toggles = {};
    for (const [group, label] of [
      ['error', 'Errors'],
      ['warn', 'Warnings'],
      ['log', 'Logs'],
    ]) {
      const toggle = this._button(label, () => {
        this._shown[group] = !this._shown[group];
        toggle.classList.toggle('active', this._shown[group]);
        this._applyFilter();
      });
      toggle.classList.add('active');
      this._toggles[group] = toggle;
      bar.appendChild(toggle);
    }
    const filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = 'Filter';
    filter.spellcheck = false;
    filter.style.cssText =
      'flex:1;min-width:0;font:11px monospace;padding:2px 6px;background:rgba(0,0,0,0.45);color:#fff;' +
      'border:1px solid rgba(255,255,255,0.18);border-radius:3px';
    filter.oninput = () => {
      this._filter = filter.value.trim().toLowerCase();
      this._applyFilter();
    };
    bar.append(filter, clear);
    this._list = document.createElement('div');
    this._list.dataset.consoleRows = '';
    this._list.style.cssText = 'flex:1;min-height:0;overflow:auto';
    this._list.onclick = (e) => this._clicked(e);
    this.el.append(bar, this._list);
  }

  /**
   * A console call of the page or a worker.
   * @param {string} source - 'page', or the worker's name
   * @param {string} level - log, info, warn, error, debug
   * @param {string} text
   */
  add(source, level, text) {
    const last = this._pending.length > 0 ? this._pending[this._pending.length - 1] : this.entries[this.entries.length - 1];
    if (last && last.level === level && last.source === source && last.text === text && last.entityIndex < 0) {
      last.count++;
      if (last.countEl) last.countEl.textContent = `×${last.count}`;
      return;
    }
    this._push({ level, source, text, count: 1, entityIndex: -1, row: null, countEl: null });
  }

  /**
   * A game code error a worker reported (Scene._onEntityError): one row per distinct error, its count updated.
   * @param {string} key
   * @param {{ phase: string, className: string, entityIndex: number, message: string, counts: Map<string, number> }} rec
   */
  entityError(key, rec) {
    let count = 0;
    for (const n of rec.counts.values()) count += n;
    const known = this._errors.get(key);
    if (known !== undefined) {
      known.count = count;
      if (known.countEl) known.countEl.textContent = `×${count}`;
      return;
    }
    const who = rec.className ? `${rec.className}${rec.entityIndex >= 0 ? ` #${rec.entityIndex}` : ''} · ` : '';
    const entry = {
      level: 'error',
      source: [...rec.counts.keys()].join(', '),
      text: `${who}${rec.phase} threw: ${rec.message}`,
      count,
      entityIndex: rec.entityIndex,
      row: null,
      countEl: null,
    };
    this._errors.set(key, entry);
    this._push(entry);
  }

  /** Another scene: its errors are new rows, the old rows stay. */
  newScene() {
    this._errors.clear();
  }

  clear() {
    this.entries.length = 0;
    this._pending.length = 0;
    this._errors.clear();
    this._list.textContent = '';
  }

  /** The debug UI's tick: draw what came since the last one. */
  update() {
    const pending = this._pending;
    if (pending.length === 0) return;
    const list = this._list;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    for (let i = 0; i < pending.length; i++) list.appendChild(this._row(pending[i]));
    pending.length = 0;
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  _push(entry) {
    this.entries.push(entry);
    this._pending.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      const old = this.entries.shift();
      if (old.row) old.row.remove();
      else this._pending.splice(this._pending.indexOf(old), 1);
      for (const [key, e] of this._errors) if (e === old) this._errors.delete(key);
    }
  }

  _row(entry) {
    const row = document.createElement('div');
    row.style.cssText = ROW_STYLE;
    row.style.color = LEVEL_COLORS[entry.level] || LEVEL_COLORS.log;
    if (entry.entityIndex >= 0) {
      row.style.cursor = 'pointer';
      row.title = 'Select the entity that threw';
      row.dataset.entity = String(entry.entityIndex);
    }
    const source = document.createElement('span');
    source.textContent = entry.source;
    source.style.cssText = 'color:#6b7080;flex:none;min-width:52px';
    const text = document.createElement('span');
    text.textContent = entry.text;
    text.style.cssText = 'flex:1;min-width:0;white-space:pre-wrap;word-break:break-word';
    const count = document.createElement('span');
    count.textContent = entry.count > 1 ? `×${entry.count}` : '';
    count.style.cssText = 'color:#8a90a0;flex:none';
    row.append(source, text, count);
    entry.row = row;
    entry.countEl = count;
    row.style.display = this._visible(entry) ? '' : 'none';
    return row;
  }

  _visible(entry) {
    if (!this._shown[groupOf(entry.level)]) return false;
    const filter = this._filter;
    return filter === '' || entry.text.toLowerCase().includes(filter) || entry.source.toLowerCase().includes(filter);
  }

  _applyFilter() {
    for (const entry of this.entries) if (entry.row) entry.row.style.display = this._visible(entry) ? '' : 'none';
  }

  _clicked(e) {
    const row = e.target.closest ? e.target.closest('[data-entity]') : null;
    if (!row) return;
    const index = Number(row.dataset.entity);
    const editMode = this.debugUI.editMode;
    if (this.debugUI.scene && index >= 0) editMode.selectFromList(index, true);
  }

  _button(text, onclick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'weed-editor-button';
    button.textContent = text;
    button.onclick = onclick;
    return button;
  }
}
