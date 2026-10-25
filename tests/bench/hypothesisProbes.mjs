/**
 * Hypothesis -> the load key that proves the intended path actually ran.
 *
 * WHY THIS EXISTS. `sceneLiveness.mjs` checks that *a* key is non-zero and that
 * *some* key scales. Both are necessary and neither is sufficient, and
 * `spritePackStressScene` demonstrated the gap six times:
 *
 *   v1  renderVisible = 0            VISIBLE 0        caught by liveness
 *   v2  setSprite never called       VISIBLE 0        caught by liveness
 *   v3  random scatter, 16k^2 world  VISIBLE 734      NOT caught - non-zero, plausible
 *   v4  spacing shrank with N        VISIBLE 11139    NOT caught - non-zero, plausible
 *   v5  world set inside create()    VISIBLE 1        caught by liveness
 *   v6  duplicate WORLD_W            crashed          caught loudly
 *
 * v3 and v4 are the dangerous ones. They produced a **non-zero key that looked
 * entirely reasonable** and a `STEP_MS` in a plausible band. Nothing in the
 * output distinguishes "measured the pack path" from "measured a self-cancelling
 * subset of it".
 *
 * The fix is a shape change: the check must be told, per hypothesis, **which key
 * proves that hypothesis's code path ran**, rather than accepting any key that
 * moved. A worker-kind table is the wrong shape, because "renderer" being alive
 * says nothing about whether the hypothesis's function is the one running.
 *
 * A hypothesis registers the key it needs and what population it expects; the
 * runner refuses a verdict when that specific key is short.
 */

/**
 * @typedef {object} HypothesisProbe
 * @property {string} id           hypothesis id, e.g. 'H-02'
 * @property {string} worker       worker kind the verdict belongs to
 * @property {string} key          the load key that proves the path ran
 * @property {number} [expected]   population the scene was asked to run
 * @property {number} [floor]      minimum acceptable share of `expected`
 * @property {string} [why]        what this key proves, for the failure message
 */

/**
 * The probes for every hypothesis that has been taken to a scene. Registered
 * rather than derived, because the whole point is that the mapping cannot be
 * guessed from the worker kind.
 *
 * `key` is deliberately a load key and not a timing. `VISIBLE_ENTITIES` for H-02
 * because the hypothesis is about packing visible sprites - if that count does
 * not scale with the requested population, the pack loop is not being measured
 * no matter what `STEP_MS` says.
 */
export const PROBES = {
  'H-02': {
    id: 'H-02',
    // preRender, NOT renderer. `packSpriteLayer` is called from TWO workers -
    // pixiWorker.js:1473 and preRenderWorker.js:3041 - and `spritePackStressScene`
    // packs in preRender: measured SPRITE_PACK_MS 1.360 against a renderer
    // QUEUE_MS of 0.012 for the same 45 568 queued sprites. A probe naming
    // `renderer` would have passed on a worker doing no packing at all, which is
    // the precise failure this table exists to prevent.
    worker: 'preRender',
    // RENDER_QUEUE_SIZE, not VISIBLE_ENTITIES. The queue is what gets packed;
    // VISIBLE_ENTITIES is the collect result upstream of it. Measured equal here
    // (21 340 / 41 984 / 45 568) but equal-by-coincidence is not a reason to probe
    // the upstream key.
    key: 'RENDER_QUEUE_SIZE',
    floor: 0.5,
    // The sub-timer the change actually lives in.
    //
    // Without this the verdict is computed on preRender_STEP_MS, which sums
    // collect + emit + sort + pack. EMIT_MS is bimodal - it alternates between a
    // full emit and a pose-only persistence shortcut, a ~1.3 ms swing on an 8 ms
    // base - and at n=4 that term alone produced a REGRESSION verdict on a change
    // whose own sub-timer moved +3.3 % in 2 of 4 pairs.
    metric: 'SPRITE_PACK_MS',
    why: 'the pack (gpuPack.wasm; packInstancedRows before E-76 W9) packs the queued rows (gatherInstancedRows, which H-02 measured, never ran in a frame: E-21); if the queue is short of the population, the pack path is not what is being timed',
  },

  'H-14': {
    id: 'H-14',
    worker: 'logic',
    key: 'ENTITIES_PROCESSED',
    floor: 0.5,
    why: '_processSpawnSoA runs on the spawn path; if entities processed is short, the spawn list is not being exercised',
  },

  'H-10': {
    id: 'H-10',
    worker: 'particle',
    // ACTIVE_DECORATIONS, the key the particle worker actually publishes - not
    // DECORATIONS_ACTIVE, which I wrote from the sound of it. Measured equal to
    // the request on every row of the corrected sweep (5 000/20 000/40 000/65 000),
    // so a probe on the wrong name would have failed every valid run with
    // PATH_NOT_RUN and taught me to distrust the check.
    key: 'ACTIVE_DECORATIONS',
    floor: 0.5,
    why: 'sway runs per swaying decoration; without a live population the pool-bounded cost is not what is being measured',
  },

  'H-19': {
    id: 'H-19',
    worker: 'preRender',
    key: 'RENDER_QUEUE_SIZE',
    floor: 0.5,
    // The hoist is in collectVisibleEntities, so COLLECT_MS is the attributable
    // number. On STEP_MS the verdict came back -12.59 % while the loop itself
    // moved -6.7 %: roughly half the headline was EMIT_MS noise.
    metric: 'COLLECT_MS',
    why: 'collectVisibleEntities fills the render queue; if the queue is short of the population, the collect loop is not what is being timed',
  },

  'H-13': {
    id: 'H-13',
    worker: 'renderer',
    key: 'DECAL_TILES_DIRTY',
    floor: 0.0,
    why: 'H-13 is about the tile sweep, which runs regardless of dirty count - this key only proves the path is reached',
  },

  // Not collectable yet: audio slots are in SoundManager's metrics, which the
  // bench report does not carry, so H-12 refuses with KEY_NOT_PUBLISHED.
  'H-12': {
    id: 'H-12',
    worker: 'renderer',
    key: 'ACTIVE_AUDIO_SLOTS',
    floor: 0.5,
    why: 'the audio mixer work is per active slot; an empty pool does not exercise it',
  },
};

/**
 * Check one hypothesis's probe against the stats its worker reported.
 *
 * @param {string} id            hypothesis id
 * @param {object} stats         parsed worker stats (see sceneLiveness.readStats)
 * @param {number} [expected]    population the scene was asked to run
 * @returns {{ok: boolean, code: string, detail: string}}
 */
export function checkProbe(id, stats, expected) {
  const probe = PROBES[id];
  if (!probe) {
    // Unknown hypothesis: refusing is right. A hypothesis with no probe cannot
    // be shown to have measured its own path, and the previous behaviour was to
    // accept it silently.
    return {
      ok: false,
      code: 'NO_PROBE',
      detail:
        `no probe registered for ${id}, so nothing has established that this ` +
        "hypothesis's code path is the one being measured. Register one in " +
        'tests/bench/hypothesisProbes.mjs before sitting it.',
    };
  }

  const s = stats || {};
  // Review D3. A key the stats do not carry says nothing about the path: H-12's
  // ACTIVE_AUDIO_SLOTS was never collected, so every H-12 sitting was refused as
  // "the code did not run". Still a refusal, now with the real reason.
  if (!(probe.key in s)) {
    return {
      ok: false,
      code: 'KEY_NOT_PUBLISHED',
      detail:
        `${probe.key} is not in the stats this run collected, so nothing shows whether ` +
        `${id}'s path ran. Collect it (the ${probe.worker} worker's report) before sitting ${id}.`,
    };
  }
  const value = Number(s[probe.key]) || 0;

  // `floor: 0` means the key is NOT a proof of liveness for this hypothesis.
  //
  // H-13 is the case that forces this: its subject is the per-frame sweep over
  // decal tiles, which runs whether or not anything is dirty, so its key is
  // legitimately zero in a healthy run. Demanding a non-zero value there would
  // refuse the very run that proves the sweep happens.
  //
  // The cost of that is real and is recorded rather than hidden: a floor-0 probe
  // cannot establish anything on its own. It proves the worker is publishing the
  // key, and no more. Any hypothesis relying on one needs its own evidence.
  if (value <= 0 && probe.floor > 0) {
    return {
      ok: false,
      code: 'PATH_NOT_RUN',
      detail:
        `${probe.key} is ${value} for ${id}; ${probe.why}. The hypothesis's code did not run, ` +
        'so any verdict taken from it measures something else.',
    };
  }

  const want = expected ?? probe.expected;
  if (want && want > 0) {
    const share = value / want;
    if (share < probe.floor) {
      return {
        ok: false,
        code: 'PATH_UNDERFED',
        detail:
          `${probe.key} is ${value} against a requested ${want} (${(share * 100).toFixed(1)}% < ` +
          `${(probe.floor * 100).toFixed(0)}% floor) for ${id}; ${probe.why}.`,
      };
    }
  }

  return {
    ok: true,
    code: 'OK',
    weak: probe.floor === 0,
    // Carried through so the gate can compute an attributed verdict on the
    // sub-timer this change actually lives in, instead of only on STEP_MS.
    metric: probe.metric ?? null,
    detail:
      `${id}: ${probe.key} = ${value}${want ? ` of ${want} requested` : ''}` +
      (probe.floor === 0
        ? ' - WEAK PROBE: this key cannot establish that the path ran (floor 0). ' +
          'It only shows the worker publishes the key. This hypothesis needs its own evidence.'
        : ''),
  };
}

export default checkProbe;