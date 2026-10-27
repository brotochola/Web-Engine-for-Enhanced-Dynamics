// scatterBrush.js — the editor's scatter brush for decorations (VISUAL_EDITOR_PLAN.md ED-25): grass, rocks, flowers
// painted into the running scene file's `decorations` section, one decoration class at a time.
//
// The Decorations section of the palette (the editor page's Assets dock) lists the scene's decoration classes
// (`static decorations`) with how many the file places, a Paint button each, and the brush's radius (world px) and
// density (decorations per 100 × 100 px). With a class chosen, a drag on the view fills the brush's circle up to the
// density, at random points inside it on the editor's grid (G), each new decoration with its own draw of what the
// class varies (a texture among several, a scale, rotation, alpha or tint range); Shift+drag takes the class's
// decorations out of the circle instead. A dab is made at the press and each time the pointer has gone a third of the
// radius; each dab spawns or despawns only its own decorations (sceneDecorations.js). One stroke is one undo, kind
// 'decorations': the class's record before and after, as data. [ and ] change the radius; Esc puts the brush down.
//
// The brush's circle is drawn on the overlay from fields, with no allocation per frame; the overlay runs while the
// brush is up (wantsOverlay). The palette's section changes only when the document or the brush does.

import {
  DECORATION_VALUE_KEYS,
  decorationClassOf,
  decorationClassProblem,
  decorationKeyVaries,
  drawDecorationValue,
} from '../../sceneFileDecorations.js';
import { snapTo } from './moveTool.js';
import {
  decorationRecordOf,
  decorationCounts,
  indicesOf,
  spawnRecordDecorations,
  syncRecord,
  removeDecorationRecord,
} from './sceneDecorations.js';
import { DecorationPool } from '../../decorationPool.js';

const TWO_PI = Math.PI * 2;
const PAINT_COLOR = 'rgba(74, 222, 128, 0.9)';
const ERASE_COLOR = 'rgba(248, 113, 113, 0.95)';
const ERASE_DASH = Object.freeze([5, 4]);
const NO_DASH = Object.freeze([]);
/** A dab each time the pointer has gone this share of the radius. */
const DAB_SPACING = 1 / 3;
const MIN_RADIUS = 4;
const MAX_RADIUS = 2000;

const FIELD_STYLE =
  'width:52px;font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;box-sizing:border-box';

/** A value as the file writes it: whole for frame and tint, else at most three decimals. */
function fileValue(key, value) {
  if (key === 'frame' || key === 'tint') return Math.round(value);
  return Math.round(value * 1000) / 1000;
}

export class ScatterBrush {
  /** @param {object} editMode */
  constructor(editMode) {
    this.editMode = editMode;
    /** The decoration class being painted, or null: the brush is down. */
    this.className = null;
    /** The circle's radius, world px. */
    this.radius = 64;
    /** Decorations per 100 × 100 px that a dab fills its circle up to. */
    this.density = 12;
    /** Random numbers in [0, 1): where decorations land, and what each draws from its class. */
    this.random = Math.random;
    // The pointer in the world, whether it is over the view, and whether Shift is held (erase).
    this._x = NaN;
    this._y = NaN;
    this._over = false;
    this._shift = false;
    /** The stroke under way: its class, its record's place and copy before it, erasing or not, the last dab. */
    this._stroke = null;
    /** The class's decorations inside the circle of a dab (their positions in the record), reused. */
    this._inside = [];
    this._section = null;
  }

  get scene() {
    return this.editMode.debugUI.scene;
  }

  /** Whether the overlay should run for the brush's circle. */
  wantsOverlay() {
    return this.className !== null;
  }

  /**
   * Take up the brush with a decoration class, or put it down (null, or the class it has).
   * @param {string|null} className
   */
  select(className) {
    const editMode = this.editMode;
    const next = className === this.className ? null : className;
    if (next !== null && !editMode.active) {
      // The editor page's palette shows while the game plays: back to editing first (EditMode.edit, ED-80).
      if (editMode.debugUI.hosted) {
        editMode.edit().then((editing) => {
          if (editing && this.className !== next) this.select(next);
        });
      }
      return;
    }
    if (next !== null && editMode.placing !== null) editMode.startPlacing(editMode.placing); // placing stops
    this.className = next;
    this._stroke = null;
    const canvas = editMode.debugUI.canvas;
    if (next !== null) canvas?.startLoop?.();
    else canvas?.syncLoop?.();
    this.refreshPalette();
    editMode._notify?.();
  }

  // ---- the tool (EditMode.addTool) ----

  press(x, y, e) {
    if (this.className === null) return false;
    const scene = this.scene;
    if (!scene?.sceneFile) {
      this.editMode._setStatus('This scene was not loaded from a scene file: there is nothing to paint into', true);
      return true;
    }
    const decl = decorationClassOf(scene.constructor, this.className);
    const problem = decl === null ? `it is not in ${scene.constructor.name}.decorations` : decorationClassProblem(decl);
    if (problem !== null) {
      this.editMode._setStatus(`${this.className} cannot be painted: ${problem}`, true);
      return true;
    }
    if (!(scene.config?.decoration?.maxDecorations > 0)) {
      this.editMode._setStatus(`${scene.constructor.name} has no decoration pool: set its config.decoration.maxDecorations`, true);
      return true;
    }
    this._track(x, y, e);
    const found = decorationRecordOf(scene, this.className);
    this._stroke = {
      className: this.className,
      doc: scene.sceneFile,
      at: found === null ? (scene.sceneFile.decorations?.length ?? 0) : found.position,
      before: found === null ? null : structuredClone(found.record),
      erase: e?.shiftKey === true,
      lastX: x,
      lastY: y,
    };
    this._dab(x, y);
    return true;
  }

  move(x, y, e) {
    this._track(x, y, e);
    const stroke = this._stroke;
    if (stroke === null) return;
    const dx = x - stroke.lastX;
    const dy = y - stroke.lastY;
    const spacing = Math.max(MIN_RADIUS, this.radius * DAB_SPACING);
    if (dx * dx + dy * dy < spacing * spacing) return;
    stroke.lastX = x;
    stroke.lastY = y;
    this._dab(x, y);
  }

  release() {
    this._finish();
  }

  hover(x, y, e) {
    this._track(x, y, e);
  }

  onKey(e) {
    if (this.className === null || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Escape') {
      this.select(null);
      return true;
    }
    if (e.key === '[' || e.key === ']') {
      this.setRadius(e.key === ']' ? this.radius * 1.25 : this.radius / 1.25);
      return true;
    }
    return false;
  }

  /**
   * Edit mode left, or a swap: a stroke under way is kept when its document is still the running one, and the
   * overlay stops drawing the circle (it stops, and clears, when nothing else draws).
   */
  cancel() {
    const stroke = this._stroke;
    if (stroke !== null && this.scene?.sceneFile === stroke.doc) this._finish();
    this._stroke = null;
    this._over = false;
    if (this.className !== null) this.editMode.debugUI.canvas?.syncLoop?.();
  }

  setRadius(radius) {
    const r = Number(radius);
    if (!Number.isFinite(r)) return;
    this.radius = Math.round(Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, r)));
    this._refreshFields();
  }

  setDensity(density) {
    const d = Number(density);
    if (Number.isFinite(d) && d > 0) this.density = Math.min(400, d);
    this._refreshFields();
  }

  _track(x, y, e) {
    this._x = x;
    this._y = y;
    if (e) {
      this._shift = e.shiftKey === true;
      const canvas = this.editMode.debugUI.gameEngine?.canvas;
      this._over = canvas === undefined || e.target === canvas;
    }
    // Edit mode entered again with the brush up: the overlay runs again (a no-op while it runs).
    if (this.className !== null) this.editMode.debugUI.canvas?.startLoop?.();
  }

  // ---- painting ----

  _dab(x, y) {
    const scene = this.scene;
    const stroke = this._stroke;
    if (stroke === null || scene.sceneFile !== stroke.doc) return;
    if (stroke.erase) this._erase(scene, x, y);
    else this._paint(scene, x, y);
  }

  /** Fill the circle at (x, y) with the class's decorations, up to the density. */
  _paint(scene, x, y) {
    const className = this._stroke.className;
    const decl = decorationClassOf(scene.constructor, className);
    let found = decorationRecordOf(scene, className);
    if (found === null) {
      const record = { class: className, x: [], y: [] };
      for (const key of DECORATION_VALUE_KEYS) if (decorationKeyVaries(decl, key)) record[key] = [];
      if (!Array.isArray(scene.sceneFile.decorations)) scene.sceneFile.decorations = [];
      scene.sceneFile.decorations.push(record);
      found = { record, position: scene.sceneFile.decorations.length - 1 };
    }
    const record = found.record;
    const random = this.random;
    // What the class varies gets an array, filled with draws for decorations already there (a file written by hand).
    for (const key of DECORATION_VALUE_KEYS) {
      if (decorationKeyVaries(decl, key) && !Array.isArray(record[key])) {
        record[key] = record.x.map(() => fileValue(key, drawDecorationValue(decl, key, random)));
      }
    }
    const indices = indicesOf(scene, record);
    const r = this.radius;
    const r2 = r * r;
    const inside = this._inside;
    inside.length = 0;
    for (let i = 0; i < record.x.length; i++) {
      const dx = record.x[i] - x;
      const dy = record.y[i] - y;
      if (dx * dx + dy * dy <= r2) inside.push(i);
    }
    let need = Math.round((this.density * Math.PI * r2) / 10000) - inside.length;
    if (need <= 0) return;
    const step = this.editMode.move?.snap ?? 1;
    const start = record.x.length;
    for (let tries = need * 8; need > 0 && tries > 0; tries--) {
      const angle = random() * TWO_PI;
      const distance = r * Math.sqrt(random());
      const px = snapTo(x + Math.cos(angle) * distance, step);
      const py = snapTo(y + Math.sin(angle) * distance, step);
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > r2 || this._taken(record, start, px, py)) continue;
      record.x.push(px);
      record.y.push(py);
      for (const key of DECORATION_VALUE_KEYS) {
        if (Array.isArray(record[key])) record[key].push(fileValue(key, drawDecorationValue(decl, key, random)));
      }
      need--;
    }
    const count = record.x.length - start;
    if (count === 0) return;
    const positions = new Array(count);
    for (let k = 0; k < count; k++) positions[k] = start + k;
    const spawned = spawnRecordDecorations(scene, record, positions);
    let room = 0;
    while (room < count && spawned[room] >= 0) room++;
    for (let k = 0; k < room; k++) indices.push(spawned[k]);
    if (room < count) {
      // The pool is full: only what it took stays in the file.
      for (const key of ['x', 'y', ...DECORATION_VALUE_KEYS]) if (Array.isArray(record[key])) record[key].length = start + room;
      this.editMode._setStatus(
        `The decoration pool is full: raise ${scene.constructor.name}'s config.decoration.maxDecorations`,
        true,
      );
    }
  }

  /** Whether a decoration of the record sits at (px, py): one inside the circle, or one this dab added. */
  _taken(record, start, px, py) {
    const inside = this._inside;
    for (let k = 0; k < inside.length; k++) if (record.x[inside[k]] === px && record.y[inside[k]] === py) return true;
    for (let i = start; i < record.x.length; i++) if (record.x[i] === px && record.y[i] === py) return true;
    return false;
  }

  /** Take the class's decorations inside the circle at (x, y) out, and despawn them. */
  _erase(scene, x, y) {
    const found = decorationRecordOf(scene, this._stroke.className);
    if (found === null) return;
    const record = found.record;
    const indices = indicesOf(scene, record);
    const keys = ['x', 'y'];
    for (const key of DECORATION_VALUE_KEYS) if (Array.isArray(record[key])) keys.push(key);
    const r2 = this.radius * this.radius;
    const n = record.x.length;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const dx = record.x[i] - x;
      const dy = record.y[i] - y;
      if (dx * dx + dy * dy <= r2) {
        if (indices[i] >= 0) DecorationPool.despawn(indices[i]);
        continue;
      }
      if (w !== i) {
        for (const key of keys) record[key][w] = record[key][i];
        indices[w] = indices[i];
      }
      w++;
    }
    if (w === n) return;
    for (const key of keys) record[key].length = w;
    indices.length = w;
  }

  /** The stroke ends: a class left with no decorations leaves the file; a stroke that changed it is one undo. */
  _finish() {
    const stroke = this._stroke;
    this._stroke = null;
    if (stroke === null) return;
    const scene = this.scene;
    if (scene?.sceneFile !== stroke.doc) return;
    const found = decorationRecordOf(scene, stroke.className);
    if (found !== null && found.record.x.length === 0) removeDecorationRecord(scene, found.record);
    const record = found !== null && found.record.x.length > 0 ? found.record : null;
    const after = record === null ? null : structuredClone(record);
    if (JSON.stringify(after) === JSON.stringify(stroke.before)) return;
    const editMode = this.editMode;
    editMode.history.push({
      id: 0,
      label: `${stroke.erase ? 'erase' : 'paint'} ${stroke.className}`,
      kind: 'decorations',
      class: stroke.className,
      at: stroke.at,
      before: stroke.before,
      after,
    });
    this._documentChanged();
  }

  /** Undo or redo a stroke (EditMode._apply): the class's record as it was, its decorations with it. */
  apply(change, forward) {
    const target = forward ? change.after : change.before;
    syncRecord(this.scene, change.class, change.at, target === null ? null : structuredClone(target));
    this._documentChanged();
  }

  _documentChanged() {
    const editMode = this.editMode;
    editMode.debugUI.hosted?.onDocumentChanged?.();
    editMode.palette?.refresh?.();
    editMode._notify?.();
  }

  // ---- the overlay ----

  /** The brush's circle where the pointer is: green to paint, dashed red with Shift to erase. */
  drawOverlay(ctx, camera, zoom) {
    if (this.className === null || !this._over || this._x !== this._x) return;
    const cx = (this._x - camera.x) * zoom;
    const cy = (this._y - camera.y) * zoom;
    const erase = this._stroke !== null ? this._stroke.erase : this._shift;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = erase ? ERASE_COLOR : PAINT_COLOR;
    ctx.setLineDash(erase ? ERASE_DASH : NO_DASH);
    ctx.beginPath();
    ctx.arc(cx, cy, this.radius * zoom, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  // ---- the palette's section ----

  /** Put the brush's section into the palette's body (Palette._createBody). */
  mountPalette(body) {
    if (this._section === null) {
      this._section = document.createElement('div');
      this._section.dataset.decorations = '';
      this._section.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1)';
    }
    body.appendChild(this._section);
    this.refreshPalette();
  }

  /** The section again: the classes with their counts, the brush's class, its radius and density. */
  refreshPalette() {
    const section = this._section;
    if (section === null) return;
    section.textContent = '';
    const scene = this.scene;
    const title = document.createElement('div');
    title.textContent = 'Decorations';
    title.style.cssText = 'font-size:11px;color:#ccc;font-weight:bold;margin-bottom:3px';
    section.appendChild(title);
    const declared = scene?.constructor?.decorations;
    const names = declared && typeof declared === 'object' ? Object.keys(declared) : [];
    if (names.length === 0) {
      const note = document.createElement('div');
      note.textContent = 'This scene declares none: give its class a static decorations to paint them.';
      note.style.cssText = 'font-size:10px;color:#888;white-space:normal';
      section.appendChild(note);
      return;
    }
    const counts = decorationCounts(scene);
    for (const name of names) section.appendChild(this._row(name, counts.get(name) || 0));
    const fields = document.createElement('div');
    fields.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px;font-size:10px;color:#aaa;flex-wrap:wrap';
    fields.append(
      this._field('Radius', 'brushRadius', this.radius, 'px: the brush’s circle in the world ([ and ] too)', (v) => this.setRadius(v)),
      this._field('Density', 'brushDensity', this.density, 'decorations per 100 × 100 px', (v) => this.setDensity(v)),
    );
    section.appendChild(fields);
    const hint = document.createElement('div');
    hint.textContent = 'Drag to paint, Shift+drag to erase; Esc puts the brush down.';
    hint.style.cssText = 'font-size:10px;color:#777;margin-top:3px;white-space:normal';
    section.appendChild(hint);
  }

  _row(name, count) {
    const row = document.createElement('div');
    row.dataset.decorationClass = name;
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.textContent = 'Paint';
    button.title = `Paint ${name}: drag on the view (Shift+drag erases, Esc stops)`;
    if (this.className === name) button.classList.add('active');
    button.onclick = () => this.select(name);
    const label = document.createElement('span');
    label.textContent = name;
    label.style.cssText = 'flex:1;font-size:11px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const placed = document.createElement('span');
    placed.textContent = `${count}`;
    placed.title = `${count} placed by this file`;
    placed.style.cssText = 'font-size:10px;color:#888';
    row.append(button, label, placed);
    return row;
  }

  _field(label, key, value, title, set) {
    const box = document.createElement('label');
    box.style.cssText = 'display:flex;gap:3px;align-items:center';
    box.title = title;
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(value);
    input.dataset[key] = '';
    input.style.cssText = FIELD_STYLE;
    input.onchange = () => set(input.value);
    box.append(text, input);
    return box;
  }

  /** The radius and density fields show the brush's values (after [ or ]). */
  _refreshFields() {
    const section = this._section;
    if (section === null) return;
    const radius = section.querySelector?.('[data-brush-radius]');
    if (radius) radius.value = String(this.radius);
    const density = section.querySelector?.('[data-brush-density]');
    if (density) density.value = String(this.density);
  }
}
