#!/usr/bin/env node
/**
 * Capture one Predator frame for kernels (tests/fixtures/predator-frame.bin).
 * Headed Chrome, detailed stats off, `--src`. Reads only: the published pose
 * SAB and the component arrays the main thread already holds, plus the audio
 * slot states. Does not step, spawn or write anything in the scene.
 *
 *   node tests/bench/capturePredatorFixture.mjs
 *   node tests/bench/capturePredatorFixture.mjs --warmup-ms 15000 --query "hour=0&zoom=0.4"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { parseArgs } from './microbenchHelpers.mjs';
import { PREDATOR_FIXTURE_PATH, writeFixture } from './predatorFixture.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = parseArgs();
const warmupMs = Number(args['warmup-ms'] ?? 12000);
const query = typeof args.query === 'string' ? args.query.replace(/^\?/, '') : '';
const out = args.output ? path.resolve(String(args.output)) : PREDATOR_FIXTURE_PATH;

const server = await createStaticBenchmarkServer(repoRoot);
const url = `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?src=1${query ? `&${query}` : ''}`;
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-webgpu-developer-features',
    '--enable-dawn-features=allow_unsafe_apis',
  ],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (err) => console.error('[page error]', err));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(() =>
    window.__WEED_BENCHMARK__.prepare({
      warmupMs: 1000,
      durationMs: 1000,
      sampleIntervalMs: 100,
      sceneModule: '/demos/predatorScene/predatorScene.js',
      sceneExport: 'PredatorScene',
      collectDetailedStats: false,
      collectGpuStats: false,
    })
  );
  await page.waitForTimeout(warmupMs);

  const snap = await page.evaluate(async () => {
    const scene = window.__WEED_BENCHMARK__.getScene();
    const [{ Transform }, { Collider }, { ShadowCaster }, { LightEmitter }, { SoundManager }] = await Promise.all([
      import('/src/components/transform.js'),
      import('/src/components/collider.js'),
      import('/src/components/shadowCaster.js'),
      import('/src/components/lightEmitter.js'),
      import('/src/core/soundManager.js'),
    ]);
    const n = scene.poseCapacity || scene.totalEntityCount;
    const sync = new Int32Array(scene.buffers.poseSync);
    const ready = Atomics.load(sync, 0);
    const sab = ((ready - 1) & 1) === 0 ? scene.buffers.poseDataA : scene.buffers.poseDataB;
    const copy = (arr, len) => (arr ? Array.from(arr.subarray(0, len)) : null);
    const x = Array.from(new Float32Array(sab, 0, n));
    const y = Array.from(new Float32Array(sab, n * 4, n));
    const rotC = Array.from(new Float32Array(sab, n * 8, n));
    const rotS = Array.from(new Float32Array(sab, n * 12, n));
    let audioPlaying = 0;
    const maxSlots = SoundManager._maxSlots | 0;
    if (SoundManager._i32) {
      for (let s = 0; s < maxSlots; s++) {
        if (Atomics.load(SoundManager._i32, SoundManager.HEADER_SIZE + s * SoundManager.SLOT_SIZE) !== SoundManager.STATE_FREE) {
          audioPlaying++;
        }
      }
    }
    return {
      n,
      poseReady: ready,
      worldWidth: scene.config.worldWidth,
      worldHeight: scene.config.worldHeight,
      spatial: scene.config.spatial,
      lighting: {
        maxShadowCastingLights: scene.config.lighting.maxShadowCastingLights,
        maxShadowsPerLight: scene.config.lighting.maxShadowsPerLight,
        maxShadowsPerEntity: scene.config.lighting.maxShadowsPerEntity,
      },
      audio: {
        maxSlots,
        playing: audioPlaying,
        dropped: SoundManager._i32 ? Atomics.load(SoundManager._i32, SoundManager.HEADER_DROPPED) : 0,
      },
      x,
      y,
      rotC,
      rotS,
      active: copy(Transform.active, n),
      entityType: copy(Transform.entityType, n),
      colliderActive: copy(Collider.active, n),
      shapeType: copy(Collider.shapeType, n),
      radius: copy(Collider.radius, n),
      visualRange: copy(Collider.visualRange, n),
      shadowActive: copy(ShadowCaster.active, n),
      shadowH: copy(ShadowCaster.heightMultiplier, n),
      lightActive: copy(LightEmitter.active, n),
      lightIntensity: copy(LightEmitter.lightIntensity, n),
    };
  });

  const f32 = (a) => Float32Array.from(a || []);
  const u8 = (a) => Uint8Array.from(a || []);
  const arrays = {
    x: f32(snap.x),
    y: f32(snap.y),
    rotC: f32(snap.rotC),
    rotS: f32(snap.rotS),
    active: u8(snap.active),
    entityType: Uint16Array.from(snap.entityType || []),
    colliderActive: u8(snap.colliderActive),
    shapeType: u8(snap.shapeType),
    radius: f32(snap.radius),
    visualRange: f32(snap.visualRange),
    shadowActive: u8(snap.shadowActive),
    shadowH: f32(snap.shadowH),
    lightActive: u8(snap.lightActive),
    lightIntensity: f32(snap.lightIntensity),
  };
  let active = 0;
  let casters = 0;
  let lights = 0;
  for (let i = 0; i < snap.n; i++) {
    if (arrays.active[i]) active++;
    if (arrays.active[i] && arrays.shadowActive[i] && arrays.shadowH[i] > 0) casters++;
    if (arrays.active[i] && arrays.lightActive[i]) lights++;
  }
  const meta = {
    capturedAt: new Date().toISOString(),
    scene: 'PredatorScene',
    query,
    warmupMs,
    n: snap.n,
    activeEntities: active,
    shadowCasters: casters,
    lights,
    poseReady: snap.poseReady,
    worldWidth: snap.worldWidth,
    worldHeight: snap.worldHeight,
    spatial: snap.spatial,
    lighting: snap.lighting,
    audio: snap.audio,
  };
  writeFixture(out, meta, arrays);
  console.log(`Wrote ${out}: ${active} active, ${casters} casters, ${lights} lights, audio ${snap.audio.playing}/${snap.audio.maxSlots} playing`);
} finally {
  await browser.close();
  await server.close();
}
