// treeMenu.js — the scene list's context menu (VISUAL_EDITOR_PLAN.md ED-64): a right click on a row of the editor
// page's scene list (entityTree.js) offers what applies to that row.
//
// - A placed entity (in the scene file): Frame, Rename, Duplicate, Copy, Delete, and Select all of its class.
// - A runtime one (spawned by code, read-only): Frame, and Select all of its class.
// - A class's row: Select all of it.
//
// The edits act on the selection, as the editor's keys do: a right click on an entity outside the selection selects
// it first; on one of several selected, Duplicate, Copy and Delete act on all of them (their labels say how many).
// Copy shows only when the editor has it (EditMode.copySelected, ED-59). "Select all" takes the class's placed
// entities (only placed ones can be selected together); under a filter, the ones it keeps.
//
// The menu is made in the list's own document (in the editor page, the editor page's, where the list is docked),
// above everything, at the pointer and inside the viewport. Esc, a click elsewhere, the window losing the focus (a
// click in the game's frame), the list scrolling or a pick closes it. ↑ ↓ move along its items, Enter picks one; its
// keys stop at it, so none reaches the editor's own (a key with Ctrl or Alt closes it and goes on).
//
// Cost: its few elements are made on each open and dropped from the document when it closes; its listeners on the
// document and the window are there only while it is open.

export const ITEM_FRAME = 'frame';
export const ITEM_RENAME = 'rename';
export const ITEM_DUPLICATE = 'duplicate';
export const ITEM_COPY = 'copy';
export const ITEM_DELETE = 'delete';
export const ITEM_SELECT_ALL = 'selectAll';
/** A line between items, not an item. */
export const ITEM_SEPARATOR = 'separator';

// What a menu is for.
export const TARGET_GROUP = 'group';
export const TARGET_PLACED = 'placed';
export const TARGET_RUNTIME = 'runtime';
/** A record of the file without a live entity (its pool may be full). */
export const TARGET_NOT_LIVE = 'notLive';

/** Space kept between the menu and the viewport's edges, px. */
const MARGIN = 4;

const MENU_STYLE =
  'position:fixed;z-index:2147483000;left:0;top:0;visibility:hidden;min-width:190px;max-width:340px;box-sizing:border-box;' +
  'padding:4px 0;background:#1b1f2b;border:1px solid #343a4c;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);' +
  "font:12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#e3e6ee;outline:none;user-select:none;overflow-y:auto";
const CAPTION_STYLE =
  'padding:2px 12px 5px;margin-bottom:4px;border-bottom:1px solid #262b38;color:#8a90a0;font-size:11px;white-space:nowrap;' +
  'overflow:hidden;text-overflow:ellipsis';
const ITEM_STYLE = 'display:flex;align-items:center;gap:20px;padding:3px 12px;white-space:nowrap';
const HINT_STYLE = 'margin-left:auto;color:#8a90a0;font-size:11px';
const SEPARATOR_STYLE = 'height:1px;margin:4px 0;background:#262b38';
const ACTIVE = 'rgba(74,222,128,0.18)';
const TEXT = '#e3e6ee';
const DISABLED = '#5d6375';

/**
 * @typedef {{ id: string, label: string, hint: string, title: string, disabled: boolean }} MenuItem
 * @typedef {{ caption: string, items: MenuItem[] }} Menu
 */

const item = (id, label, hint, title, disabled = false) => ({ id, label, hint, title, disabled });
const SEPARATOR = Object.freeze(item(ITEM_SEPARATOR, '', '', ''));

/**
 * The menu for a row: what applies to it, each item with its key and a hover title.
 * @param {{ kind: string, className: string, name?: string|null, index?: number, selected?: number, placed: number,
 *   matching: number, runtime?: number, filtered?: boolean, canCopy?: boolean }} target
 *   - name, index: the row's entity (its name in the file; a runtime one has none)
 *   - selected: how many placed entities the edits act on (the row's alone, or the selection it is part of)
 *   - placed: the class's placed entities; matching: the ones the filter keeps (all of them without a filter)
 *   - canCopy: the editor has Copy (EditMode.copySelected)
 * @returns {Menu}
 */
export function menuFor(target) {
  const { kind, className, placed, matching } = target;
  const name = target.name ?? null;
  const items = [];
  let caption;
  if (kind === TARGET_PLACED) {
    const n = Math.max(1, target.selected ?? 1);
    const several = n > 1;
    caption = several ? `${name} and ${n - 1} more selected` : `${name}  ·  ${className}`;
    items.push(
      item(ITEM_FRAME, 'Frame', 'Enter', several ? 'Move the view onto the selected entities (Enter)' : `Move the view onto ${name} (Enter, or a double click)`),
      item(ITEM_RENAME, 'Rename…', 'F2', `Rename ${name} in the scene file; the params, joints and groups that name it follow (F2)`),
      item(
        ITEM_DUPLICATE,
        several ? `Duplicate ${n}` : 'Duplicate',
        'Ctrl+D',
        several ? 'A copy of each, a grid step away, named anew; one undo (Ctrl+D)' : 'A copy, a grid step away, named anew (Ctrl+D)',
      ),
    );
    if (target.canCopy === true) {
      items.push(
        item(
          ITEM_COPY,
          several ? `Copy ${n}` : 'Copy',
          'Ctrl+C',
          'Copy the records (with the joints between them) to paste with Ctrl+V, in this level or another (Ctrl+C)',
        ),
      );
    }
    items.push(
      item(
        ITEM_DELETE,
        several ? `Delete ${n}` : 'Delete',
        'Del',
        several ? 'Take them out of the scene file, as one undo (Del)' : `Take ${name} out of the scene file; Ctrl+Z puts it back (Del)`,
      ),
    );
  } else if (kind === TARGET_RUNTIME) {
    caption = `${className} #${target.index}  ·  spawned by code, read-only`;
    items.push(item(ITEM_FRAME, 'Frame', 'Enter', 'Move the view onto it (Enter, or a double click)'));
  } else if (kind === TARGET_NOT_LIVE) {
    caption = `${name}  ·  not live: its pool may be full`;
    items.push(item(ITEM_FRAME, 'Frame', 'Enter', 'Not live: nothing in the view to frame', true));
  } else {
    caption = `${className}  ·  ${placed} placed, ${target.runtime ?? 0} runtime`;
  }
  if (items.length > 0) items.push(SEPARATOR);
  items.push(selectAllItem(className, placed, matching, target.filtered === true));
  return { caption, items };
}

/** "Select all <Class>": the class's placed entities, or under a filter the ones it keeps. */
function selectAllItem(className, placed, matching, filtered) {
  const some = filtered && matching < placed;
  const count = some ? matching : placed;
  if (count === 0) {
    return item(
      ITEM_SELECT_ALL,
      `Select all ${className}`,
      '',
      some
        ? `The filter keeps no placed ${className}`
        : `No ${className} is placed by the scene file: entities spawned by code cannot be selected together`,
      true,
    );
  }
  return some
    ? item(ITEM_SELECT_ALL, `Select the ${count} matching ${className}`, '', `Select the placed ${className} the filter keeps: a move, Del and Ctrl+D act on all of them`)
    : item(ITEM_SELECT_ALL, `Select all ${className} (${count})`, '', `Select every placed ${className}: a move, Del and Ctrl+D act on all of them`);
}

/**
 * Where a menu of `width` × `height` opened at (x, y) goes inside a viewport: to the left of the point when it does not
 * fit to its right, above it when it does not fit below, and never past an edge.
 * @returns {[number, number]} its left and top, viewport px
 */
export function placeMenu(x, y, width, height, viewWidth, viewHeight) {
  let left = x;
  if (left + width > viewWidth - MARGIN) left = viewWidth - MARGIN - width;
  if (left < MARGIN) left = MARGIN;
  let top = y;
  if (top + height > viewHeight - MARGIN) top = y - height;
  if (top + height > viewHeight - MARGIN) top = viewHeight - MARGIN - height;
  if (top < MARGIN) top = MARGIN;
  return [left, top];
}

export class TreeMenu {
  /** @param {(id: string) => void} onPick - an item was picked (the menu has closed) */
  constructor(onPick) {
    this._onPick = onPick;
    /** The menu's element while it is open, else null. */
    this.el = null;
    this._doc = null;
    this._win = null;
    /** The items shown, and their elements (null for a separator). */
    this._items = [];
    this._itemEls = [];
    /** The item ↑ ↓ and the pointer are on, or -1. */
    this._active = -1;
    /** Where the focus goes back to when the menu closes on a key or a pick: the list. */
    this._returnFocus = null;

    this._onOutside = (e) => {
      if (this.el !== null && !this.el.contains(e.target)) this.close(false);
    };
    this._onWindowBlur = () => this.close(false);
    this._onKeyDown = (e) => this._key(e);
    this._onPointerMove = (e) => this._hover(e);
    this._onClick = (e) => this._clicked(e);
    this._onContextMenu = (e) => e.preventDefault();
  }

  get isOpen() {
    return this.el !== null;
  }

  /** The labels shown, in order ('—' for a separator): what a test or a smoke reads. */
  get labels() {
    return this._items.map((it) => (it.id === ITEM_SEPARATOR ? '—' : it.label));
  }

  /**
   * Open at a point of the viewport (client px), inside it.
   * @param {Document} doc - the list's document
   * @param {number} x
   * @param {number} y
   * @param {Menu} menu
   * @param {{ keyboard?: boolean, returnFocus?: { focus(): void }|null }} [options] - opened by a key: its first item
   *   active
   */
  open(doc, x, y, menu, { keyboard = false, returnFocus = null } = {}) {
    this.close(false);
    const el = doc.createElement('div');
    el.setAttribute('role', 'menu');
    el.tabIndex = -1;
    el.style.cssText = MENU_STYLE;
    const caption = doc.createElement('div');
    caption.style.cssText = CAPTION_STYLE;
    caption.textContent = menu.caption;
    caption.title = menu.caption;
    el.appendChild(caption);
    const items = [];
    const itemEls = [];
    for (const it of menu.items) {
      const row = doc.createElement('div');
      if (it.id === ITEM_SEPARATOR) {
        row.style.cssText = SEPARATOR_STYLE;
        el.appendChild(row);
        items.push(it);
        itemEls.push(null);
        continue;
      }
      row.setAttribute('role', 'menuitem');
      row.dataset.item = String(items.length);
      row.style.cssText = ITEM_STYLE;
      row.style.color = it.disabled ? DISABLED : TEXT;
      row.style.cursor = it.disabled ? 'default' : 'pointer';
      if (it.disabled) row.setAttribute('aria-disabled', 'true');
      row.title = it.title;
      const label = doc.createElement('span');
      label.textContent = it.label;
      row.appendChild(label);
      if (it.hint !== '') {
        const hint = doc.createElement('span');
        hint.style.cssText = HINT_STYLE;
        hint.textContent = it.hint;
        row.appendChild(hint);
      }
      el.appendChild(row);
      items.push(it);
      itemEls.push(row);
    }
    el.addEventListener('keydown', this._onKeyDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('click', this._onClick);
    el.addEventListener('contextmenu', this._onContextMenu);
    doc.body.appendChild(el);

    // Measured where it is, then put in place: inside the viewport.
    const view = doc.defaultView;
    const viewWidth = doc.documentElement?.clientWidth || view?.innerWidth || 0;
    const viewHeight = doc.documentElement?.clientHeight || view?.innerHeight || 0;
    const rect = el.getBoundingClientRect();
    if (viewHeight > 0 && rect.height > viewHeight - 2 * MARGIN) el.style.maxHeight = `${viewHeight - 2 * MARGIN}px`;
    const [left, top] = placeMenu(x, y, rect.width, Math.min(rect.height, Math.max(0, viewHeight - 2 * MARGIN)), viewWidth, viewHeight);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = '';

    this.el = el;
    this._doc = doc;
    this._win = view ?? null;
    this._items = items;
    this._itemEls = itemEls;
    this._active = -1;
    this._returnFocus = returnFocus;
    doc.addEventListener('pointerdown', this._onOutside, true);
    this._win?.addEventListener('blur', this._onWindowBlur);
    this._win?.addEventListener('resize', this._onWindowBlur);
    el.focus();
    if (keyboard) this._move(1);
  }

  /** Close (the focus back to the list when `refocus`: a key or a pick). */
  close(refocus) {
    const el = this.el;
    if (el === null) return;
    this.el = null;
    this._doc.removeEventListener('pointerdown', this._onOutside, true);
    this._win?.removeEventListener('blur', this._onWindowBlur);
    this._win?.removeEventListener('resize', this._onWindowBlur);
    el.removeEventListener('keydown', this._onKeyDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('click', this._onClick);
    el.removeEventListener('contextmenu', this._onContextMenu);
    const returnFocus = this._returnFocus;
    this._doc = null;
    this._win = null;
    this._items = [];
    this._itemEls = [];
    this._active = -1;
    this._returnFocus = null;
    if (refocus && returnFocus !== null) returnFocus.focus();
    el.remove();
  }

  /** Its keys stop at it: ↑ ↓ Home End move, Enter or Space picks, Esc or Tab closes. Ctrl or Alt: closes, goes on. */
  _key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      this.close(true);
      return;
    }
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        this._move(1);
        break;
      case 'ArrowUp':
        this._move(-1);
        break;
      case 'Home':
        this._active = -1;
        this._move(1);
        break;
      case 'End':
        this._active = this._items.length;
        this._move(-1);
        break;
      case 'Enter':
      case ' ':
        this._pick(this._active);
        break;
      case 'Escape':
      case 'Tab':
        this.close(true);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  /** The next enabled item from the active one (wrapping round). */
  _move(step) {
    const count = this._items.length;
    if (count === 0) return;
    let at = this._active;
    for (let k = 0; k < count; k++) {
      at = (((at + step) % count) + count) % count;
      const it = this._items[at];
      if (it.id !== ITEM_SEPARATOR && !it.disabled) {
        this._setActive(at);
        return;
      }
    }
  }

  _setActive(at) {
    if (at === this._active) return;
    const old = this._itemEls[this._active];
    if (old) old.style.background = '';
    this._active = at;
    const el = this._itemEls[at];
    if (el) el.style.background = ACTIVE;
  }

  _hover(e) {
    const at = this._itemAt(e.target);
    if (at >= 0 && !this._items[at].disabled) this._setActive(at);
  }

  _clicked(e) {
    const at = this._itemAt(e.target);
    if (at >= 0) this._pick(at);
  }

  _itemAt(target) {
    const el = target?.closest ? target.closest('[data-item]') : null;
    return el === null ? -1 : Number(el.dataset.item);
  }

  _pick(at) {
    const it = at >= 0 ? this._items[at] : null;
    if (!it || it.disabled || it.id === ITEM_SEPARATOR) return;
    this.close(true);
    this._onPick(it.id);
  }
}
