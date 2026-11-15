import WEED from '/src/index.js';
import { BENCH_ASSETS, benchSheetSpec, sheetScale } from '/demos/lightBenchScene/benchAssets.js';

export { sheetScale };

/**
 * What the DX-LIGHT3D stress scenes share: the light bench's sheets (demos/lightBenchScene/benchAssets.js: Quaternius
 * props drawn from 32 directions, the repo's standard MinZiin cars over half a turn and mirrored, drawn at twice their
 * size, the shared LPC person, each with its height and normal maps), the camera they were drawn for, and the scenes'
 * URL knobs. Nothing here is copied: the sheets are read where they are kept, and their anchors, scales and boxes come
 * from the bench's table. An entity draws a sheet at its scale times sheetScale(sheet).
 */
export const BENCH_DIR = '/demos/lightBenchScene/assets/';

/** The camera the bench's art was drawn for: the floor at 0.736 and a px of height at 0.752 px on the screen. */
export const FLOOR_SCALE_Y = 0.7364193217154872;
export const HEIGHT_SCALE_Y = 0.7516549042792687;
export const BENCH_CAMERA = Object.freeze({ pitch: 47, floorScaleY: FLOOR_SCALE_Y, heightScaleY: HEIGHT_SCALE_Y });

/** The bench runner's canvas (runIntegratedWorkerBenchmark's default): a scene this size at zoom 1 shows all of itself. */
export const VIEW_W = 1920;
export const VIEW_H = 1080;

/** A URL knob as written, or null. WEED.params: the same on the main thread and in every worker. */
export function param(key) {
  return WEED.params?.get(key) ?? null;
}

/** A numeric knob, or `fallback` when it is missing or not a number. */
export function paramNumber(key, fallback) {
  const raw = param(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** A count knob: an integer in [min, max]. A value out of range is clamped (and the runner's parameter check names it). */
export function paramCount(key, fallback, min, max) {
  return Math.min(max, Math.max(min, Math.floor(paramNumber(key, fallback))));
}

/** `?backend=webgpu`, else WebGL (the stress scenes' default). */
export function paramBackend() {
  return param('backend') === 'webgpu' ? 'webgpu' : 'webgl';
}

/** The bench's sheet specs for `names`, with their height and normal maps unless `maps` is false. */
export function benchSheets(names, maps = true) {
  const sheets = {};
  for (const name of names) sheets[name] = benchSheetSpec(name, maps);
  return sheets;
}

/** The anchor the bench's converter put every frame's foot at. */
export function anchorOn(go, sheet) {
  const a = BENCH_ASSETS[sheet];
  go.spriteRenderer.anchorX = a.anchorX;
  go.spriteRenderer.anchorY = a.anchorY;
}

/** The directionless animation a bench render plays with DirectionalSprite: a car drives, a prop stands. */
export function benchAnimation(sheet) {
  return BENCH_ASSETS[sheet].kind === 'car' ? 'drive' : 'stand';
}

/** The widest side of a render's footprint (floor px), to fit it in a grid cell; 64 when the sheet has no box. */
export function benchSize(sheet) {
  const b = BENCH_ASSETS[sheet].box;
  return b ? Math.max(b[1] - b[0], b[3] - b[2]) : 64;
}

/**
 * A render's box as shadowCaster.setBox's arguments at `scale`, or null when the sheet has none. The bench's box is
 * (x0, x1, y0, y1, height): floor px of the model unturned, the height in floor px. setBox's frame is the one the entity's
 * rotation turns (x the way it looks) and its height is screen px (heightScaleY a px). A car's unturned render faces east
 * (its frame at 0°), a prop's faces the camera (south, its frame at 90°: the sheet's directions start there), so a prop's
 * box turns a quarter back: at rotation 90° it lies as the unturned model does.
 */
export function benchBox(sheet, scale) {
  const a = BENCH_ASSETS[sheet];
  const b = a.box;
  if (!b) return null;
  const [x0, x1, y0, y1, h] = b;
  const height = h * HEIGHT_SCALE_Y * scale;
  if (a.kind === 'car') {
    return { width: (x1 - x0) * scale, depth: (y1 - y0) * scale, height, offsetX: ((x0 + x1) / 2) * scale, offsetY: ((y0 + y1) / 2) * scale };
  }
  return { width: (y1 - y0) * scale, depth: (x1 - x0) * scale, height, offsetX: ((y0 + y1) / 2) * scale, offsetY: (-(x0 + x1) / 2) * scale };
}

/** The values a `?kind=` knob takes: the sheet's own way (no setter), its card, its height map, its box. */
export const CAST_KINDS = Object.freeze(['auto', 'sprite', 'height', 'box']);

/**
 * How the entity casts, for every light (DX-CASTER, plan §5.5): 'sprite' its card (setSprite), 'height' each pixel where it
 * is in 3D (setHeightMap), 'box' its sheet's box (setBox, which the entity's rotation turns; a sheet without one casts its
 * card), 'auto' no setter: its sheet's own way (meta.light3d.cast). The last setter wins.
 */
export function castAs(go, kind, sheet, scale) {
  const caster = go.shadowCaster;
  if (kind === 'sprite') caster.setSprite();
  else if (kind === 'height') caster.setHeightMap();
  else if (kind === 'box') {
    const box = benchBox(sheet, scale);
    if (box !== null) caster.setBox(box.width, box.depth, box.height, { offsetX: box.offsetX, offsetY: box.offsetY });
    else caster.setSprite();
  }
}

/**
 * `count` cells on a jittered grid over w × h, about as wide as they are tall: [x, y] of each cell's centre (moved by up to
 * half of `jitter` of a cell), the grid's columns and rows, and a cell's size. `skipRow(r)` leaves row r empty (a road);
 * the grid takes as many more rows as that needs.
 */
export function gridCells(count, w, h, rng, { jitter = 0.3, skipRow = null } = {}) {
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * w) / h)));
  let rows = Math.max(1, Math.ceil(count / cols));
  const kept = (n) => {
    let k = 0;
    for (let r = 0; r < n; r++) if (skipRow === null || !skipRow(r)) k++;
    return k;
  };
  while (kept(rows) * cols < count && rows < count + 64) rows++;
  const cellW = w / cols;
  const cellH = h / rows;
  const cells = [];
  for (let r = 0; r < rows && cells.length < count; r++) {
    if (skipRow !== null && skipRow(r)) continue;
    for (let c = 0; c < cols && cells.length < count; c++) {
      cells.push([(c + 0.5 + (rng() - 0.5) * jitter) * cellW, (r + 0.5 + (rng() - 0.5) * jitter) * cellH]);
    }
  }
  return { cells, cols, rows, cellW, cellH, side: Math.min(cellW, cellH) };
}
