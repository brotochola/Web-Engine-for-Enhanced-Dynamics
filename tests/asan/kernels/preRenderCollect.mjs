/**
 * Pre-render's sprite collect (wasm/preRenderCollect.c collect_sprites and collect_sprites_turned) under ASan, driven as
 * preRenderCollectWasm.test.js drives it: the real PreRenderWorker (loaded by tests/bench/workerHarness.mjs) runs
 * collectVisibleEntities through its own client (preRenderCollectClient.js, bound on the ASan module's memory). Every
 * column the collect reads or writes (Transform, SpriteRenderer, Collider, the bodies' two pose generations, the sort
 * line's columns, the frame sizes, the main collector) is its own malloc'd block of exactly the entities, the
 * collector's rows or the frames; the list, table and results at the product's sizes. Each case collects with the ASan
 * kernel, then with the shipped one: the same collectors, counts and warning. Cases: the test's (cull, skipCull, a
 * turned camera, masked sprites, a full collector, the query's list, no mask or visual range columns, bodies latched,
 * interpolated and first published, Y-sort with frames handed back, with bodies, with the list, full, on halves, before
 * the texture tables), and edge cases: one entity, a collector exactly as long as the sprites queued and one row
 * shorter, a list of one id (the last entity), last textures at the frame sizes' end and past it, one frame size.
 */
import { bytesOf, firstDifference, rng } from '../asanCases.mjs';

const N = 3000;
const CULL_ANCHORS = [[0.5, 1], [0.5, 1], [0.5, 0.5], [0, 0], [1, 1], [0.45, 0.95], [-0.5, 1.5], [NaN, 0.25]];
const HALVES = [-0.5, -1.5, -2.5, -0.25, -0, 0, 0.5, 1.5, 2.5, -0.75, 8388607.5, -8388607.5, 1e-30, -1e-30];

async function imports(ctx) {
  const [client, map, harness, layer, query, transform, sprite, collider, rigid] = await Promise.all([
    ctx.importRepo('src/workers/preRenderCollectClient.js'),
    ctx.importRepo('src/util/wasmMemoryMap.js'),
    ctx.importRepo('tests/bench/workerHarness.mjs'),
    ctx.importRepo('src/core/layer.js'),
    ctx.importRepo('src/core/query.js'),
    ctx.importRepo('src/components/transform.js'),
    ctx.importRepo('src/components/spriteRenderer.js'),
    ctx.importRepo('src/components/collider.js'),
    ctx.importRepo('src/components/rigidBody.js'),
  ]);
  return {
    client, map, harness, Layer: layer.Layer, Query: query.Query, Transform: transform.Transform,
    SpriteRenderer: sprite.SpriteRenderer, Collider: collider.Collider, RigidBody: rigid.RigidBody,
  };
}

/** preRenderCollectKernel.mjs collectMemory, every column its own malloc'd block, bound on the components and `pre`. */
function collectColumns(session, S, pre, n, maxItems, { mask = true, visualRange = true, frames = 64 } = {}) {
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
    ['oY', Float32Array, maxItems], ['oType', Uint8Array, maxItems], ['oIndex', Int32Array, maxItems],
    ['oX', Float32Array, maxItems], ['oPy', Float32Array, maxItems], ['oRc', Float32Array, maxItems], ['oRs', Float32Array, maxItems],
  ];
  const v = {};
  for (const [name, Ctor, len] of parts) v[name] = len > 0 || name.startsWith('frame') ? session.alloc(Ctor, len, name) : null;
  const { Transform, SpriteRenderer, Collider, RigidBody } = S;
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
  const layout = {
    entities: n,
    listByte: session.malloc(n * 4, 'collectList'),
    tableByte: session.malloc(S.map.COLLECT_TABLE_SLOTS * 4, 'collectTable'),
    resultsByte: session.malloc(16, 'collectResults'),
  };
  return { views: v, layout, n, maxItems };
}

/** The test's random columns (preRenderCollectWasm.test.js fill). */
function fill(m, seed, { masked, Layer }) {
  const r = rng(seed);
  const v = m.views;
  const n = m.n;
  const odd = () => [0, -0, NaN][(r() * 3) | 0];
  for (let i = 0; i < n; i++) {
    v.tActive[i] = r() < 0.92 ? 1 : 0;
    v.x[i] = (r() - 0.3) * 4000;
    v.y[i] = (r() - 0.3) * 2600;
    v.rotC[i] = r() < 0.05 ? odd() : Math.cos(r() * 6.3);
    v.rotS[i] = r() < 0.05 ? odd() : Math.sin(r() * 6.3);
    v.sActive[i] = r() < 0.95 ? 1 : 0;
    v.sVisible[i] = r() < 0.95 ? 1 : 0;
    v.halfW[i] = r() < 0.1 ? odd() : r() * 60;
    v.halfH[i] = r() < 0.1 ? odd() : r() * 60;
    v.sheet[i] = r() < 0.03 ? 0 : 1 + ((r() * 3) | 0);
    if (v.visualRange) v.visualRange[i] = r() < 0.3 ? odd() : r() * 200;
    const [ax, ay] = CULL_ANCHORS[(r() * CULL_ANCHORS.length) | 0];
    v.anchorX[i] = ax;
    v.anchorY[i] = ay;
    if (v.mask) v.mask[i] = 0;
  }
  const unit = (a) => [Math.cos(a), Math.sin(a)];
  for (let i = 0; i < n; i++) {
    v.rb[i] = r() < 0.6 ? 1 : 0;
    const dead = r() < 0.05;
    const [c, s] = unit(r() * 6.3);
    v.px[i] = v.x[i] + (r() - 0.5) * 8;
    v.py[i] = v.y[i] + (r() - 0.5) * 8;
    v.pc[i] = dead ? 0 : c;
    v.ps[i] = dead ? 0 : s;
    const still = r() < 0.3;
    const [c0, s0] = still ? [c, s] : unit(r() * 6.3);
    const unborn = r() < 0.05;
    v.qx[i] = v.px[i] + (r() - 0.5) * 6;
    v.qy[i] = v.py[i] + (r() - 0.5) * 6;
    v.qc[i] = unborn ? 0 : c0;
    v.qs[i] = unborn ? 0 : s0;
  }
  const anchors = [[0.5, 1], [0.5, 0.5], [0.5, 0.98], [1, 0.5], [0, 0.66]];
  const frames = v.frameW.length;
  for (let f = 0; f < frames; f++) {
    v.frameW[f] = 1 + ((r() * 200) | 0);
    v.frameH[f] = 1 + ((r() * 200) | 0);
  }
  for (let i = 0; i < n; i++) {
    const [ax, ay] = anchors[(r() * anchors.length) | 0];
    v.anchorX[i] = ax;
    v.anchorY[i] = ay;
    v.scaleX[i] = 0.3 + r() * 2;
    v.scaleY[i] = (r() < 0.2 ? -1 : 1) * (0.3 + r() * 2);
    v.inherit[i] = r() < 0.5 ? 1 : 0;
    const [fc, fs] = unit(r() * 6.3);
    v.faceC[i] = fc;
    v.faceS[i] = fs;
    // Last textures past the frame sizes too (the kernel sizes them 0), and the JS's unresolved frame.
    v.lastTexture[i] = r() < 0.05 ? 0xffff : r() < 0.03 ? Math.max(0, frames - 1) : (r() * (frames + 4)) | 0;
  }
  if (masked && v.mask) {
    for (let i = 0; i < n; i++) {
      if (r() < 0.04) v.mask[i] = 1 << masked.fx;
      else if (r() < 0.02) v.mask[i] = (1 << masked.fx) | Layer.entitiesMask();
    }
  }
}

function camera(pre, { skipCull, rot }) {
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = 1280;
  pre.canvasHeight = 720;
  pre.cullingRatio = 0.05;
  pre.skipCull = skipCull;
  pre._frameCameraZoom = 0.8;
  pre._frameCameraX = 600;
  pre._frameCameraY = 420;
  pre._frameCameraRot = rot;
  pre.renderQueueEnabled = true;
  pre._entitySortY = false;
  pre._collectEntityGlow = () => {};
  pre._poseX = null;
  pre._rbActive = null;
}

function useBodies(pre, m, { prev = true, interpolate = false, alpha = 1 } = {}) {
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

function useSortY(pre, m, resolve) {
  const v = m.views;
  pre._entitySortY = true;
  pre.entityLastTextureId = v.lastTexture;
  pre.frameWidth = v.frameW;
  pre.frameHeight = v.frameH;
  pre._emitWasm = {
    texturesReady: true,
    layout: { frameWidthByte: v.frameW.byteOffset, frameHeightByte: v.frameH.byteOffset },
    frames: v.frameW.length,
  };
  pre._resolveEntitySpriteTextureId = resolve;
  pre._spriteSortArrays = null;
}

const CASES = [
  { name: 'cull, a straight camera', skipCull: false, rot: 0 },
  { name: 'skipCull (BunnyMark)', skipCull: true, rot: 0 },
  { name: 'a turned camera', skipCull: false, rot: 0.6 },
  { name: 'masked sprites through collectRenderable', skipCull: false, rot: 0, masked: true },
  { name: 'a full collector', skipCull: true, rot: 0, maxItems: 1000 },
  { name: 'the sprite query\'s list', skipCull: false, rot: 0.3, masked: true, list: true },
  { name: 'no layer mask and no visual range columns', skipCull: false, rot: 0, bare: true },
  { name: 'bodies, the latched pose', skipCull: false, rot: 0, bodies: {} },
  { name: 'bodies, interpolated', skipCull: false, rot: 0, bodies: { interpolate: true, alpha: 0.37 } },
  { name: 'bodies, the first publish', skipCull: false, rot: 0, bodies: { interpolate: true, alpha: 0.6, prev: false } },
  { name: 'Y-sort, with frames handed back', skipCull: false, rot: 0, sortY: true },
  { name: 'Y-sort and bodies, a turned camera', skipCull: false, rot: 0.6, sortY: true, bodies: { interpolate: true, alpha: 0.81 } },
  { name: 'Y-sort and bodies, the list, masked', skipCull: false, rot: 0, masked: true, list: true, sortY: true, bodies: {} },
  { name: 'Y-sort, a full collector', skipCull: true, rot: 0, maxItems: 1000, sortY: true },
  { name: 'Y-sort on halves and negative zeros (Math.round)', skipCull: true, rot: 0, sortY: true, halves: true },
  { name: 'Y-sort before the emit kernel\'s texture tables (no frame sizes)', skipCull: false, rot: 0, sortY: true, noTables: true },
  // Edge cases.
  { name: 'one entity', skipCull: true, rot: 0, n: 1, sortY: true, bodies: {} },
  { name: 'one entity, a turned camera', skipCull: false, rot: 2.1, n: 1, bodies: { interpolate: true, alpha: 0.5 } },
  { name: 'a collector exactly as long as the sprites queued', skipCull: true, rot: 0, exact: 0, sortY: true, bodies: {} },
  { name: 'a collector one row shorter than the sprites queued', skipCull: true, rot: 0, exact: -1, sortY: true },
  { name: 'a collector of one row', skipCull: false, rot: 0.4, maxItems: 1, bodies: {} },
  { name: 'a list of one id, the last entity', skipCull: true, rot: 0, list: 'last', sortY: true, bodies: {} },
  { name: 'Y-sort, one frame size', skipCull: true, rot: 0, sortY: true, frames: 1 },
  { name: 'Y-sort, every last texture at or past the frame sizes\' end', skipCull: true, rot: 0, sortY: true, frames: 7, lastAtEnd: true },
];

function collectCase(S, c, k) {
  return async (ctx) => {
    const { session } = ctx;
    const { Layer, Query, harness } = S;
    Layer.reset();
    Layer.initializeFromConfig({ fx: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
    const pre = await harness.loadWorker('preRenderWorker.js', 'preRenderWorker');
    const realQuery = Query.queryActiveEntities;
    const warn = console.warn;
    try {
      const n = c.n ?? N;
      const fx = Layer.get('fx').id;
      const setup = (maxItems) => {
        const m = collectColumns(session, S, pre, n, maxItems, { ...(c.bare ? { mask: false, visualRange: false } : {}), frames: c.frames ?? 64 });
        fill(m, 1234 + k, { masked: c.masked ? { fx } : null, Layer });
        camera(pre, c);
        if (c.bodies) useBodies(pre, m, c.bodies);
        if (c.sortY) useSortY(pre, m, (i) => (i * 7) % m.views.frameW.length);
        if (c.noTables) {
          pre._emitWasm.texturesReady = false;
          pre._emitWasm.frames = 0;
          pre.frameWidth = null;
          pre.frameHeight = null;
        }
        if (c.halves) {
          for (let i = 0; i < n; i += 3) {
            m.views.y[i] = HALVES[(i / 3) % HALVES.length];
            m.views.anchorX[i] = 0.5;
            m.views.anchorY[i] = 1;
            m.views.rb[i] = 0;
          }
        }
        if (c.lastAtEnd) {
          const frames = m.views.frameW.length;
          for (let i = 0; i < n; i++) m.views.lastTexture[i] = frames - 1 + (i % 3);
        }
        return m;
      };
      if (c.list) {
        const r = rng(99);
        const ids = c.list === 'last' ? Uint32Array.of(n - 1)
          : Uint16Array.from({ length: n }, (_, i) => i).filter(() => r() < 0.7).sort(() => r() - 0.5);
        Query.queryActiveEntities = () => ids;
      }
      console.warn = () => {};
      let maxItems = c.maxItems ?? n;
      if (c.exact !== undefined) {
        // The sprites this frame queues, from the shipped kernel on a collector with room for all of them.
        const probe = setup(n);
        const kp = await S.client.bindPreRenderCollect(session.memory, probe.layout);
        pre._renderableCount = 0;
        pre.visibleEntitiesCount = 0;
        pre._renderQueueOverflowWarned = false;
        pre._customLayerCollectors = { [fx]: harness.customLayerCollector(n) };
        pre._collectWasm = kp;
        pre.collectVisibleEntities();
        pre._collectWasm = null;
        maxItems = Math.max(1, pre._renderableCount + c.exact);
      }
      const m = setup(maxItems);
      const kernel = await S.client.bindPreRenderCollect(session.memory, m.layout);
      const shipped = { collectSprites: kernel.collectSprites, collectSpritesTurned: kernel.collectSpritesTurned };
      let asanCalls = 0;
      const counted = (fn) => (...a) => {
        asanCalls++;
        return fn(...a);
      };
      const asan = { collectSprites: counted(session.fn('collect_sprites')), collectSpritesTurned: counted(session.fn('collect_sprites_turned')) };
      const v = m.views;
      const outputs = [v.oY, v.oType, v.oIndex, v.oX, v.oPy, v.oRc, v.oRs];
      const run = (fns) => {
        for (const o of outputs) bytesOf(o).fill(0);
        bytesOf(kernel.results).fill(0xa5);
        pre._renderableCount = 0;
        pre.visibleEntitiesCount = 0;
        pre._renderQueueOverflowWarned = false;
        pre._customLayerCollectors = { [fx]: harness.customLayerCollector(n) };
        Object.assign(kernel, fns);
        pre._collectWasm = kernel;
        pre.collectVisibleEntities();
        pre._collectWasm = null;
        const col = pre._customLayerCollectors[fx];
        return {
          state: JSON.stringify([pre._renderableCount, pre.visibleEntitiesCount, pre._renderQueueOverflowWarned, col.count,
            Array.from(col.index.subarray(0, col.count))]),
          outs: outputs.map((o) => Buffer.from(bytesOf(o))),
        };
      };
      const got = run(asan);
      const want = run(shipped);
      let mismatch = null;
      if (asanCalls === 0) mismatch = 'the worker called no kernel';
      else if (got.state !== want.state) mismatch = `the collectors' counts differ: ${got.state} / the shipped kernel ${want.state}`;
      else {
        const names = ['y', 'type', 'index', 'x', 'pose y', 'rotC', 'rotS'];
        for (let i = 0; i < outputs.length && !mismatch; i++) {
          const at = firstDifference(got.outs[i], want.outs[i]);
          if (at >= 0) mismatch = `the collector's ${names[i]} column differs from the shipped kernel's at byte ${at}`;
        }
      }
      return { calls: asanCalls, rows: JSON.parse(want.state)[0], mismatch };
    } finally {
      console.warn = warn;
      Query.queryActiveEntities = realQuery;
      Layer.reset();
    }
  };
}

export default {
  name: 'preRenderCollect',
  sources: ['wasm/preRenderCollect.c'],
  exports: ['collect_sprites', 'collect_sprites_turned'],

  async groups(ctx) {
    const S = await imports(ctx);
    const cases = CASES.map((c, k) => ({ label: c.name, run: collectCase(S, c, k) }));
    return [{ label: 'preRenderCollectWasm cases and edge cases', cases }];
  },
};
