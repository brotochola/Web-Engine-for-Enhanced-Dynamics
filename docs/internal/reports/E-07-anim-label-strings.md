# E-07 — 20 000 strings a frame: real allocation, no measurable cost

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: NEUTRAL. Kept as hygiene, not a speed keep.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-07.

## Hypothesis, in one sentence

`emitSpriteQueue` builds four template-literal strings per queued row per frame —
`particle:${pAnimIdx}`, `liquidFun:…`, `decoration:…`, `bullet:…` — and passes them
into `_resolveAnimFrameStart`, which reads them **only inside its two warning
branches**; so the worker builds ~20 000 strings per frame in Predator to describe a
condition that is essentially never true.

## What was true

Four unconditional per-row string builds, at the hottest loop in the engine
(`emitSpriteQueue`, 19.9 % of pre-render):

```js
: this._resolveAnimFrameStart(pAnimIdx, `particle:${pAnimIdx}`);
rqTextureId[out] = this._resolveAnimFrameStart(dAnimIdx, `decoration:${dAnimIdx}`);
```

And the receiver:

```js
_resolveAnimFrameStart(animIdx, label) {
    if (animIdx === undefined || animIdx === null || animIdx < 0) {
        this._warnMissingTexture(`anim:${label}`, …);   // label used HERE only
        return INVALID_TEXTURE_ID;
    }
    const start = this.animationFrameStart?.[animIdx];
    if (start === undefined || start === null) {
        this._warnMissingTexture(`frameStart:${label}:${animIdx}`, …);  // and HERE
        return INVALID_TEXTURE_ID;
    }
    return start | 0;                                   // hot path: label unused
}
```

The sitting confirms the regime was right, which matters more than usual given what
came before: **`ACTIVE_DECORATIONS` is 20 000 on both sides**, so the labels really
were being built 20 000 times a frame.

## What was changed

A frozen numeric tag table (`ANIM_LABEL_TAG` / `ANIM_LABEL_NAMES`) and a
`formatAnimLabel` that is only called inside the two warn branches. The four call
sites pass a tag; the name-based caller at `:422` still passes a string and is not in
the per-row path.

It also fixed a duplicated index in the warning **key**: the old form rendered
`frameStart:particle:123:123`.

## The sitting

Predator ABAB, 4 counterbalanced pairs, 10 s / 10 s, detailed stats off,
`--owner preRender`, A = the reverted file, B = the tree.

| worker | A | B | paired | worse | cv |
| --- | --- | --- | --- | --- | --- |
| **preRender** (owner) | 6.855 ms | 6.797 ms | **+1.3 %** | 2/4 | 5 % / 5 % |
| logic | 4.023 | 3.846 | −0.7 % | 2/4 | 5 % / 10 % |
| spatial | 5.554 | 5.546 | +0.0 % | 2/4 | 5 % / 4 % |
| renderer | 3.736 | 3.733 | −0.5 % | 2/4 | 9 % / 3 % |
| physics | 6.913 | 6.738 | +3.7 % | 3/4 | 11 % / 9 % |
| particle | 1.173 | 1.174 | — | below the 3 ms floor, not judged |

Load closed on every gating key: `BODY_COUNT` +0.1 %, `GPU_CASTERS` −0.8 %,
`GPU_SHADOW_LIGHTS` 0.0 %, `VISIBLE_ENTITIES` −0.8 %, `ENTITIES_PROCESSED` +0.1 %.

**Verdict: NEUTRAL.** The owner moved +1.3 % with 2 of 4 pairs worse — a coin flip,
in the wrong direction, and well inside the noise this harness shows on identical code
(the 2026-09-30 A/A control moved logic 6 %).

`physics +3.7 %` is reported as **not blocking** because the physics host does not run
`emitSpriteQueue`. It is worth naming that this is exactly the hole proposal P-1 in
the math-allocation audit describes: a bystander worker at +3.7 % on 3/4 pairs is
the kind of thing that "does not cross the runner's regression rule" lets through, and
in this sitting it is almost certainly contention noise — but the protocol cannot
distinguish those two, only a repeat can.

## What the number means

**20 000 strings per frame, removed, and the worker did not move.** At 60 Hz that is
1.2 M string builds a second, which V8's young generation absorbs without a scavenge
being visible in the step.

This is the **fourth** hypothesis in this campaign whose premise was about memory and
whose cost was not there:

| | the claim | measured |
| --- | --- | --- |
| E-02 | a strided pass over 34 MB | 1.09 µs — 0.016 % of the worker |
| E-10 | the pair key is a boxed double | 0 boxed keys |
| E-03 | 24 allocations per frame are worth removing | escape analysis already removes them; forcing it costs −15.7 % |
| **E-07** | **20 000 allocations per frame are worth removing** | **+1.3 % — indistinguishable** |

The pattern is now firm enough to state as a rule rather than an observation, and it
is **not** "allocations are cheap":

> **In this engine, allocation *count* has never once been the cost. What has cost
> is reallocation of something large, a wrong memory-order assumption, or a
> representation change that defeats escape analysis.**

The one allocation hypothesis that paid (E-08) was not about count either — it was a
`.length` assignment that **reallocated a backing store every frame**, in a phase with
no timer. That is consistent with the rule, not an exception to it.

## What is kept

The code. Not as a speed win — the sitting says it is not one — but because:

1. it removes work whose cost is *invisible in this engine but not necessarily in
   every engine configuration* (a scene with far more decorations, or a different
   GC setting);
2. it makes `_resolveAnimFrameStart` say what it means: the fast path takes a tag and
   builds nothing;
3. it fixed a duplicated index in a warning key.

Recorded as **hygiene, explicitly not a speed keep**, per the protocol: no primary
worker regressed ≥ 3 %.

## Correctness

`tests/node/animLabelNoPerRowString.test.js`, 9 tests. The checksum is the warning
text itself, because this is a **diagnostics** path — the day it matters is the day
somebody is debugging a missing texture, and the label is their only clue:

- every tag round-trips to **byte-identical** output against the four old templates,
  across 6 index values;
- `null` / `undefined` / `-1` render exactly as template coercion did;
- a literal string kind still passes through for the name-based caller;
- no per-row call site builds a template string again (4 separate regexes);
- the label is built only as the first statement of a guard;
- the success path builds nothing — asserted structurally, because **there is no
  contiguous "success path" slice**: the second warn branch sits between the
  `animationFrameStart` read and the final return.

**Suite: 1084/1084 pass.**

### Four false positives in this test file, all instructive

Every one was a test bug that would have quietly disarmed the file:

1. `extractConst` searched for `});` and returned an **empty slice** for the one-line
   array form → `ANIM_LABEL_NAMES is not defined`.
2. `extractFn` sliced from the first `{` and **dropped the parameter list**, so
   `kind` was undefined inside the extracted copy.
3. The call-site regex also matched **the function definition**, reporting "expected
   4, found 5".
4. The success-path slice started at the `animationFrameStart` read and so **swept in
   the second warn branch**.

A fifth, in the *baseline verifier*, was the E-08 lesson repeating: the E-07 doc
comment quotes the old form verbatim, so a raw scan counted **the documentation as
code**. `verifyE07Baseline.mjs` now strips comments before asserting — which is now a
standing rule in this campaign: **strip comments, then assert.** A confident comment
quoting removed code is indistinguishable from that code to any regex.

## Cost

Four call sites, one frozen table, one small helper, one test file (9 tests), one
baseline verifier. ~150 lines including comments and tests. No API change, no config
key, no new branch on any hot line.

## What it adds

E-07 is the test that makes the campaign's rule safe to state. E-02, E-03 and E-10
were each *one* wrong intuition. Four in a row, all surviving a proper measurement,
is the difference between "be careful" and "here is the rule". Recorded as **E-30** in
the plan.