/**
 * The sprite collect kernel (E-76 W4b, wasm/preRenderCollect.c), shared by its test and its bench.
 *
 * `collectMemory` lays every column the sprite collect reads and writes in one shared WebAssembly.Memory, binds
 * them where the shipped PreRenderWorker.collectVisibleEntities reads them (Transform, SpriteRenderer, Collider,
 * the worker's main collector), and leaves room for the kernel's list, table and results, as the render-queue
 * memory's collect regions do. `bindCollect` binds the worker's kernel there; with `pre._collectWasm` set the
 * shipped collect takes the kernel, with it null the JS loop. The bodies' columns (RigidBody.active, two pose
 * generations) and the sort line's (scale, own facing, last texture, the frame sizes) are laid too: `useBodies`
 * and `useSortY` point the worker at them, as its pose latch and Y-sort do.
 */
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { COLLECT_TABLE_SLOTS } from '../../src/util/wasmMemoryMap.js';
import { bindPreRenderCollect } from '../../src/workers/preRenderCollectClient.js';

/**
 * One memory with every collect column for `n` entities and a `maxItems` collector, bound on the components
 * and on `pre`. `mask`: SpriteRenderer.layerMask exists; `visualRange`: Collider.visualRange exists. `skew`:
 * each column starts one cache line past its 64-byte boundary (E-113's queue layout), else on the boundary, as
 * the components' columns lie (at a count that is a multiple of 1 024, a multiple of 4 KB apart).
 */
export function collectMemory(pre, n, maxItems, { mask = true, visualRange = true, frames = 64, skew = false } = {}) {
  const parts = [
    ['tActive', Uint8Array, n], ['x', Float32Array, n], ['y', Float32Array, n],
    ['rotC', Float32Array, n], ['rotS', Float32Array, n],
    ['sActive', Uint8Array, n], ['sVisible', Uint8Array, n], ['halfW', Float32Array, n], ['halfH', Float32Array, n],
    ['sheet', Uint8Array, n], ['mask', Uint16Array, mask ? n : 0], ['visualRange', Float32Array, visualRange ? n : 0],
    ['anchorX', Float32Array, n], ['anchorY', Float32Array, n],
    ['scaleX', Float32Array, n], ['scaleY', Float32Array, n], ['inherit', Uint8Array, n],
    ['faceC', Float32Array, n], ['faceS', Float32Array, n], ['lastTexture', Uint16Array, n],
    ['frameW', Uint16Array, frames], ['frameH', Uint16Array, frames],
    ['rb', Uint8Array, n],
    ['px', Float32Array, n], ['py', Float32Array, n], ['pc', Float32Array, n], ['ps', Float32Array, n],
    ['qx', Float32Array, n], ['qy', Float32Array, n], ['qc', Float32Array, n], ['qs', Float32Array, n],
    ['list', Uint32Array, n],
    ['oY', Float32Array, maxItems], ['oType', Uint8Array, maxItems], ['oIndex', Int32Array, maxItems],
    ['oX', Float32Array, maxItems], ['oPy', Float32Array, maxItems], ['oRc', Float32Array, maxItems], ['oRs', Float32Array, maxItems],
    ['results', Int32Array, 4], ['table', Uint32Array, COLLECT_TABLE_SLOTS],
  ];
  let top = 64;
  const offsets = {};
  for (const [name, Ctor, len] of parts) {
    top = ((top + 63) & ~63) + (skew ? 64 : 0);
    offsets[name] = len > 0 ? top : 0;
    top += len * Ctor.BYTES_PER_ELEMENT;
  }
  const pages = Math.ceil(top / 65536) + 1;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const v = {};
  for (const [name, Ctor, len] of parts) v[name] = len > 0 ? new Ctor(memory.buffer, offsets[name], len) : null;

  Transform.active = v.tActive;
  Transform.x = v.x;
  Transform.y = v.y;
  Transform.rotC = v.rotC;
  Transform.rotS = v.rotS;
  SpriteRenderer.active = v.sActive;
  SpriteRenderer.renderVisible = v.sVisible;
  SpriteRenderer.boundsHalfW = v.halfW;
  SpriteRenderer.boundsHalfH = v.halfH;
  SpriteRenderer.spritesheetId = v.sheet;
  SpriteRenderer.layerMask = v.mask;
  SpriteRenderer.anchorX = v.anchorX;
  SpriteRenderer.anchorY = v.anchorY;
  SpriteRenderer.scaleX = v.scaleX;
  SpriteRenderer.scaleY = v.scaleY;
  SpriteRenderer.inheritTransformRotation = v.inherit;
  SpriteRenderer.spriteRotC = v.faceC;
  SpriteRenderer.spriteRotS = v.faceS;
  RigidBody.active = v.rb;
  pre._spriteSortArrays = null;
  Collider.visualRange = v.visualRange;
  pre._renderableY = v.oY;
  pre._renderableType = v.oType;
  pre._renderableIndex = v.oIndex;
  pre._collectPx = v.oX;
  pre._collectPy = v.oPy;
  pre._collectRotC = v.oRc;
  pre._collectRotS = v.oRs;
  pre.renderQueueMaxItems = maxItems;
  pre.globalEntityCount = n;
  return { memory, views: v, offsets, layout: { entities: n, listByte: offsets.list, tableByte: offsets.table, resultsByte: offsets.results } };
}

/** The worker's collect kernel on that memory, as its init binds it from the render-queue layout. */
export function bindCollect(m) {
  return bindPreRenderCollect(m.memory, m.layout);
}

/**
 * Point the worker at the bodies' columns as _latchPose leaves them: the latched generation, the one before it
 * (`prev` false: the first publish), and RigidBody.active.
 */
export function useBodies(pre, m, { prev = true, interpolate = false, alpha = 1 } = {}) {
  const v = m.views;
  pre._rbActive = v.rb;
  pre._poseX = v.px;
  pre._poseY = v.py;
  pre._poseRotC = v.pc;
  pre._poseRotS = v.ps;
  pre._prevPoseX = prev ? v.qx : null;
  pre._prevPoseY = prev ? v.qy : null;
  pre._prevPoseRotC = prev ? v.qc : null;
  pre._prevPoseRotS = prev ? v.qs : null;
  pre.interpolatePhysicsPose = interpolate;
  pre._poseAlpha = alpha;
}

/**
 * Y-sort on, with the frame sizes the JS reads (pre.frameWidth/frameHeight) where the emit kernel's copy is: the
 * same arrays, so the kernel and the JS read one table. `resolve` stands in for the frame an unresolved sprite
 * gets from its animation state.
 */
export function useSortY(pre, m, resolve) {
  const v = m.views;
  pre._entitySortY = true;
  pre.entityLastTextureId = v.lastTexture;
  pre.frameWidth = v.frameW;
  pre.frameHeight = v.frameH;
  pre._emitWasm = {
    texturesReady: true,
    layout: { frameWidthByte: m.offsets.frameW, frameHeightByte: m.offsets.frameH },
    frames: v.frameW.length,
  };
  pre._resolveEntitySpriteTextureId = resolve;
  pre._spriteSortArrays = null;
}
