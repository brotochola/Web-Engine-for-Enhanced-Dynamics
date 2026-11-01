#!/usr/bin/env node
/**
 * Kernel (E-160): the shadow stamp replayed in Node on a capture of a scene's own inputs (captureStampInputs.mjs;
 * the replay is shadowStampReplay.mjs). One op is the whole capture, every frame as the scene called it; the
 * report also gives the ms a frame against the scene's own ms a call. The checksum folds every frame's cursor, rows
 * and light indices; `matchesCapture` says whether the shipped kernel's replay writes what the scene's stamp wrote.
 *
 *   node tests/bench/shadowStampReplayMicrobench.mjs [--capture tests/results/stamp-capture/predator.bin]
 *        [--variant wasm|other] [--other-wasm path] [--output path] [--check]
 * `other` is the shipped stamp from another engine.wasm (--other-wasm, say a copy taken before a change), so a
 * build can be compared with the one before it in alternating processes.
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/shadowStampReplayMicrobench.mjs --variants wasm,<v> --rounds 5
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { captureChecksum, createStampReplay, STAMP_REPLAY_VARIANTS } from './shadowStampReplay.mjs';
import { decodeStampCapture } from './stampCapture.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const here = import.meta.dirname;

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'wasm');
  const other = variant === 'other' ? String(args['other-wasm'] || '') : '';
  if (variant === 'other' && !other) throw new Error('--variant other needs --other-wasm <engine.wasm>');
  const v = other ? { file: other, name: 'shadowStamp', fn: 'stamp_light_range' } : STAMP_REPLAY_VARIANTS[variant];
  if (!v) throw new Error(`unknown variant ${variant} (${[...Object.keys(STAMP_REPLAY_VARIANTS), 'other'].join(', ')})`);
  const file = path.resolve(here, '../..', String(args.capture ?? 'tests/results/stamp-capture/predator.bin'));
  if (!fs.existsSync(file)) throw new Error(`missing ${file} (run captureStampInputs.mjs)`);
  const capture = decodeStampCapture(new Uint8Array(fs.readFileSync(file)));
  const r = await createStampReplay(capture, pathToFileURL(path.resolve(here, STAMP_REPLAY_VARIANTS.wasm.file)));
  const fn = variant === 'wasm' ? r.shipped : await r.kernelOf(pathToFileURL(path.resolve(here, v.file)), v.name, v.fn);
  if (!fn) throw new Error(`no ${v.fn} in ${v.file}`);
  const expected = captureChecksum(capture);
  const checksum = r.replayChecksum(fn);
  const frames = capture.frames.length;
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} frames ${frames} matchesCapture ${checksum === expected}`);
    return;
  }
  const run = () => r.replay(fn);
  const tier = await warmWasm(fn, run, { calls: 60 });
  const cases = { replay: timeIt(`replay ${variant} (${frames} frames)`, run, { warmup: 5 }) };
  const msPerFrame = 1000 / (cases.replay.opsPerSec * frames);
  const report = {
    feature: 'shadow-stamp-replay',
    variant,
    functions: [`${v.name}.${v.fn}`],
    capture: path.relative(path.resolve(here, '../..'), file),
    frames,
    checksum,
    matchesCapture: checksum === expected,
    sceneMsPerCall: capture.meta.sceneMsPerCall,
    msPerFrame,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    console.log(`checksum ${checksum} matchesCapture ${checksum === expected} tier ${tier}`);
    console.log(`replay ${msPerFrame.toFixed(3)} ms a frame; the scene ${capture.meta.sceneMsPerCall.toFixed(3)} ms a call`);
  }
}

if (isCli(import.meta.url)) await main();
