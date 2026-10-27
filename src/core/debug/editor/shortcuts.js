// shortcuts.js — the editor's keys on one sheet (VISUAL_EDITOR_PLAN.md ED-69): `?` in edit mode, or the toolbar's ?,
// shows it over the page (the editor page's when the game runs in it); `?`, Esc or a click outside closes it.
//
// Cost: built when opened, removed when closed.

/** What the sheet lists: a heading, then [keys, what they do] rows. */
export const SHORTCUTS = Object.freeze([
  [
    'Modes',
    [
      ['Shift+E', 'edit (the world holds still) or play'],
      ['Esc', 'stop placing, then clear the selection, then leave edit mode'],
      ['?', 'this sheet'],
    ],
  ],
  [
    'Select',
    [
      ['Click', 'select (again on the same spot: the one under it)'],
      ['Shift+click', 'add to the selection, or take out'],
      ['Drag on empty ground', 'select what the box touches'],
      ['Ctrl+A', 'select every placed entity'],
      ['Ctrl+G · Ctrl+Shift+G', 'group · ungroup (a click on one selects the group)'],
    ],
  ],
  [
    'Move and change',
    [
      ['Drag', 'move, on the grid (Alt: off it)'],
      ['Arrows', 'nudge one grid step (Shift: ten)'],
      ['G · Shift+G', 'the snap step · the grid’s lines'],
      ['Ctrl+D', 'duplicate'],
      ['Ctrl+C · Ctrl+X · Ctrl+V', 'copy · cut · paste where the pointer is'],
      ['Del', 'delete'],
      ['Alt+drag', 'a joint’s anchor; Alt+click on a route adds a point'],
      ['[ · ]', 'the decoration brush’s radius; Shift+drag erases'],
    ],
  ],
  [
    'View',
    [
      ['F · Shift+F', 'frame the selection · the whole level'],
      ['Wheel', 'zoom about the pointer'],
      ['Right or middle drag · Space+drag', 'pan'],
      ['W A S D', 'pan'],
    ],
  ],
  [
    'File',
    [
      ['Ctrl+S', 'save the level’s scene file'],
      ['Ctrl+Z · Ctrl+Y', 'undo · redo'],
    ],
  ],
]);

/** The sheet shown in each document, so a second `?` closes it. */
const open = new WeakMap();

/**
 * Show the sheet over `doc`, or close it when it is open there.
 * @param {Document} doc
 * @returns {boolean} whether it is open now
 */
export function toggleShortcutSheet(doc) {
  const shown = open.get(doc);
  if (shown) {
    shown.close();
    return false;
  }
  const backdrop = doc.createElement('div');
  backdrop.dataset.shortcuts = '';
  backdrop.style.cssText =
    'position:fixed;inset:0;z-index:100000;background:rgba(5,7,12,0.55);display:flex;align-items:center;justify-content:center;padding:16px';
  const sheet = doc.createElement('div');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Editor keys');
  sheet.style.cssText =
    'background:#141824;color:#dfe3ee;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:14px 18px;' +
    'max-width:min(760px,100%);max-height:100%;overflow:auto;font:12px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.5);' +
    'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:4px 24px';
  for (const [heading, rows] of SHORTCUTS) {
    const group = doc.createElement('div');
    const title = doc.createElement('div');
    title.textContent = heading;
    title.style.cssText = 'font-weight:600;color:#34d399;margin:6px 0 2px';
    group.appendChild(title);
    for (const [keys, action] of rows) {
      const row = doc.createElement('div');
      row.style.cssText = 'display:flex;gap:10px';
      const k = doc.createElement('span');
      k.textContent = keys;
      k.style.cssText = 'flex:none;width:118px;color:#fff;font-family:ui-monospace,monospace;font-size:11px';
      const a = doc.createElement('span');
      a.textContent = action;
      a.style.cssText = 'color:#aab0c0';
      row.append(k, a);
      group.appendChild(row);
    }
    sheet.appendChild(group);
  }
  backdrop.appendChild(sheet);
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    open.delete(doc);
    doc.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  };
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(backdrop);
  open.set(doc, { close });
  return true;
}
