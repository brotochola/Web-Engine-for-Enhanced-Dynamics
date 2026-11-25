#!/usr/bin/env node
/**
 * Scenes of two revisions against each other on this machine, A B B A, without drawing (runIntegratedWorkerBenchmark
 * --no-draw: every WebGL call is taken and no pixel is made), so a machine without a GPU times the workers: each one's own
 * time a frame (STEP_MS less its waits, over every frame of the window), Pixi's calls among it. Each side is its whole
 * revision (its scenes too) served by this tree's runner. The loads are small: the machines have 4 threads, and a frame's
 * workers already share them.
 *
 *   node tests/bench/ci/sceneAb.mjs --a <rev> --b <rev> [--pairs 3] [--scenes predator,boids | --set all] [--query k=v&k=v] [--mode shell] [--draw] [--channel chrome]
 *     [--warmup-ms 6000] [--duration-ms 8000] [--shard 1/2] --output file.json
 *
 * A pair is one observation of a worker's time: ln(B / A). What a scene draws, the GPU's time and the frames on the screen
 * are not here. --set all: every scene both revisions have (sceneList.mjs), instead of the eight below. --mode: how Chromium
 * is started (runScene; frameProbe found no difference once nothing is drawn). --channel chrome: the installed Chrome (on a
 * laptop with two GPUs Playwright's Chromium may take the integrated one). Each run says the frames each worker ran: a
 * worker that ran a few, cold, has no time to read.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isCli, parseArgs } from '../microbenchHelpers.mjs';
import { ensureRevWorktree, repoRoot } from '../revWorktree.mjs';
import { scenesOfBoth, changedModules } from './sceneList.mjs';
import { predatorMetrics } from '../runPredatorAbab.mjs';

const RUN_TIMEOUT_MS = 180000;
/** Scenes both a release and the one before have, at loads four threads carry. */
export const SCENES = Object.freeze([
  { key: 'bunnyMark', path: '/demos/bunnyMarkScene/bunnyMarkScene.js', exportName: 'BunnyMarkScene', query: 'bunnies=60000' },
  { key: 'predator', path: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene', query: 'crowd=0.4' },
  { key: 'boids', path: '/demos/boidsScene/boidsScene.js', exportName: 'BoidsScene', query: '' },
  { key: 'balls', path: '/demos/ballsScene/ballsScene.js', exportName: 'BallsScene', query: '' },
  { key: 'littleCity', path: '/demos/littleCity/littleCityScene.js', exportName: 'LittleCityScene', query: '' },
  { key: 'particles', path: '/tests/bench/stressScenes/particleIntegrateStressScene.js', exportName: 'ParticleIntegrateStressScene', query: '' },
  { key: 'decals', path: '/tests/bench/stressScenes/decalStampStressScene.js', exportName: 'DecalStampStressScene', query: '' },
  { key: 'ray', path: '/tests/bench/stressScenes/rayStressScene.js', exportName: 'RayStressScene', query: '' },
]);
const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];

/**
 * One run of `scene` of the tree at `root` (o: mode, warmupMs, durationMs, draw): each worker's own ms a frame and
 * the frames it ran. o.mode: shell (Playwright's headless shell), headless (Chromium's own), window (on Linux in a virtual
 * screen).
 */
export function runScene(root, scene, o, out) {
  fs.rmSync(out, { force: true });
  const argv = [path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs'), '--src', '--root', root, ...(o.draw ? [] : ['--no-draw']),
    '--channel', o.channel ?? 'chromium', ...(o.mode === 'window' ? ['--headed'] : o.mode === 'headless' ? ['--new-headless'] : []),
    '--no-collect-detailed-stats', '--scene', scene.path, '--scene-export', scene.exportName,
    '--warmup-ms', String(o.warmupMs), '--duration-ms', String(o.durationMs), '--output', out, ...(scene.query ? ['--query', scene.query] : [])];
  const virtual = o.mode === 'window' && process.platform === 'linux' && !process.env.DISPLAY;
  const command = virtual ? 'xvfb-run' : process.execPath;
  const full = virtual ? ['-a', '--server-args=-screen 0 2048x1280x24', process.execPath, ...argv] : argv;
  const r = spawnSync(command, full, { cwd: repoRoot, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0 || !fs.existsSync(out)) {
    const text = `${r.stderr || ''}\n${r.stdout || ''}`;
    const line = /^.*(?:Error|error:|failed).*$/m.exec(text)?.[0] || text.trim().split('\n').slice(-1)[0] || '';
    return { error: (r.error ? r.error.message : `exit ${r.status}: ${line}`).slice(0, 240) };
  }
  const m = predatorMetrics(JSON.parse(fs.readFileSync(out, 'utf8')));
  const ms = {};
  const frames = {};
  for (const kind of KINDS) {
    const v = m[`${kind}_STEP_MS_EXACT`];
    if (v > 0) ms[kind] = +v.toPrecision(5);
    if (m[`${kind}_FRAMES`] > 0) frames[kind] = m[`${kind}_FRAMES`];
  }
  return { ms, frames, entities: m.VISIBLE_ENTITIES ?? null, queue: m.RENDER_QUEUE_SIZE ?? null, particles: m.ACTIVE_PARTICLES ?? null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const o = {
    pairs: Number(args.pairs ?? 3), warmupMs: Number(args['warmup-ms'] ?? 6000), durationMs: Number(args['duration-ms'] ?? 8000),
    mode: String(args.mode ?? 'shell'), draw: Boolean(args.draw), channel: typeof args.channel === 'string' ? args.channel : 'chromium',
  };
  const sides = {
    a: ensureRevWorktree(String(args.a ?? 'HEAD'), { tag: 'a', srcOnly: false }),
    b: ensureRevWorktree(String(args.b ?? 'HEAD'), { tag: 'b', srcOnly: false }),
  };
  let scenes = args.set === 'all'
    ? scenesOfBoth(sides.a.root, sides.b.root)
    : SCENES.map((s) => ({ ...s, changed: changedModules(sides.a.root, sides.b.root, s.path) }));
  if (args.scenes) {
    const want = String(args.scenes).split(',');
    scenes = scenes.filter((s) => want.includes(s.key));
  }
  if (typeof args.query === 'string') scenes = scenes.map((s) => ({ ...s, query: args.query }));
  if (args.shard) {
    const [k, n] = String(args.shard).split('/').map(Number);
    scenes = scenes.filter((_, i) => i % n === k - 1);
  }
  const tmp = path.join(repoRoot, 'tests/results/ci-scenes');
  fs.mkdirSync(tmp, { recursive: true });
  const out = { kind: 'sceneAb', a: sides.a.sha, b: sides.b.sha, pairs: o.pairs, mode: o.mode, draw: o.draw, channel: o.channel, durationMs: o.durationMs, rows: [] };
  const write = () => fs.writeFileSync(path.resolve(String(args.output ?? 'scene-ab.json')), `${JSON.stringify(out, null, 1)}\n`);
  const t0 = performance.now();
  for (const [index, scene] of scenes.entries()) {
    const row = { scene: scene.key, query: scene.query, changed: scene.changed, a: [], b: [] };
    for (let p = 0; p < o.pairs && !row.error; p++) {
      for (const label of (p + index) % 2 === 0 ? ['a', 'b'] : ['b', 'a']) {
        const side = label === 'a' && scene.exportNameA ? { ...scene, exportName: scene.exportNameA } : scene;
        const got = runScene(sides[label].root, side, o, path.join(tmp, `${scene.key}-${label}.json`));
        if (got.error) {
          row.error = `${label}: ${got.error}`;
          break;
        }
        row[label].push(got);
      }
    }
    out.rows.push(row);
    write();
    const med = (list, kind) => {
      const v = list.map((x) => x.ms[kind]).filter((x) => x > 0).sort((x, y) => x - y);
      return v.length ? v[v.length >> 1] : null;
    };
    console.log(`${((performance.now() - t0) / 60000).toFixed(1)} min  ${scene.key}${row.error ? ` FAILED ${row.error}` : `  ${KINDS
      .filter((k) => med(row.a, k) !== null && med(row.b, k) !== null).map((k) => `${k} ${med(row.a, k).toFixed(2)}>${med(row.b, k).toFixed(2)}`).join('  ')}`}`);
  }
  write();
}

if (isCli(import.meta.url)) main();
