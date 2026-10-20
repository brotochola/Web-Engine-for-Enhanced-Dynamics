// E-29: the two pre-render phases that published no stat.
//
// `_collectVisibleLights` and `_collectStampLights` ran every frame and reported
// nothing. E-08 lived inside one of them for the life of this engine without that
// being knowable from a trace: no `*_MS` stat meant no row, meant no candidate
// primary, meant no sitting.
//
// These tests exist because adding a timer is three ways to be wrong, and two of
// them are silent:
//
//   1. Add the stat slot but never the write -- it publishes a permanent 0 and looks
//      exactly like a phase that is genuinely free. This is the ADOBE_MS bug, and
//      WAIT_MS before it.
//   2. Time the phase but put it in a slot that the debug panel already used, or
//      renumber the stride and miss one -- every other pre-render stat shifts meaning
//      silently. ADOBE_MS: 15 is adjacent to VISIBILITY_MS: 14 and nothing checks that
//      the two stayed in their own order.
//   3. Report two timers that overlap, and let a reader add them. STAMP_LIGHTS_MS sits
//      INSIDE the SHADOW_Q_MS window, so a table listing both and no note invites
//      double-counting the shadow phase.
//
// The substantive one is (3), because the first two are caught by a row being zero and
// this one is caught by nothing: a double-counted number still looks like a real number.
//
// E-29 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const worker = 'src/workers/preRenderWorker.js';
const utils = 'src/util/workersUtils.js';

/**
 * The comment block immediately ABOVE `anchor` in `src`.
 *
 * Schema docs are JSDoc above the key, so any assertion about them has to look
 * backwards from the key, not forwards from it. Searching forward finds unrelated
 * later text and passes for the wrong reason - which is exactly how the first
 * version of this file "verified" a schema note that was never written.
 *
 * Walks back over the whole CONTIGUOUS run of comment lines. Taking only the last
 * `//` before the anchor is the obvious shortcut and it is wrong: for a four-line
 * note it returns one line, so an assertion about line 2 fails against a comment
 * that is present and correct.
 */
function docAbove(src, anchor) {
  const at = src.indexOf(anchor);
  assert.ok(at > 0, `anchor not found: ${anchor}`);
  const lines = src.slice(0, at).split('\n');
  // `at` is the start of the anchor, so the slice ends mid-line with just the
  // indentation before it. That whitespace-only tail is not a comment line, and
  // treating it as one ends the walk before it starts.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const collected = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('//')) {
      collected.unshift(t);
      continue;
    }
    // A JSDoc block ends with */ on its own line; walk back to its opener.
    if (t === '*/' || t.startsWith('*/')) {
      for (let j = i; j >= 0; j--) {
        collected.unshift(lines[j].trim());
        if (lines[j].trim().startsWith('/**')) break;
      }
      break;
    }
    break;
  }
  return collected.join('\n');
}

// ---------------------------------------------------------------------------
// 1. The stat slots exist, are unique, and do not collide
// ---------------------------------------------------------------------------

test('the two new stat slots exist and the stride accounts for them', async () => {
  const { PRE_RENDER_STATS: S } = await import('../../src/util/workersUtils.js');
  assert.equal(S.VISIBLE_LIGHTS_MS, 19);
  assert.equal(S.STAMP_LIGHTS_MS, 20);
  // 0..20 is 21 slots. If STRIDE_FLOATS lags, a worker writes past its own buffer and
  // the next worker's first stat is corrupted -- silently, and only on multi-worker
  // scenes.
  assert.equal(S.STRIDE_FLOATS, 21);
  assert.equal(S.BUFFER_SIZE_PER_WORKER, 21 * 4);
  assert.equal(S.BUFFER_SIZE, 21 * 4);
});

test('every stat slot is distinct and below the stride', async () => {
  const { PRE_RENDER_STATS: S } = await import('../../src/util/workersUtils.js');
  // The three derived names are numbers but not slots. Filtering by shape alone lets
  // STRIDE_FLOATS count itself and fail the bound check it exists to enforce.
  const DERIVED = new Set(['STRIDE_FLOATS', 'BUFFER_SIZE_PER_WORKER', 'BUFFER_SIZE']);
  const slots = Object.entries(S).filter(([k]) => !DERIVED.has(k) && /^[A-Z][A-Z0-9_]*$/.test(k) && typeof S[k] === 'number');
  const seen = new Map();
  for (const [k, v] of slots) {
    assert.ok(Number.isInteger(v), `${k} = ${v} is not an integer slot`);
    assert.ok(v >= 0 && v < S.STRIDE_FLOATS, `${k} = ${v} is outside the ${S.STRIDE_FLOATS}-slot stride`);
    assert.ok(!seen.has(v), `${k} and ${seen.get(v)} both claim slot ${v}`);
    seen.set(v, k);
  }
  // The stride must be exactly the number of slots, not a lower number that merely
  // happens to fit. This is the check ADOBE_MS would have failed.
  assert.equal(seen.size, S.STRIDE_FLOATS, `stride is ${S.STRIDE_FLOATS} but ${seen.size} slots are used`);
});

test('no other pre-render stat moved when the two slots were added', async () => {
  // The renumbering hazard. Every pre-existing slot must keep the index it had, or a
  // saved sitting's sub-timer means something different today than it did then.
  const { PRE_RENDER_STATS: S } = await import('../../src/util/workersUtils.js');
  const expected = {
    FPS: 0, VISIBLE_ENTITIES: 1, VISIBLE_PARTICLES: 2, VISIBLE_DECORATIONS: 3,
    SHADOWS_UPDATED: 4, RENDER_QUEUE_SIZE: 5, MSG_MS: 6, SKIPPED_FRAMES: 7,
    STEP_MS: 8, COLLECT_MS: 9, SORT_MS: 10, EMIT_MS: 11, CUSTOM_LAYER_MS: 12,
    SHADOW_Q_MS: 13, VISIBILITY_MS: 14, ADOBE_MS: 15, WAIT_MS: 16,
    SPRITE_PACK_MS: 17, IDLE_MS: 18,
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(S[k], v, `${k} moved from slot ${v} to ${S[k]}`);
  }
});

// ---------------------------------------------------------------------------
// 2. The phases are actually timed, and actually published
// ---------------------------------------------------------------------------

test('both phases are timed and gated on collectDetailedStats', () => {
  const src = code(worker);
  // Comments are stripped: the E-29 notes quote the very code the test looks for.
  const vis = src.slice(src.indexOf('collectVisibleLights();'), src.indexOf('packSpriteAndShadowQueues();'));
  assert.ok(vis.length > 0, 'could not find the collectVisibleLights call site');
  assert.match(vis, /performance\.now\(\)/, 'collectVisibleLights is not timed');
  assert.match(vis, /visibleLightsTimeThisFrame/, 'collectVisibleLights does not store its time');
  assert.match(vis, /collectDetailedStats/, 'collectVisibleLights is not gated on collectDetailedStats');

  const stamp = src.slice(src.indexOf('_stampAgainstSun(dst'), src.indexOf('const lights = this._stampLights;'));
  assert.ok(stamp.length > 0, 'could not find the _collectStampLights call site');
  assert.match(stamp, /performance\.now\(\)/, '_collectStampLights is not timed');
  assert.match(stamp, /stampLightsTimeThisFrame/, '_collectStampLights does not store its time');
  assert.match(stamp, /collectDetailedStats/, '_collectStampLights is not gated on collectDetailedStats');
});

test('both timers are published under collectDetailedStats', () => {
  // The ADOBE_MS failure mode: the field is computed and never written, so the stat is
  // a permanent 0 that looks like a free phase. Publishing is what makes the timer real.
  const src = code(worker);
  const report = src.slice(src.indexOf('reportFPS()'));
  assert.match(report, /stats\[PRE_RENDER_STATS\.VISIBLE_LIGHTS_MS\] = this\.visibleLightsTimeThisFrame/);
  assert.match(report, /stats\[PRE_RENDER_STATS\.STAMP_LIGHTS_MS\] = this\.stampLightsTimeThisFrame/);
  // And both must be after the early `return` that gates detailed stats, so the
  // always-published block stays cheap. This mirrors the STEP_MS / IDLE_MS split.
  const gateAt = report.indexOf('if (!this.collectDetailedStats) return;');
  assert.ok(gateAt > 0, 'reportFPS no longer gates detailed stats');
  assert.ok(gateAt < report.indexOf('VISIBLE_LIGHTS_MS]'), 'VISIBLE_LIGHTS_MS is published outside the detailed gate');
  assert.ok(gateAt < report.indexOf('STAMP_LIGHTS_MS]'), 'STAMP_LIGHTS_MS is published outside the detailed gate');
});

test('both accumulators are reset every frame', () => {
  // A timer that is set but not reset reads the last frame that set it -- a phase that
  // runs on some frames and not others would report a stale positive number forever,
  // which is worse than reporting zero because it looks like work.
  const src = code(worker);
  for (const field of ['visibleLightsTimeThisFrame', 'stampLightsTimeThisFrame']) {
    const assignments = src.match(new RegExp(`this\\.${field}\\s*=\\s*0`, 'g')) || [];
    assert.ok(
      assignments.length >= 2,
      `${field} is only zeroed ${assignments.length}x; it needs a constructor init and a per-frame reset`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. The overlap, which is the one nothing else catches
// ---------------------------------------------------------------------------

test('STAMP_LIGHTS_MS is documented as contained in SHADOW_Q_MS, and it is', () => {
  // Verify the containment in the code, not just in the comment. `_collectStampLights`
  // is reached only from `_stampAgainstSun`, which is reached only from
  // `_packGpuShadows`, which is the body of the SHADOW_Q_MS window.
  const src = code(worker);
  const callSites = src.match(/_collectStampLights\(\)/g) || [];
  // One declaration plus exactly one call, and the call is inside _stampAgainstSun.
  assert.equal(callSites.length, 2, `expected a declaration and one call, found ${callSites.length}`);
  const callAt = src.indexOf('this._collectStampLights();');
  const fnAt = src.indexOf('_stampAgainstSun(dst');
  assert.ok(fnAt > 0 && fnAt < callAt, '_collectStampLights is called from somewhere other than _stampAgainstSun');

  // The window that claims to contain it.
  const pack = src.slice(src.indexOf('const tShadows = detail ? performance.now() : 0;'));
  assert.match(pack, /_packGpuShadows\(dst, q\)/, 'the SHADOW_Q_MS window no longer calls _packGpuShadows');
  assert.match(pack, /shadowQTimeThisFrame = performance\.now\(\) - tShadows/, 'the SHADOW_Q_MS window no longer closes');

  // And the warning has to exist in both places a reader would look: the schema and
  // the panel. A warning in only one of them is a warning that half the readers miss.
  //
  // The doc comment sits ABOVE the key, so the search has to look backwards. An
  // earlier version of this test searched forward and found the panel's "SUB-TIMER of
  // it" instead - a phrase that names no timer at all - and reported the schema as
  // undocumented while the schema was in fact the better of the two.
  const u = read(utils);
  assert.match(
    docAbove(u, 'STAMP_LIGHTS_MS'),
    /[Ss]ub-timer of SHADOW_Q_MS/,
    'the schema does not say STAMP_LIGHTS_MS is inside SHADOW_Q_MS',
  );
  // No slice first: the panel's comment is above its `{ key:`, so slicing from the
  // anchor would remove exactly the text being asserted.
  assert.match(
    docAbove(u, "{ key: 'STAMP_LIGHTS_MS'"),
    /SUB-TIMER of SHADOW_Q_MS/,
    'the debug panel does not say STAMP_LIGHTS_MS is inside SHADOW_Q_MS',
  );
});

test('VISIBLE_LIGHTS_MS is documented as a peer, not inside COLLECT_MS or VISIBILITY_MS', () => {
  // The other half of the finding. It runs after both windows close, so it belongs to
  // neither -- and if someone later "tidies" it into COLLECT_MS, the containment has to
  // be checked rather than assumed.
  const src = code(worker);
  const update = src.slice(src.indexOf('collectVisibleParticles();'), src.indexOf('this.publishFrame();'));
  const collectClose = update.indexOf('collectTimeThisFrame = performance.now() - started;');
  const callAt = update.indexOf('this.collectVisibleLights();');
  const visOpen = update.indexOf('buildVisibilityPolygons();');
  assert.ok(collectClose > 0 && callAt > collectClose, 'collectVisibleLights is now inside the COLLECT_MS window');
  assert.ok(visOpen > callAt, 'collectVisibleLights is now inside the VISIBILITY_MS window');
  // The point of E-29: that gap used to belong to no stat.
  const u = read(utils);
  assert.match(
    docAbove(u, 'VISIBLE_LIGHTS_MS'),
    /between COLLECT_MS/,
    'the schema does not say where VISIBLE_LIGHTS_MS sits',
  );
});

// ---------------------------------------------------------------------------
// 4. The timer can be named as a primary, or it is still invisible
// ---------------------------------------------------------------------------

test('both timers are reachable by the A/B harness as a metric', () => {
  // The whole point of E-29. A timer nobody can select is not instrumentation, it is
  // a number in a buffer.
  const abab = read('tests/bench/runPredatorAbab.mjs');
  assert.match(abab, /'VISIBLE_LIGHTS_MS'/, 'the A/B runner cannot resolve VISIBLE_LIGHTS_MS as a metric');
  assert.match(abab, /'STAMP_LIGHTS_MS'/, 'the A/B runner cannot resolve STAMP_LIGHTS_MS as a metric');
  const ml = read('tests/bench/measureLib.mjs');
  assert.match(ml, /VISIBLE_LIGHTS_MS: preRender\.VISIBLE_LIGHTS_MS/, 'measureLib does not collect VISIBLE_LIGHTS_MS');
  assert.match(ml, /STAMP_LIGHTS_MS: preRender\.STAMP_LIGHTS_MS/, 'measureLib does not collect STAMP_LIGHTS_MS');
});

test('the debug panel shows both, with labels that do not imply a sum', () => {
  const u = code(utils);
  assert.match(u, /\{ key: 'VISIBLE_LIGHTS_MS', label: 'VisLights'/, 'no panel row for VISIBLE_LIGHTS_MS');
  assert.match(u, /\{ key: 'STAMP_LIGHTS_MS', label: 'StampLights'/, 'no panel row for STAMP_LIGHTS_MS');
  // Neither may be a COUNT row, or the panel formats a millisecond value as a
  // count. VISIBLE_LIGHTS_MS is a peer of the other phases (TIME). STAMP_LIGHTS_MS
  // sits inside SHADOW_Q_MS (point 3 above), so it is NESTED: as TIME the
  // panel's Rest subtracted it twice (review M3).
  const kindOf = (k) => {
    const row = u.slice(u.indexOf(`{ key: '${k}'`));
    return /STAT_KIND\.(\w+)/.exec(row.slice(0, 120))?.[1];
  };
  assert.equal(kindOf('VISIBLE_LIGHTS_MS'), 'TIME');
  assert.equal(kindOf('STAMP_LIGHTS_MS'), 'NESTED');
});