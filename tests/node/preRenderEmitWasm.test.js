// E-112 (W4a): the emit kernel (preRenderEmit.wasm, through preRenderEmitClient.js) against the shipped
// PreRenderWorker.emitSpriteQueue on a real worker, every column in the render-queue memory as the scene
// lays it out. Both sides start from the same state and run 30 frames; for every frame the kernel's sprite
// and decoration rows, the animation state (frame, clock, last texture, bounds), the play-once ends and
// the missing-texture warnings must be what the JS made, and the rows of other types must be listed and
// left alone. The mix covers what the kernel copies from the JS: tiled sprites (world and local) and the
// tiles-dirty frames after them, sprites without an animation or a first frame, play-once ends, zIndex,
// Y-sort on and off, NaN and -0 shadow terms, decorations with and without a texture, and a collector
// longer than the queue. W4d: with BulletComponent in the memory, the bullet and trail rows too (hidden,
// short and -0 trails, offsets, a bullet without a first frame). With LightEmitter and Transform there, the glow rows
// (hidden by their scale or their alpha, NaN and -0 roots and offsets, every glow strength, the entity's zIndex). With
// ParticleComponent there (the particle memory placed in it), the particle rows (zenithal, flat and plain, flipped,
// the alpha fade on and off, the white circle and a texture past the animations). With the LiquidFun render buffer
// and pre-render's previous positions there, the LiquidFun rows (interpolated or not, with and without baseAlpha).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Layer } from '../../src/core/layer.js';
import { computeBufferSize, createViews, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { createParticleMemory, particleMemoryBytes } from '../../src/util/particleMemory.js';
import { liquidFunRenderByteSize } from '../../src/render/liquidFunRender.js';
import {
  bindPreRenderEmit,
  EMIT_BOUNDS,
  EMIT_DECLINED,
  EMIT_OTHERS_ONLY,
  EMIT_PERSIST_MISS,
  EMIT_SORT_KEY,
  EMIT_TILES_DIRTY,
  EMIT_WARN_BULLET_START,
  EMIT_WARN_DECO_START,
  EMIT_WARN_NO_ANIM,
  EMIT_WARN_NO_START,
  EMIT_WARN_PARTICLE_START,
  EMIT_WARN_LF_START,
  EMIT_Y_SORT,
  bumpEmitDecorationEpoch,
  writeEmitBulletColumns,
  writeEmitColumns,
  writeEmitGlowColumns,
  writeEmitParticleColumns,
  writeEmitLiquidFunColumns,
  writeEmitTextures,
  writePersistColumns,
} from '../../src/workers/preRenderEmitClient.js';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { installEmitJs } from '../reference/preRenderEmitJs.mjs';

const N = 700;
const DECOS = 300;
const MAX = 900;
const DT = 1000 / 60;
const FRAMES = 30;
const POOL = 64;
/** LiquidFun particles in the render buffer. */
const LFN = 96;
/** A custom sprite layer's id and rows (its queue and collector in the memory). */
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

/** Sheets 1-3 with 1-, 2-, 5- and 13-frame animations, frame sizes that change from frame to frame. */
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
  // Sheet 4: state 0 maps past the last animation (no first frame), state 1 to nothing at all.
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
    animationFrameStart,
    animationFrameCount,
    proxyToGlobalAnim,
    animationNameToIndex,
    totalFrames: offset,
    frameWidth: Uint16Array.from(widths),
    frameHeight: Uint16Array.from(heights),
  };
}

async function setup({ ySort, maxItems = MAX, count = MAX, seed = 0x5eed, persist = false, bullets = false, lights = false, particles = false, alphaFade = 0, liquidFun = false, interpolate = false, noBaseAlpha = false, customLayer = false, keyed = false, keyedDecorations = false, keyedLiquidFun = false, faces = false }) {
  const caps = gpuQueueCaps(maxItems, { enabled: false });
  // W4d: with `bullets`, BulletComponent in the memory where the scene puts it (the bullet tick's regions, W19).
  // With `lights`, LightEmitter in the emit's blocks and Transform's pose in the collect's (a scene without physics).
  const collect = bullets || lights
    ? {
        entities: N,
        transformBytes: Transform.getBufferSize(N),
        colliderBytes: 0,
        rigidBodyBytes: 0,
        bullets: bullets ? { bullets: POOL, entities: N, componentBytes: BulletComponent.getBufferSize(POOL), impacts: 8 } : null,
        visibility: null,
      }
    : null;
  const m = createRenderQueueMemory(maxItems, computeBufferSize(maxItems), computeGpuQueueBufferSize(caps), {
    entities: N,
    spriteBytes: SpriteRenderer.getBufferSize(N),
    casterBytes: ShadowCaster.getBufferSize(N),
    decorationBytes: DecorationComponent.getBufferSize(DECOS),
    lightBytes: lights ? LightEmitter.getBufferSize(N) : 0,
    particleBytes: particles ? particleMemoryBytes(POOL, ParticleComponent.getBufferSize(POOL)) : 0,
    liquidFun: liquidFun ? { maxCount: LFN, renderBytes: liquidFunRenderByteSize(LFN) } : null,
    customLayers: customLayer ? [{ layerId: CL, maxItems: CLMAX, queueBytes: computeBufferSize(CLMAX) }] : [],
    // E-177: with `keyed`, the keyed frames' resync header (and the main queue's key column and flags bound).
    pixiKeyed: keyed,
    // E-188: with `keyedDecorations` too, the decorations' records (their rows keyed by pool slot past the entities).
    keyedDecorations: keyed && keyedDecorations ? DECOS : 0,
    // E-194: with `keyedLiquidFun` too, the LiquidFun particles' records (keyed by index past the decorations).
    keyedLiquidFun: keyed && liquidFun && keyedLiquidFun ? LFN : 0,
  }, null, null, false, collect);
  const e = m.layout.emit;
  // With `particles`, the particle memory in its region of this one, as the scene places it.
  const pm = particles
    ? createParticleMemory(POOL, ParticleComponent.getBufferSize(POOL), { memory: m.memory, baseByte: e.particleMemoryByte, bytes: e.particleMemoryBytes })
    : null;
  const buffers = {
    componentData: {
      ...coreComponentData(N),
      SpriteRenderer: m.buffer,
      ShadowCaster: m.buffer,
      DecorationComponent: m.buffer,
      // What the rows of other types read in the JS run (the kernel leaves those rows to it).
      LightEmitter: lights ? m.buffer : new SharedArrayBuffer(LightEmitter.getBufferSize(N)),
      ParticleComponent: particles ? m.buffer : new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)),
      BulletComponent: bullets ? m.buffer : new SharedArrayBuffer(BulletComponent.getBufferSize(POOL)),
    },
    componentDataByte: {
      SpriteRenderer: e.spriteRendererByte,
      ShadowCaster: e.shadowCasterByte,
      DecorationComponent: e.decorationByte,
      ...(bullets ? { BulletComponent: m.layout.collect.bullets.componentByte } : {}),
      ...(lights ? { LightEmitter: e.lightEmitterByte } : {}),
      ...(particles ? { ParticleComponent: pm.layout.componentByte } : {}),
    },
    // With `liquidFun`, the render buffer in its region of the memory, as the scene places it.
    ...(liquidFun ? { liquidFunRender: m.buffer, liquidFunRenderByte: e.liquidFunRenderByte } : {}),
  };
  for (const C of [SpriteRenderer, ShadowCaster, DecorationComponent, LightEmitter]) C.clearArrays();
  const meta = textureMetadata();
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  // The JS emit the kernel replaced, for the runs with _emitWasm null (tests/reference).
  installEmitJs(worker);
  await initWorker(worker, {
    config: { worldWidth: 4000, worldHeight: 3000, preRender: { interpolation: false }, renderer: { ySort } },
    globalEntityCount: N,
    buffers,
    extra: {
      maxDecorations: DECOS,
      maxParticles: POOL,
      maxBullets: POOL,
      liquidFunMaxCount: liquidFun ? LFN : 0,
      textureMetadata: meta,
      // With `customLayer`, one custom sprite layer's queue and collector where the scene places them.
      ...(customLayer ? {
        customLayerRenderQueues: {
          [CL]: {
            dataA: m.buffer, dataAByte: e.customLayers[0].queueAByte, dataB: m.buffer, dataBByte: e.customLayers[0].queueBByte,
            collectorByte: e.customLayers[0].collectorByte, maxItems: CLMAX, layerId: CL, layerName: 'fx',
          },
        },
      } : {}),
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: m.buffer,
        entityTextureByte: e.lastTextureByte,
      },
    },
  });
  bindPoseColumns(N);
  if (lights) {
    // Transform's pose where a scene without physics keeps it: the collect's pose block (x, y, rotation, rotC, rotS).
    const pose = m.layout.collect.poseByte;
    Transform.x = new Float32Array(m.buffer, pose, N);
    Transform.y = new Float32Array(m.buffer, pose + 4 * N, N);
    Transform.rotC = new Float32Array(m.buffer, pose + 12 * N, N);
    Transform.rotS = new Float32Array(m.buffer, pose + 16 * N, N);
  }
  assert.equal(SpriteRenderer.scaleX.buffer, m.buffer, 'SpriteRenderer is in the memory');
  assert.equal(LightEmitter.color.buffer === m.buffer, lights, `LightEmitter is ${lights ? '' : 'not '}in the memory`);
  assert.equal(ParticleComponent.x.buffer === m.buffer, particles, `ParticleComponent is ${particles ? '' : 'not '}in the memory`);
  worker.zenithalMaxHeight = 220;
  worker.zenithalScaleFactor = 0.5;
  worker.zenithalAlphaFade = alphaFade;
  if (liquidFun) {
    assert.equal(worker.liquidFun.x.buffer, m.buffer, 'the LiquidFun render buffer is in the memory');
    assert.equal(worker._prevLfX.buffer, m.buffer, 'and the previous positions');
  }
  assert.equal(worker._renderableType.buffer, m.buffer, 'the collector is in the memory');
  assert.equal(BulletComponent.x.buffer === m.buffer, bullets, `BulletComponent is ${bullets ? '' : 'not '}in the memory`);
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
    // Tiled sprites, world and local; every other one is stretched.
    sr.repeatX[i] = i % 17 === 0 ? 32 : 0;
    sr.repeatY[i] = i % 23 === 0 ? 48 : 0;
    sr.tileMode[i] = i % 2 ? 2 : 1;
    sr.tileOffsetU[i] = (i * 977) & 0xffff;
    sr.tileOffsetV[i] = (i * 331) & 0xffff;
    sr.boundsHalfW[i] = 10 + (i % 40);
    sr.boundsHalfH[i] = 12 + (i % 30);
    // Sheets 1-3 with every state, sheet 4 (no first frame / no animation), sheet 0 (unset).
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
  const meta2 = meta;
  for (let d = 0; d < DECOS; d++) {
    DecorationComponent.scaleX[d] = r();
    DecorationComponent.scaleY[d] = r();
    DecorationComponent.alpha[d] = r();
    DecorationComponent.tint[d] = (r() * 0xffffff) >>> 0;
    DecorationComponent.textureId[d] = d % 47 === 0 ? meta2.animationFrameStart.length + 9 : d % 12;
    DecorationComponent.anchorX[d] = r();
    DecorationComponent.anchorY[d] = r();
    // DX-FACES: every third one is no face.
    DecorationComponent.faceOct[d] = faces && d % 3 !== 0 ? 0x0101 + ((r() * 0xfafa) | 0) : 0;
    DecorationComponent.faceZ[d] = faces && d % 3 !== 0 ? (r() * 0xffff) | 0 : 0;
  }
  worker._faces = faces;

  // Bullets (W4d), from a generator of their own: inactive ones, trails of no length (start at the bullet), shorter
  // than 0.1, with a -0 difference (x -0, start +0), muzzle offsets, a texture past the animations.
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

  // Lights: no glow (the scale's floor: a radius under about 12), too faint (the alpha's), NaN and -0 radii, NaN and
  // -0 glow offsets, every strength and brightness.
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
    // DX-LIGHTOFFSET: an offset on some lights, turned by the light's facing.
    le.offsetX[i] = i % 3 === 0 ? rl() * 40 - 20 : 0;
    le.offsetY[i] = i % 3 === 0 ? rl() * 40 - 20 : 0;
    const facing = rl() * 6.283;
    Transform.rotC[i] = Math.cos(facing);
    Transform.rotS[i] = Math.sin(facing);
  }

  // Particles: zenithal (heights above and below the floor, -0, NaN), zenithal and flat, flat, plain; flipped either way;
  // texture 0 (the white circle), an animation, one past the animations.
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

  // LiquidFun particles: interpolated from a previous position (the first 12 with `interpolate`) or not, a baseAlpha
  // (missing on a second run), texture 0, an animation, one past the animations.
  if (liquidFun) {
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
    if (noBaseAlpha) lf.baseAlpha = null;
    worker.interpolatePhysicsPose = interpolate;
    worker._prevLfCount = 12;
    worker._poseAlpha = 0.37;
  }

  // The collector: sprites, decorations and a few rows of other types, poses in the queue (E-98d).
  // With `bullets`, a quarter of the rows are of other types, each type in turn walking the bullet slots, so the
  // bullet and trail rows reach every slot class above.
  const types = [];
  const indices = [];
  let other = 0;
  let pnext = 0;
  let lfnext = 0;
  // E-177: with `keyed`, each sprite an entity of its own, as the emit writes one row an entity (the same draws, so the
  // other rows are the same).
  const unique = keyed ? Array.from({ length: N }, (_, i) => (i * 389) % N) : null;
  let un = 0;
  for (let k = 0; k < count; k++) {
    const pick = r();
    if (pick < (bullets ? 0.55 : 0.62)) {
      const pickEntity = Math.floor(r() * N);
      types.push(0);
      indices.push(keyed ? unique[un++ % N] : pickEntity);
    }
    else if (pick < (bullets ? 0.75 : 0.92)) { types.push(2); indices.push(Math.floor(r() * DECOS)); }
    else if (particles && k % 3 === 1) { types.push(1); indices.push(pnext++ % POOL); }
    else if (liquidFun && k % 3 === 2) { types.push(7); indices.push(lfnext++ % LFN); }
    else if (lights && k % 3 !== 0) { types.push(3); indices.push((k * 7919) % N); }
    else if (bullets) { types.push([1, 3, 4, 5][other % 4]); indices.push((other >> 2) % POOL); other++; }
    else { types.push([1, 3, 4, 5][k % 4]); indices.push(k % POOL); }
  }
  const qViews = () => ({ x: worker.renderQueueX, y: worker.renderQueueY, rc: worker.renderQueueRotC, rs: worker.renderQueueRotS });
  const q = qViews();
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
    q.x, q.y, q.rc, q.rs, persist, true, ySort);

  // Everything either side writes, to put back between the two runs.
  const state = [
    worker.entityFrameIndex, worker.entityFrameAccumulator, worker.entityLastTextureId,
    SpriteRenderer.boundsHalfW, SpriteRenderer.boundsHalfH,
  ];
  const queueBytes = new Uint8Array(m.buffer, m.layout.queueAByte, computeBufferSize(maxItems));
  const snapshot = () => ({
    queue: queueBytes.slice(),
    state: state.map((a) => a.slice()),
    tiled: new Set(worker._tiledTileColumns),
  });
  const restore = (s) => {
    queueBytes.set(s.queue);
    state.forEach((a, k) => a.set(s.state[k]));
    worker._tiledTileColumns = new Set(s.tiled);
  };

  const b = await bindPreRenderEmit(m.memory, e);
  assert.ok(writeEmitTextures(b, meta), 'the metadata fits the tables');
  return { worker, m, b, source, types, indices, count, maxItems, snapshot, restore, ySort, bullets, lights, particles, liquidFun, interpolate, customLayer, keyed };
}

/** E-177: queue row r's statics as gpuPack.c packs them for an indexed frame (depth 0, a zero after). */
function rowStatics(w, r) {
  const f = new Float32Array(12);
  const u = new Uint32Array(f.buffer);
  f[0] = w.renderQueueScaleX[r];
  f[1] = w.renderQueueScaleY[r];
  f[2] = w.renderQueueAnchorX[r];
  f[3] = w.renderQueueAnchorY[r];
  let a = w.renderQueueAlpha[r];
  if (!(a >= 0)) a = 0;
  else if (a > 1) a = 1;
  u[5] = ((((a * 255 + 0.5) | 0) & 255) << 24 | (w.renderQueueTint[r] & 0xffffff)) >>> 0;
  f[6] = w.renderQueueTextureId[r];
  f[7] = w.renderQueueTileMulX ? w.renderQueueTileMulX[r] : 0;
  f[8] = w.renderQueueTileMulY ? w.renderQueueTileMulY[r] : 0;
  f[9] = (w.renderQueueTileOffsetU ? w.renderQueueTileOffsetU[r] : 0) * (1 / 65535);
  f[10] = (w.renderQueueTileOffsetV ? w.renderQueueTileOffsetV[r] : 0) * (1 / 65535);
  return u;
}

/** E-177: the bit of a sprite's key that says its statics changed since the emit before (preRenderEmit.c KEY_CHANGED). */
const KEY_CHANGED = 0x80000000;
/** E-189: with KEY_CHANGED, the bit that says the texture alone changed (preRenderEmit.c KEY_TEX_ONLY). */
const KEY_TEX_ONLY = 0x40000000;
const KEY_FLAGS = (KEY_CHANGED | KEY_TEX_ONLY) >>> 0;
const TEX_WORD = 6;

/**
 * E-177: Pixi's statics texture as the keys build it: a sprite row whose key carries the changed bit sends its statics to
 * its entity's row (E-189: its texture word alone when the key also carries KEY_TEX_ONLY). After every frame each drawn
 * sprite's key is its entity, and its entity's row holds the row's statics, marked or not: a row marked for its texture
 * alone whose other statics moved shows here. `st.tex` carries the texture between frames.
 */
function checkKeys(k, n, label, st) {
  const w = k.worker;
  const keys = w.renderQueueKey;
  let sprites = 0;
  let marked = 0;
  let texOnly = 0;
  for (let r = 0; r < n; r++) {
    if (w._renderableType[r] !== 0) continue;
    sprites++;
    const raw = keys[r];
    const e = (raw & ~KEY_FLAGS) >>> 0;
    if (e !== w._renderableIndex[r]) assert.fail(`${label}: row ${r}'s key ${raw} is not its entity ${w._renderableIndex[r]}`);
    if ((raw & KEY_TEX_ONLY) !== 0 && raw < KEY_CHANGED) assert.fail(`${label}: row ${r}'s texture-only bit without the changed one`);
    if (raw >= KEY_CHANGED) {
      if ((raw & KEY_TEX_ONLY) !== 0) {
        st.tex[e * 12 + TEX_WORD] = rowStatics(w, r)[TEX_WORD];
        texOnly++;
      } else {
        st.tex.set(rowStatics(w, r), e * 12);
      }
      marked++;
    }
  }
  for (let r = 0; r < n; r++) {
    if (w._renderableType[r] !== 0) continue;
    const e = (keys[r] & ~KEY_FLAGS) >>> 0;
    const want = rowStatics(w, r);
    for (let j = 0; j < 12; j++) {
      if (st.tex[e * 12 + j] !== want[j]) {
        assert.fail(`${label}: row ${r}'s entity ${e} (${keys[r] >= KEY_CHANGED ? 'marked' : 'not marked'}), statics word ${j}: ${st.tex[e * 12 + j]} vs ${want[j]}`);
      }
    }
  }
  return { sprites, marked, texOnly };
}

/** The queue columns a row has. */
const ROW_COLUMNS = [
  'renderQueueX', 'renderQueueY', 'renderQueueScaleX', 'renderQueueScaleY', 'renderQueueRotC', 'renderQueueRotS',
  'renderQueueAlpha', 'renderQueueTint', 'renderQueueTextureId', 'renderQueueAnchorX', 'renderQueueAnchorY',
  'renderQueueType', 'renderQueueSortKey', 'renderQueueRepeatX', 'renderQueueRepeatY', 'renderQueueTileMode',
  'renderQueueTileOffsetU', 'renderQueueTileOffsetV', 'renderQueueTileMulX', 'renderQueueTileMulY',
  'renderQueueShadowH', 'renderQueueShadowOffX', 'renderQueueShadowOffY',
];

function hex(bytes, at, n) {
  return [...bytes.subarray(at, at + n)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function runCase(t, opts) {
  const k = await setup(opts);
  const { worker, b, source, types, count, maxItems } = k;
  const n = Math.min(count, maxItems);
  /** The rows the kernel writes: sprites and decorations, and (W4d) bullets and trails with their component in the memory. */
  const ours = (type) => type === 0 || type === 2 || (k.bullets && (type === 4 || type === 5)) || (k.lights && type === 3)
    || (k.particles && type === 1) || (k.liquidFun && type === 7);
  if (k.liquidFun) {
    // The LiquidFun rows reach every case the kernel copies.
    const seen = new Set();
    for (let r = 0; r < n; r++) {
      if (types[r] !== 7) continue;
      const s = k.indices[r];
      seen.add(k.interpolate && s < 12 ? 'interpolated' : 'at its position');
      seen.add(s % 4 === 0 ? 'white' : s % 13 === 0 ? 'no texture' : 'texture');
    }
    const expected = ['at its position', 'no texture', 'texture', 'white', ...(k.interpolate ? ['interpolated'] : [])];
    assert.deepEqual([...seen].sort(), expected.sort());
  }
  if (k.particles) {
    // The particle rows reach every branch the kernel copies.
    const seen = new Set();
    for (let r = 0; r < n; r++) {
      if (types[r] !== 1) continue;
      const s = k.indices[r];
      const zen = s % 2 === 0;
      const flat = s % 7 === 0;
      seen.add(zen && !flat ? 'zenithal' : zen ? 'zenithal flat' : flat ? 'flat' : 'plain');
      seen.add(s % 6 === 0 ? 'white' : s % 11 === 0 ? 'no texture' : 'texture');
      if (s % 3 === 0 && s % 4 === 0) seen.add('flipped both');
    }
    assert.deepEqual([...seen].sort(), ['flat', 'flipped both', 'no texture', 'plain', 'texture', 'white', 'zenithal', 'zenithal flat']);
  }
  if (k.lights) {
    // The glow rows reach every case the kernel copies.
    const seen = new Set();
    for (let r = 0; r < n; r++) {
      if (types[r] !== 3) continue;
      const i = k.indices[r];
      const glow = [0, 0.5, 1, 0.5][i % 4];
      if (i % 11 === 0 || i % 17 === 0 || i % 19 === 0 || glow === 0) seen.add('no scale or no glow');
      else if (i % 13 === 0) seen.add('too faint');
      else seen.add(i % 7 === 0 ? 'drawn, NaN offset' : i % 9 === 0 ? 'drawn, -0 offset' : 'drawn');
    }
    assert.deepEqual([...seen].sort(), ['drawn', 'drawn, -0 offset', 'drawn, NaN offset', 'no scale or no glow', 'too faint']);
  }
  if (k.bullets) {
    // The bullet and trail rows reach every case the kernel copies (setup's bullet slots).
    const seen = new Set();
    for (let r = 0; r < n; r++) {
      const type = types[r];
      if (type !== 4 && type !== 5) continue;
      const slot = k.indices[r];
      if (slot % 7 === 0) seen.add(`${type} inactive`);
      else if (type === 4) seen.add(slot % 17 === 0 ? '4 no texture' : '4 drawn');
      else if (slot % 13 === 0) seen.add('5 -0 dx');
      else seen.add(slot % 5 === 0 || slot % 6 === 0 ? '5 too short' : '5 drawn');
    }
    assert.deepEqual([...seen].sort(), ['4 drawn', '4 inactive', '4 no texture', '5 -0 dx', '5 drawn', '5 inactive', '5 too short']);
  }
  const start = k.snapshot();

  // The JS: 30 frames, the queue and the state after each, the ends and warnings it made. The worker
  // bound the kernel at init; unbound, emitSpriteQueue is the JS loop.
  worker._emitWasm = null;
  const jsFrames = [];
  const ends = [];
  const warns = [];
  const realEnded = worker._spriteAnimationEnded;
  const realWarn = worker._warnMissingTexture;
  worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
  worker._warnMissingTexture = (key) => warns.push(key);
  for (let f = 0; f < FRAMES; f++) {
    ends.length = 0;
    warns.length = 0;
    const written = worker.emitSpriteQueue(DT, source);
    assert.equal(written, n);
    // The kernel's warnings: not the builtin lookups, nor a bullet's when the bullet rows are left to the JS.
    const kernelWarn = (w) => !w.startsWith('name:') && (k.bullets || !w.startsWith('frameStart:bullet:'))
      && (k.particles || !w.startsWith('frameStart:particle:')) && (k.liquidFun || !w.startsWith('frameStart:liquidFun:'));
    jsFrames.push({ snap: k.snapshot(), ends: [...ends].sort(), warns: warns.filter(kernelWarn).sort() });
  }
  worker._spriteAnimationEnded = realEnded;
  worker._warnMissingTexture = realWarn;

  // The kernel from the same start. Rows of other types hold a marker it must not change.
  k.restore(start);
  const marker = 0x5a;
  for (let r = 0; r < n; r++) {
    if (ours(types[r])) continue;
    for (const c of ROW_COLUMNS) {
      const v = worker[c];
      if (v) new Uint8Array(v.buffer, v.byteOffset + r * v.BYTES_PER_ELEMENT, v.BYTES_PER_ELEMENT).fill(marker);
    }
  }
  // L1: the regions the kernel must never write hold a canary through every frame.
  const L = k.m.layout;
  const queueSize = computeBufferSize(maxItems);
  const untouched = [
    ['guard', 0, L.queueAByte],
    ['queueB', L.queueBByte, queueSize],
    ['gpu queues and the pack scratch', L.gpuAByte, L.emit.spriteRendererByte - L.gpuAByte],
  ].map(([name, at, bytes]) => [name, new Uint8Array(k.m.buffer, at, bytes)]);
  for (const [, bytes] of untouched) bytes.fill(0xa5);
  const results = b.results;
  // E-177: Pixi's statics texture as the keys build it (empty at first), every sprite flagged at first as a spawn leaves
  // it (keyedDirty); the main queue's source (persist marks it) binds the key column and the flags.
  const keySt = { tex: new Uint32Array(N * 12) };
  const keyMarks = [];
  const kernelSource = k.keyed ? { ...source, persist: true } : source;
  if (k.keyed) SpriteRenderer.keyedDirty.fill(1);
  for (let f = 0; f < FRAMES; f++) {
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, kernelSource), 'every column is in the memory');
    assert.equal(writeEmitBulletColumns(b, BulletComponent, worker._resolveBuiltinTextureId('_bulletTrail')), k.bullets, 'the bullet columns');
    assert.equal(writeEmitGlowColumns(b, LightEmitter, Transform, worker._resolveBuiltinTextureId('_lightGradient')), k.lights, 'the glow columns');
    assert.equal(writeEmitParticleColumns(b, ParticleComponent, worker._resolveBuiltinTextureId('_whiteCircle'),
      worker.zenithalMaxHeight, worker.zenithalScaleFactor, worker.zenithalAlphaFade), k.particles, 'the particle columns');
    const lfPrev = worker.interpolatePhysicsPose && worker._prevLfX ? worker._prevLfCount : 0;
    assert.equal(writeEmitLiquidFunColumns(b, worker.liquidFun, worker._prevLfX, worker._prevLfY, lfPrev, worker._poseAlpha,
      worker._resolveBuiltinTextureId('_whiteCircle')), k.liquidFun, 'the LiquidFun columns');
    const tilesDirty = worker.renderQueueTileMode !== null && (worker._faces || worker._tiledTileColumns.has(worker.renderQueueTileMode));
    const flags = EMIT_SORT_KEY | (k.ySort ? EMIT_Y_SORT : 0) | (tilesDirty ? EMIT_TILES_DIRTY : 0) | EMIT_BOUNDS;
    const written = b.emitRows(b.tableByte, count, maxItems, flags, DT / 1000, worker._decorationZoomAlpha, worker._zBand);
    assert.notEqual(written, EMIT_DECLINED);
    assert.equal(written, n, `frame ${f}: rows written`);
    if (worker._faces) {
      // The face in the row, from the component: the JS side mirrors the kernel, so the two could be wrong together.
      let faces = 0;
      for (let r = 0; r < n; r++) {
        if (worker._renderableType[r] !== 2) continue;
        const d = worker._renderableIndex[r];
        assert.equal(worker.renderQueueTileOffsetU[r], DecorationComponent.faceOct[d], `frame ${f} row ${r}: the normal`);
        assert.equal(worker.renderQueueTileOffsetV[r], DecorationComponent.faceZ[d], `frame ${f} row ${r}: the height`);
        if (DecorationComponent.faceOct[d] !== 0) faces++;
      }
      assert.ok(faces > 50, `frame ${f}: ${faces} faces drawn`);
    }
    if (results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
    if (k.keyed) keyMarks.push(checkKeys(k, n, `frame ${f}`, keySt));
    const js = jsFrames[f];
    // State: every entity, every frame.
    const now = k.snapshot();
    for (let s = 0; s < now.state.length; s++) {
      assert.deepEqual(Buffer.from(now.state[s].buffer, now.state[s].byteOffset, now.state[s].byteLength),
        Buffer.from(js.snap.state[s].buffer, js.snap.state[s].byteOffset, js.snap.state[s].byteLength), `frame ${f}: state ${s}`);
    }
    // Rows: sprites and decorations equal to the JS's, bit for bit; the others untouched and listed.
    // [collector row, queue row] pairs: the same row without an Adobe root.
    const foreign = [];
    for (let r = 0; r < results[3]; r++) foreign.push([b.u32[b.foreignAt + 2 * r], b.u32[b.foreignAt + 2 * r + 1]]);
    const expectForeign = [];
    for (let r = 0; r < n; r++) if (!ours(types[r])) expectForeign.push([r, r]);
    assert.deepEqual(foreign, expectForeign, `frame ${f}: the rows left to the JS`);
    const qa = k.m.layout.queueAByte;
    for (let r = 0; r < n; r++) {
      const mine = ours(types[r]);
      for (const c of ROW_COLUMNS) {
        const v = worker[c];
        if (!v) continue;
        const bpe = v.BYTES_PER_ELEMENT;
        const at = v.byteOffset - qa + r * bpe;
        for (let x = 0; x < bpe; x++) {
          const got = now.queue[at + x];
          if (mine && got !== js.snap.queue[at + x]) {
            assert.fail(`frame ${f} row ${r} (type ${types[r]}) ${c}: ${hex(now.queue, at, bpe)}, the JS wrote ${hex(js.snap.queue, at, bpe)}`);
          }
          if (!mine && got !== marker) assert.fail(`frame ${f} row ${r} (type ${types[r]}) ${c} was written`);
        }
      }
    }
    // Ends and warnings: the JS's, from the kernel's lists.
    const kEnds = [];
    for (let r = 0; r < results[0]; r++) kEnds.push(`${b.u32[b.endsAt + 2 * r]}:${b.u32[b.endsAt + 2 * r + 1]}`);
    assert.deepEqual(kEnds.sort(), js.ends, `frame ${f}: play-once ends`);
    const kWarns = [];
    for (let r = 0; r < results[1]; r++) {
      const idx = b.u32[b.warnsAt + 2 * r];
      const kind = b.u32[b.warnsAt + 2 * r + 1];
      kWarns.push(warnKey(worker, idx, kind));
    }
    assert.deepEqual(kWarns.sort(), js.warns, `frame ${f}: warnings`);
  }
  for (const [name, bytes] of untouched) {
    const at = bytes.findIndex((x) => x !== 0xa5);
    assert.equal(at, -1, `the kernel wrote ${name} (byte ${at})`);
  }
  t.diagnostic(`${n} rows, ${jsFrames.reduce((s, x) => s + x.ends.length, 0)} ends, ${jsFrames[0].warns.length} warnings a frame`);
  if (k.keyed) {
    // The first frame marks every sprite (every flag set); after it, the ones whose frame or texture moved and the
    // repeating ones.
    assert.equal(keyMarks[0].marked, keyMarks[0].sprites, 'the first frame marks every sprite');
    assert.ok(keyMarks.slice(1).some((x) => x.marked > 0), 'later frames mark the animated sprites');
    assert.ok(keyMarks.slice(1).every((x) => x.marked < x.sprites), 'later frames mark fewer than all');
    // E-189: an animation's step changes the texture alone, and goes up as such.
    assert.ok(keyMarks.slice(1).some((x) => x.texOnly > 0), 'later frames mark sprites for their texture alone');
    t.diagnostic(`marked a frame: ${keyMarks.map((x) => `${x.marked} (${x.texOnly} texture alone)`).join(' ')}`);
  }
}

/** The key the JS warns under, for a kernel warning. */
function warnKey(worker, idx, kind) {
  if (kind === EMIT_WARN_NO_ANIM) return `sprite:${SpriteRenderer.spritesheetId[idx]}:${SpriteRenderer.animationState[idx]}`;
  if (kind === EMIT_WARN_NO_START) {
    const g = worker.proxyToGlobalAnim[SpriteRenderer.spritesheetId[idx]][SpriteRenderer.animationState[idx]];
    return `animStart:${g}`;
  }
  if (kind === EMIT_WARN_DECO_START) return `frameStart:decoration:${DecorationComponent.textureId[idx]}`;
  if (kind === EMIT_WARN_BULLET_START) return `frameStart:bullet:${BulletComponent.textureId[idx]}`;
  if (kind === EMIT_WARN_PARTICLE_START) return `frameStart:particle:${ParticleComponent.textureId[idx]}`;
  if (kind === EMIT_WARN_LF_START) return `frameStart:liquidFun:${worker.liquidFun.textureId[idx]}`;
  return `kind ${kind}`;
}

test('the emit kernel writes what emitSpriteQueue writes, Y-sorted', async (t) => {
  await runCase(t, { ySort: true });
});

test('the emit kernel writes what emitSpriteQueue writes, without Y-sort', async (t) => {
  await runCase(t, { ySort: false, seed: 0xbeef });
});

test('DX-FACES: a decoration\'s row carries its face in the tile offsets, and a sprite\'s row stays untiled', async (t) => {
  await runCase(t, { ySort: true, faces: true });
});

test("E-177: the emit marks a sprite's key when its statics changed since the emit before", async (t) => {
  await runCase(t, { ySort: true, keyed: true });
});

test('the emit kernel fills a queue to its capacity', async (t) => {
  await runCase(t, { ySort: true, maxItems: 600, count: 600, seed: 0xfeed });
});

test('W4d: the emit kernel writes the bullet and trail rows emitSpriteQueue writes, BulletComponent in the memory', async (t) => {
  await runCase(t, { ySort: true, bullets: true, seed: 0xb0b });
  await runCase(t, { ySort: false, bullets: true, seed: 0xb1b });
});

test('the emit kernel writes the glow rows emitSpriteQueue writes, LightEmitter and Transform in the memory', async (t) => {
  await runCase(t, { ySort: true, lights: true, seed: 0x6107 });
  await runCase(t, { ySort: false, lights: true, bullets: true, seed: 0x6108 });
});

test('the emit kernel writes the particle rows emitSpriteQueue writes, the particle memory in the render-queue memory', async (t) => {
  await runCase(t, { ySort: true, particles: true, seed: 0x9a71 });
  await runCase(t, { ySort: false, particles: true, alphaFade: 0.8, seed: 0x9a72 });
  await runCase(t, { ySort: true, particles: true, lights: true, bullets: true, alphaFade: 2.5, seed: 0x9a73 });
});

test('the emit kernel writes the LiquidFun rows emitSpriteQueue writes, its render buffer in the render-queue memory', async (t) => {
  await runCase(t, { ySort: true, liquidFun: true, interpolate: true, seed: 0x1f01 });
  await runCase(t, { ySort: false, liquidFun: true, interpolate: false, seed: 0x1f02 });
  // Without baseAlpha (the JS multiplies by 1), with particles in the memory too.
  await runCase(t, { ySort: true, liquidFun: true, interpolate: true, particles: true, noBaseAlpha: true, seed: 0x1f03 });
});

// Close-out group B. A custom sprite layer's queue goes through the same emit (buildCustomLayerQueues): its collector
// keeps a pose stash written at the collect, as the entities' does (E-98d), and with the collector and both queue
// buffers in the memory the kernel writes the layer's rows. 30 frames of the layer through buildCustomLayerQueues,
// the JS loop against the kernel, from the same start: the layer's queue, the animation state and the ends.
test('a custom layer\'s queue through the emit kernel is the one the JS writes', async (t) => {
  for (const ySort of [true, false]) {
    const k = await setup({ ySort, bullets: true, lights: true, particles: true, liquidFun: true, customLayer: true, seed: ySort ? 0xc1a1 : 0xc1a2 });
    const { worker, m } = k;
    const entry = worker._customLayerEntries[0];
    assert.ok(entry && entry.layerId === CL, 'the worker made the layer');
    const c = entry.collector;
    assert.equal(c.type.buffer, m.buffer, 'its collector is in the memory');
    assert.equal(c.stashX.buffer, m.buffer, 'its pose stash too');
    worker._setWriteBuffer(0);
    assert.equal(entry.ref.x.buffer, m.buffer, 'and its queue');
    // The layer's rows: the entities collector's first rows, poses from a generator.
    const r = rng(ySort ? 0x51a : 0x51b);
    const rows = CLMAX - 7;
    for (let i = 0; i < rows; i++) {
      c.type[i] = k.types[i];
      c.index[i] = k.indices[i];
      c.y[i] = Math.round(r() * 3000) * 128;
      c.stashX[i] = r() * 4000;
      c.stashY[i] = r() * 3000;
      c.stashRotC[i] = Math.cos(i * 0.7);
      c.stashRotS[i] = Math.sin(i * 0.7);
    }
    const L = m.layout.emit.customLayers[0];
    const layerQueue = new Uint8Array(m.buffer, L.queueAByte, computeBufferSize(CLMAX));
    const start = { main: k.snapshot(), layer: layerQueue.slice() };
    const bound = worker._emitWasm;
    let kernelCalls = 0;
    const realRows = bound.emitRows;
    bound.emitRows = (...args) => {
      kernelCalls++;
      return realRows(...args);
    };
    const realEnded = worker._spriteAnimationEnded;
    const run = (kernel) => {
      k.restore(start.main);
      layerQueue.set(start.layer);
      worker._emitWasm = kernel;
      worker._setWriteBuffer(0);
      const frames = [];
      for (let f = 0; f < FRAMES; f++) {
        const ends = [];
        worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
        c.count = rows;
        worker.buildCustomLayerQueues(DT);
        frames.push({ queue: layerQueue.slice(), count: entry.ref.count[0], state: k.snapshot().state, ends });
      }
      worker._spriteAnimationEnded = realEnded;
      return frames;
    };
    const js = run(null);
    const wasm = run(bound);
    bound.emitRows = realRows;
    worker._emitWasm = bound;
    assert.equal(kernelCalls, FRAMES, 'the kernel took every frame of the layer');
    for (let f = 0; f < FRAMES; f++) {
      assert.equal(wasm[f].count, js[f].count, `frame ${f}: rows`);
      const at = wasm[f].queue.findIndex((x, i) => x !== js[f].queue[i]);
      assert.equal(at, -1, `frame ${f}: the layer's queue differs at byte ${at}`);
      wasm[f].state.forEach((v, s2) => {
        assert.deepEqual(Buffer.from(v.buffer, v.byteOffset, v.byteLength), Buffer.from(js[f].state[s2].buffer, js[f].state[s2].byteOffset, js[f].state[s2].byteLength), `frame ${f}: state ${s2}`);
      });
      assert.deepEqual(wasm[f].ends, js[f].ends, `frame ${f}: play-once ends, in order`);
    }
    t.diagnostic(`ySort ${ySort}: ${js[0].count} rows in the layer, ${new Set(k.types.slice(0, rows)).size} row types`);
  }
});

// The stash a custom layer's collect now writes (_writeRenderable: the display pose of a sprite, a decoration's world
// position and facing) gives the queue the JS emit wrote when the layer had no stash and took the poses at the emit.
test('a custom layer emitted from its stash writes what the emit wrote taking the poses itself', async () => {
  const k = await setup({ ySort: true, customLayer: true, seed: 0xc1a3 });
  const { worker, m } = k;
  const entry = worker._customLayerEntries[0];
  const c = entry.collector;
  const rows = CLMAX - 3;
  const pose = new Float32Array(4);
  const r = rng(0x51c);
  for (let i = 0; i < N; i++) {
    Transform.x[i] = r() * 4000;
    Transform.y[i] = r() * 3000;
    Transform.rotC[i] = Math.cos(i * 0.3);
    Transform.rotS[i] = Math.sin(i * 0.3);
  }
  for (let d = 0; d < DECOS; d++) {
    DecorationComponent.rotC[d] = Math.cos(d * 1.1);
    DecorationComponent.rotS[d] = Math.sin(d * 1.1);
  }
  for (let i = 0; i < rows; i++) {
    const type = k.types[i] === 0 || k.types[i] === 2 ? k.types[i] : 0;
    const idx = type === 2 ? k.indices[i] % DECOS : k.indices[i];
    c.type[i] = type;
    c.index[i] = idx;
    c.y[i] = Math.round(r() * 3000) * 128;
    // What _writeRenderable stashes.
    if (type === 0) {
      worker._displayPose(idx, pose);
      c.stashX[i] = pose[0];
      c.stashY[i] = pose[1];
      c.stashRotC[i] = pose[2];
      c.stashRotS[i] = pose[3];
    } else {
      worker._decorationWorldXY(idx, pose);
      c.stashX[i] = pose[0];
      c.stashY[i] = pose[1];
      c.stashRotC[i] = DecorationComponent.rotC[idx];
      c.stashRotS[i] = DecorationComponent.rotS[idx];
    }
  }
  const L = m.layout.emit.customLayers[0];
  const layerQueue = new Uint8Array(m.buffer, L.queueAByte, computeBufferSize(CLMAX));
  const start = { main: k.snapshot(), layer: layerQueue.slice() };
  const stash = [c.stashX, c.stashY, c.stashRotC, c.stashRotS];
  const run = (withStash) => {
    k.restore(start.main);
    layerQueue.set(start.layer);
    worker._emitWasm = null;
    worker._setWriteBuffer(0);
    if (!withStash) c.stashX = c.stashY = c.stashRotC = c.stashRotS = null;
    c.count = rows;
    worker.buildCustomLayerQueues(DT);
    [c.stashX, c.stashY, c.stashRotC, c.stashRotS] = stash;
    return layerQueue.slice();
  };
  const without = run(false);
  const withIt = run(true);
  const at = withIt.findIndex((x, i) => x !== without[i]);
  assert.equal(at, -1, `the layer's queue differs at byte ${at}`);
});

test('a frame with an Adobe root or a LiquidFun row is declined before anything is written', async () => {
  const k = await setup({ ySort: true });
  const { worker, b, source } = k;
  for (const type of [6, 7]) {
    worker._renderableType[17] = type;
    const before = k.snapshot();
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source));
    const written = b.emitRows(b.tableByte, source.count, source.maxItems, EMIT_SORT_KEY | EMIT_Y_SORT | EMIT_BOUNDS, DT / 1000, 1, worker._zBand);
    assert.equal(written, EMIT_DECLINED, `type ${type}`);
    const after = k.snapshot();
    assert.deepEqual(Buffer.from(after.queue), Buffer.from(before.queue), 'the queue is untouched');
    after.state.forEach((a, s) => assert.deepEqual(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(before.state[s].buffer, before.state[s].byteOffset, before.state[s].byteLength)));
  }
});

test('a column outside the memory makes the table refuse, so the JS emits', async () => {
  const k = await setup({ ySort: true });
  const { worker, b, source } = k;
  const saved = SpriteRenderer.alpha;
  SpriteRenderer.alpha = new Float32Array(N);
  assert.equal(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), false);
  SpriteRenderer.alpha = saved;
  assert.equal(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), true);
});

test('emitSpriteQueue through the kernel writes every row the JS loop writes, other types included', async (t) => {
  // Every row type's columns in the memory, as the scene lays them (close-out group B): the kernel writes every row.
  const cases = [[true, 0x9a74, false], [false, 0xc0ffee, false], [true, 0xdecade, true], [false, 0xb2b, true]];
  for (const [ySort, seed, liquidFun] of cases) {
    const k = await setup({ ySort, bullets: true, lights: true, particles: true, liquidFun, interpolate: liquidFun, alphaFade: 0.6, seed });
    const { worker, source } = k;
    const bound = worker._emitWasm;
    assert.ok(bound, 'the worker bound the kernel at init');
    assert.ok(bound.texturesReady, 'and wrote the metadata tables');
    let kernelCalls = 0;
    const realRows = bound.emitRows;
    bound.emitRows = (...args) => {
      kernelCalls++;
      return realRows(...args);
    };
    const start = k.snapshot();
    const realEnded = worker._spriteAnimationEnded;
    const realWarn = worker._warnMissingTexture;
    const run = (kernel) => {
      worker._emitWasm = kernel;
      const frames = [];
      for (let f = 0; f < FRAMES; f++) {
        const ends = [];
        const warns = [];
        worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
        worker._warnMissingTexture = (key) => warns.push(key);
        const written = worker.emitSpriteQueue(DT, source);
        frames.push({ written, snap: k.snapshot(), ends, warns: warns.sort() });
      }
      worker._spriteAnimationEnded = realEnded;
      worker._warnMissingTexture = realWarn;
      return frames;
    };
    const js = run(null);
    k.restore(start);
    const wasm = run(bound);
    assert.equal(kernelCalls, FRAMES, 'the kernel took every frame');
    for (let f = 0; f < FRAMES; f++) {
      assert.equal(wasm[f].written, js[f].written, `frame ${f}: rows`);
      const a = wasm[f].snap.queue;
      const b = js[f].snap.queue;
      const at = a.findIndex((x, i) => x !== b[i]);
      assert.equal(at, -1, `frame ${f}: the queue differs at byte ${at}`);
      wasm[f].snap.state.forEach((v, s2) => {
        assert.deepEqual(Buffer.from(v.buffer, v.byteOffset, v.byteLength), Buffer.from(js[f].snap.state[s2].buffer, js[f].snap.state[s2].byteOffset, js[f].snap.state[s2].byteLength), `frame ${f}: state ${s2}`);
      });
      assert.deepEqual([...wasm[f].snap.tiled], [...js[f].snap.tiled], `frame ${f}: tiled columns`);
      assert.deepEqual(wasm[f].ends, js[f].ends, `frame ${f}: play-once ends, in order`);
      assert.deepEqual(wasm[f].warns, js[f].warns, `frame ${f}: warnings`);
    }
    t.diagnostic(`ySort ${ySort}, LiquidFun ${liquidFun}: ${js[0].written} rows, ${k.types.filter((x) => x !== 0 && x !== 2).length} of other types`);
  }
});

// W4c, E-116: the persist path. Frame after frame on alternating queue buffers, the kernel's persist_frame
// and persist_remember against the shipped _type0PersistHit, _writeType0PosesOnly and _rememberType0Set,
// with what makes a frame miss scheduled in: dirty sprites (and the other buffer's full emit they force),
// a changed animation, swapped collector rows and a frame past its animation's end (the repair misses).
// persist_frame writes the pose columns of the rows it passed before it missed, which the full emit after
// a miss rewrites; so on a miss both sides run that full emit, emit_rows (held to the JS full emit by the
// tests above), then the remember.
const PERSIST_FRAMES = 40;

/** The regions the persist path writes, as [name, byte, bytes]. */
function persistRegions(m, maxItems) {
  const L = m.layout;
  const e = L.emit;
  const q = computeBufferSize(maxItems);
  const n = e.persistRows;
  return [
    ['queueA', L.queueAByte, q], ['queueB', L.queueBByte, q],
    ['spriteRenderer', e.spriteRendererByte, SpriteRenderer.getBufferSize(N)],
    ['frame', e.frameByte, N * 2], ['accum', e.accumByte, N * 4], ['lastTexture', e.lastTextureByte, N * 2],
    ['persistType', e.persistTypeByte, 2 * n], ['persistEntity', e.persistEntityByte, 8 * n],
    ['persistFrame', e.persistFrameByte, 4 * n], ['persistAnim', e.persistAnimByte, 4 * n],
  ];
}

/** Run fn with an order on the entity queue (a zIndex user, and Y-sort on the entities layer when ySort). */
async function withPersistOrder(ySort, fn) {
  // Sort keys on persist frames need an order: a zIndex user, and Y-sort on the entities layer.
  SpriteRenderer._zIndexUsers[0] = 1;
  const savedLayer = [Layer._ySorting, Layer.entitiesId];
  if (ySort) {
    Layer._ySorting = new Uint8Array(32);
    Layer.entitiesId = 0;
    Layer._ySorting[0] = 1;
  }
  try {
    await fn();
  } finally {
    [Layer._ySorting, Layer.entitiesId] = savedLayer;
  }
}

/**
 * The persist cases' frames: prepare(f) flips to buffer f & 1, writes the frame's poses into the stash
 * (the queue's own columns, E-98d, or the other buffer's), changes shadow casters with no dirty flag (the
 * persist frames must refresh their terms) and makes what misses on schedule: dirty sprites, a changed
 * animation, swapped collector rows, a frame past its animation's end and, with adobe, an Adobe root for
 * six frames. Some animated sprites get NaN clocks first: neither path advances them (N-65). The same calls give
 * the same frames on both runs.
 */
function persistSchedule(k, { inQueue, seed, adobe, casters = true }) {
  const { worker, count } = k;
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const sprites = [];
  for (let r = 0; r < count; r++) if (cType[r] === 0) sprites.push(r);
  for (const r of sprites.slice(0, 60)) if (SpriteRenderer.isAnimated[cIndex[r]]) SpriteRenderer.animationSpeed[cIndex[r]] = NaN;
  const animatedRow = sprites.find((r) => SpriteRenderer.isAnimated[cIndex[r]] && SpriteRenderer.spritesheetId[cIndex[r]] === 2
    && SpriteRenderer.animationState[cIndex[r]] === 3);
  assert.ok(animatedRow !== undefined, 'a sprite with a 13-frame animation');
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
    if (f % 7 === 3) for (let j = 0; j < 5; j++) SpriteRenderer.renderDirty[cIndex[sprites[Math.floor(r() * sprites.length)]]] = 1;
    if (f % 11 === 5) {
      const idx = cIndex[sprites[Math.floor(r() * sprites.length)]];
      if (SpriteRenderer.spritesheetId[idx] !== 4) SpriteRenderer.animationState[idx] = (SpriteRenderer.animationState[idx] + 1) % 4;
    }
    if (f % 13 === 8) {
      const a = Math.floor(r() * count);
      const c = Math.floor(r() * count);
      [cType[a], cType[c]] = [cType[c], cType[a]];
      [cIndex[a], cIndex[c]] = [cIndex[c], cIndex[a]];
    }
    if (f === 17) worker.entityFrameIndex[cIndex[animatedRow]] = 99;
    // ShadowCaster columns change with no dirty flag: every persist frame refreshes the shadow terms.
    if (casters && f % 5 === 2) {
      for (let j = 0; j < 8; j++) {
        const idx = cIndex[sprites[Math.floor(r() * sprites.length)]];
        ShadowCaster.heightMultiplier[idx] = r() * 2;
        ShadowCaster.active[idx] ^= 1;
      }
    }
    if (adobe && f === 20) cType[5] = 6;
    if (adobe && f === 26) cType[5] = k.types[5];
    return { buf, st };
  };
}

async function runPersistCase(t, { ySort, inQueue, seed, keyed = false }) {
  const k = await setup({ ySort, seed, persist: true, keyed });
  await withPersistOrder(ySort, () => persistFrames(t, k, { ySort, inQueue, seed }));
}

async function persistFrames(t, k, { ySort, inQueue, seed }) {
  const { worker, b, m, maxItems } = k;
  const count = k.count;
  assert.equal(worker._entityYSort(), ySort);
  assert.ok(worker._queueHasOrder());
  const all = new Uint8Array(m.buffer);
  const regions = persistRegions(m, maxItems);
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const cY = worker._renderableY;
  // No Adobe root: emit_rows declines a frame with one (the worker's JS loop then rewrites every row);
  // the test after this one has the Adobe miss.
  const prepare = persistSchedule(k, { inQueue, seed, adobe: false });
  // E-177: with keyed frames, every sprite starts flagged (as a spawn leaves it). The flags and the marks in the key
  // column are the kernel's alone (the JS persist path knows neither), so the comparison below leaves keyedDirty and the
  // queues' key columns out; checkKeys judges what they do.
  if (k.keyed) SpriteRenderer.keyedDirty.fill(1);
  const dirtyAt = SpriteRenderer.keyedDirty.byteOffset - m.layout.emit.spriteRendererByte;
  const keyAt = createViews(m.buffer, maxItems, m.layout.queueAByte).key.byteOffset - m.layout.queueAByte;
  const start = all.slice();

  /** This frame's column table, its flags, and the full emit a miss leads to (with its ends). */
  const frameTable = (buf, st) => {
    const source = worker._fillEmitSource(count, maxItems, cY, cType, cIndex, st.x, st.y, st.rc, st.rs, true, true, ySort);
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), 'every column is in the memory');
    assert.ok(writePersistColumns(b, worker, SpriteRenderer, buf), 'and the persist rows');
    const sort = !!(worker.renderQueueSortKey && worker._queueHasOrder());
    return (sort ? EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? EMIT_Y_SORT : 0) | EMIT_BOUNDS;
  };
  const listEnds = (ends) => {
    for (let e = 0, at = b.endsAt; e < b.results[0]; e++, at += 2) {
      if (worker._animEndByType[Transform.entityType[b.u32[at]]] === 1) ends.push(`${b.u32[at]}:${b.u32[at + 1]}`);
    }
  };
  const fullEmit = (flags, ends) => {
    const tilesDirty = worker.renderQueueTileMode !== null && worker._tiledTileColumns.has(worker.renderQueueTileMode);
    const written = b.emitRows(b.tableByte, count, maxItems, flags | (tilesDirty ? EMIT_TILES_DIRTY : 0), DT / 1000,
      worker._decorationZoomAlpha, worker._zBand);
    assert.notEqual(written, EMIT_DECLINED);
    if (b.results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
    listEnds(ends);
  };
  const record = (hit, others, moved, repaired, ends) => ({
    hit, others, moved, repaired, ends, counts: [...worker._persistCount],
    mem: regions.map(([name, at, bytes]) => {
      const copy = all.slice(at, at + bytes);
      if (k.keyed && name === 'spriteRenderer') copy.fill(0, dirtyAt, dirtyAt + N);
      if (k.keyed && (name === 'queueA' || name === 'queueB')) copy.fill(0, keyAt, keyAt + 4 * maxItems);
      return copy;
    }),
  });

  // The JS persist path.
  const realEnded = worker._spriteAnimationEnded;
  const js = [];
  for (let f = 0; f < PERSIST_FRAMES; f++) {
    const { buf, st } = prepare(f);
    const ends = [];
    worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
    const flags = frameTable(buf, st);
    const hit = worker._type0PersistHit(buf, count, cType, cIndex);
    const others = hit ? worker._writeType0PosesOnly(count, cType, cIndex, cY, st.x, st.y, st.rc, st.rs, DT) : 0;
    if (!hit) {
      fullEmit(flags, ends);
      worker._rememberType0Set(buf, count, cType, cIndex);
    }
    js.push(record(hit, others, hit ? worker._persistFramesMoved : 0, hit ? worker._persistFramesRepaired : 0, ends));
  }
  worker._spriteAnimationEnded = realEnded;

  // The kernel, from the same start.
  all.set(start);
  worker._persistCount = [0, 0];
  worker._tiledTileColumns = new Set();
  const kinds = { hit: 0, repaired: 0, moved: 0, ends: 0 };
  // E-177: Pixi's statics texture as the keys build it, after each frame, persist frames among them (a persisted sprite's
  // statics move only with a repaired or advanced texture, or a flag).
  const keySt = { tex: new Uint32Array(N * 12) };
  for (let f = 0; f < PERSIST_FRAMES; f++) {
    const { buf, st } = prepare(f);
    const flags = frameTable(buf, st);
    let hit = false;
    let others = 0;
    let moved = 0;
    let repaired = 0;
    const ends = [];
    if (worker._persistCount[buf] === count) {
      const got = b.persistFrame(b.tableByte, count, maxItems, flags, DT / 1000, worker._zBand);
      hit = got !== EMIT_PERSIST_MISS;
      if (hit) {
        others = got;
        moved = b.results[1];
        repaired = b.results[2];
        listEnds(ends);
      }
    }
    if (!hit) {
      fullEmit(flags, ends);
      const cleared = b.persistRemember(b.tableByte, count, maxItems);
      worker._persistCount[buf] = count;
      if (cleared) worker._persistCount[buf ^ 1] = -1;
    }
    if (k.keyed) checkKeys(k, Math.min(count, maxItems), `frame ${f} (${hit ? 'persist' : 'full'})`, keySt);
    const got = record(hit, others, moved, repaired, ends);
    const want = js[f];
    assert.deepEqual({ hit: got.hit, others: got.others, moved: got.moved, repaired: got.repaired, counts: got.counts },
      { hit: want.hit, others: want.others, moved: want.moved, repaired: want.repaired, counts: want.counts }, `frame ${f}`);
    assert.deepEqual(got.ends, want.ends, `frame ${f}: play-once ends, in order`);
    regions.forEach(([name], r) => {
      const at = got.mem[r].findIndex((x, i) => x !== want.mem[r][i]);
      assert.equal(at, -1, `frame ${f}: ${name} differs at byte ${at}`);
    });
    if (hit) kinds.hit++;
    kinds.repaired += repaired;
    kinds.moved += moved;
    kinds.ends += ends.length;
  }
  // The schedule must have reached every branch it is there for.
  assert.ok(kinds.hit >= 10 && kinds.hit <= PERSIST_FRAMES - 10, `hits ${kinds.hit}`);
  assert.ok(kinds.repaired > 0 && kinds.moved > 0 && kinds.ends > 0, JSON.stringify(kinds));
  t.diagnostic(`${count} rows: ${kinds.hit} persist frames of ${PERSIST_FRAMES}, ${kinds.repaired} repaired, ${kinds.moved} moved, ${kinds.ends} ends`);
}

test('the persist path in the kernel does what the JS persist path does, Y-sorted', async (t) => {
  await runPersistCase(t, { ySort: true, inQueue: true, seed: 0x9e1 });
});

test("E-177: persist frames mark the keys as the full emit does: the repaired and advanced textures, the flagged sprites", async (t) => {
  await runPersistCase(t, { ySort: true, inQueue: true, seed: 0x9e1, keyed: true });
});

test('the persist path in the kernel does what the JS persist path does, without Y-sort', async (t) => {
  await runPersistCase(t, { ySort: false, inQueue: true, seed: 0x9e2 });
});

test('the persist path in the kernel copies a stash that is not the queue', async (t) => {
  await runPersistCase(t, { ySort: true, inQueue: false, seed: 0x9e3 });
});

test('persist_frame misses on a frame with an Adobe root, which it held last time too', async () => {
  const k = await setup({ ySort: false, seed: 0xad0, persist: true });
  const { worker, b, count, maxItems } = k;
  worker._queueBuf = 0;
  worker._setWriteBuffer(0);
  const source = worker._fillEmitSource(count, maxItems, worker._renderableY, worker._renderableType, worker._renderableIndex,
    worker.renderQueueX, worker.renderQueueY, worker.renderQueueRotC, worker.renderQueueRotS, true, true, false);
  const frame = () => {
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source));
    assert.ok(writePersistColumns(b, worker, SpriteRenderer, 0));
    b.persistRemember(b.tableByte, count, maxItems);
    return b.persistFrame(b.tableByte, count, maxItems, 0, DT / 1000, worker._zBand);
  };
  worker._renderableType[5] = 6;
  assert.equal(frame(), EMIT_PERSIST_MISS, 'the same rows, an Adobe root among them');
  worker._renderableType[5] = k.types[5];
  assert.notEqual(frame(), EMIT_PERSIST_MISS, 'the same rows without it');
});

/**
 * emitSpriteQueue on persist frames with the kernel against the JS, end to end. Without casters the scene
 * has no ShadowCaster (its columns unbound): the kernel leaves the sprite rows' shadow terms (E-117), the
 * JS writes their zeros again, and the queues must not differ.
 */
async function runWiredPersist(t, cases, casters) {
  for (const { ySort, seed } of cases) {
    // Every row type's columns in the memory, as the scene lays them: a persist frame's other rows go through the kernel too.
    const k = await setup({ ySort, seed, persist: true, bullets: true, lights: true, particles: true, liquidFun: true, interpolate: true });
    // No ShadowCaster: its columns unbound, as in a scene that never registered it (the next setup binds them).
    if (!casters) for (const c of ['active', 'heightMultiplier', 'anchorOffsetX', 'anchorOffsetY']) ShadowCaster[c] = null;
    await withPersistOrder(ySort, async () => {
      const { worker, m, maxItems, count } = k;
      const bound = worker._emitWasm;
      assert.ok(bound && bound.texturesReady, 'the worker bound the kernel and wrote its tables');
      const calls = { persistFrame: 0, persistHits: 0, persistRemember: 0, emitRows: 0, othersOnly: 0 };
      for (const name of ['persistFrame', 'persistRemember', 'emitRows']) {
        const real = bound[name];
        bound[name] = (...args) => {
          calls[name]++;
          const got = real(...args);
          if (name === 'persistFrame' && got !== EMIT_PERSIST_MISS) calls.persistHits++;
          if (name === 'emitRows' && (args[3] & EMIT_OTHERS_ONLY) !== 0) calls.othersOnly++;
          return got;
        };
      }
      const all = new Uint8Array(m.buffer);
      const regions = persistRegions(m, maxItems);
      // No Adobe root here: the JS loop's Adobe branch needs AdobeAnimComponent (the kernel test has one).
      const prepare = persistSchedule(k, { inQueue: true, seed, adobe: false, casters });
      const start = all.slice();
      const startGen = worker._staticGen;
      const realEnded = worker._spriteAnimationEnded;
      const realWarn = worker._warnMissingTexture;
      const run = (kernel) => {
        all.set(start);
        worker._persistCount = [0, 0];
        worker._tiledTileColumns = new Set();
        worker._staticGen = startGen;
        worker._emitWasm = kernel;
        const frames = [];
        for (let f = 0; f < PERSIST_FRAMES; f++) {
          const { st } = prepare(f);
          const ends = [];
          const warns = [];
          worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
          worker._warnMissingTexture = (key) => warns.push(key);
          const hasOrder = worker._queueHasOrder();
          const source = worker._fillEmitSource(count, maxItems, worker._renderableY, worker._renderableType,
            worker._renderableIndex, st.x, st.y, st.rc, st.rs, true, hasOrder, hasOrder && worker._entityYSort());
          const written = worker.emitSpriteQueue(DT, source);
          frames.push({
            written, ends, warns: warns.sort(), counts: [...worker._persistCount], gen: worker._staticGen,
            tiled: [...worker._tiledTileColumns].length, mem: regions.map(([, at, bytes]) => all.slice(at, at + bytes)),
          });
        }
        worker._spriteAnimationEnded = realEnded;
        worker._warnMissingTexture = realWarn;
        return frames;
      };
      const js = run(null);
      assert.deepEqual(calls, { persistFrame: 0, persistHits: 0, persistRemember: 0, emitRows: 0, othersOnly: 0 }, 'the JS run called no kernel');
      const wasm = run(bound);
      for (let f = 0; f < PERSIST_FRAMES; f++) {
        const got = wasm[f];
        const want = js[f];
        assert.deepEqual({ written: got.written, counts: got.counts, gen: got.gen, tiled: got.tiled },
          { written: want.written, counts: want.counts, gen: want.gen, tiled: want.tiled }, `frame ${f}`);
        assert.deepEqual(got.ends, want.ends, `frame ${f}: play-once ends, in order`);
        assert.deepEqual(got.warns, want.warns, `frame ${f}: warnings`);
        regions.forEach(([name], r) => {
          const at = got.mem[r].findIndex((x, i) => x !== want.mem[r][i]);
          assert.equal(at, -1, `frame ${f}: ${name} differs at byte ${at}`);
        });
      }
      // Every frame went through the kernel: persist_frame unless the count changed, and on a miss the
      // full emit and the remember; a hit with rows of other types (every collector here has some) their emit.
      assert.equal(calls.persistHits + calls.persistRemember, PERSIST_FRAMES, JSON.stringify(calls));
      assert.equal(calls.emitRows, calls.persistRemember + calls.othersOnly, JSON.stringify(calls));
      assert.equal(calls.othersOnly, calls.persistHits, JSON.stringify(calls));
      assert.ok(calls.persistHits >= 10 && calls.persistRemember >= 10, JSON.stringify(calls));
      t.diagnostic(`ySort ${ySort}${casters ? '' : ', no ShadowCaster'}: ${JSON.stringify(calls)}`);
    });
  }
}

test('emitSpriteQueue through the kernel takes the persist frames the JS takes and writes what it writes', async (t) => {
  await runWiredPersist(t, [{ ySort: true, seed: 0xa11 }, { ySort: false, seed: 0xa12 }, { ySort: true, seed: 0xa13 }], true);
});

test('without ShadowCaster the kernel leaves the shadow terms the full emit wrote (E-117)', async (t) => {
  await runWiredPersist(t, [{ ySort: true, seed: 0xa13 }], false);
});

// E-188: with the keyed decorations' records laid out, a decoration row's key is its pool slot past the entities, marked
// when the statics the row got differ from the ones its slot last emitted (a texture, an alpha, a tint, the zoom's fade),
// or its record is from an earlier epoch (pre-render moves it when Pixi asks for every statics again). The first
// emit of a slot marks it; its rows later in the same frame do not need to.
test('DX-FACES: a decoration keyed by its slot is marked when its face changes', async () => {
  const k = await setup({ ySort: true, keyed: true, keyedDecorations: true, faces: true });
  const { worker: w, b, source, count, maxItems } = k;
  const n = Math.min(count, maxItems);
  const kernelSource = { ...source, persist: true };
  SpriteRenderer.keyedDirty.fill(1);
  const frame = () => {
    assert.ok(writeEmitColumns(b, w, SpriteRenderer, ShadowCaster, DecorationComponent, kernelSource));
    const flags = EMIT_SORT_KEY | EMIT_Y_SORT | EMIT_BOUNDS | EMIT_TILES_DIRTY;
    assert.equal(b.emitRows(b.tableByte, count, maxItems, flags, DT / 1000, w._decorationZoomAlpha, w._zBand), n);
    const marked = new Map();
    for (let r = 0; r < n; r++) {
      if (w._renderableType[r] !== 2) continue;
      const d = w._renderableIndex[r];
      if (!marked.has(d)) marked.set(d, w.renderQueueKey[r] >= KEY_CHANGED);
    }
    return marked;
  };
  const drawn = [...frame().keys()];
  assert.ok(drawn.length > 50, 'decorations drawn');
  assert.ok([...frame().values()].every((x) => !x), 'faces that held mark none');
  const [d0, d1] = drawn;
  DecorationComponent.faceOct[d0] = (DecorationComponent.faceOct[d0] ^ 0x0102) || 0x0101;
  DecorationComponent.faceZ[d1] = (DecorationComponent.faceZ[d1] + 8) & 0xffff;
  const m = frame();
  assert.deepEqual(drawn.filter((d) => m.get(d)), [d0, d1], 'a normal and a height mark their slot alone');
});

// A row belongs to whatever sorts there next: a zoom changes what is on screen, and every row after that changes hands.
test('DX-FACES: a sprite that sorts into a row a face held carries no face', async () => {
  const k = await setup({ ySort: true, faces: true });
  const { worker: w, b, source, count, maxItems } = k;
  const n = Math.min(count, maxItems);
  const emit = () => {
    assert.ok(writeEmitColumns(b, w, SpriteRenderer, ShadowCaster, DecorationComponent, source));
    const flags = EMIT_SORT_KEY | EMIT_Y_SORT | EMIT_BOUNDS | EMIT_TILES_DIRTY;
    assert.equal(b.emitRows(b.tableByte, count, maxItems, flags, DT / 1000, w._decorationZoomAlpha, w._zBand), n);
  };
  emit();
  const faces = [];
  const plain = [];
  for (let r = 0; r < n; r++) {
    const e = w._renderableIndex[r];
    if (w._renderableType[r] === 2 && w.renderQueueTileOffsetU[r] !== 0) faces.push(r);
    if (w._renderableType[r] === 0 && SpriteRenderer.repeatX[e] === 0 && SpriteRenderer.repeatY[e] === 0) plain.push(r);
  }
  const pairs = Math.min(faces.length, plain.length);
  assert.ok(pairs > 50, `${pairs} rows change hands`);
  for (let p = 0; p < pairs; p++) {
    const [a, c] = [faces[p], plain[p]];
    const [type, index] = [w._renderableType[a], w._renderableIndex[a]];
    w._renderableType[a] = w._renderableType[c];
    w._renderableIndex[a] = w._renderableIndex[c];
    w._renderableType[c] = type;
    w._renderableIndex[c] = index;
  }
  emit();
  for (let p = 0; p < pairs; p++) {
    assert.equal(w.renderQueueTileOffsetU[faces[p]], 0, `row ${faces[p]}: a sprite is no face`);
    assert.equal(w.renderQueueTileOffsetV[faces[p]], 0, `row ${faces[p]}: and has no face's height`);
    const d = w._renderableIndex[plain[p]];
    assert.equal(w.renderQueueTileOffsetU[plain[p]], DecorationComponent.faceOct[d], `row ${plain[p]}: the face that moved there`);
  }
});

test('E-188: the emit keys a decoration by its pool slot, marked when its statics moved', async () => {
  const k = await setup({ ySort: true, keyed: true, keyedDecorations: true });
  const { worker: w, b, source, count, maxItems } = k;
  assert.ok(b.decoKeyedByte >= 0, 'the records are laid out');
  const n = Math.min(count, maxItems);
  const kernelSource = { ...source, persist: true };
  SpriteRenderer.keyedDirty.fill(1);
  const frame = () => {
    assert.ok(writeEmitColumns(b, w, SpriteRenderer, ShadowCaster, DecorationComponent, kernelSource));
    const flags = EMIT_SORT_KEY | EMIT_Y_SORT | EMIT_BOUNDS;
    assert.equal(b.emitRows(b.tableByte, count, maxItems, flags, DT / 1000, w._decorationZoomAlpha, w._zBand), n);
    // Each decoration slot drawn this frame: whether its first row was marked; and every row's key.
    const marked = new Map();
    for (let r = 0; r < n; r++) {
      const raw = w.renderQueueKey[r];
      const key = (raw & ~KEY_FLAGS) >>> 0;
      if (w._renderableType[r] === 0) {
        assert.equal(key, w._renderableIndex[r], `row ${r}: a sprite keeps its entity's key`);
        continue;
      }
      if (w._renderableType[r] !== 2) continue;
      const d = w._renderableIndex[r];
      assert.equal(key, N + d, `row ${r}: decoration ${d}'s key is its slot past the entities`);
      if (!marked.has(d)) marked.set(d, raw >= KEY_CHANGED);
      else assert.ok(raw < KEY_CHANGED, `row ${r}: decoration ${d}'s later row is not marked again`);
    }
    return marked;
  };
  const all = (m) => [...m.values()].every(Boolean);
  const none = (m) => [...m.values()].every((x) => !x);
  let m = frame();
  assert.ok(m.size > 50, `decorations drawn (${m.size})`);
  assert.ok(all(m), 'the first emit marks every decoration');
  assert.ok(none(frame()), 'statics that held mark none');
  const drawn = [...m.keys()];
  const [d0, d1, d2] = drawn;
  DecorationComponent.textureId[d0] = (DecorationComponent.textureId[d0] + 1) % 12;
  DecorationComponent.alpha[d1] *= 0.5;
  DecorationComponent.tint[d2] = (DecorationComponent.tint[d2] ^ 0x00ff00) >>> 0;
  m = frame();
  assert.deepEqual(drawn.filter((d) => m.get(d)), [d0, d1, d2], 'a texture, an alpha and a tint mark their slot alone');
  assert.ok(none(frame()));
  w._decorationZoomAlpha = 0.5;
  assert.ok(all(frame()), 'the zoom\'s fade moves every decoration\'s alpha');
  assert.ok(none(frame()));
  bumpEmitDecorationEpoch(b);
  assert.ok(all(frame()), 'a new epoch marks every decoration');
  assert.ok(none(frame()));
});

// E-194: with the keyed LiquidFun records laid out, a LiquidFun row's key is its particle index past the keyed
// decorations, marked as a decoration's is: when the statics its row got differ from the ones that index last emitted
// (LiquidFun compacts its buffers, so a particle that moved index is marked where its statics differ), or the record is
// from an earlier epoch. Pixi's copy, replayed from the marked rows, always holds every LiquidFun row's statics.
test('E-194: the emit keys a LiquidFun particle by its index past the keyed decorations, marked when its statics moved', async () => {
  const k = await setup({ ySort: true, keyed: true, keyedDecorations: true, liquidFun: true, keyedLiquidFun: true });
  const { worker: w, b, source, count, maxItems } = k;
  assert.ok(b.lfKeyedByte >= 0, 'the records are laid out');
  assert.equal(b.lfKeyBase, N + DECOS, 'past the keyed decorations');
  const n = Math.min(count, maxItems);
  const kernelSource = { ...source, persist: true };
  const lf = w.liquidFun;
  const white = w._resolveBuiltinTextureId('_whiteCircle');
  SpriteRenderer.keyedDirty.fill(1);
  // Pixi's statics texture for the LiquidFun keys, as the marked rows leave it.
  const copy = new Uint32Array(LFN * 12);
  // check: Pixi's copy holds every row's statics (not after a change physics did not announce, by design).
  const frame = (check = true) => {
    assert.ok(writeEmitColumns(b, w, SpriteRenderer, ShadowCaster, DecorationComponent, kernelSource));
    assert.ok(writeEmitLiquidFunColumns(b, lf, w._prevLfX, w._prevLfY, 0, w._poseAlpha, white));
    const flags = EMIT_SORT_KEY | EMIT_Y_SORT | EMIT_BOUNDS;
    assert.equal(b.emitRows(b.tableByte, count, maxItems, flags, DT / 1000, w._decorationZoomAlpha, w._zBand), n);
    const marked = new Map();
    for (let r = 0; r < n; r++) {
      if (w._renderableType[r] !== 7) continue;
      const raw = w.renderQueueKey[r];
      const p = w._renderableIndex[r];
      assert.equal((raw & ~KEY_FLAGS) >>> 0, N + DECOS + p, `row ${r}: particle ${p}'s key`);
      assert.equal(raw & KEY_TEX_ONLY, 0, `row ${r}: a LiquidFun mark is never the texture alone`);
      if (!marked.has(p)) marked.set(p, raw >= KEY_CHANGED);
      else assert.ok(raw < KEY_CHANGED, `row ${r}: particle ${p}'s later row is not marked again`);
      if (raw >= KEY_CHANGED) copy.set(rowStatics(w, r), p * 12);
    }
    for (let r = 0; check && r < n; r++) {
      if (w._renderableType[r] !== 7) continue;
      const p = w._renderableIndex[r];
      const want = rowStatics(w, r);
      for (let j = 0; j < 12; j++) {
        if (copy[p * 12 + j] !== want[j]) assert.fail(`row ${r}: particle ${p}'s statics word ${j} is stale in the copy`);
      }
    }
    return marked;
  };
  const all = (m) => [...m.values()].every(Boolean);
  const none = (m) => [...m.values()].every((x) => !x);
  let m = frame();
  assert.ok(m.size > 20, `LiquidFun particles drawn (${m.size})`);
  assert.ok(all(m), 'the first emit marks every particle');
  // Moving changes no statics.
  for (let s = 0; s < LFN; s++) { lf.x[s] += 3; lf.y[s] -= 2; lf.rotC[s] = Math.cos(s); lf.rotS[s] = Math.sin(s); }
  assert.ok(none(frame()), 'a frame of moves marks none');
  const drawn = [...m.keys()];
  const [p0, p1, p2, p3] = drawn;
  // Step 2: physics announces each change to the statics by moving its counter; the emit reads its records only then.
  assert.ok(lf.staticsEpoch, 'the render buffer has the counter');
  const announce = () => Atomics.add(lf.staticsEpoch, 0, 1);
  lf.tint[p0] = (lf.tint[p0] ^ 0x00ff00) >>> 0;
  lf.scaleX[p1] *= 1.5;
  lf.alpha[p2] *= 0.5;
  lf.textureId[p3] = lf.textureId[p3] === 2 ? 3 : 2;
  assert.ok(none(frame(false)), 'a change physics did not announce is not looked for');
  announce();
  m = frame();
  assert.deepEqual(drawn.filter((p) => m.get(p)), [p0, p1, p2, p3], 'a tint, a scale, an alpha and a texture mark their index alone');
  assert.ok(none(frame()));
  // A compaction moves particles to other indices: two that trade indices (and statics) mark both, nothing else.
  const [a, c] = [drawn[4], drawn[5]];
  for (const key of ['scaleX', 'scaleY', 'alpha', 'tint', 'textureId']) {
    const t = lf[key][a];
    lf[key][a] = lf[key][c];
    lf[key][c] = t;
  }
  announce();
  m = frame();
  assert.deepEqual(drawn.filter((p) => m.get(p)), [a, c], 'two particles that traded indices mark both');
  assert.ok(none(frame()));
  bumpEmitDecorationEpoch(b);
  assert.ok(all(frame()), 'a new epoch marks every particle');
  assert.ok(none(frame()));
  // A frame with the counter unmoved reads no record: a record made stale behind the emit's back stays unread.
  const recs = new Uint32Array(k.m.buffer, b.lfKeyedByte, LFN * 8);
  const saved = recs.slice();
  recs.fill(0xdeadbeef);
  assert.ok(none(frame()), 'the records were not read');
  announce();
  assert.ok(all(frame()), 'read again once physics announces a change');
  recs.set(saved);
});
