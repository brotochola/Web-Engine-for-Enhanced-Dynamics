/**
 * Harness for WebAssembly kernels (E-76 T4).
 *
 * A WASM kernel is judged against the shipped JavaScript it would replace, on the same bytes, laid
 * out the way the product lays them out. A kernel bench built on this module:
 *
 * - instantiates the module the way the product must: `instantiateKernel(name, memory)` reads
 *   wasm/modules.json and passes exactly one import, the shared memory (the T6 rule), so a module
 *   that needs anything else fails to link here;
 * - checks parity before timing: both sides run once on the same input and must write the same
 *   output (the kernel compares, then checksums);
 * - times the optimizing tier on both sides. JS: `warmNormalCompile` (N-28). WASM: V8 compiles a
 *   function with Liftoff on its first call and tiers it up to TurboFan in the background once it
 *   has run enough (dynamic tiering counts executed code, not calls). Chrome's steady state is the
 *   TurboFan code. `warmWasm` makes the short calls; run the bench with `--allow-natives-syntax`
 *   and it also checks the tier and throws if the code is still Liftoff. Without that flag,
 *   `kernelTierAudit.mjs` checks it from `--trace-wasm-compilation-times`;
 * - alternates the sides in one process (`abab`): on 2026-10-22 one process per sample spread the
 *   same module from 4 500 to 8 800 ops/s (the laptop was on battery), while sides that alternate
 *   every few milliseconds see the same clock;
 * - records the machine (`machineState`): Node, V8, CPU and the power source.
 *
 * Node's V8 is not Chrome's (12.4 here against 15.5). A WASM-vs-JS verdict from this harness is the
 * kernel gate; the scene pair in Chrome is the one that is believed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEED_PCT } from './measureLib.mjs';
import { timeIt } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Printed when timing starts, so kernelTierAudit.mjs can tell warm-up compiles from late ones. */
export const TIMING_MARKER = '[wasm-kernel] timing starts';

/** wasm/modules.json entry for `name`. */
export function kernelEntry(name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'wasm', 'modules.json'), 'utf8'));
  const mod = manifest.modules.find((m) => m.name === name);
  if (!mod) throw new Error(`wasm/modules.json lists no module named ${name}`);
  return mod;
}

/**
 * The binary a kernel ships in: engine.wasm for a kernel of the engine module (close-out step 4), with every
 * kernel's exports, or its own build with `separate` (tests/fixtures/wasm/, for the A/B against the engine).
 */
export function kernelBinaryPath(name, { separate = false } = {}) {
  const entry = kernelEntry(name);
  return path.join(repoRoot, entry.engine && !separate ? kernelEntry('engine').output : entry.output);
}

/** Compiled module (sync); `file` overrides the manifest's output path (a candidate binary). */
export function compileKernel(name, file = null, { separate = false } = {}) {
  const bytes = fs.readFileSync(file ? path.resolve(file) : kernelBinaryPath(name, { separate }));
  return new WebAssembly.Module(bytes);
}

/**
 * Instance exports, linked to `memory` and nothing else.
 * @param {string | WebAssembly.Module} nameOrModule
 * @param {WebAssembly.Memory} memory
 */
export function instantiateKernel(nameOrModule, memory) {
  const mod = typeof nameOrModule === 'string' ? compileKernel(nameOrModule) : nameOrModule;
  return new WebAssembly.Instance(mod, { env: { memory } }).exports;
}

const natives = process.execArgv.includes('--allow-natives-syntax');
// Built only under the flag: `%` is a syntax error without it.
const isTurboFan = natives ? new Function('f', 'return %IsTurboFanFunction(f)') : null;
const isLiftoff = natives ? new Function('f', 'return %IsLiftoffFunction(f)') : null;

/** 'turbofan' | 'liftoff' | 'uncompiled' for an exported WASM function; 'unchecked' without natives. */
export function wasmTier(fn) {
  if (!natives) return 'unchecked';
  if (isTurboFan(fn)) return 'turbofan';
  if (isLiftoff(fn)) return 'liftoff';
  return 'uncompiled';
}

/**
 * Warm an exported WASM function to TurboFan through short calls. `short` runs `fn` on a small
 * slice of the kernel's input. With natives, calls continue (up to `maxCalls`) until the tier-up
 * is installed and a function still in Liftoff throws; without, `calls` are made and the tier is
 * reported as 'unchecked'.
 * @returns {Promise<string>} the tier
 */
export async function warmWasm(fn, short, { calls = 3000, maxCalls = 200000 } = {}) {
  for (let i = 0; i < calls; i++) short();
  // The TurboFan compile runs on a background thread; give it time to install.
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (!natives) return 'unchecked';
  for (let i = calls; i < maxCalls && wasmTier(fn) !== 'turbofan'; i += 100) {
    for (let k = 0; k < 100; k++) short();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const tier = wasmTier(fn);
  if (tier !== 'turbofan') throw new Error(`warmWasm: still ${tier} after ${maxCalls} calls`);
  return tier;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Compare two sides' samples (ops/s): median delta, the cross comparisons of HOW_WE_MEASURE
 * (every `side` sample against every `base` sample; a verdict needs 90 % of them) and the paired
 * comparisons of the rounds (same moment, same clock).
 */
export function compareSamples(base, side) {
  const delta = ((median(side) - median(base)) / median(base)) * 100;
  let cross = 0;
  for (const s of side) for (const b of base) if (s > b) cross++;
  let paired = 0;
  for (let r = 0; r < Math.min(base.length, side.length); r++) if (side[r] > base[r]) paired++;
  const total = base.length * side.length;
  const need = Math.ceil(total * 0.9);
  let verdict = 'TIE';
  if (delta >= SPEED_PCT && cross >= need) verdict = 'FASTER';
  else if (delta <= -SPEED_PCT && total - cross >= need) verdict = 'SLOWER';
  return {
    deltaPct: delta,
    crossWins: cross,
    crossTotal: total,
    pairedWins: paired,
    pairedTotal: Math.min(base.length, side.length),
    verdict,
  };
}

/**
 * Time every side in one process, alternating: round r runs the sides in order, round r + 1 in
 * reverse. Each sample is `timeIt`'s median of 5 runs of at least `minMs` (3 ms, the timer floor),
 * at the iteration count calibrated once per side. Sides are arity-0 functions doing one op.
 * The first side is the base every other side is compared with.
 * @param {Record<string, () => void>} sides
 * @param {{ rounds?: number, minMs?: number, label?: string }} [opts]
 */
export function abab(sides, { rounds = 9, minMs, label = 'kernel' } = {}) {
  const names = Object.keys(sides);
  const floor = minMs === undefined ? {} : { minMs };
  const iterations = {};
  for (const name of names) iterations[name] = timeIt(name, sides[name], { silent: true, ...floor }).iterations;
  console.log(TIMING_MARKER);
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? names : [...names].reverse();
    for (const name of order) {
      samples[name].push(timeIt(name, sides[name], { iterations: iterations[name], silent: true, ...floor }).opsPerSec);
    }
  }
  const cases = {};
  for (const name of names) {
    cases[name] = { opsPerSec: median(samples[name]), samples: samples[name], iterations: iterations[name] };
  }
  const base = names[0];
  const comparisons = {};
  for (const name of names.slice(1)) comparisons[name] = compareSamples(samples[base], samples[name]);
  for (const name of names) {
    const c = comparisons[name];
    const tail = c
      ? ` | ${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct.toFixed(1)} % vs ${base}, cross ${c.crossWins}/${c.crossTotal}, paired ${c.pairedWins}/${c.pairedTotal}: ${c.verdict}`
      : '';
    console.log(`${label} ${name}: ${Math.round(cases[name].opsPerSec).toLocaleString('en-US')} ops/s${tail}`);
  }
  return { rounds, base, cases, comparisons };
}

let powerCache;
/** 'ac' | 'battery' | 'unknown'. A laptop on battery clocks erratically; say so in the report. */
export function powerSource() {
  if (powerCache) return powerCache;
  powerCache = 'unknown';
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus).PowerOnline'],
        { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      // One line per battery; a desktop has none and prints nothing.
      powerCache = /true/i.test(out) ? 'ac' : /false/i.test(out) ? 'battery' : 'unknown';
    } else if (process.platform === 'linux') {
      const dir = '/sys/class/power_supply';
      const mains = fs.readdirSync(dir).filter((d) => /^(AC|ADP)/i.test(d));
      if (mains.length) powerCache = mains.some((d) => fs.readFileSync(path.join(dir, d, 'online'), 'utf8').trim() === '1') ? 'ac' : 'battery';
    }
  } catch {
    powerCache = 'unknown';
  }
  return powerCache;
}

/** What the report says about the machine that timed it. Warns when on battery. */
export function machineState() {
  const power = powerSource();
  if (power === 'battery') console.warn('warning: running on battery; kernel timings swing with the clock');
  return {
    node: process.version,
    v8: process.versions.v8,
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    power,
    nativesChecked: natives,
    execArgv: process.execArgv,
  };
}
