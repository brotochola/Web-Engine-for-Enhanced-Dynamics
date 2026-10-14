/**
 * Kernel for H-01: `Scene.updateKeyboardBuffer` - O(1) per key event against
 * the full 74-key resync, and what the `Object.entries` enumeration allocated.
 *
 * Gate 2 on both sides: the shipped method is taken off `Scene.prototype` and
 * called on a stub `this`; the pre-fix body is an exact textual diff over the
 * shipped source, compiled in memory outside the working tree.
 *
 * Five counterbalanced rounds, medians per side - one process per side cannot
 * resolve 3 % (DEVLOG, 30 Sept).
 *
 * SCOPE, stated up front because it decides how far the number can be pushed:
 * this is an EVENT path. It runs on keydown/keyup, not per frame, and the CPU
 * trace does not name it anywhere. So this kernel can say what one key event
 * costs and how much it allocated. It cannot say what that is worth to Predator,
 * and nothing here should be promoted to a product number without the sitting in
 * docs/HOW_WE_MEASURE.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.window = globalThis.window || {};
const { Scene } = await import('../../src/core/scene.js');
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '../results/h01-keyboard-input');
const SRC = path.resolve(HERE, '../../src/core/scene.js');
const ANCHOR = '  updateKeyboardBuffer(key) {';
const PRE_FIX_BODY = `  updateKeyboardBuffer() {
    const input = this.views.input;
    if (!input) return;
    for (const [key, index] of Object.entries(this.keyMap)) {
      input[index] = this.keyboard[key] ? 1 : 0;
    }
  }
`;

const SEED = 0x1d0;
const KEY_COUNT = 74;
const ROUNDS = 5;
const FLOOR_PCT = 3;

/** scene.js's key map, built the same way, indices dense 0..N-1. */
function buildKeyMap() {
  const keyMap = {};
  let i = 0;
  for (let k = 0; k < 26; k++) keyMap[String.fromCharCode(97 + k)] = i++;
  for (let k = 0; k < 10; k++) keyMap[String.fromCharCode(48 + k)] = i++;
  for (const k of [' ', 'enter', 'escape', 'tab', 'backspace', 'delete', 'shift', 'control', 'alt', 'meta']) keyMap[k] = i++;
  for (const k of ['arrowup', 'arrowdown', 'arrowleft', 'arrowright']) keyMap[k] = i++;
  for (let f = 1; f <= 12; f++) keyMap[`f${f}`] = i++;
  for (const c of ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']) keyMap[c] = i++;
  return keyMap;
}

const keyMap = buildKeyMap();
const KEY_NAMES = Object.keys(keyMap);

/** Stub `this` with the cached lists built the way scene.js builds them. */
function makeCtx(rng) {
  const entries = Object.entries(keyMap);
  const names = new Array(entries.length);
  const indices = new Int32Array(entries.length);
  for (let k = 0; k < entries.length; k++) {
    names[k] = entries[k][0];
    indices[k] = entries[k][1];
  }
  const keyboard = {};
  // A held-key workload: a handful of keys down, so the buffer is not trivially
  // all-zero and the writes are not all the same value.
  const held = ['a', 'w', 's', 'd', 'shift'];
  for (const k of held) keyboard[k] = true;
  return {
    keyMap,
    _keyNames: names,
    _keyIndices: indices,
    views: { input: new Int32Array(KEY_COUNT * 2) },
    keyboard,
    _held: held,
    _rng: rng,
  };
}

/** The pre-fix body, compiled from the shipped source by exact diff. */
function buildPreFix() {
  const source = fs.readFileSync(SRC, 'utf8');
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error(`keyboardInput: anchor not found in ${SRC}: "${ANCHOR}"`);
  const open = source.indexOf('{', at);

  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error('keyboardInput: could not find the end of updateKeyboardBuffer');

  // Replace the whole method (signature through closing brace) with the pre-fix
  // shape, which takes no argument.
  let patched = source.slice(0, at) + PRE_FIX_BODY.trimEnd() + source.slice(close + 1);

  // The copy lives outside `src/`, so relative imports have to become absolute.
  patched = patched.replace(
    /from '(\.\.?\/[^']+)'/g,
    (_m, spec) => `from '${pathToFileURL(path.resolve(path.dirname(SRC), spec)).href}'`,
  );

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, 'scene.prefixKeyboardInput.mjs');
  fs.writeFileSync(file, patched, 'utf8');
  return file;
}

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Drives a scripted hold-and-release cycle.
 *
 * `mode` picks which claim is measured, because the optimization has two
 * separable parts and averaging them into one number hides both:
 *
 *   'full' - call with no argument, so the shipped method takes its full-sync
 *            path over the CACHED lists. Against the pre-fix baseline this
 *            isolates the caching: same 74 writes, no Object.entries.
 *   'o1'   - call with a real key, so it takes the O(1) fast path. Against the
 *            cached full sync this isolates the O(1) part: 1 write, no
 *            allocation.
 */
function drive(fn, ctx, mode, events) {
  for (let i = 0; i < events; i++) {
    const k = KEY_NAMES[i % KEY_NAMES.length];
    ctx.keyboard[k] = (i & 1) === 0;
    fn.call(ctx, mode === 'o1' ? k : undefined);
  }
}

async function main() {
  const args = parseArgs();

  const shipped = Scene.prototype.updateKeyboardBuffer;

  // Pre-fix compiled in memory.
  const preFile = buildPreFix();
  const preMod = await import(pathToFileURL(preFile).href);
  const preFn = preMod.Scene.prototype.updateKeyboardBuffer;

  // Checksum gate: all three shapes must leave identical buffer state.
  const ctxPre = makeCtx(1);
  const ctxFull = makeCtx(1);
  const ctxO1 = makeCtx(1);
  drive(preFn, ctxPre, 'full', 200);
  drive(shipped, ctxFull, 'full', 200);
  drive(shipped, ctxO1, 'o1', 200);
  const sameFull = ctxPre.views.input.every((v, i) => v === ctxFull.views.input[i]);
  const sameO1 = ctxPre.views.input.every((v, i) => v === ctxO1.views.input[i]);
  if (!sameFull || !sameO1) {
    throw new Error(
      `keyboardInput: variants disagree - preFix/full ${sameFull}, preFix/o1 ${sameO1}; ` +
        'the timed code is not comparable',
    );
  }

  // --- allocation count: this is the half the hypothesis is actually about ---
  // `Object.entries` allocates the outer array plus one pair array per key.
  const entries = Object.entries(keyMap);
  const allocsPerOldSync = 1 + entries.length;

  const runs = { preFix: [], shippedFull: [], shippedO1: [] };
  const wins = { cache: 0, o1: 0 };

  for (let r = 0; r < ROUNDS; r++) {
    const a = makeCtx(SEED + r);
    const b = makeCtx(SEED + r);
    const c = makeCtx(SEED + r);
    const pre = () => timeIt(`pre-fix#${r}`, (n) => drive(preFn, a, 'full', n));
    const full = () => timeIt(`shippedFull#${r}`, (n) => drive(shipped, b, 'full', n));
    const o1 = () => timeIt(`shippedO1#${r}`, (n) => drive(shipped, c, 'o1', n));

    // Counterbalanced: the order rotates so drift inside a pair cannot always
    // land on the same side.
    const order = r % 3 === 0 ? [pre, full, o1] : r % 3 === 1 ? [o1, pre, full] : [full, o1, pre];
    const [tPre, tFull, tO1] = order.map((fn) => fn());

    runs.preFix.push(tPre.opsPerSec);
    runs.shippedFull.push(tFull.opsPerSec);
    runs.shippedO1.push(tO1.opsPerSec);
    if (tFull.opsPerSec > tPre.opsPerSec) wins.cache++;
    if (tO1.opsPerSec > tFull.opsPerSec) wins.o1++;
  }

  const medPre = median(runs.preFix);
  const medFull = median(runs.shippedFull);
  const medO1 = median(runs.shippedO1);

  const cachePct = ((medFull / medPre) - 1) * 100;
  const o1Pct = ((medO1 / medFull) - 1) * 100;
  const totalPct = ((medO1 / medPre) - 1) * 100;

  const cacheAgree = wins.cache === ROUNDS;
  const o1Agree = wins.o1 === ROUNDS;

  let verdict;
  if (!cacheAgree) {
    verdict =
      `NO CLAIM on the caching - ${wins.cache}/${ROUNDS} rounds; inside the noise band.`;
  } else if (cachePct < FLOOR_PCT) {
    verdict = `NO CLAIM on the caching - unanimous but +${cachePct.toFixed(1)} % is under the floor.`;
  } else {
    verdict =
      `KERNEL WIN on the caching: +${cachePct.toFixed(0)} % (${(medPre / medFull).toFixed(1)}x), ` +
      `${ROUNDS}/${ROUNDS} rounds, over the ${FLOOR_PCT} % floor. ` +
      `${allocsPerOldSync} array allocations per key event removed.`;
  }
  verdict +=
    o1Agree && o1Pct >= FLOOR_PCT
      ? ` The O(1) fast path adds a further +${o1Pct.toFixed(0)} % (${(medFull / medO1).toFixed(1)}x), ` +
        `${ROUNDS}/${ROUNDS} rounds.`
      : ` The O(1) fast path is ${o1Agree ? 'unanimous but' : `${wins.o1}/${ROUNDS} rounds,`}` +
        ` +${o1Pct.toFixed(0)} %, which is ${o1Pct >= FLOOR_PCT ? 'also over the floor' : 'inside the noise band'}.`;

  const payload = {
    kernel: 'keyboardInput',
    hypothesis: 'H-01',
    seed: SEED,
    keyCount: KEY_COUNT,
    checksumOk: sameFull && sameO1,
    protocol: { rounds: ROUNDS, order: 'counterbalanced, rotating per round', floorPct: FLOOR_PCT },
    allocation: {
      perOldSync: allocsPerOldSync,
      note: 'Object.entries allocates 1 outer array + 1 pair array per key, per key event',
    },
    cases: {
      'keyEvents.preFix': { opsPerSec: medPre, runs: runs.preFix },
      'keyEvents.shippedFull': { opsPerSec: medFull, runs: runs.shippedFull },
      'keyEvents.shippedO1': { opsPerSec: medO1, runs: runs.shippedO1 },
    },
    cacheGainPct: Number(cachePct.toFixed(2)),
    o1GainPct: Number(o1Pct.toFixed(2)),
    totalGainPct: Number(totalPct.toFixed(2)),
    cacheRoundsAgree: cacheAgree,
    o1RoundsAgree: o1Agree,
    verdict,
    scope:
      'event path, not per-frame; the CPU trace does not name it. No product number without a sitting.',
  };

  console.log(`keyboardInput  pre-fix       ${Math.round(medPre).toLocaleString()} keyEvents/s`);
  console.log(`               cached full  ${Math.round(medFull).toLocaleString()} keyEvents/s   (+${cachePct.toFixed(0)} %, ${wins.cache}/${ROUNDS})`);
  console.log(`               O(1) fast    ${Math.round(medO1).toLocaleString()} keyEvents/s   (+${o1Pct.toFixed(0)} %, ${wins.o1}/${ROUNDS})`);
  console.log(`               total        +${totalPct.toFixed(0)} %   allocations saved per key event: ${allocsPerOldSync}`);
  console.log(`               verdict: ${verdict}`);

  writeReport(args.output ? String(args.output) : path.join(REPORT_DIR, 'kernel.json'), payload);
}

if (isCli(import.meta.url)) {
  main();
}