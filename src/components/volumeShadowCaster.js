// VolumeShadowCaster — says what an object is, and the engine works out its shadow (DX-VOLUME). A box, levels or a hull of
// points, in the entity's frame: it moves and turns with the entity. No second entity, no layer in the config, no mesh code.
//
// A volume is the entity's MeshGeometry slot, with the height of each vertex where a mesh has its U, on the `volumeShadows`
// layer, which Scene adds when a class lists this component: sunProjected, so the GPU moves each vertex by the sun. Only the
// roof and the sides are drawn. A ray from a point in shadow up to the sun leaves the volume through one of them, so a floor
// face would add nothing.
//
// x and y are on the floor, height in screen px. A floor seen at an angle is drawn floorScaleY as tall as it is wide: the
// shader applies it, after the turn, so a turning car rewrites no vertex (meshUvFill.vert.glsl).

import { Component } from '../core/component.js';
import { Layer } from '../core/layer.js';
import { MeshGeometry } from '../core/meshGeometry.js';
import { convexHull3D, MAX_HULL_POINTS } from '../render/convexHull3D.js';
import { triangulateSimplePolygon } from '../render/meshTriangulate.js';
import { VOLUME_LAYER } from '../util/configDefaults.js';
import { resolveGroundScaleY } from '../util/lightRadius.js';
import { MeshRenderer, markMeshPaint } from './meshRenderer.js';

const HEIGHT_ON_THE_FLOOR = 1e-3;

let _warnedFull = false;
/** The shape warnings given, by text: each mistake once, so a second kind still says what it is. */
const _warnedShapes = new Set();

export function resetVolumeShadowCasterWarns() {
  _warnedFull = false;
  _warnedShapes.clear();
}

function warnFull() {
  if (_warnedFull) return;
  _warnedFull = true;
  console.warn('WeedJS: VolumeShadowCaster: the mesh arena is full; raise lighting.maxVolumeVerts (16 by default)');
}

function warnShape(what) {
  if (_warnedShapes.has(what)) return;
  _warnedShapes.add(what);
  console.warn(`WeedJS: VolumeShadowCaster: ${what}`);
}

const _base = new Float32Array(8);
const _top = new Float32Array(8);
let _ringA = new Float32Array(64);
let _ringB = new Float32Array(64);
let _cap = new Uint32Array(64);

/**
 * Flat x,y or {x,y}[] into `into`, grown if it must. Returns the array that holds them; its corner count is ringCount, -1 when
 * a corner is not finite.
 */
let ringCount = 0;
function readRing(points, into) {
  ringCount = 0;
  if (!points || points.length == null) return into;
  const objects = points[0] != null && typeof points[0] === 'object';
  const n = objects ? points.length | 0 : (points.length | 0) >> 1;
  if (!objects && (points.length & 1)) return into;
  const out = into.length >= n * 2 ? into : new Float32Array(n * 2);
  for (let p = 0; p < n; p++) {
    const x = objects ? +points[p].x : +points[p * 2];
    const y = objects ? +points[p].y : +points[p * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      ringCount = -1;
      return out;
    }
    out[p * 2] = x;
    out[p * 2 + 1] = y;
  }
  ringCount = n;
  return out;
}

/** Writes the mesh and joins the layer. `xy`, `heights` and `indices` are scratch this file owns or MeshGeometry's. */
function publish(i, xy, heights, indices, vertN, indexN) {
  if (!MeshGeometry.replace(i, xy, indices, heights, vertN, indexN)) {
    // A refused mesh leaves the slot empty, and an empty slot on the layer would fill its collider.
    VolumeShadowCaster.leaveLayer(i);
    warnFull();
    return false;
  }
  VolumeShadowCaster.joinLayer(i);
  return true;
}

/** How far apart, against the base's size, two corners must be to be two. */
const SAME_CORNER = 1e-6;

/**
 * Whether `top` closes on a point or on a line: a pyramid, a gabled roof. All its corners on one line, within `near`. Its
 * signed area would not do: a top that crosses itself evenly has none either, and that one is refused.
 */
function topIsFlat(top, n, near) {
  const x0 = top[0];
  const y0 = top[1];
  let far = 0;
  let fx = 0;
  let fy = 0;
  for (let p = 1; p < n; p++) {
    const dx = top[p * 2] - x0;
    const dy = top[p * 2 + 1] - y0;
    const d = dx * dx + dy * dy;
    if (d > far) {
      far = d;
      fx = dx;
      fy = dy;
    }
  }
  if (far <= near * near) return true;
  const length = Math.sqrt(far);
  for (let p = 1; p < n; p++) {
    const off = (fx * (top[p * 2 + 1] - y0) - fy * (top[p * 2] - x0)) / length;
    if (off > near || off < -near) return false;
  }
  return true;
}

/**
 * One level: `base` at height `bottom`, `top` at height `height`, the roof and a quad up each side, after the mesh the entity
 * holds when `keep`. A top that closes on a point or a line has no roof, and a side whose two top corners meet is one
 * triangle: no row draws nothing.
 */
function writeLevel(i, base, top, n, bottom, height, keep) {
  let minX = base[0];
  let maxX = base[0];
  let minY = base[1];
  let maxY = base[1];
  for (let p = 1; p < n; p++) {
    minX = Math.min(minX, base[p * 2]);
    maxX = Math.max(maxX, base[p * 2]);
    minY = Math.min(minY, base[p * 2 + 1]);
    maxY = Math.max(maxY, base[p * 2 + 1]);
  }
  const near = SAME_CORNER * Math.max(maxX - minX, maxY - minY);
  const flat = topIsFlat(top, n, near);
  let capN = 0;
  if (!flat) {
    if (_cap.length < (n - 2) * 3) _cap = new Uint32Array((n - 2) * 3);
    capN = triangulateSimplePolygon(top, n, _cap, MeshGeometry.vertLimit);
    if (capN < 0) {
      warnShape('a level needs a simple outline');
      return false;
    }
  }
  const at = keep ? MeshGeometry.vertOffset[i] | 0 : -1;
  const hadV = at >= 0 ? MeshGeometry.vertCount[i] | 0 : 0;
  const ixAt = at >= 0 ? MeshGeometry.indexOffset[i] | 0 : -1;
  const hadI = ixAt >= 0 ? MeshGeometry.indexCount[i] | 0 : 0;
  const vertN = hadV + n * 2;
  const indexN = hadI + capN + n * 6;
  const xy = MeshGeometry.scratchXY(vertN * 2);
  const uv = MeshGeometry.scratchUV(vertN * 2);
  const idx = MeshGeometry.scratchIdx(indexN);
  for (let v = 0; v < hadV; v++) {
    xy[v * 2] = MeshGeometry.vertexX[at + v];
    xy[v * 2 + 1] = MeshGeometry.vertexY[at + v];
    uv[v * 2] = MeshGeometry.uvU[at + v];
    uv[v * 2 + 1] = 0;
  }
  for (let t = 0; t < hadI; t++) idx[t] = MeshGeometry.indices[ixAt + t];
  // The old spans go first: asked for a bigger one, the arena would leave each level's a hole no later volume fits.
  if (at >= 0) MeshGeometry.clearEntity(i);
  const floorRing = hadV;
  const roofRing = hadV + n;
  for (let p = 0; p < n; p++) {
    xy[(floorRing + p) * 2] = base[p * 2];
    xy[(floorRing + p) * 2 + 1] = base[p * 2 + 1];
    uv[(floorRing + p) * 2] = bottom;
    uv[(floorRing + p) * 2 + 1] = 0;
    xy[(roofRing + p) * 2] = top[p * 2];
    xy[(roofRing + p) * 2 + 1] = top[p * 2 + 1];
    uv[(roofRing + p) * 2] = height;
    uv[(roofRing + p) * 2 + 1] = 0;
  }
  let w = hadI;
  for (let t = 0; t < capN; t++) idx[w++] = roofRing + _cap[t];
  for (let p = 0; p < n; p++) {
    const q = p + 1 < n ? p + 1 : 0;
    idx[w++] = floorRing + p;
    idx[w++] = floorRing + q;
    idx[w++] = roofRing + q;
    const dx = top[q * 2] - top[p * 2];
    const dy = top[q * 2 + 1] - top[p * 2 + 1];
    if (dx * dx + dy * dy <= near * near) continue;
    idx[w++] = floorRing + p;
    idx[w++] = roofRing + q;
    idx[w++] = roofRing + p;
  }
  if (publish(i, xy, uv, idx, vertN, w)) return true;
  // The arena refused the bigger volume (publish warned): the one the entity had is still at the start of the scratch, and
  // its spans were just freed, so it goes back, on the layer. A car that cannot add its cabin keeps its body's shadow.
  if (hadV >= 3 && MeshGeometry.replace(i, xy, hadI > 0 ? idx : null, uv, hadV, hadI)) VolumeShadowCaster.joinLayer(i);
  return false;
}

export class VolumeShadowCaster extends Component {
  static ARRAY_SCHEMA = {
    floorScaleY: Float32Array, // above 0 on every slot of a class that lists this component
  };

  /** Its mesh and its row are MeshRenderer's: an entity of this class has one, listed or not. A getter: modules import in a cycle. */
  static get requires() {
    return [MeshRenderer];
  }

  /** config.lighting.groundScaleY, validated, on each thread: a new volume's floorScaleY. */
  static defaultFloorScaleY = 1;

  static initializeArrays(buffer, count, byteOffset = 0) {
    super.initializeArrays(buffer, count, byteOffset);
    MeshRenderer.volumeColumn = this.floorScaleY;
  }

  static clearArrays() {
    super.clearArrays();
    MeshRenderer.volumeColumn = null;
  }

  /** @returns {number} the layer's bit in a layer mask, or 0 */
  static layerBit() {
    const layer = Layer.get(VOLUME_LAYER);
    return layer ? Layer.bit(layer.id) : 0;
  }

  static joinLayer(i) {
    const bit = VolumeShadowCaster.layerBit();
    if ((MeshRenderer.layerMask[i] & bit) === bit) return;
    MeshRenderer.layerMask[i] |= bit;
    markMeshPaint(i);
  }

  /** Off the layer: a MeshRenderer with no mesh there would fill its collider, in black. */
  static leaveLayer(i) {
    const bit = VolumeShadowCaster.layerBit();
    if (!(MeshRenderer.layerMask[i] & bit)) return;
    MeshRenderer.layerMask[i] &= ~bit;
    markMeshPaint(i);
  }

  /** How tall the floor is drawn against its width, in (0, 1]: `config.lighting.groundScaleY` unless a volume says. */
  get floorScaleY() {
    return VolumeShadowCaster.floorScaleY[this.index];
  }
  set floorScaleY(value) {
    const s = resolveGroundScaleY(value);
    if (VolumeShadowCaster.floorScaleY[this.index] === Math.fround(s)) return;
    VolumeShadowCaster.floorScaleY[this.index] = s;
    markMeshPaint(this.index);
  }

  /**
   * A box. Replaces the volume this entity had.
   * @param {number} width along x, the way the entity looks
   * @param {number} depth across it, on the floor
   * @param {number} height screen px
   * @param {{ offsetX?: number, offsetY?: number, topScale?: number, floorScaleY?: number }} [options] the box's centre on
   *   the entity's frame; how much smaller the roof is, about that centre
   * @returns {this}
   */
  setBox(width, depth, height, { offsetX = 0, offsetY = 0, topScale = 1, floorScaleY } = {}) {
    if (![width, depth, height, offsetX, offsetY, topScale].every(Number.isFinite)) {
      warnShape('setBox needs finite sizes, offsets and topScale');
      return this;
    }
    if (!(topScale >= 0)) {
      warnShape('setBox needs a topScale of 0 or more: 0 is a pyramid');
      return this;
    }
    const hw = width * 0.5;
    const hd = depth * 0.5;
    if (!(hw > 0) || !(hd > 0) || !(height > 0)) {
      warnShape('setBox needs a width, a depth and a height above 0');
      return this;
    }
    if (floorScaleY !== undefined) this.floorScaleY = floorScaleY;
    const corners = [-hw, -hd, hw, -hd, hw, hd, -hw, hd];
    for (let c = 0; c < 4; c++) {
      _base[c * 2] = offsetX + corners[c * 2];
      _base[c * 2 + 1] = offsetY + corners[c * 2 + 1];
      _top[c * 2] = offsetX + corners[c * 2] * topScale;
      _top[c * 2 + 1] = offsetY + corners[c * 2 + 1] * topScale;
    }
    writeLevel(this.index, _base, _top, 4, 0, height, false);
    return this;
  }

  /**
   * One more level on top of what the volume has: a body, a cabin on it, a tank on a roof. Its outline need not be convex. One
   * the arena has no room for warns and leaves the volume as it was.
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} outline on the entity's frame
   * @param {number} bottom height of the outline, screen px
   * @param {number} top height of the level's top
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} [topOutline] the top, as many corners; left out, the same outline
   * @param {{ floorScaleY?: number }} [options]
   * @returns {this}
   */
  addLevel(outline, bottom, top, topOutline = outline, { floorScaleY } = {}) {
    _ringA = readRing(outline, _ringA);
    const n = ringCount;
    _ringB = readRing(topOutline, _ringB);
    if (n < 0 || ringCount < 0 || !Number.isFinite(bottom) || !Number.isFinite(top)) {
      warnShape('a level needs finite corners and heights');
      return this;
    }
    if (n < 3 || ringCount !== n) {
      warnShape('a level needs at least 3 corners, as many on its top');
      return this;
    }
    if (!(top > bottom)) {
      warnShape('a level needs its top above its bottom');
      return this;
    }
    if (floorScaleY !== undefined) this.floorScaleY = floorScaleY;
    writeLevel(this.index, _ringA, _ringB, n, bottom, top, true);
    return this;
  }

  /**
   * The convex volume around points: a house from an editor. It runs once, when called. Replaces the volume this entity had.
   * @param {ArrayLike<number>|Array<{x:number,y:number,z:number}>} points flat x, y, z (z: height, screen px) or objects
   * @param {{ floorScaleY?: number }} [options]
   * @returns {this}
   */
  setHull(points, { floorScaleY } = {}) {
    const objects = points?.[0] != null && typeof points[0] === 'object';
    const n = objects ? points.length | 0 : (points?.length | 0) / 3 | 0;
    if (n > MAX_HULL_POINTS) {
      warnShape(`setHull takes at most ${MAX_HULL_POINTS} points`);
      return this;
    }
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      x[p] = objects ? +points[p].x : +points[p * 3];
      y[p] = objects ? +points[p].y : +points[p * 3 + 1];
      const h = objects ? +points[p].z : +points[p * 3 + 2];
      if (!Number.isFinite(x[p]) || !Number.isFinite(y[p]) || !Number.isFinite(h)) {
        warnShape('setHull needs finite points');
        return this;
      }
      z[p] = h > 0 ? h : 0;
    }
    const triangles = convexHull3D(x, y, z, n);
    if (triangles === null) {
      warnShape('setHull needs points that enclose a volume');
      return this;
    }
    if (floorScaleY !== undefined) this.floorScaleY = floorScaleY;
    const used = new Int32Array(n).fill(-1);
    const idx = MeshGeometry.scratchIdx(triangles.length);
    let vertN = 0;
    let indexN = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t];
      const b = triangles[t + 1];
      const c = triangles[t + 2];
      if (z[a] < HEIGHT_ON_THE_FLOOR && z[b] < HEIGHT_ON_THE_FLOOR && z[c] < HEIGHT_ON_THE_FLOOR) continue;
      for (let k = 0; k < 3; k++) {
        const p = triangles[t + k];
        if (used[p] < 0) used[p] = vertN++;
        idx[indexN++] = used[p];
      }
    }
    if (indexN < 3) {
      warnShape('setHull needs points that enclose a volume');
      return this;
    }
    const xy = MeshGeometry.scratchXY(vertN * 2);
    const uv = MeshGeometry.scratchUV(vertN * 2);
    for (let p = 0; p < n; p++) {
      const v = used[p];
      if (v < 0) continue;
      xy[v * 2] = x[p];
      xy[v * 2 + 1] = y[p];
      uv[v * 2] = z[p];
      uv[v * 2 + 1] = 0;
    }
    publish(this.index, xy, uv, idx, vertN, indexN);
    return this;
  }

  /** No volume: the entity casts nothing until it is given one again. */
  clear() {
    MeshGeometry.clearEntity(this.index);
    VolumeShadowCaster.leaveLayer(this.index);
    return this;
  }
}
