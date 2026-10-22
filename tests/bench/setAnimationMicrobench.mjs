#!/usr/bin/env node
/**
 * Kernel: GameObject.setAnimation called every tick, the way demos would call
 * it if it were free when nothing changed (bug, cityPerson and walker cache the
 * last direction in a plain field instead). Real GameObject, SpriteRenderer and
 * SpriteSheetRegistry; 8 direction animations per sheet.
 *
 *   node --expose-gc tests/bench/setAnimationMicrobench.mjs [--entities 4096] [--output path]
 *
 * Cases: `same` (each entity sets the animation it already plays: the common
 * tick), `turn` (every call switches between two animations). Reports ops/s,
 * a checksum of animationState, and the minor GCs during the timed samples (a
 * call that allocates shows up there).
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

export function setupSetAnimation(n) {
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(n)), n);
  const animations = {};
  for (const d of DIRS) animations[d] = [`${d}_0`, `${d}_1`, `${d}_2`];
  for (const sheet of ['bugA', 'bugB']) {
    if (!SpriteSheetRegistry.spritesheets.has(sheet)) SpriteSheetRegistry.register(sheet, { animations });
  }
  class Bug extends GameObject {
    static components = [SpriteRenderer];
  }
  GameObject._assignComponentClassMap(Bug);
  const bugs = [];
  for (let i = 0; i < n; i++) {
    const bug = new Bug(i, {}, null, { page: true });
    SpriteRenderer.spritesheetId[i] = SpriteSheetRegistry.getSpritesheetId(i & 1 ? 'bugB' : 'bugA');
    bug.setAnimation(DIRS[i & 7]);
    bugs.push(bug);
  }
  return bugs;
}

/** One pass: entity i sets DIRS[(i + shift) & 7]; shift 0 keeps every animation. */
export function setAll(bugs, shift) {
  for (let i = 0; i < bugs.length; i++) bugs[i].setAnimation(DIRS[(i + shift) & 7]);
}

function minorGcsDuring(fn) {
  let count = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.detail?.kind === 1 || e.kind === 1) count++;
  });
  obs.observe({ entryTypes: ['gc'] });
  const result = fn();
  return new Promise((resolve) => setTimeout(() => { obs.disconnect(); resolve({ result, minorGcs: count }); }, 50));
}

export async function runSetAnimationMicrobench({ entities = 4096 } = {}) {
  const bugs = setupSetAnimation(entities);
  const small = bugs.slice(0, 64);
  warmNormalCompile(() => setAll(small, 0));
  warmNormalCompile(() => { setAll(small, 1); setAll(small, 0); });

  globalThis.gc?.();
  const same = await minorGcsDuring(() => timeIt('setAnimation same', () => setAll(bugs, 0), { iterations: 50 }));
  setAll(bugs, 0);
  let flip = 0;
  globalThis.gc?.();
  const turn = await minorGcsDuring(() => timeIt('setAnimation turn', () => setAll(bugs, (flip ^= 1)), { iterations: 50 }));
  setAll(bugs, 0);

  const checksum = checksumInts(SpriteRenderer.animationState, entities);
  const perCall = (r) => Math.round((r.result.opsPerSec * entities));
  console.log(`same: ${perCall(same).toLocaleString()} calls/s, ${same.minorGcs} minor GCs`);
  console.log(`turn: ${perCall(turn).toLocaleString()} calls/s, ${turn.minorGcs} minor GCs`);
  console.log(`checksum ${checksum}${globalThis.gc ? '' : ' (run with --expose-gc for a clean GC count)'}`);
  return {
    entities,
    checksum,
    same: { callsPerSec: perCall(same), minorGcs: same.minorGcs, ms: same.result.ms, iterations: same.result.iterations },
    turn: { callsPerSec: perCall(turn), minorGcs: turn.minorGcs, ms: turn.result.ms, iterations: turn.result.iterations },
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = await runSetAnimationMicrobench({ entities: args.entities ?? 4096 });
  if (args.output) writeReport(args.output, report);
}
