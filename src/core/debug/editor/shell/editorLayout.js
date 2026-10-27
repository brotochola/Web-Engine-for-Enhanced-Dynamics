// editorLayout.js — the editor page's docks (VISUAL_EDITOR_PLAN.md ED-50, ED-51): their sizes, which a drag on a
// handle changes, their folds, and the narrow layouts.
//
//   - A handle between the view and each dock (the scene list, the right column, the bottom dock) and one between
//     the Inspector and the Assets. A double click puts its size back to the default.
//   - A fold button on each dock and section; the bar's dock buttons and Ctrl+1 (the scene list), Ctrl+2 (the right
//     column) and Ctrl+3 (the bottom dock) fold and unfold them.
//   - The bottom dock is the debug bar's strip, with the Console's button: a pane of its own height opens above the
//     strip only while the Console or one of the debug bar's panels is open (editorShell.css, :has()).
//   - Below NARROW_PX the side docks narrow: they give up what the window loses, so the view keeps its width down to
//     OVERLAY_PX. Below OVERLAY_PX they are panels over the view, which keeps the whole width; the bar's dock buttons
//     open and close them.
//   - Sizes and folds are this viewer's, kept in localStorage (every access in try/catch: a blocked or full storage
//     leaves the defaults).
//
// Cost: the sizes are CSS custom properties registered as not inherited (editorShell.css, @property), each set on
// the one element that reads it, so a drag restyles that element and lays the page out, nothing more. A pointer move
// writes one property from arithmetic on what the press read: no layout read, and no new string once a value has
// been seen (numberText). Nothing runs while no handle is held.

/** Where this viewer's layout is kept. */
export const LAYOUT_KEY = 'weed.editor.layout';

/** The layout a viewer starts with: widths and the bottom pane's height in px, the Inspector's share of its column. */
export const LAYOUT_DEFAULTS = Object.freeze({
  left: 250,
  right: 320,
  bottom: 240,
  split: 0.6,
  leftFolded: false,
  rightFolded: false,
  bottomFolded: false,
  inspectorFolded: false,
  assetsFolded: false,
  consoleOpen: false,
});

/** The sizes a layout holds, and its folds (booleans). */
export const SIZE_KEYS = Object.freeze(['left', 'right', 'bottom', 'split']);
export const FLAG_KEYS = Object.freeze(['leftFolded', 'rightFolded', 'bottomFolded', 'inspectorFolded', 'assetsFolded', 'consoleOpen']);

/** Each size's bounds, whatever the window: px, and the split as a share. */
export const SIZE_LIMITS = Object.freeze({
  left: Object.freeze([140, 640]),
  right: Object.freeze([200, 760]),
  bottom: Object.freeze([96, 1600]),
  split: Object.freeze([0.15, 0.85]),
});

/** Window widths: below NARROW_PX the side docks narrow; below OVERLAY_PX they open over the view. */
export const NARROW_PX = 1280;
export const OVERLAY_PX = 1100;
/**
 * Between OVERLAY_PX and NARROW_PX a side dock is its size × (width − NARROW_BASE_PX) / NARROW_SPAN_PX: all of it at
 * 1280 px, 70 % at 1100 px. editorShell.css writes the same: `var(--weed-left) * (100vw - 680px) / 600`.
 */
export const NARROW_BASE_PX = 680;
export const NARROW_SPAN_PX = 600;
/** The widest a side dock gets, as a share of the window: docked, and over the view. */
export const DOCKED_MAX_SHARE = Object.freeze({ left: 0.32, right: 0.4 });
export const OVERLAY_MAX_SHARE = 0.85;
/** The bottom pane leaves this much of the window above it: `100vh - 200px` in editorShell.css. */
export const PANE_RESERVE_PX = 200;

/** The docks Ctrl+1, Ctrl+2 and Ctrl+3 fold, and the bar's dock buttons. */
export const DOCK_KEYS = Object.freeze({ 1: 'left', 2: 'right', 3: 'bottom' });
/** The keys, by KeyboardEvent.code, so a keyboard layout that shifts its digits has them too. */
const DIGIT_CODES = Object.freeze({ Digit1: 1, Digit2: 2, Digit3: 3, Numpad1: 1, Numpad2: 2, Numpad3: 3 });

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/** Whether a window this wide shows the side docks over the view. */
export const isOverlay = (viewportWidth) => viewportWidth < OVERLAY_PX;

/** What a side dock's size is multiplied by in a window this wide (1 outside the narrow band). */
export function narrowFactor(viewportWidth) {
  if (viewportWidth >= NARROW_PX || viewportWidth < OVERLAY_PX) return 1;
  return (viewportWidth - NARROW_BASE_PX) / NARROW_SPAN_PX;
}

/** The widest a side dock shows in a window this wide. */
function sideMax(side, viewportWidth) {
  return (isOverlay(viewportWidth) ? OVERLAY_MAX_SHARE : DOCKED_MAX_SHARE[side]) * viewportWidth;
}

/**
 * The width a side dock shows, from its kept size, as editorShell.css works it out (CSS clamp: the minimum wins).
 * @param {'left'|'right'} side
 * @param {number} size - the kept size, px
 * @param {number} viewportWidth
 */
export function sideWidth(side, size, viewportWidth) {
  return clamp(size * narrowFactor(viewportWidth), SIZE_LIMITS[side][0], sideMax(side, viewportWidth));
}

// The functions a drag calls on each move read their bounds by index: no destructuring, which may make an iterator.

/**
 * The size to keep so a side dock shows `width` px (a drag): within what the window allows, then the size's bounds.
 * @param {'left'|'right'} side
 * @param {number} width - px
 * @param {number} viewportWidth
 * @returns {number} whole px
 */
export function sideSizeFor(side, width, viewportWidth) {
  const limits = SIZE_LIMITS[side];
  const shown = clamp(width, limits[0], sideMax(side, viewportWidth));
  return Math.round(clamp(shown / narrowFactor(viewportWidth), limits[0], limits[1]));
}

/** The height the bottom pane shows, from its kept size, in a window this tall. */
export function paneHeight(size, viewportHeight) {
  return clamp(size, SIZE_LIMITS.bottom[0], viewportHeight - PANE_RESERVE_PX);
}

/** The size to keep so the bottom pane shows `height` px (a drag). */
export function paneSizeFor(height, viewportHeight) {
  const limits = SIZE_LIMITS.bottom;
  return Math.round(clamp(clamp(height, limits[0], viewportHeight - PANE_RESERVE_PX), limits[0], limits[1]));
}

/**
 * The split (the Inspector's share of the right column) when the Assets section is `assets` px of a `column` px tall:
 * the Assets' height is (1 − split) of the column (editorShell.css), the Inspector has the rest. To the thousandth.
 */
export function splitFor(assets, column) {
  const limits = SIZE_LIMITS.split;
  const share = column > 0 ? 1 - assets / column : LAYOUT_DEFAULTS.split;
  return Math.round(clamp(share, limits[0], limits[1]) * 1000) / 1000;
}

/** A kept size within its bounds (a value read back from storage). */
export function clampSize(key, value) {
  const limits = SIZE_LIMITS[key];
  const clamped = clamp(value, limits[0], limits[1]);
  return key === 'split' ? Math.round(clamped * 1000) / 1000 : Math.round(clamped);
}

/**
 * This viewer's layout: the defaults, with what storage holds over them where it is a value of the right kind,
 * within its bounds. A storage that throws (blocked), holds no layout or holds something else leaves the defaults.
 * @param {{ getItem(key: string): string|null }|null} storage
 */
export function readLayout(storage) {
  const layout = { ...LAYOUT_DEFAULTS };
  let saved = null;
  try {
    const text = storage === null || storage === undefined ? null : storage.getItem(LAYOUT_KEY);
    saved = typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    saved = null; // blocked storage, or not JSON
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return layout;
  for (const key of SIZE_KEYS) {
    const value = saved[key];
    if (typeof value === 'number' && Number.isFinite(value)) layout[key] = clampSize(key, value);
  }
  for (const key of FLAG_KEYS) if (typeof saved[key] === 'boolean') layout[key] = saved[key];
  return layout;
}

/**
 * Keep this viewer's layout. A storage that throws (blocked, full) keeps nothing.
 * @param {{ setItem(key: string, value: string): void }|null} storage
 * @param {object} layout
 * @returns {boolean} whether it was kept
 */
export function writeLayout(storage, layout) {
  if (storage === null || storage === undefined) return false;
  const kept = {};
  for (const key of SIZE_KEYS) kept[key] = layout[key];
  for (const key of FLAG_KEYS) kept[key] = layout[key] === true;
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** Strings of whole numbers, made once each: a drag writes its property without making a new one per move. */
const NUMBER_TEXT = [];
const NUMBER_TEXT_MAX = 8192;

/** A whole number as text, from a table filled as values are seen. */
export function numberText(n) {
  if (n >= 0 && n < NUMBER_TEXT_MAX && n === (n | 0)) {
    const text = NUMBER_TEXT[n];
    return text === undefined ? (NUMBER_TEXT[n] = String(n)) : text;
  }
  return String(n);
}

/** A share in thousandths as text ('0.400'), from a table filled as values are seen. */
const SHARE_TEXT = [];
export function shareText(thousandths) {
  const k = thousandths | 0;
  if (k < 0 || k > 1000) return String(thousandths / 1000);
  const text = SHARE_TEXT[k];
  return text === undefined ? (SHARE_TEXT[k] = (k / 1000).toFixed(3)) : text;
}

/**
 * The digit of Ctrl+1, Ctrl+2 or Ctrl+3 (Cmd on a Mac), or 0: another key, or with Shift or Alt.
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 */
export function dockKeyOf(e) {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return 0;
  const byCode = DIGIT_CODES[e.code];
  if (byCode !== undefined) return byCode;
  return e.key === '1' ? 1 : e.key === '2' ? 2 : e.key === '3' ? 3 : 0;
}

/** The body classes of the layout's state. */
const FOLD_CLASSES = Object.freeze({
  left: 'weed-fold-left',
  right: 'weed-fold-right',
  bottom: 'weed-fold-bottom',
  inspector: 'weed-fold-inspector',
  assets: 'weed-fold-assets',
});
const OPEN_CLASSES = Object.freeze({ left: 'weed-open-left', right: 'weed-open-right' });
const CONSOLE_CLASS = 'weed-console-open';
const RESIZING_CLASS = 'weed-resizing';
const RESIZING_X_CLASS = 'weed-resizing-x';
const RESIZING_Y_CLASS = 'weed-resizing-y';

/** What a handle sizes. */
const DRAG_NONE = 0;
const DRAG_LEFT = 1;
const DRAG_RIGHT = 2;
const DRAG_BOTTOM = 3;
const DRAG_SPLIT = 4;
const DRAG_KINDS = Object.freeze({ left: DRAG_LEFT, right: DRAG_RIGHT, bottom: DRAG_BOTTOM, split: DRAG_SPLIT });

/**
 * The editor page's elements the layout works with (index.html): found by dockLayoutElements, or made by a test.
 * @typedef {{ body: HTMLElement, left: HTMLElement, right: HTMLElement, bottom: HTMLElement, column: HTMLElement,
 *   assets: HTMLElement, handles: HTMLElement[], folds: HTMLElement[], toggles: HTMLElement[],
 *   consoleTab: HTMLElement|null, consolePane: HTMLElement|null, debugSlot: HTMLElement|null }} LayoutElements
 *   (column: the right dock's column, which the Inspector and the Assets share)
 */

/** The layout's elements in the editor page. */
export function dockLayoutElements(doc) {
  const one = (selector) => doc.querySelector(selector);
  return {
    body: doc.body,
    left: one('[data-dock=left]'),
    right: one('[data-dock=right]'),
    bottom: one('[data-dock=bottom]'),
    column: one('[data-dock=right] > .weed-editor-column'),
    assets: one('[data-section=assets]'),
    handles: [...doc.querySelectorAll('[data-handle]')],
    folds: [...doc.querySelectorAll('[data-fold]')],
    toggles: [...doc.querySelectorAll('[data-toggle]')],
    consoleTab: one('[data-tab=console]'),
    consolePane: one('[data-pane=console]'),
    debugSlot: one('[data-slot=debug]'),
  };
}

export class DockLayout {
  /**
   * @param {LayoutElements} elements
   * @param {{ win: { innerWidth: number, innerHeight: number, matchMedia?: Function }, storage?: object|null }} options
   */
  constructor(elements, { win, storage = null }) {
    this.el = elements;
    this.win = win;
    this.storage = storage;
    /** The layout now: sizes and folds (readLayout's shape). */
    this.layout = readLayout(storage);
    /** Which side docks are open over the view (below OVERLAY_PX): not kept, a narrow window starts with neither. */
    this.openLeft = false;
    this.openRight = false;

    // A drag: what its handle sizes, its pointer, where it was pressed, and what the press read of the layout.
    this._drag = DRAG_NONE;
    this._dragHandle = null;
    this._dragPointer = -1;
    this._dragX = NaN;
    this._dragY = NaN;
    this._dragFrom = NaN;
    this._dragSpan = NaN;
    this._dragViewW = NaN;
    this._dragViewH = NaN;
    this._dragOverlay = false;

    this._onHandleDown = (e) => this._beginDrag(e);
    this._onHandleMove = (e) => this._moveDrag(e);
    this._onHandleUp = (e) => this._endDrag(e);
    this._onHandleReset = (e) => this.resetSize(e.currentTarget.dataset.handle);
    this._onFold = (e) => {
      e.stopPropagation(); // a section's own head folds it too
      this.toggleFold(e.currentTarget.dataset.fold);
    };
    this._onToggle = (e) => this.toggleDock(e.currentTarget.dataset.toggle);
    this._onConsoleTab = () => this.setConsole(!this.layout.consoleOpen);
    // One pane at a time: a debug bar's panel opened while the Console is open closes the Console.
    this._onDebugClick = () => {
      if (this.layout.consoleOpen && this.el.debugSlot?.querySelector('.debug-ui-panel.open')) this.setConsole(false);
    };
    // The debug bar's tabs scroll sideways under a plain wheel when the strip is too narrow for them.
    this._onDebugWheel = (e) => {
      if (e.deltaX !== 0 || e.deltaY === 0) return;
      const header = this.el.debugSlot?.querySelector('.debug-ui-header');
      if (header && header.scrollWidth > header.clientWidth) header.scrollLeft += e.deltaY;
    };
    this._overlayQuery = null;
    this._onOverlayChange = () => this._showToggles();
  }

  /** Show the kept layout and listen to the handles, the fold buttons, the bar's dock buttons and the Console's. */
  start() {
    const el = this.el;
    this.apply();
    for (const handle of el.handles) {
      handle.addEventListener('pointerdown', this._onHandleDown);
      handle.addEventListener('pointermove', this._onHandleMove);
      handle.addEventListener('pointerup', this._onHandleUp);
      handle.addEventListener('pointercancel', this._onHandleUp);
      handle.addEventListener('lostpointercapture', this._onHandleUp);
      handle.addEventListener('dblclick', this._onHandleReset);
    }
    for (const button of el.folds) button.addEventListener('click', this._onFold);
    for (const button of el.toggles) button.addEventListener('click', this._onToggle);
    el.consoleTab?.addEventListener('click', this._onConsoleTab);
    el.debugSlot?.addEventListener('click', this._onDebugClick);
    el.debugSlot?.addEventListener('wheel', this._onDebugWheel, { passive: true });
    // The bar's dock buttons show folds in a wide window and the open panels in a narrow one.
    if (typeof this.win.matchMedia === 'function') {
      this._overlayQuery = this.win.matchMedia(`(width < ${OVERLAY_PX}px)`);
      this._overlayQuery.addEventListener?.('change', this._onOverlayChange);
    }
    return this;
  }

  /** Whether the side docks are panels over the view now. */
  get overlay() {
    return isOverlay(this.win.innerWidth);
  }

  /** Write every size and fold of the layout to the page. */
  apply() {
    const layout = this.layout;
    this._writeSize(DRAG_LEFT, true);
    this._writeSize(DRAG_RIGHT, true);
    this._writeSize(DRAG_BOTTOM, true);
    this._writeSize(DRAG_SPLIT, true);
    const classes = this.el.body.classList;
    classes.toggle(FOLD_CLASSES.left, layout.leftFolded);
    classes.toggle(FOLD_CLASSES.right, layout.rightFolded);
    classes.toggle(FOLD_CLASSES.bottom, layout.bottomFolded);
    classes.toggle(FOLD_CLASSES.inspector, layout.inspectorFolded);
    classes.toggle(FOLD_CLASSES.assets, layout.assetsFolded);
    classes.toggle(OPEN_CLASSES.left, this.openLeft);
    classes.toggle(OPEN_CLASSES.right, this.openRight);
    this._showConsole();
    this._showToggles();
    this._showSections();
  }

  /**
   * Fold or unfold a dock or a section: 'left', 'right', 'bottom', 'inspector' or 'assets'. Below OVERLAY_PX a side
   * dock's fold button closes it over the view instead.
   */
  toggleFold(name) {
    if ((name === 'left' || name === 'right') && this.overlay) {
      this.setOpen(name, false);
      return;
    }
    this.setFolded(name, !this.layout[`${name}Folded`]);
  }

  /** @param {'left'|'right'|'bottom'|'inspector'|'assets'} name */
  setFolded(name, folded) {
    const key = `${name}Folded`;
    if (!(key in this.layout) || this.layout[key] === folded) return;
    this.layout[key] = folded;
    this.el.body.classList.toggle(FOLD_CLASSES[name], folded);
    this._showToggles();
    this._showSections();
    this.save();
  }

  /** Open or close a side dock over the view (below OVERLAY_PX). */
  setOpen(side, open) {
    if (side === 'left') this.openLeft = open;
    else if (side === 'right') this.openRight = open;
    else return;
    this.el.body.classList.toggle(OPEN_CLASSES[side], open);
    this._showToggles();
  }

  /**
   * A dock button of the bar, or its key (Ctrl+1, 2, 3): a side dock folds or unfolds, or below OVERLAY_PX opens or
   * closes over the view; the bottom dock folds or unfolds.
   * @param {'left'|'right'|'bottom'|number} dock - a name, or the key's digit
   * @returns {boolean} whether it was a dock
   */
  toggleDock(dock) {
    const name = typeof dock === 'number' ? DOCK_KEYS[dock] : dock;
    if (name === 'left' || name === 'right') {
      if (this.overlay) this.setOpen(name, !(name === 'left' ? this.openLeft : this.openRight));
      else this.setFolded(name, !this.layout[`${name}Folded`]);
      return true;
    }
    if (name === 'bottom') {
      this.setFolded('bottom', !this.layout.bottomFolded);
      return true;
    }
    return false;
  }

  /**
   * A key typed in the editor page: Ctrl+1, Ctrl+2 and Ctrl+3 are the layout's, before the game page's editor sees
   * them (the browser's own use of them, switching tabs, is prevented).
   * @param {KeyboardEvent} e
   * @returns {boolean} whether the layout took it
   */
  onKey(e) {
    const digit = dockKeyOf(e);
    if (digit === 0) return false;
    e.preventDefault();
    if (!e.repeat) this.toggleDock(digit); // a held key folds once
    return true;
  }

  /** Open or close the Console's pane; opening it closes a debug bar's panel that is open, and unfolds the dock. */
  setConsole(open) {
    if (this.layout.consoleOpen !== open) {
      this.layout.consoleOpen = open;
      this._showConsole();
      this.save();
    }
    if (!open) return;
    if (this.layout.bottomFolded) this.setFolded('bottom', false);
    // The debug bar's tab of the open panel, clicked: the bar closes it as its own click would.
    const tab = this.el.debugSlot?.querySelector('.debug-ui-tab.active');
    if (tab) tab.click();
  }

  /** Put a size back to its default (a double click on its handle). */
  resetSize(name) {
    const kind = DRAG_KINDS[name];
    if (kind === undefined) return;
    this.layout[name] = LAYOUT_DEFAULTS[name];
    this._writeSize(kind, true);
    this.save();
  }

  /** Keep the layout for this viewer. */
  save() {
    return writeLayout(this.storage, this.layout);
  }

  // ---- drags ----

  _beginDrag(e) {
    if (e.button !== 0 || this._drag !== DRAG_NONE) return;
    const handle = e.currentTarget;
    const kind = DRAG_KINDS[handle.dataset.handle];
    if (kind === undefined) return;
    e.preventDefault(); // no text selection, no focus change
    const el = this.el;
    this._drag = kind;
    this._dragHandle = handle;
    this._dragPointer = e.pointerId;
    this._dragX = e.clientX;
    this._dragY = e.clientY;
    this._dragViewW = this.win.innerWidth;
    this._dragViewH = this.win.innerHeight;
    this._dragOverlay = isOverlay(this._dragViewW);
    // What the layout is at the press: the only layout read of the drag.
    if (kind === DRAG_LEFT) this._dragFrom = el.left.getBoundingClientRect().width;
    else if (kind === DRAG_RIGHT) this._dragFrom = el.right.getBoundingClientRect().width;
    else if (kind === DRAG_BOTTOM) this._dragFrom = el.bottom.getBoundingClientRect().height;
    else {
      this._dragFrom = el.assets.getBoundingClientRect().height;
      this._dragSpan = el.column.getBoundingClientRect().height;
    }
    try {
      handle.setPointerCapture?.(e.pointerId);
    } catch {
      // a pointer that is gone already: the drag ends on its pointerup or never moves
    }
    const classes = el.body.classList;
    classes.add(RESIZING_CLASS);
    classes.add(kind === DRAG_BOTTOM || kind === DRAG_SPLIT ? RESIZING_Y_CLASS : RESIZING_X_CLASS);
    handle.classList.add('active');
  }

  _moveDrag(e) {
    const kind = this._drag;
    if (kind === DRAG_NONE || e.pointerId !== this._dragPointer) return;
    const layout = this.layout;
    const dx = e.clientX - this._dragX;
    const dy = e.clientY - this._dragY;
    if (kind === DRAG_LEFT) {
      const size = sideSizeFor('left', this._dragFrom + dx, this._dragViewW);
      if (size === layout.left) return;
      layout.left = size;
    } else if (kind === DRAG_RIGHT) {
      const size = sideSizeFor('right', this._dragFrom - dx, this._dragViewW);
      if (size === layout.right) return;
      layout.right = size;
    } else if (kind === DRAG_BOTTOM) {
      const size = paneSizeFor(this._dragFrom - dy, this._dragViewH);
      if (size === layout.bottom) return;
      layout.bottom = size;
    } else {
      const split = splitFor(this._dragFrom - dy, this._dragSpan);
      if (split === layout.split) return;
      layout.split = split;
    }
    this._writeSize(kind, false);
  }

  _endDrag(e) {
    const kind = this._drag;
    if (kind === DRAG_NONE || e.pointerId !== this._dragPointer) return;
    this._drag = DRAG_NONE;
    this._dragPointer = -1;
    const handle = this._dragHandle;
    this._dragHandle = null;
    try {
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    } catch {
      // released already
    }
    handle.classList.remove('active');
    const classes = this.el.body.classList;
    classes.remove(RESIZING_CLASS);
    classes.remove(RESIZING_X_CLASS);
    classes.remove(RESIZING_Y_CLASS);
    // A side dock's size goes to both places that read it (docked and over the view), once.
    this._writeSize(kind, true);
    this.save();
  }

  /**
   * Write one size where the page reads it: a side dock's width on the body's grid when docked and on the dock itself
   * over the view (a drag writes the one it shows; `both` writes the two), the pane's height on the bottom dock, the
   * split on the Assets section.
   */
  _writeSize(kind, both) {
    const el = this.el;
    const layout = this.layout;
    if (kind === DRAG_LEFT || kind === DRAG_RIGHT) {
      const left = kind === DRAG_LEFT;
      const name = left ? '--weed-left' : '--weed-right';
      const text = numberText(left ? layout.left : layout.right);
      const overlay = this._drag !== DRAG_NONE ? this._dragOverlay : this.overlay;
      if (both || !overlay) el.body.style.setProperty(name, text);
      if (both || overlay) (left ? el.left : el.right).style.setProperty(name, text);
    } else if (kind === DRAG_BOTTOM) {
      el.bottom.style.setProperty('--weed-bottom', numberText(layout.bottom));
    } else {
      el.assets.style.setProperty('--weed-assets', shareText(1000 - Math.round(layout.split * 1000)));
    }
  }

  // ---- what the buttons show ----

  _showConsole() {
    const el = this.el;
    const open = this.layout.consoleOpen;
    el.body.classList.toggle(CONSOLE_CLASS, open);
    if (el.consolePane) el.consolePane.hidden = !open;
    if (el.consoleTab) {
      el.consoleTab.classList.toggle('active', open);
      el.consoleTab.setAttribute('aria-pressed', open ? 'true' : 'false');
    }
  }

  /** The sections' titles say whether their section is open (aria-expanded); their chevron turns in CSS. */
  _showSections() {
    for (const button of this.el.folds) {
      const name = button.dataset.fold;
      if (name === 'inspector' || name === 'assets') {
        button.setAttribute('aria-expanded', this.layout[`${name}Folded`] ? 'false' : 'true');
      }
    }
  }

  /** The bar's dock buttons: pressed while their dock shows (wide: not folded; narrow: open over the view). */
  _showToggles() {
    const overlay = this.overlay;
    const layout = this.layout;
    for (const button of this.el.toggles) {
      const name = button.dataset.toggle;
      let shown;
      if (name === 'left') shown = overlay ? this.openLeft : !layout.leftFolded;
      else if (name === 'right') shown = overlay ? this.openRight : !layout.rightFolded;
      else shown = !layout.bottomFolded;
      button.classList.toggle('active', shown);
      button.setAttribute('aria-pressed', shown ? 'true' : 'false');
    }
  }
}
