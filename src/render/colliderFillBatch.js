/**
 * Instanced fill of this entity's collider (LAYER_KIND.MESH).
 * Explicit MeshGeometry wins. Else fixtures, else primary polygon / box /
 * display 8-gon for a physics circle. Per-vertex UVs go to packMeshUvFill.
 * One PIXI.Mesh per MESH slot. VS applies packed pose (published display pose
 * when pixi latched it, else live Transform).
 * Static bodies pack live Transform: pose lags a remesh/spawn and the island snaps.
 * A dynamic body whose published rotation is still zero (slot reuse) does too.
 * Pixi skips pack+upload when ColliderFixture.revision, MeshGeometry.revision,
 * mesh pose, and paint match.
 *
 * Instance floats (18): v0, v1, v2, xy, rotCS, tintBits, depth, texId, tileInv, tileOff, body.
 * World verts. Camera is the RT render root, not baked here.
 */

import {
  Geometry,
  Mesh,
  Shader,
  GpuProgram,
  GlProgram,
  Buffer,
  BufferUsage,
  State,
  Texture,
  TextureSource,
} from '../vendor/pixi.min.js';

import { MAX_POLYGON_VERTICES, ShapeType, SPRITE_TILE_MODE } from '../util/configDefaults.js';
import { colliderFillGpuProgram } from './webgpu/colliderFillWgsl.js';
import { colliderFillGlProgram } from './webgl/colliderFillGlsl.js';
import { dummyLutSource } from './instancedSpriteBatch.js';
import { MESH_NO_TEXTURE } from '../components/meshRenderer.js';

export const COLLIDER_FILL_FLOATS = 18;
export const COLLIDER_FILL_STRIDE = COLLIDER_FILL_FLOATS * 4;
/** Explicit mesh with per-vertex UVs. 18 collider floats plus uv0, uv1, uv2. */
export const MESH_UV_FILL_FLOATS = 24;
export const MESH_UV_FILL_STRIDE = MESH_UV_FILL_FLOATS * 4;
/** lastRevision < 0 means no packed frame yet (always pack). */
export const COLLIDER_FILL_PACK_FIRST_FRAME = -1;

const INV = 0xffff;
const TWO_PI = Math.PI * 2;
const STRETCH = SPRITE_TILE_MODE.STRETCH;
const WORLD = SPRITE_TILE_MODE.WORLD;

let _warnedMeshLayer = false;
let _warnedNoDrawable = false;

export function resetColliderFillMeshLayerWarn() {
  _warnedMeshLayer = false;
  _warnedNoDrawable = false;
}

function explicitMeshOffset(i, views) {
  const off = views.meshVertOffset;
  if (!off) return -1;
  const o = off[i] | 0;
  return o >= 0 ? o : -1;
}

function entityHasDrawableCollider(i, views) {
  if ((views.fixtureCount[i] | 0) >= 1) return true;
  const st = views.primaryShapeType ? views.primaryShapeType[i] | 0 : -1;
  if (st === ShapeType.Polygon && views.primaryPolyCount && (views.primaryPolyCount[i] | 0) >= 3) {
    return true;
  }
  if (st === ShapeType.Box && views.primaryWidth && views.primaryHeight) {
    return views.primaryWidth[i] > 0 && views.primaryHeight[i] > 0;
  }
  if (st === ShapeType.Circle && views.primaryRadius) {
    return views.primaryRadius[i] > 0;
  }
  return false;
}

const _paint = { texId: -1, tix: 0, tiy: 0, tou: 0, tov: 0 };
let _outset = 0;
let _ox = 0;
let _oy = 0;

function radialOutset(x, y, outset) {
  if (!(outset > 0)) {
    _ox = x;
    _oy = y;
    return;
  }
  // H-03: sqrt, not Math.hypot - the overflow/underflow guard is wasted here.
  // Measured ~16x cheaper (5/5 counterbalanced rounds, 1e-3..1e7). NOT
  // bit-identical to hypot: it agrees on ~64% of in-range pairs and differs by
  // a few ulps on the rest, because hypot is deliberately the more accurate of
  // the two. That is ~1e-16 relative, far under the Float32 this value is
  // stored into. Overflow is unreachable (Float64 squares overflow past ~1.34e154).
  // Do not reintroduce hypot here without measuring it again.
  const len = Math.sqrt(x * x + y * y);
  if (len < 1e-6) {
    _ox = x;
    _oy = y;
    return;
  }
  const k = 1 + outset / len;
  _ox = x * k;
  _oy = y * k;
}

function bindMeshPaint(i, views) {
  const tex = views.meshTextureId;
  const anim = tex ? tex[i] : MESH_NO_TEXTURE;
  const hasTex = anim !== MESH_NO_TEXTURE;
  const starts = views.animationFrameStart;
  if (!hasTex) {
    _paint.texId = -1;
  } else if (starts) {
    const s = starts[anim];
    _paint.texId = s == null ? -1 : +s;
  } else {
    _paint.texId = anim;
  }
  const mode = views.meshTileMode ? views.meshTileMode[i] : 0;
  const rx = views.meshRepeatX ? views.meshRepeatX[i] : 0;
  const ry = views.meshRepeatY ? views.meshRepeatY[i] : 0;
  if (!hasTex || mode === STRETCH || (rx <= 0 && ry <= 0)) {
    _paint.tix = 0;
    _paint.tiy = 0;
  } else if (mode === WORLD) {
    _paint.tix = rx > 0 ? 1 / rx : 0;
    _paint.tiy = ry > 0 ? 1 / ry : 0;
  } else {
    _paint.tix = rx > 0 ? -(1 / rx) : 0;
    _paint.tiy = ry > 0 ? -(1 / ry) : 0;
  }
  const ou = views.meshTileOffU;
  const ov = views.meshTileOffV;
  _paint.tou = ou ? (ou[i] & 65535) / 65535 : 0;
  _paint.tov = ov ? (ov[i] & 65535) / 65535 : 0;
  _outset = views.meshVisualOutset ? views.meshVisualOutset[i] : 0;
}

/**
 * Write one fan triangle. Returns new written count, or -1 if cap hit.
 */
function writeFillTri(out, outU32, base, written, maxOut, depthDenom, x0, y0, x1, y1, x2, y2, wx, wy, c, s, packed) {
  if (written >= maxOut) return -1;
  out[base] = x0;
  out[base + 1] = y0;
  out[base + 2] = x1;
  out[base + 3] = y1;
  out[base + 4] = x2;
  out[base + 5] = y2;
  out[base + 6] = wx;
  out[base + 7] = wy;
  out[base + 8] = c;
  out[base + 9] = s;
  outU32[base + 10] = packed >>> 0;
  out[base + 11] = 1.0 - (written + 1) / depthDenom;
  out[base + 12] = _paint.texId;
  out[base + 13] = _paint.tix;
  out[base + 14] = _paint.tiy;
  out[base + 15] = _paint.tou;
  out[base + 16] = _paint.tov;
  out[base + 17] = _packEntity;
  if (_instanceEntity) _instanceEntity[written] = _packEntity;
  return written + 1;
}

let _instanceEntity = null;
let _packEntity = 0;

const _fanOut = { written: 0, base: 0, full: false };

/** Reused when the caller omits views.outU32 (tests / kernel). Pixi passes dataU32. */
let _packOutU32 = null;

function packOutU32(out, views) {
  if (views.outU32) return views.outU32;
  if (
    _packOutU32 &&
    _packOutU32.buffer === out.buffer &&
    _packOutU32.byteOffset === out.byteOffset &&
    _packOutU32.length === out.length
  ) {
    return _packOutU32;
  }
  _packOutU32 = new Uint32Array(out.buffer, out.byteOffset, out.length);
  return _packOutU32;
}

function fanLocalVerts(out, outU32, base, written, maxOut, depthDenom, vx, vy, vb, n, wx, wy, c, s, packed, outset) {
  radialOutset(vx[vb], vy[vb], outset);
  const x0 = _ox;
  const y0 = _oy;
  const fans = n - 2;
  for (let t = 0; t < fans; t++) {
    radialOutset(vx[vb + t + 1], vy[vb + t + 1], outset);
    const x1 = _ox;
    const y1 = _oy;
    radialOutset(vx[vb + t + 2], vy[vb + t + 2], outset);
    const next = writeFillTri(
      out, outU32, base, written, maxOut, depthDenom,
      x0, y0, x1, y1, _ox, _oy,
      wx, wy, c, s, packed,
    );
    if (next < 0) {
      _fanOut.written = written;
      _fanOut.base = base;
      _fanOut.full = true;
      return _fanOut;
    }
    written = next;
    base += COLLIDER_FILL_FLOATS;
  }
  _fanOut.written = written;
  _fanOut.base = base;
  _fanOut.full = false;
  return _fanOut;
}

/**
 * Grow reused pose/presence scratch for MF4 skip. No alloc when already large enough.
 * @param {object} prevPose
 * @param {number} entityCount
 */
export function ensureMeshFillPoseScratch(prevPose, entityCount) {
  const n = entityCount | 0;
  if (!prevPose.x || prevPose.x.length < n) {
    prevPose.x = new Float32Array(n);
    prevPose.y = new Float32Array(n);
    prevPose.rotC = new Float32Array(n);
    prevPose.rotS = new Float32Array(n);
    prevPose.active = new Uint8Array(n);
    prevPose.visible = new Uint8Array(n);
  }
  return prevPose;
}

/**
 * Copy current mesh pose + presence into prevPose after a successful pack.
 * @param {object} views
 * @param {object} prevPose
 */
const MESH_LIVE_POSE_SLACK_SQ = 48 * 48;

function meshFillUsesLive(i, views) {
  if (!views.liveX || !views.liveY) return false;
  if (views.rbStatic && views.rbStatic[i]) return true;
  const c = views.rotC ? views.rotC[i] : 1;
  const s = views.rotS ? views.rotS[i] : 0;
  // Same gate as poseRotationLive: zeros mean this life has not been published.
  if (c * c + s * s <= 0.25) return true;
  const dx = views.liveX[i] - views.x[i];
  const dy = views.liveY[i] - views.y[i];
  return dx * dx + dy * dy > MESH_LIVE_POSE_SLACK_SQ;
}

const _livePose = { x: 0, y: 0, c: 1, s: 0 };

export function sampleMeshFillPose(i, views) {
  return readMeshFillPose(i, views, meshFillUsesLive(i, views));
}

function readMeshFillPose(i, views, live) {
  const useLive = live === true;
  _livePose.x = useLive ? views.liveX[i] : views.x[i];
  _livePose.y = useLive ? views.liveY[i] : views.y[i];
  if (useLive && views.liveRotC) _livePose.c = views.liveRotC[i];
  else _livePose.c = views.rotC ? views.rotC[i] : 1;
  if (useLive && views.liveRotS) _livePose.s = views.liveRotS[i];
  else _livePose.s = views.rotS ? views.rotS[i] : 0;
  return _livePose;
}

export function copyMeshFillPoseScratch(views, prevPose) {
  const n = views.entityCount | 0;
  ensureMeshFillPoseScratch(prevPose, n);
  const px = prevPose.x;
  const py = prevPose.y;
  const pc = prevPose.rotC;
  const ps = prevPose.rotS;
  const pa = prevPose.active;
  const pv = prevPose.visible;
  const active = views.meshActive;
  const visible = views.meshVisible;
  for (let i = 0; i < n; i++) {
    const pose = readMeshFillPose(i, views, meshFillUsesLive(i, views));
    px[i] = pose.x;
    py[i] = pose.y;
    pc[i] = pose.c;
    ps[i] = pose.s;
    pa[i] = active[i];
    pv[i] = visible[i];
  }
}

/**
 * True if any mesh-active/visible bit or Transform pose drifted vs prevPose.
 * @param {object} views
 * @param {object} prevPose
 */
export function meshFillPoseOrPresenceChanged(views, prevPose) {
  const n = views.entityCount | 0;
  const px = prevPose && prevPose.x;
  if (!px || px.length < n) return true;
  const py = prevPose.y;
  const pc = prevPose.rotC;
  const ps = prevPose.rotS;
  const pa = prevPose.active;
  const pv = prevPose.visible;
  const active = views.meshActive;
  const visible = views.meshVisible;
  for (let i = 0; i < n; i++) {
    const a = active[i] | 0;
    const vis = visible[i] | 0;
    if ((pa[i] | 0) !== a || (pv[i] | 0) !== vis) return true;
    if (!a || !vis) continue;
    const pose = readMeshFillPose(i, views, meshFillUsesLive(i, views));
    if (pose.x !== px[i] || pose.y !== py[i] || pose.c !== pc[i] || pose.s !== ps[i]) return true;
  }
  return false;
}

export function meshFillPaintDirty(views) {
  const ep = views.paintEpoch;
  if (ep) return (ep[0] | 0) !== (views.lastPaintEpoch | 0);
  const d = views.meshDirty;
  if (!d) return false;
  const n = views.entityCount | 0;
  for (let i = 0; i < n; i++) {
    if (d[i]) return true;
  }
  return false;
}

export function clearMeshFillPaintDirty(views) {
  const d = views.meshDirty;
  if (d) d.fill(0);
}

function readFixtureRevision(views) {
  return views.fixtureRevision ? (views.fixtureRevision[0] | 0) : 0;
}

function readMeshGeomRevision(views) {
  return views.meshGeomRevision ? (views.meshGeomRevision[0] | 0) : 0;
}

/**
 * True when pack+upload can be skipped.
 * ponytail: first frame and any fixture replace / mesh edit / pose / paint always pack.
 * @param {object} views
 * @param {number} lastRevision
 * @param {object} prevPose
 */
export function colliderFillCanSkipPack(views, lastRevision, prevPose) {
  if ((lastRevision | 0) < 0 || !prevPose) return false;
  if (readFixtureRevision(views) !== (lastRevision | 0)) return false;
  if (views.meshGeomRevision) {
    if (readMeshGeomRevision(views) !== (views.lastMeshRevision | 0)) return false;
  }
  if (views.outsetEpoch) {
    if ((views.outsetEpoch[0] | 0) !== (views.lastOutsetEpoch | 0)) return false;
  }
  if (views.meshVertEpoch) {
    if (Atomics.load(views.meshVertEpoch, 0) !== (views.lastVertEpoch >>> 0)) return false;
  }
  if (views.paintEpoch) {
    if ((views.paintEpoch[0] | 0) !== (views.lastPaintEpoch | 0)) return false;
  } else if (meshFillPaintDirty(views)) {
    return false;
  }
  return !meshFillPoseOrPresenceChanged(views, prevPose);
}

/**
 * Pack collider fans for one MESH layer bit into `out`.
 * Explicit mesh wins (no visualOutset, no collider offset). Else fixtures,
 * else primary polygon, box (two tris), or a display regular 8-gon for a
 * physics circle. Circle physics stays a true circle. Per-vertex UVs are skipped
 * here; packMeshUvFill writes those. Sets views.layerHasVertexUv.
 * @param {Float32Array} out
 * @param {number} cap
 * @param {number} layerId
 * @param {object} views
 * @returns {number} instance count
 */
export function packColliderFill(out, cap, layerId, views) {
  const maxOut = cap | 0;
  if (!out || maxOut <= 0) return 0;

  const entityCount = views.entityCount | 0;
  const meshActive = views.meshActive;
  const meshVisible = views.meshVisible;
  const meshMask = views.meshLayerMask;
  const meshTint = views.meshTint;
  const meshAlpha = views.meshAlpha;
  const fixtureCount = views.fixtureCount;
  const head = views.fixtureHead;
  const next = views.fixtureNext;
  const fxActive = views.fixtureActive;
  const vertCount = views.vertCount;
  const vx = views.vertexX;
  const vy = views.vertexY;
  const offsetX = views.offsetX;
  const offsetY = views.offsetY;
  const meshBits = views.meshBits | 0;
  const maxFx = views.maxFixtures | 0;
  const primaryShapeType = views.primaryShapeType;
  const primaryPolyCount = views.primaryPolyCount;
  const primaryPolyVertexX = views.primaryPolyVertexX;
  const primaryPolyVertexY = views.primaryPolyVertexY;
  const primaryWidth = views.primaryWidth;
  const primaryHeight = views.primaryHeight;
  const primaryRadius = views.primaryRadius;
  const outU32 = packOutU32(out, views);
  _instanceEntity = views.instanceEntity || null;
  views.layerHasVertexUv = 0;

  const bit = 1 << (layerId | 0);
  const depthDenom = maxOut + 1;
  let written = 0;
  let base = 0;

  for (let i = 0; i < entityCount; i++) {
    _packEntity = i;
    if (!meshActive[i] || !meshVisible[i]) continue;
    const mask = meshMask[i] | 0;
    const meshAt = explicitMeshOffset(i, views);
    const drawable = meshAt >= 0 || entityHasDrawableCollider(i, views);
    if (!(mask & meshBits)) {
      if (!_warnedMeshLayer && drawable) {
        _warnedMeshLayer = true;
        console.warn('WeedJS: MeshRenderer requires setLayer on a LAYER_KIND.MESH layer');
      }
      continue;
    }
    if (!(mask & bit)) continue;
    if (!drawable) {
      if (!_warnedNoDrawable) {
        _warnedNoDrawable = true;
        console.warn('WeedJS: MeshRenderer has no drawable collider (fixtures or primary box/circle/polygon)');
      }
      continue;
    }

    bindMeshPaint(i, views);
    const outset = _outset;
    const pose = readMeshFillPose(i, views, meshFillUsesLive(i, views));
    const c = pose.c;
    const s = pose.s;
    const ox = offsetX ? offsetX[i] : 0;
    const oy = offsetY ? offsetY[i] : 0;
    const wx = pose.x + c * ox - s * oy;
    const wy = pose.y + s * ox + c * oy;

    let a = meshAlpha ? meshAlpha[i] : 1;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | ((meshTint[i] >>> 0) & 0xffffff);

    if (meshAt >= 0) {
      if (views.meshHasUv && views.meshHasUv[i]) {
        views.layerHasVertexUv = 1;
        continue;
      }
      const vcount = views.meshVertCount ? (views.meshVertCount[i] | 0) : 0;
      const ixAt = views.meshIndexOffset ? (views.meshIndexOffset[i] | 0) : -1;
      const mx = views.meshVertexX;
      const my = views.meshVertexY;
      if (ixAt >= 0 && views.meshIndices && views.meshIndexCount) {
        const ic = views.meshIndexCount[i] | 0;
        const indices = views.meshIndices;
        const triN = (ic / 3) | 0;
        for (let t = 0; t < triN; t++) {
          const o = ixAt + t * 3;
          const ia = indices[o] | 0;
          const ib = indices[o + 1] | 0;
          const icx = indices[o + 2] | 0;
          if (ia < 0 || ib < 0 || icx < 0 || ia >= vcount || ib >= vcount || icx >= vcount) continue;
          const nextW = writeFillTri(
            out, outU32, base, written, maxOut, depthDenom,
            mx[meshAt + ia], my[meshAt + ia],
            mx[meshAt + ib], my[meshAt + ib],
            mx[meshAt + icx], my[meshAt + icx],
            pose.x, pose.y, c, s, packed,
          );
          if (nextW < 0) return written;
          written = nextW;
          base += COLLIDER_FILL_FLOATS;
        }
        continue;
      }
      if (vcount >= 3 && mx && my) {
        const fan = fanLocalVerts(
          out, outU32, base, written, maxOut, depthDenom,
          mx, my, meshAt, vcount, pose.x, pose.y, c, s, packed, 0,
        );
        written = fan.written;
        base = fan.base;
        if (fan.full) return written;
      }
      continue;
    }

    if ((fixtureCount[i] | 0) >= 1 && head) {
      let cur = head[i];
      let guard = 0;
      while (cur !== INV && guard++ < maxFx) {
        if (!fxActive[cur]) {
          cur = next[cur];
          continue;
        }
        const n = vertCount[cur] | 0;
        if (n < 3 || n > MAX_POLYGON_VERTICES) {
          cur = next[cur];
          continue;
        }
        const fan = fanLocalVerts(
          out, outU32, base, written, maxOut, depthDenom,
          vx, vy, cur * MAX_POLYGON_VERTICES, n, wx, wy, c, s, packed, outset,
        );
        written = fan.written;
        base = fan.base;
        if (fan.full) return written;
        cur = next[cur];
      }
      continue;
    }

    const st = primaryShapeType ? primaryShapeType[i] | 0 : -1;
    if (st === ShapeType.Polygon && primaryPolyCount && (primaryPolyCount[i] | 0) >= 3) {
      const n = primaryPolyCount[i] | 0;
      const fan = fanLocalVerts(
        out, outU32, base, written, maxOut, depthDenom,
        primaryPolyVertexX, primaryPolyVertexY, i * MAX_POLYGON_VERTICES, n,
        wx, wy, c, s, packed, outset,
      );
      written = fan.written;
      base = fan.base;
      if (fan.full) return written;
      continue;
    }

    if (st === ShapeType.Box && primaryWidth && primaryHeight) {
      const hw = primaryWidth[i] * 0.5;
      const hh = primaryHeight[i] * 0.5;
      if (hw > 0 && hh > 0) {
        radialOutset(-hw, -hh, outset);
        const x0 = _ox;
        const y0 = _oy;
        radialOutset(hw, -hh, outset);
        const x1 = _ox;
        const y1 = _oy;
        radialOutset(hw, hh, outset);
        const x2 = _ox;
        const y2 = _oy;
        radialOutset(-hw, hh, outset);
        const x3 = _ox;
        const y3 = _oy;
        let nextW = writeFillTri(
          out, outU32, base, written, maxOut, depthDenom,
          x0, y0, x1, y1, x2, y2, wx, wy, c, s, packed,
        );
        if (nextW < 0) return written;
        written = nextW;
        base += COLLIDER_FILL_FLOATS;
        nextW = writeFillTri(
          out, outU32, base, written, maxOut, depthDenom,
          x0, y0, x2, y2, x3, y3, wx, wy, c, s, packed,
        );
        if (nextW < 0) return written;
        written = nextW;
        base += COLLIDER_FILL_FLOATS;
      }
      continue;
    }

    if (st === ShapeType.Circle && primaryRadius) {
      const r = primaryRadius[i];
      if (r > 0) {
        const n = MAX_POLYGON_VERTICES;
        const step = TWO_PI / n;
        const sr = r + (outset > 0 ? outset : 0);
        const x0 = sr;
        const y0 = 0;
        for (let t = 0; t < n - 2; t++) {
          const a1 = (t + 1) * step;
          const a2 = (t + 2) * step;
          const nextW = writeFillTri(
            out, outU32, base, written, maxOut, depthDenom,
            x0, y0, sr * Math.cos(a1), sr * Math.sin(a1), sr * Math.cos(a2), sr * Math.sin(a2),
            wx, wy, c, s, packed,
          );
          if (nextW < 0) return written;
          written = nextW;
          base += COLLIDER_FILL_FLOATS;
        }
      }
    }
  }

  _instanceEntity = null;
  return written;
}

/** Prior full pack wrote instance→entity, so pose-only refill is legal. */
export function meshFillHasLocals(views) {
  return !!(views && views.instanceEntity);
}

export function meshFillPresenceChanged(views, prevPose) {
  const n = views.entityCount | 0;
  const pa = prevPose && prevPose.active;
  if (!pa || pa.length < n) return true;
  const pv = prevPose.visible;
  const active = views.meshActive;
  const visible = views.meshVisible;
  for (let i = 0; i < n; i++) {
    if ((pa[i] | 0) !== (active[i] | 0) || (pv[i] | 0) !== (visible[i] | 0)) return true;
  }
  return false;
}

/**
 * Rewrite pose/paint on already-packed local tris. Fixture topology must match.
 * @returns {number} instance count (same as `count`)
 */
export function packColliderFillPoseOnly(out, cap, count, entityOfInstance, views, stride) {
  const n = count | 0;
  if (!out || n <= 0 || !entityOfInstance) return 0;
  const step = (stride | 0) > 0 ? (stride | 0) : COLLIDER_FILL_FLOATS;
  const outU32 = packOutU32(out, views);
  const offsetX = views.offsetX;
  const offsetY = views.offsetY;
  const meshTint = views.meshTint;
  const meshAlpha = views.meshAlpha;
  const depthDenom = (cap | 0) + 1;
  for (let k = 0; k < n; k++) {
    const i = entityOfInstance[k] | 0;
    bindMeshPaint(i, views);
    const pose = readMeshFillPose(i, views, meshFillUsesLive(i, views));
    const c = pose.c;
    const s = pose.s;
    const explicit = explicitMeshOffset(i, views) >= 0;
    const ox = !explicit && offsetX ? offsetX[i] : 0;
    const oy = !explicit && offsetY ? offsetY[i] : 0;
    const base = k * step;
    out[base + 6] = pose.x + c * ox - s * oy;
    out[base + 7] = pose.y + s * ox + c * oy;
    out[base + 8] = c;
    out[base + 9] = s;
    let a = meshAlpha ? meshAlpha[i] : 1;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    outU32[base + 10] = ((a8 & 255) << 24) | ((meshTint[i] >>> 0) & 0xffffff);
    out[base + 11] = 1.0 - (k + 1) / depthDenom;
    out[base + 12] = _paint.texId;
    out[base + 13] = _paint.tix;
    out[base + 14] = _paint.tiy;
    out[base + 15] = _paint.tou;
    out[base + 16] = _paint.tov;
  }
  return n;
}

/**
 * Rewrite aV0..aV2 (and uv0..uv2 when stride is the UV batch) for entities whose
 * vertGen moved. Returns -1 when the packed triangle count no longer matches.
 * @returns {number} 1 ok, -1 topology mismatch, 0 nothing to do
 */
export function rewriteExplicitMeshCorners(out, count, entityOfInstance, views, stride, lastVertGen) {
  const n = count | 0;
  if (!out || n <= 0 || !entityOfInstance || !views.meshVertGen || !lastVertGen) return 0;
  const step = (stride | 0) > 0 ? (stride | 0) : COLLIDER_FILL_FLOATS;
  const gen = views.meshVertGen;
  const vx = views.meshVertexX;
  const vy = views.meshVertexY;
  const indices = views.meshIndices;
  const u = views.meshUvU;
  const v = views.meshUvV;
  const uvOn = step >= MESH_UV_FILL_FLOATS && u && v;
  let k = 0;
  while (k < n) {
    const i = entityOfInstance[k] | 0;
    let end = k + 1;
    while (end < n && (entityOfInstance[end] | 0) === i) end++;
    const run = end - k;
    const dirty = i >= 0 && i < gen.length && (gen[i] >>> 0) !== ((lastVertGen[i] >>> 0));
    const vOff = views.meshVertOffset && i >= 0 ? (views.meshVertOffset[i] | 0) : -1;
    if (dirty && vOff >= 0) {
      const vN = views.meshVertCount ? (views.meshVertCount[i] | 0) : 0;
      const iAt = views.meshIndexOffset ? (views.meshIndexOffset[i] | 0) : -1;
      const need = iAt >= 0
        ? ((views.meshIndexCount[i] >>> 0) / 3) | 0
        : (vN >= 3 ? vN - 2 : 0);
      if (need !== run || vN < 3 || !vx || !vy) return -1;
      if (iAt >= 0) {
        if (!indices) return -1;
        for (let t = 0; t < run; t++) {
          const o = iAt + t * 3;
          const a = indices[o] | 0;
          const b = indices[o + 1] | 0;
          const c = indices[o + 2] | 0;
          if (a < 0 || b < 0 || c < 0 || a >= vN || b >= vN || c >= vN) return -1;
          const ia = vOff + a;
          const ib = vOff + b;
          const ic = vOff + c;
          const base = (k + t) * step;
          out[base] = vx[ia];
          out[base + 1] = vy[ia];
          out[base + 2] = vx[ib];
          out[base + 3] = vy[ib];
          out[base + 4] = vx[ic];
          out[base + 5] = vy[ic];
          if (uvOn) {
            out[base + 18] = u[ia];
            out[base + 19] = v[ia];
            out[base + 20] = u[ib];
            out[base + 21] = v[ib];
            out[base + 22] = u[ic];
            out[base + 23] = v[ic];
          }
        }
      } else {
        for (let t = 0; t < run; t++) {
          const ib = vOff + t + 1;
          const ic = vOff + t + 2;
          const base = (k + t) * step;
          out[base] = vx[vOff];
          out[base + 1] = vy[vOff];
          out[base + 2] = vx[ib];
          out[base + 3] = vy[ib];
          out[base + 4] = vx[ic];
          out[base + 5] = vy[ic];
          if (uvOn) {
            out[base + 18] = u[vOff];
            out[base + 19] = v[vOff];
            out[base + 20] = u[ib];
            out[base + 21] = v[ib];
            out[base + 22] = u[ic];
            out[base + 23] = v[ic];
          }
        }
      }
    }
    k = end;
  }
  return 1;
}

function writeUvTri(
  out, outU32, base, written, maxOut, depthDenom,
  x0, y0, x1, y1, x2, y2, wx, wy, c, s, packed,
  u0, v0, u1, v1, u2, v2,
) {
  const next = writeFillTri(
    out, outU32, base, written, maxOut, depthDenom,
    x0, y0, x1, y1, x2, y2, wx, wy, c, s, packed,
  );
  if (next < 0) return -1;
  out[base + 18] = u0;
  out[base + 19] = v0;
  out[base + 20] = u1;
  out[base + 21] = v1;
  out[base + 22] = u2;
  out[base + 23] = v2;
  return next;
}

/**
 * Per-vertex UV meshes on this MESH layer. Stride is MESH_UV_FILL_FLOATS.
 * Collider fill and tile-mode explicit meshes stay in packColliderFill.
 * @returns {number} instance count
 */
export function packMeshUvFill(out, cap, layerId, views) {
  const maxOut = cap | 0;
  if (!out || maxOut <= 0 || !views.meshHasUv || !views.meshVertexX) return 0;
  const entityCount = views.entityCount | 0;
  const meshActive = views.meshActive;
  const meshVisible = views.meshVisible;
  const meshMask = views.meshLayerMask;
  const meshTint = views.meshTint;
  const meshAlpha = views.meshAlpha;
  const meshBits = views.meshBits | 0;
  const outU32 = packOutU32(out, views);
  _instanceEntity = views.instanceEntity || null;
  const bit = 1 << (layerId | 0);
  const depthDenom = maxOut + 1;
  const mx = views.meshVertexX;
  const my = views.meshVertexY;
  const mu = views.meshUvU;
  const mv = views.meshUvV;
  const indices = views.meshIndices;
  let written = 0;
  let base = 0;

  for (let i = 0; i < entityCount; i++) {
    _packEntity = i;
    if (!meshActive[i] || !meshVisible[i]) continue;
    if (!views.meshHasUv[i]) continue;
    const mask = meshMask[i] | 0;
    if (!(mask & bit) || !(mask & meshBits)) continue;
    const meshAt = explicitMeshOffset(i, views);
    if (meshAt < 0) continue;
    const vcount = views.meshVertCount ? (views.meshVertCount[i] | 0) : 0;
    if (vcount < 3 || !mu || !mv) continue;

    bindMeshPaint(i, views);
    const pose = readMeshFillPose(i, views, meshFillUsesLive(i, views));
    const rc = pose.c;
    const rs = pose.s;
    let a = meshAlpha ? meshAlpha[i] : 1;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | ((meshTint[i] >>> 0) & 0xffffff);
    const ixAt = views.meshIndexOffset ? (views.meshIndexOffset[i] | 0) : -1;

    if (ixAt >= 0 && indices && views.meshIndexCount) {
      const triN = ((views.meshIndexCount[i] | 0) / 3) | 0;
      for (let t = 0; t < triN; t++) {
        const o = ixAt + t * 3;
        const ia = indices[o] | 0;
        const ib = indices[o + 1] | 0;
        const icx = indices[o + 2] | 0;
        if (ia < 0 || ib < 0 || icx < 0 || ia >= vcount || ib >= vcount || icx >= vcount) continue;
        const a0 = meshAt + ia;
        const b0 = meshAt + ib;
        const c0 = meshAt + icx;
        const nextW = writeUvTri(
          out, outU32, base, written, maxOut, depthDenom,
          mx[a0], my[a0], mx[b0], my[b0], mx[c0], my[c0],
          pose.x, pose.y, rc, rs, packed,
          mu[a0], mv[a0], mu[b0], mv[b0], mu[c0], mv[c0],
        );
        if (nextW < 0) {
          _instanceEntity = null;
          return written;
        }
        written = nextW;
        base += MESH_UV_FILL_FLOATS;
      }
      continue;
    }
    const fans = vcount - 2;
    const a0 = meshAt;
    for (let t = 0; t < fans; t++) {
      const b0 = meshAt + t + 1;
      const c0 = meshAt + t + 2;
      const nextW = writeUvTri(
        out, outU32, base, written, maxOut, depthDenom,
        mx[a0], my[a0], mx[b0], my[b0], mx[c0], my[c0],
        pose.x, pose.y, rc, rs, packed,
        mu[a0], mv[a0], mu[b0], mv[b0], mu[c0], mv[c0],
      );
      if (nextW < 0) {
        _instanceEntity = null;
        return written;
      }
      written = nextW;
      base += MESH_UV_FILL_FLOATS;
    }
  }
  _instanceEntity = null;
  return written;
}

export class ColliderFillBatch {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {string} [opts.label]
   * @param {boolean} [opts.useWebGpu=true]
   * @param {object} opts.shaders
   * @param {import('../vendor/pixi.min.js').TextureSource} [opts.atlasSource]
   * @param {import('../vendor/pixi.min.js').TextureSource} [opts.lutSource]
   */
  constructor({ capacity, label, useWebGpu = true, shaders = null, atlasSource = null, lutSource = null }) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * COLLIDER_FILL_FLOATS);
    this.dataU32 = new Uint32Array(this.data.buffer);
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: label || 'collider-fill',
    });

    const tri = new Float32Array([0, 0, 1, 0, 0, 1]);
    const stride = COLLIDER_FILL_STRIDE;
    const buf = this.buffer;

    this.geometry = new Geometry({
      attributes: {
        aTri: { buffer: tri, format: 'float32x2' },
        aV0: { buffer: buf, format: 'float32x2', stride, offset: 0, instance: true },
        aV1: { buffer: buf, format: 'float32x2', stride, offset: 8, instance: true },
        aV2: { buffer: buf, format: 'float32x2', stride, offset: 16, instance: true },
        aInstXY: { buffer: buf, format: 'float32x2', stride, offset: 24, instance: true },
        aInstRotCS: { buffer: buf, format: 'float32x2', stride, offset: 32, instance: true },
        aInstTintBits: { buffer: buf, format: 'float32', stride, offset: 40, instance: true },
        aInstDepth: { buffer: buf, format: 'float32', stride, offset: 44, instance: true },
        aInstTexId: { buffer: buf, format: 'float32', stride, offset: 48, instance: true },
        aInstTileInv: { buffer: buf, format: 'float32x2', stride, offset: 52, instance: true },
        aInstTileOff: { buffer: buf, format: 'float32x2', stride, offset: 60, instance: true },
        aInstBody: { buffer: buf, format: 'float32', stride, offset: 68, instance: true },
      },
    });
    this.geometry.instanceCount = 0;

    const atlas = atlasSource || Texture.WHITE.source;
    const lut = lutSource || dummyLutSource(useWebGpu);
    const posePx = new Float32Array(4);
    this._poseSource = TextureSource.from({
      resource: posePx,
      width: 1,
      height: 1,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this._poseSource.uploadMethodId = 'external';
    this.poseTable = new Float32Array(256 * 4);
    const resources = {
      uTexture: atlas,
      uSampler: atlas.style,
      uTexLut: lut,
      uPoseTable: this._poseSource,
    };

    const name = label || 'collider-fill';
    if (useWebGpu) {
      const gpuProgram = colliderFillGpuProgram(GpuProgram, shaders?.colliderFill, name);
      this.shader = new Shader({ gpuProgram, resources });
    } else {
      const glProgram = colliderFillGlProgram(
        GlProgram,
        shaders?.colliderFillVert,
        shaders?.colliderFillFrag,
        name
      );
      this.shader = new Shader({ glProgram, resources });
    }

    const state = new State();
    state.blend = true;
    state.blendMode = 'normal';
    state.depthTest = true;
    state.depthMask = true;
    state.culling = false;

    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: this.shader,
      state,
      label: name,
    });
    this.mesh.blendMode = 'normal';
    this.mesh.visible = false;
    this.mesh.cullable = false;
  }

  setAtlasSource(source) {
    if (!source) return;
    this.shader.resources.uTexture = source;
    this.shader.resources.uSampler = source.style;
  }

  setLutSource(source) {
    if (source) this.shader.resources.uTexLut = source;
  }

  /**
   * @param {number} count packed instances already written into this.data
   * @returns {number}
   */
  upload(count) {
    const n = count | 0;
    if (n <= 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }
    this.mesh.visible = true;
    this.buffer.update(n * COLLIDER_FILL_STRIDE);
    this.geometry.instanceCount = n;
    return n;
  }

  /**
   * One texel per body: xy in rg, rot cs in ba. The fat VBO stays resident.
   * @returns {number} instance count left on the mesh
   */
  uploadPoseTable(instanceEntity, count, views) {
    const n = count | 0;
    if (n <= 0 || !instanceEntity) return 0;
    const entityCount = views.entityCount | 0;
    const width = 256;
    const height = Math.max(1, ((entityCount + width - 1) / width) | 0);
    const need = width * height * 4;
    if (!this.poseTable || this.poseTable.length < need) this.poseTable = new Float32Array(need);
    if (!this._poseGen || this._poseGen.length < entityCount) this._poseGen = new Int32Array(entityCount);
    const table = this.poseTable;
    const gen = this._poseGen;
    const stamp = (this._poseStamp + 1) | 0 || 1;
    this._poseStamp = stamp;
    let k = 0;
    while (k < n) {
      const i = instanceEntity[k] | 0;
      let end = k + 1;
      while (end < n && (instanceEntity[end] | 0) === i) end++;
      k = end;
      if (i < 0 || i >= entityCount || gen[i] === stamp) continue;
      gen[i] = stamp;
      const pose = readMeshFillPose(i, views, meshFillUsesLive(i, views));
      const o = i * 4;
      table[o] = pose.x;
      table[o + 1] = pose.y;
      table[o + 2] = pose.c;
      table[o + 3] = pose.s;
    }
    this._poseWidth = width;
    this._poseHeight = height;
    this._poseDirty = true;
    this.mesh.visible = true;
    return n;
  }
}
