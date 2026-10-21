/**
 * Kernel: SpriteRenderer.updateBounds, the call behind every setScale and every
 * setSprite / setAnimation. It reads the frame size through the registry; for
 * a proxy sheet (every spritesheet once packed into bigAtlas) that lookup
 * builds `${sheet}_${anim}` on each call. Reports ops/s and the minor GCs a
 * fixed run triggers (allocation shows as scavenges).
 *
 *   node tests/bench/spriteBoundsMicrobench.mjs [--output out.json]
 *
 * Half the entities use a proxy sheet (animated sprite), half bigAtlas (static).
 * Kernel only: calls the shipped functions, never writes src/.
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { checksumFloats, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const N = 4096;
const GC_CALLS = 2_000_000;

function setupRegistry() {
  SpriteSheetRegistry.clearForSceneUnload();
  const animations = Object.create(null);
  const frames = new Map();
  const indexToName = [];
  for (let a = 0; a < 16; a++) {
    const name = `civil1_walk${a}`;
    animations[name] = { frames: [`${name}_0`], frameCount: 1 };
    frames.set(`${name}_0`, { w: 32 + a, h: 48 });
    indexToName.push(name);
  }
  SpriteSheetRegistry.spritesheets.set('bigAtlas', { animations, indexToName, totalAnimations: 16 });
  SpriteSheetRegistry.frameDimensions.set('bigAtlas', frames);
  SpriteSheetRegistry.registerSpritesheetId('bigAtlas');
  const proxyNames = [];
  for (let a = 0; a < 16; a++) proxyNames.push(`walk${a}`);
  SpriteSheetRegistry.registerProxy('civil1', { isProxy: true, indexToName: proxyNames, animations: {} });
  return {
    atlasId: SpriteSheetRegistry.getSpritesheetId('bigAtlas'),
    proxyId: SpriteSheetRegistry.getSpritesheetId('civil1'),
  };
}

export function run() {
  const { atlasId, proxyId } = setupRegistry();
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) {
    SpriteRenderer.spritesheetId[i] = i & 1 ? proxyId : atlasId;
    SpriteRenderer.animationState[i] = i & 15;
    SpriteRenderer.scaleX[i] = 1 + (i & 3) * 0.25;
    SpriteRenderer.scaleY[i] = 1;
  }
  const pass = (n) => {
    for (let k = 0; k < n; k++) SpriteRenderer.updateBounds(k & (N - 1));
  };
  warmNormalCompile(() => pass(64));

  let minorGcs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.detail?.kind === 1 || e.kind === 1) minorGcs++;
  });
  obs.observe({ entryTypes: ['gc'] });
  pass(GC_CALLS);
  return new Promise((resolve) => {
    setTimeout(() => {
      obs.disconnect();
      const t = timeIt('updateBounds (half proxy sheets)', (n) => pass(n), { iterations: 200_000 });
      resolve({
        calls: GC_CALLS,
        minorGcs,
        opsPerSec: t.opsPerSec,
        medianMs: t.ms,
        checksum: checksumFloats(SpriteRenderer.boundsHalfW, N),
      });
    }, 50);
  });
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = await run();
  console.log(JSON.stringify(report));
  if (args.output) writeReport(String(args.output), report);
}
