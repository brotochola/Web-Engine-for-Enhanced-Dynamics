/**
 * Pre-render's emit (wasm/preRenderEmit.c emit_rows, persist_frame, persist_remember) under ASan, on
 * preRenderEmitWasm.test.js's scenes: the real PreRenderWorker initialized as the test initializes it, but on the ASan
 * module's memory, every region of the render-queue memory (createRenderQueueMemory's layout: the queues, the emit's
 * component blocks and state, the collect's pose and bullet blocks, the custom layers) moved into a malloc'd block of
 * its own, 64-byte aligned as the product aligns them, at the bytes renderQueueMemoryRegions gives it; so an access past
 * a region's end lands in a redzone instead of the next region. The columns inside one component block or one queue stay
 * where the product lays them.
 * The emit keeps state from frame to frame, so each kernel call is run twice from the same bytes: every block of the
 * case is copied, the ASan kernel runs, its blocks are copied, the first copy is put back, the shipped kernel runs, and
 * every block must hold the same bytes after both (a write to the wrong region shows too). Cases: the test's runCase
 * scenes (Y-sort on and off, faces, keyed frames, a queue filled to its capacity, bullets, glows, particles with their
 * alpha fade, LiquidFun interpolated and not, without baseAlpha, keyed decorations and LiquidFun), 30 frames each, and
 * its persist path (persist_frame and persist_remember on alternating buffers, with dirty sprites, changed animations,
 * swapped rows and a frame past its animation's end on schedule), Y-sorted and not, the stash in the queue and not.
 */
import { relocateTree } from '../asanCases.mjs';

const N = 700;
const DECOS = 300;
const MAX = 900;
const DT = 1000 / 60;
const POOL = 64;
const LFN = 96;
const CL = 9;
const CLMAX = 500;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function imports(ctx) {
  const mods = await Promise.all([
    'src/components/transform.js', 'src/components/spriteRenderer.js', 'src/components/shadowCaster.js',
    'src/components/decorationComponent.js', 'src/components/particleComponent.js', 'src/components/bulletComponent.js',
    'src/components/lightEmitter.js', 'src/core/layer.js', 'src/render/renderQueueLayout.js', 'src/render/gpuQueueLayout.js',
    'src/util/renderQueueMemory.js', 'src/util/wasmMemoryMap.js', 'src/util/particleMemory.js', 'src/render/liquidFunRender.js',
    'src/workers/preRenderEmitClient.js', 'tests/bench/workerHarness.mjs', 'src/render/gpuPackClient.js',
  ].map((p) => ctx.importRepo(p)));
  const [tr, sr, sc, dc, pc, bc, le, layer, rql, gql, rqm, map, pm, lfr, client, harness, pack] = mods;
  return {
    Transform: tr.Transform, SpriteRenderer: sr.SpriteRenderer, ShadowCaster: sc.ShadowCaster,
    DecorationComponent: dc.DecorationComponent, ParticleComponent: pc.ParticleComponent, BulletComponent: bc.BulletComponent,
    LightEmitter: le.LightEmitter, Layer: layer.Layer, rql, gql, rqm, map, pm, lfr, client, harness, pack,
  };
}

/** preRenderEmitWasm.test.js textureMetadata: sheets 1-3 with 1-, 2-, 5- and 13-frame animations, sheet 4 without. */
function textureMetadata() {
  const animationFrameStart = [];
  const animationFrameCount = [];
  const widths = [];
  const heights = [];
  const proxyToGlobalAnim = {};
  let offset = 0;
  for (let sheet = 1; sheet <= 3; sheet++) {
    proxyToGlobalAnim[sheet] = {};
    [1, 2, 5, 13].forEach((frames, local) => {
      proxyToGlobalAnim[sheet][local] = animationFrameStart.length;
      animationFrameStart.push(offset);
      animationFrameCount.push(frames);
      for (let f = 0; f < frames; f++) {
        widths.push(16 + ((sheet * 7 + local * 3 + f * 5) % 50));
        heights.push(20 + ((sheet * 11 + f * 3) % 40));
      }
      offset += frames;
    });
  }
  proxyToGlobalAnim[4] = { 0: animationFrameStart.length + 5 };
  const animationNameToIndex = {};
  for (const name of ['_lightGradient', '_whiteCircle', '_bulletTrail']) {
    animationNameToIndex[name] = animationFrameStart.length;
    animationFrameStart.push(offset);
    animationFrameCount.push(1);
    widths.push(64);
    heights.push(64);
    offset += 1;
  }
  return {
    animationFrameStart, animationFrameCount, proxyToGlobalAnim, animationNameToIndex, totalFrames: offset,
    frameWidth: Uint16Array.from(widths), frameHeight: Uint16Array.from(heights),
  };
}

/** renderQueueMemory.js pixiExtraSpec (not exported): the Pixi pack scratch beyond its rows, as the memory sizes it. */
function pixiExtraSpec(S, emit, maxItems) {
  if (!emit) return null;
  const tableSlots = S.rqm.GPU_PACK_TABLE_SLOTS + 2 * ((emit.customLayers && emit.customLayers.length) | 0);
  const keyRows = emit.pixiKeyed
    ? S.gql.gpuIndexedStaticRows((emit.entities | 0) + (emit.keyedDecorations | 0) + (emit.keyedLiquidFun | 0) + (maxItems | 0))
    : 0;
  return { glowRows: emit.pixiGlowRows | 0, tableSlots, tableBytes: tableSlots * S.pack.GPU_PACK_COLUMNS.length * 4, keyRows };
}

/**
 * The test's setup on the ASan module's memory: the product layout relocated region by region (relocateTree), the
 * worker initialized on it, every column filled as the test fills it, the emit kernel bound.
 */
async function setup(ctx, S, o) {
  const { session } = ctx;
  const { Transform, SpriteRenderer, ShadowCaster, DecorationComponent, ParticleComponent, BulletComponent, LightEmitter } = S;
  const ySort = o.ySort;
  const maxItems = o.maxItems ?? MAX;
  const count = o.count ?? MAX;
  const seed = o.seed ?? 0x5eed;
  const caps = S.gql.gpuQueueCaps(maxItems, { enabled: false });
  const collect = o.bullets || o.lights
    ? {
        entities: N, transformBytes: Transform.getBufferSize(N), colliderBytes: 0, rigidBodyBytes: 0,
        bullets: o.bullets ? { bullets: POOL, entities: N, componentBytes: BulletComponent.getBufferSize(POOL), impacts: 8 } : null,
        visibility: null,
      }
    : null;
  const emitSpec = {
    entities: N,
    spriteBytes: SpriteRenderer.getBufferSize(N),
    casterBytes: ShadowCaster.getBufferSize(N),
    decorationBytes: DecorationComponent.getBufferSize(DECOS),
    lightBytes: o.lights ? LightEmitter.getBufferSize(N) : 0,
    particleBytes: o.particles ? S.pm.particleMemoryBytes(POOL, ParticleComponent.getBufferSize(POOL)) : 0,
    liquidFun: o.liquidFun ? { maxCount: LFN, renderBytes: S.lfr.liquidFunRenderByteSize(LFN) } : null,
    customLayers: o.customLayer ? [{ layerId: CL, maxItems: CLMAX, queueBytes: S.rql.computeBufferSize(CLMAX) }] : [],
    pixiKeyed: !!o.keyed,
    keyedDecorations: o.keyed && o.keyedDecorations ? DECOS : 0,
    keyedLiquidFun: o.keyed && o.liquidFun && o.keyedLiquidFun ? LFN : 0,
  };
  const queueBytes = S.rql.computeBufferSize(maxItems);
  const gpuQueueBytes = S.gql.computeGpuQueueBufferSize(caps);
  const product = S.rqm.createRenderQueueMemory(maxItems, queueBytes, gpuQueueBytes, emitSpec, null, null, false, collect);
  const tableBytes = S.rqm.GPU_PACK_TABLE_SLOTS * S.pack.GPU_PACK_COLUMNS.length * 4;
  const map = S.map.renderQueueMemoryRegions(queueBytes, gpuQueueBytes, maxItems, tableBytes, emitSpec, null, null, 0, collect, null, 15,
    pixiExtraSpec(S, emitSpec, maxItems));
  if (map.regions.queueB.byte !== product.layout.queueBByte || map.regions.emitTable.byte !== product.layout.emit.tableByte) {
    throw new Error('preRenderEmit: the region map and createRenderQueueMemory disagree');
  }
  const { layout } = relocateTree(session, map, product.layout, ['emit', '']);
  const e = layout.emit;
  const buffer = session.buffer;
  const memory = session.memory;
  const pm = o.particles
    ? S.pm.createParticleMemory(POOL, ParticleComponent.getBufferSize(POOL), { memory, baseByte: e.particleMemoryByte, bytes: e.particleMemoryBytes })
    : null;
  const buffers = {
    componentData: {
      ...S.harness.coreComponentData(N),
      SpriteRenderer: buffer,
      ShadowCaster: buffer,
      DecorationComponent: buffer,
      LightEmitter: o.lights ? buffer : new SharedArrayBuffer(LightEmitter.getBufferSize(N)),
      ParticleComponent: o.particles ? buffer : new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)),
      BulletComponent: o.bullets ? buffer : new SharedArrayBuffer(BulletComponent.getBufferSize(POOL)),
    },
    componentDataByte: {
      SpriteRenderer: e.spriteRendererByte,
      ShadowCaster: e.shadowCasterByte,
      DecorationComponent: e.decorationByte,
      ...(o.bullets ? { BulletComponent: layout.collect.bullets.componentByte } : {}),
      ...(o.lights ? { LightEmitter: e.lightEmitterByte } : {}),
      ...(o.particles ? { ParticleComponent: pm.layout.componentByte } : {}),
    },
    ...(o.liquidFun ? { liquidFunRender: buffer, liquidFunRenderByte: e.liquidFunRenderByte } : {}),
  };
  for (const C of [SpriteRenderer, ShadowCaster, DecorationComponent, LightEmitter]) C.clearArrays();
  const meta = textureMetadata();
  const worker = await S.harness.loadWorker('preRenderWorker.js', 'preRenderWorker');
  await S.harness.initWorker(worker, {
    config: { worldWidth: 4000, worldHeight: 3000, preRender: { interpolation: false }, renderer: { ySort } },
    globalEntityCount: N,
    buffers,
    extra: {
      maxDecorations: DECOS,
      maxParticles: POOL,
      maxBullets: POOL,
      liquidFunMaxCount: o.liquidFun ? LFN : 0,
      textureMetadata: meta,
      ...(o.customLayer ? {
        customLayerRenderQueues: {
          [CL]: {
            dataA: buffer, dataAByte: e.customLayers[0].queueAByte, dataB: buffer, dataBByte: e.customLayers[0].queueBByte,
            collectorByte: e.customLayers[0].collectorByte, maxItems: CLMAX, layerId: CL, layerName: 'fx',
          },
        },
      } : {}),
      renderQueueMemory: memory,
      renderQueueLayout: layout,
      renderQueue: {
        maxItems,
        sync: new SharedArrayBuffer(8),
        dataA: buffer,
        dataAByte: layout.queueAByte,
        dataB: buffer,
        dataBByte: layout.queueBByte,
        cameraA: new SharedArrayBuffer(S.rql.RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(S.rql.RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: buffer,
        entityTextureByte: e.lastTextureByte,
      },
    },
  });
  S.harness.bindPoseColumns(N);
  if (o.lights) {
    const pose = layout.collect.poseByte;
    Transform.x = new Float32Array(buffer, pose, N);
    Transform.y = new Float32Array(buffer, pose + 4 * N, N);
    Transform.rotC = new Float32Array(buffer, pose + 12 * N, N);
    Transform.rotS = new Float32Array(buffer, pose + 16 * N, N);
  }
  if (SpriteRenderer.scaleX.buffer !== buffer || worker._renderableType.buffer !== buffer) {
    throw new Error('preRenderEmit: the worker did not bind its columns on the ASan memory');
  }
  worker.zenithalMaxHeight = 220;
  worker.zenithalScaleFactor = 0.5;
  worker.zenithalAlphaFade = o.alphaFade ?? 0;
  worker._decorationZoomAlpha = 0.75;
  worker._animEndByType = new Uint8Array(256).fill(1);

  const r = rng(seed);
  const sr = SpriteRenderer;
  for (let i = 0; i < N; i++) {
    sr.active[i] = 1;
    sr.scaleX[i] = i % 31 === 0 ? -1.25 : 0.5 + r();
    sr.scaleY[i] = i % 37 === 0 ? 0 : 0.5 + r();
    sr.alpha[i] = r();
    sr.tint[i] = (r() * 0xffffff) >>> 0;
    sr.anchorX[i] = r();
    sr.anchorY[i] = r();
    sr.inheritTransformRotation[i] = i % 3 === 0 ? 0 : 1;
    sr.spriteRotC[i] = Math.cos(i);
    sr.spriteRotS[i] = Math.sin(i);
    sr.zIndex[i] = (i % 5) - 2;
    sr.repeatX[i] = i % 17 === 0 ? 32 : 0;
    sr.repeatY[i] = i % 23 === 0 ? 48 : 0;
    sr.tileMode[i] = i % 2 ? 2 : 1;
    sr.tileOffsetU[i] = (i * 977) & 0xffff;
    sr.tileOffsetV[i] = (i * 331) & 0xffff;
    sr.boundsHalfW[i] = 10 + (i % 40);
    sr.boundsHalfH[i] = 12 + (i % 30);
    sr.spritesheetId[i] = i % 41 === 0 ? 0 : i % 29 === 0 ? 4 : 1 + (i % 3);
    sr.animationState[i] = sr.spritesheetId[i] === 4 ? (i & 1) : i % 4;
    sr.isAnimated[i] = i % 7 === 0 ? 0 : 1;
    sr.animationSpeed[i] = 0.1 + r() * 0.9;
    sr.loop[i] = i % 11 === 0 ? 0 : 1;
    ShadowCaster.active[i] = i % 4 === 0 ? 0 : 1;
    ShadowCaster.heightMultiplier[i] = i % 13 === 0 ? NaN : i % 19 === 0 ? -0 : r() * 2;
    ShadowCaster.anchorOffsetX[i] = i % 9 === 0 ? -0 : r();
    ShadowCaster.anchorOffsetY[i] = i % 10 === 0 ? NaN : r();
    worker.entityFrameIndex[i] = (i * 7) % 15;
    worker.entityFrameAccumulator[i] = r() * 0.2;
  }
  for (let d = 0; d < DECOS; d++) {
    DecorationComponent.scaleX[d] = r();
    DecorationComponent.scaleY[d] = r();
    DecorationComponent.alpha[d] = r();
    DecorationComponent.tint[d] = (r() * 0xffffff) >>> 0;
    DecorationComponent.textureId[d] = d % 47 === 0 ? meta.animationFrameStart.length + 9 : d % 12;
    DecorationComponent.anchorX[d] = r();
    DecorationComponent.anchorY[d] = r();
    DecorationComponent.faceOct[d] = o.faces && d % 3 !== 0 ? 0x0101 + ((r() * 0xfafa) | 0) : 0;
    DecorationComponent.faceZ[d] = o.faces && d % 3 !== 0 ? (r() * 0xffff) | 0 : 0;
  }
  worker._faces = !!o.faces;

  const rb = rng(seed ^ 0xb011e7);
  const bc = BulletComponent;
  for (let s = 0; s < POOL; s++) {
    bc.active[s] = s % 7 === 0 ? 0 : 1;
    bc.x[s] = s % 13 === 0 ? -0 : rb() * 4000;
    bc.y[s] = rb() * 3000;
    bc.startX[s] = s % 13 === 0 ? 0 : s % 5 === 0 ? bc.x[s] : s % 6 === 0 ? bc.x[s] + 0.03 : bc.x[s] - (rb() - 0.5) * 300;
    bc.startY[s] = s % 5 === 0 || s % 6 === 0 ? bc.y[s] : bc.y[s] - (rb() - 0.5) * 300;
    bc.offsetY[s] = s % 3 === 0 ? 0 : -rb() * 40;
    bc.scale[s] = 0.25 + rb();
    bc.alpha[s] = rb();
    bc.tint[s] = (rb() * 0xffffff) >>> 0;
    bc.textureId[s] = s % 17 === 0 ? meta.animationFrameStart.length + 3 : s % 12;
    bc.spriteRotC[s] = Math.cos(s * 0.7);
    bc.spriteRotS[s] = Math.sin(s * 0.7);
    bc.bulletRotC[s] = Math.cos(s * 1.3);
    bc.bulletRotS[s] = Math.sin(s * 1.3);
    bc.trailWidth[s] = 0.5 + rb() * 3;
    bc.anchorX[s] = rb();
    bc.anchorY[s] = rb();
  }

  const rl = rng(seed ^ 0x9107);
  const le = LightEmitter;
  for (let i = 0; i < N; i++) {
    const radius = i % 11 === 0 ? 0 : i % 13 === 0 ? (i & 1 ? 5 : 11) : 70 + rl() * 1400;
    le.radius[i] = i % 17 === 0 ? NaN : i % 19 === 0 ? -0 : radius;
    le.glow[i] = [0, 0.4, 1.2, 0.0005][i % 4];
    le.brightness[i] = i % 5 === 0 ? 0.5 : 1;
    le.glowOffsetY[i] = i % 7 === 0 ? NaN : i % 9 === 0 ? -0 : rl() * 60 - 50;
    le.color[i] = (rl() * 0xffffffff) >>> 0;
    Transform.x[i] = i % 23 === 0 ? -0 : rl() * 4000;
    Transform.y[i] = rl() * 3000;
    le.offsetX[i] = i % 3 === 0 ? rl() * 40 - 20 : 0;
    le.offsetY[i] = i % 3 === 0 ? rl() * 40 - 20 : 0;
    const facing = rl() * 6.283;
    Transform.rotC[i] = Math.cos(facing);
    Transform.rotS[i] = Math.sin(facing);
  }

  const rp = rng(seed ^ 0x9a27);
  const pc = ParticleComponent;
  for (let s = 0; s < POOL; s++) {
    pc.x[s] = rp() * 4000;
    pc.y[s] = rp() * 3000;
    pc.z[s] = s % 13 === 0 ? NaN : s % 9 === 0 ? -0 : s % 5 === 0 ? rp() * 30 : -rp() * 400;
    pc.scaleX[s] = 0.1 + rp() * 2;
    pc.scaleY[s] = 0.1 + rp() * 2;
    pc.flipX[s] = s % 3 === 0 ? 1 : 0;
    pc.flipY[s] = s % 4 === 0 ? 1 : 0;
    pc.rotC[s] = Math.cos(s * 0.9);
    pc.rotS[s] = Math.sin(s * 0.9);
    pc.alpha[s] = rp();
    pc.tint[s] = (rp() * 0xffffff) >>> 0;
    pc.textureId[s] = s % 6 === 0 ? 0 : s % 11 === 0 ? meta.animationFrameStart.length + 5 : 1 + (s % 10);
    pc.viewMode[s] = s % 2 === 0 ? 1 : 0;
    pc.flat[s] = s % 7 === 0 ? 1 : 0;
  }

  if (o.liquidFun) {
    const rf = rng(seed ^ 0x1f1f);
    const lf = worker.liquidFun;
    lf.count[0] = LFN;
    for (let s = 0; s < LFN; s++) {
      lf.x[s] = rf() * 4000;
      lf.y[s] = rf() * 3000;
      lf.scaleX[s] = 0.2 + rf();
      lf.scaleY[s] = 0.2 + rf();
      lf.alpha[s] = rf();
      lf.baseAlpha[s] = s % 5 === 0 ? 1 : rf();
      lf.rotC[s] = Math.cos(s * 0.3);
      lf.rotS[s] = Math.sin(s * 0.3);
      lf.tint[s] = (rf() * 0xffffff) >>> 0;
      lf.textureId[s] = s % 4 === 0 ? 0 : s % 13 === 0 ? meta.animationFrameStart.length + 7 : 1 + (s % 9);
      worker._prevLfX[s] = lf.x[s] + (rf() - 0.5) * 20;
      worker._prevLfY[s] = lf.y[s] + (rf() - 0.5) * 20;
    }
    if (o.noBaseAlpha) lf.baseAlpha = null;
    worker.interpolatePhysicsPose = !!o.interpolate;
    worker._prevLfCount = 12;
    worker._poseAlpha = 0.37;
  }

  const types = [];
  const indices = [];
  let other = 0;
  let pnext = 0;
  let lfnext = 0;
  const unique = o.keyed ? Array.from({ length: N }, (_, i) => (i * 389) % N) : null;
  let un = 0;
  for (let k = 0; k < count; k++) {
    const pick = r();
    if (pick < (o.bullets ? 0.55 : 0.62)) {
      const pickEntity = Math.floor(r() * N);
      types.push(0);
      indices.push(o.keyed ? unique[un++ % N] : pickEntity);
    } else if (pick < (o.bullets ? 0.75 : 0.92)) {
      types.push(2);
      indices.push(Math.floor(r() * DECOS));
    } else if (o.particles && k % 3 === 1) {
      types.push(1);
      indices.push(pnext++ % POOL);
    } else if (o.liquidFun && k % 3 === 2) {
      types.push(7);
      indices.push(lfnext++ % LFN);
    } else if (o.lights && k % 3 !== 0) {
      types.push(3);
      indices.push((k * 7919) % N);
    } else if (o.bullets) {
      types.push([1, 3, 4, 5][other % 4]);
      indices.push((other >> 2) % POOL);
      other++;
    } else {
      types.push([1, 3, 4, 5][k % 4]);
      indices.push(k % POOL);
    }
  }
  const q = { x: worker.renderQueueX, y: worker.renderQueueY, rc: worker.renderQueueRotC, rs: worker.renderQueueRotS };
  for (let k = 0; k < count; k++) {
    worker._renderableType[k] = types[k];
    worker._renderableIndex[k] = indices[k];
    worker._renderableY[k] = Math.round(r() * 3000) * 128 + (k % 3 === 0 ? -0 : 0);
    q.x[k] = r() * 4000;
    q.y[k] = r() * 3000;
    q.rc[k] = Math.cos(k);
    q.rs[k] = Math.sin(k);
  }
  const source = worker._fillEmitSource(count, maxItems, worker._renderableY, worker._renderableType, worker._renderableIndex,
    q.x, q.y, q.rc, q.rs, !!o.persist, true, ySort);
  const b = await S.client.bindPreRenderEmit(memory, e);
  if (!S.client.writeEmitTextures(b, meta)) throw new Error('preRenderEmit: the metadata does not fit the tables');
  return { worker, layout, b, source, types, count, maxItems, ySort, ...o };
}

/**
 * One kernel call made twice from the same bytes: the ASan build (asanFn), then the shipped one (shippedFn), every
 * block of the case copied before and put back between them. Returns the shipped call's value, or throws a mismatch.
 */
function dualCall(session, label, asanFn, shippedFn) {
  const blocks = session.allocs.map((a) => new Uint8Array(session.buffer, a.ptr, a.bytes));
  const before = blocks.map((v) => Buffer.from(v));
  const got = asanFn();
  const after = blocks.map((v) => Buffer.from(v));
  blocks.forEach((v, i) => v.set(before[i]));
  const want = shippedFn();
  if (got !== want) return { value: want, mismatch: `${label}: returned ${got}, the shipped kernel ${want}` };
  for (let i = 0; i < blocks.length; i++) {
    if (Buffer.compare(blocks[i], after[i]) !== 0) {
      let at = 0;
      while (blocks[i][at] === after[i][at]) at++;
      return { value: want, mismatch: `${label}: '${session.allocs[i].name}' differs from the shipped kernel's at byte ${at}` };
    }
  }
  return { value: want, mismatch: null };
}

/** The kernel's three exports, ASan's and the shipped one's, with the ASan calls counted. */
function kernels(session, b) {
  const counter = { n: 0 };
  const wrap = (name) => {
    const fn = session.fn(name);
    return (...a) => {
      counter.n++;
      return fn(...a);
    };
  };
  return {
    counter,
    shipped: { emitRows: b.emitRows, persistFrame: b.persistFrame, persistRemember: b.persistRemember },
    asan: { emitRows: wrap('emit_rows'), persistFrame: wrap('persist_frame'), persistRemember: wrap('persist_remember') },
  };
}

/** The test's runCase, the kernel half: `frames` frames of emit_rows, each run twice (dualCall). */
function emitCase(S, opts, frames) {
  return async (ctx) => {
    const { session } = ctx;
    const k = await setup(ctx, S, opts);
    const { worker, b, source, count, maxItems } = k;
    const C = S.client;
    const K = kernels(session, b);
    const kernelSource = k.keyed ? { ...source, persist: true } : source;
    if (k.keyed) S.SpriteRenderer.keyedDirty.fill(1);
    let rows = 0;
    for (let f = 0; f < frames; f++) {
      b.testKeyFrame = (b.testKeyFrame | 0) + 1;
      C.setEmitKeyFrames(b, b.testKeyFrame, b.testKeyFrame - 1);
      if (!C.writeEmitColumns(b, worker, S.SpriteRenderer, S.ShadowCaster, S.DecorationComponent, kernelSource)) {
        return { calls: K.counter.n, rows, mismatch: `frame ${f}: a column is not in the memory` };
      }
      C.writeEmitBulletColumns(b, S.BulletComponent, worker._resolveBuiltinTextureId('_bulletTrail'));
      C.writeEmitGlowColumns(b, S.LightEmitter, S.Transform, worker._resolveBuiltinTextureId('_lightGradient'));
      C.writeEmitParticleColumns(b, S.ParticleComponent, worker._resolveBuiltinTextureId('_whiteCircle'),
        worker.zenithalMaxHeight, worker.zenithalScaleFactor, worker.zenithalAlphaFade);
      const lfPrev = worker.interpolatePhysicsPose && worker._prevLfX ? worker._prevLfCount : 0;
      C.writeEmitLiquidFunColumns(b, worker.liquidFun, worker._prevLfX, worker._prevLfY, lfPrev, worker._poseAlpha,
        worker._resolveBuiltinTextureId('_whiteCircle'));
      const tilesDirty = worker.renderQueueTileMode !== null && (worker._faces || worker._tiledTileColumns.has(worker.renderQueueTileMode));
      const flags = C.EMIT_SORT_KEY | (k.ySort ? C.EMIT_Y_SORT : 0) | (tilesDirty ? C.EMIT_TILES_DIRTY : 0) | C.EMIT_BOUNDS;
      const args = [b.tableByte, count, maxItems, flags, DT / 1000, worker._decorationZoomAlpha, worker._zBand];
      const d = dualCall(session, `frame ${f}`, () => K.asan.emitRows(...args), () => K.shipped.emitRows(...args));
      if (d.mismatch) return { calls: K.counter.n, rows, mismatch: d.mismatch };
      if (d.value === C.EMIT_DECLINED) return { calls: K.counter.n, rows, mismatch: `frame ${f}: the kernel declined the frame` };
      rows += d.value;
      if (b.results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
    }
    return { calls: K.counter.n, rows, mismatch: null };
  };
}

/** The test's persistSchedule: the frames' poses, and what makes a frame miss, on schedule. */
function persistSchedule(S, k, { inQueue, seed }) {
  const { worker, count } = k;
  const SR = S.SpriteRenderer;
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const sprites = [];
  for (let r = 0; r < count; r++) if (cType[r] === 0) sprites.push(r);
  for (const r of sprites.slice(0, 60)) if (SR.isAnimated[cIndex[r]]) SR.animationSpeed[cIndex[r]] = NaN;
  const animatedRow = sprites.find((r) => SR.isAnimated[cIndex[r]] && SR.spritesheetId[cIndex[r]] === 2 && SR.animationState[cIndex[r]] === 3);
  return (f) => {
    const buf = f & 1;
    worker._queueBuf = buf;
    worker._setWriteBuffer(buf);
    const o = worker.renderQueueBuffers[buf ^ 1];
    const st = inQueue
      ? { x: worker.renderQueueX, y: worker.renderQueueY, rc: worker.renderQueueRotC, rs: worker.renderQueueRotS }
      : { x: o.x, y: o.y, rc: o.rotC, rs: o.rotS };
    const r = rng(seed * 1000 + f);
    for (let i = 0; i < count; i++) {
      st.x[i] = r() * 4000;
      st.y[i] = r() * 3000;
      st.rc[i] = Math.cos(f + i);
      st.rs[i] = Math.sin(f + i);
    }
    if (f % 7 === 3) for (let j = 0; j < 5; j++) SR.renderDirty[cIndex[sprites[Math.floor(r() * sprites.length)]]] = 1;
    if (f % 11 === 5) {
      const idx = cIndex[sprites[Math.floor(r() * sprites.length)]];
      if (SR.spritesheetId[idx] !== 4) SR.animationState[idx] = (SR.animationState[idx] + 1) % 4;
    }
    if (f % 13 === 8) {
      const a = Math.floor(r() * count);
      const c = Math.floor(r() * count);
      [cType[a], cType[c]] = [cType[c], cType[a]];
      [cIndex[a], cIndex[c]] = [cIndex[c], cIndex[a]];
    }
    if (f === 17 && animatedRow !== undefined) worker.entityFrameIndex[cIndex[animatedRow]] = 99;
    if (f % 5 === 2) {
      for (let j = 0; j < 8; j++) {
        const idx = cIndex[sprites[Math.floor(r() * sprites.length)]];
        S.ShadowCaster.heightMultiplier[idx] = r() * 2;
        S.ShadowCaster.active[idx] ^= 1;
      }
    }
    return { buf, st };
  };
}

/** The test's persistFrames, the kernel half: persist_frame where the buffer holds the frame, else emit_rows and persist_remember. */
function persistCase(S, opts, frames) {
  return async (ctx) => {
    const { session } = ctx;
    const k = await setup(ctx, S, { ...opts, persist: true });
    const { worker, b, maxItems } = k;
    const count = k.count;
    const C = S.client;
    const K = kernels(session, b);
    const SR = S.SpriteRenderer;
    const savedLayer = [S.Layer._ySorting, S.Layer.entitiesId];
    SR._zIndexUsers[0] = 1;
    if (opts.ySort) {
      S.Layer._ySorting = new Uint8Array(32);
      S.Layer.entitiesId = 0;
      S.Layer._ySorting[0] = 1;
    }
    try {
      const prepare = persistSchedule(S, k, opts);
      if (k.keyed) SR.keyedDirty.fill(1);
      const cType = worker._renderableType;
      const cIndex = worker._renderableIndex;
      const cY = worker._renderableY;
      worker._persistCount = [0, 0];
      worker._tiledTileColumns = new Set();
      let rows = 0;
      let hits = 0;
      for (let f = 0; f < frames; f++) {
        const { buf, st } = prepare(f);
        const source = worker._fillEmitSource(count, maxItems, cY, cType, cIndex, st.x, st.y, st.rc, st.rs, true, true, opts.ySort);
        b.testKeyFrame = (b.testKeyFrame | 0) + 1;
        C.setEmitKeyFrames(b, b.testKeyFrame, b.testKeyFrame - 1);
        if (!C.writeEmitColumns(b, worker, SR, S.ShadowCaster, S.DecorationComponent, source) || !C.writePersistColumns(b, worker, SR, buf)) {
          return { calls: K.counter.n, rows, mismatch: `frame ${f}: a column is not in the memory` };
        }
        const sort = !!(worker.renderQueueSortKey && worker._queueHasOrder());
        const flags = (sort ? C.EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? C.EMIT_Y_SORT : 0) | C.EMIT_BOUNDS;
        let hit = false;
        if (worker._persistCount[buf] === count) {
          const args = [b.tableByte, count, maxItems, flags, DT / 1000, worker._zBand];
          const d = dualCall(session, `frame ${f} persist_frame`, () => K.asan.persistFrame(...args), () => K.shipped.persistFrame(...args));
          if (d.mismatch) return { calls: K.counter.n, rows, mismatch: d.mismatch };
          hit = d.value !== C.EMIT_PERSIST_MISS;
          if (hit) hits++;
        }
        if (!hit) {
          const tilesDirty = worker.renderQueueTileMode !== null && worker._tiledTileColumns.has(worker.renderQueueTileMode);
          const args = [b.tableByte, count, maxItems, flags | (tilesDirty ? C.EMIT_TILES_DIRTY : 0), DT / 1000, worker._decorationZoomAlpha, worker._zBand];
          const d = dualCall(session, `frame ${f} emit_rows`, () => K.asan.emitRows(...args), () => K.shipped.emitRows(...args));
          if (d.mismatch) return { calls: K.counter.n, rows, mismatch: d.mismatch };
          if (d.value === C.EMIT_DECLINED) return { calls: K.counter.n, rows, mismatch: `frame ${f}: the kernel declined the frame` };
          rows += d.value;
          if (b.results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
          const rargs = [b.tableByte, count, maxItems];
          const rem = dualCall(session, `frame ${f} persist_remember`, () => K.asan.persistRemember(...rargs), () => K.shipped.persistRemember(...rargs));
          if (rem.mismatch) return { calls: K.counter.n, rows, mismatch: rem.mismatch };
          worker._persistCount[buf] = count;
          if (rem.value) worker._persistCount[buf ^ 1] = -1;
        } else {
          rows += count;
        }
      }
      if (hits === 0) return { calls: K.counter.n, rows, mismatch: 'no frame took the persist path' };
      return { calls: K.counter.n, rows, mismatch: null };
    } finally {
      [S.Layer._ySorting, S.Layer.entitiesId] = savedLayer;
    }
  };
}

const EMIT_CASES = [
  ['Y-sorted', { ySort: true }],
  ['without Y-sort', { ySort: false, seed: 0xbeef }],
  ['faces', { ySort: true, faces: true }],
  ['keyed frames', { ySort: true, keyed: true }],
  ['a queue filled to its capacity', { ySort: true, maxItems: 600, count: 600, seed: 0xfeed }],
  ['bullets, Y-sorted', { ySort: true, bullets: true, seed: 0xb0b }],
  ['bullets', { ySort: false, bullets: true, seed: 0xb1b }],
  ['glows', { ySort: true, lights: true, seed: 0x6107 }],
  ['glows and bullets', { ySort: false, lights: true, bullets: true, seed: 0x6108 }],
  ['particles', { ySort: true, particles: true, seed: 0x9a71 }],
  ['particles, alpha fade', { ySort: false, particles: true, alphaFade: 0.8, seed: 0x9a72 }],
  ['particles, glows and bullets', { ySort: true, particles: true, lights: true, bullets: true, alphaFade: 2.5, seed: 0x9a73 }],
  ['LiquidFun, interpolated', { ySort: true, liquidFun: true, interpolate: true, seed: 0x1f01 }],
  ['LiquidFun', { ySort: false, liquidFun: true, interpolate: false, seed: 0x1f02 }],
  ['LiquidFun without baseAlpha, particles', { ySort: true, liquidFun: true, interpolate: true, particles: true, noBaseAlpha: true, seed: 0x1f03 }],
  ['keyed decorations and LiquidFun', { ySort: true, keyed: true, keyedDecorations: true, liquidFun: true, keyedLiquidFun: true, seed: 0x1f04 }],
  ['a custom layer in the memory', { ySort: true, customLayer: true, seed: 0xc1 }],
];

const PERSIST_CASES = [
  ['Y-sorted, the stash in the queue', { ySort: true, inQueue: true, seed: 0x9e1 }],
  ['keyed, Y-sorted', { ySort: true, inQueue: true, seed: 0x9e2, keyed: true }],
  ['without Y-sort', { ySort: false, inQueue: true, seed: 0x9e3 }],
  ['a stash that is not the queue', { ySort: true, inQueue: false, seed: 0x9e4 }],
];

export default {
  name: 'preRenderEmit',
  sources: ['wasm/preRenderEmit.c'],
  exports: ['emit_rows', 'persist_frame', 'persist_remember', 'adobe_advance'],

  async groups(ctx) {
    const S = await imports(ctx);
    const frames = ctx.quick ? 6 : 30;
    const emit = (ctx.quick ? EMIT_CASES.filter((_, i) => i % 3 === 0) : EMIT_CASES)
      .map(([label, o]) => ({ label, run: emitCase(S, o, frames) }));
    const persist = (ctx.quick ? PERSIST_CASES.slice(0, 1) : PERSIST_CASES)
      .map(([label, o]) => ({ label, run: persistCase(S, o, ctx.quick ? 20 : 40) }));
    return [
      { label: 'emit_rows on preRenderEmitWasm\'s scenes, frame after frame', cases: emit },
      { label: 'the persist path (persist_frame, persist_remember, emit_rows on a miss)', cases: persist },
    ];
  },
};
