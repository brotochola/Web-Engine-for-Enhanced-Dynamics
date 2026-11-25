#!/usr/bin/env node
/**
 * How many frames each worker runs in a window, by the way Chromium is started on this machine (DX-CI): a worker that ran a
 * few cold frames has no time to read. Modes: shell (Playwright's headless shell), headless (Chromium's own), window
 * (Chromium with a window, on Linux in a virtual screen: xvfb-run), each with flags or a canvas size after a +.
 *
 *   node tests/bench/ci/frameProbe.mjs [--modes shell,headless,window,window+scale4+480x270] [--scenes bunnyMark,boids]
 *     [--runs 1] [--draw] --output file.json
 */
import fs from 'node:fs';
import path from 'node:path';

import { isCli, parseArgs } from '../microbenchHelpers.mjs';
import { repoRoot } from '../revWorktree.mjs';
import { CHROMIUM_FLAGS, SCENES, runScene } from './sceneAb.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const modes = String(args.modes ?? 'shell,headless,window').split(',');
  const keys = String(args.scenes ?? 'bunnyMark,boids,balls,particles,predator').split(',');
  const runs = Number(args.runs ?? 1);
  const out = { kind: 'frameProbe', rows: [] };
  const file = path.resolve(String(args.output ?? 'frame-probe.json'));
  const tmp = path.join(repoRoot, 'tests/results/ci-scenes');
  fs.mkdirSync(tmp, { recursive: true });
  for (const scene of SCENES.filter((s) => keys.includes(s.key))) {
    for (const mode of modes) {
      const [kind, ...more] = mode.split('+');
      const canvas = more.find((x) => /^[0-9]+x[0-9]+$/.test(x)) ?? null;
      const flags = more.filter((x) => CHROMIUM_FLAGS[x]).map((x) => CHROMIUM_FLAGS[x]).join(' ');
      for (let r = 0; r < runs; r++) {
        const got = runScene(repoRoot, scene, {
          mode: kind, warmupMs: 6000, durationMs: 8000, draw: Boolean(args.draw), canvas, flags,
        }, path.join(tmp, 'probe.json'));
        out.rows.push({ scene: scene.key, mode, ...got });
        fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
        console.log(scene.key.padEnd(10), mode.padEnd(9), got.error ?? `${Object.entries(got.ms).map(([k, v]) => `${k} ${v}`).join('  ')}  | frames ${JSON.stringify(got.frames)}`);
      }
    }
  }
}

if (isCli(import.meta.url)) main();
