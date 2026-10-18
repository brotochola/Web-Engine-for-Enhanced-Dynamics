# E-21 — `gatherInstancedRows` is dead in production, and a report claimed otherwise

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: documentation fixed (hygiene). No behaviour change.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-21.

## Finding

`gatherInstancedRows` (`src/render/gpuQueueLayout.js:83`) has **no caller anywhere in
`src/`**. A recursive scan of the tree returns only the definition and its own doc
comment. The only references in the entire repository are in `tests/node/*` and
`tests/bench/*`.

```powershell
Get-ChildItem src -Recurse -Filter *.js |
  Select-String -Pattern "gatherInstancedRows"
# -> gpuQueueLayout.js:73  (doc comment)
# -> gpuQueueLayout.js:83  (the definition)
```

## The live gather

The engine does gather SoA columns into interleaved instance floats every frame, just
through a different function — `packInstancedRows` (`gpuQueueLayout.js:244`), with a
larger signature. Its call sites:

| call site | what it packs |
| --- | --- |
| `instancedSpriteBatch.js:625` | the renderer's main sprite batch |
| `preRenderWorker.js:2907` | sun casters |
| `preRenderWorker.js:3052` | shadow cookies |
| `preRenderWorker.js:3094` | sprites |
| `preRenderWorker.js:3105` | glow |

## Why this is more than a tidiness note

The comment that stood on the dead function said:

> "`subarray` allocates a new TypedArray view per row… At the deepest spritePack
> setting that is one view per queued sprite — **45 568 allocations per frame**"

**True of that function. False of the engine.** And it did not stay in a code comment:

- it is quoted in **`docs/internal/DEVLOG.md`** ("the H-02 kernel… The allocation
  story was the reason to do it");
- it is quoted in **`MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md`** as the justification for
  H-02;
- H-02 is recorded in **`HYPOTHESIS_LOG.md`** as *kept (kernel)*.

So a measurement of a function that does not run was promoted, through three documents,
into an apparent engine-level finding. That is the failure mode worth naming: **a
kernel keep on a function with no production caller looks identical to every other
kernel keep in the log**, because nothing in the format asks whether the code runs.

Two facts independently falsified the story before this audit found the dead caller:

1. the same H-02 sitting counted **0 GC events on both sides**;
2. its gate verdict was **NEUTRAL** and `SPRITE_PACK_MS` was under the 3 ms floor.

Both were recorded, and the conclusion drawn was "the allocation story is dead" —
which was right, and still left the 45 568 figure standing as the reason the change was
made. The missing step was not a measurement. It was one `grep`.

## What was changed

The doc comment now states the function is dead in production, names the live gather
and its five call sites, and records the history — including that the allocation story
was already falsified by the sitting that produced it. It is **kept rather than
deleted**: it is exported, covered by `gatherInstancedRowsParity.test.js`, and it is
the natural place for a contiguous-range gather if a future backend needs one. Keeping
it with its history recorded is what stops the figure being re-cited.

## What this adds to the campaign

**E-25 gains a clause.** The practice "verify a claim against the tree before citing it"
was written for hypotheses. This is the same failure found in a *report* rather than in
code, and it is more dangerous, because a reported number carries more authority than
a comment — it is a measurement, and measurements are trusted.

The cheap gate is one command:

```powershell
Get-ChildItem src -Recurse -Filter *.js | Select-String -Pattern "<fnName>"
```

It should be part of gate 1 for any kernel whose function is exported but not obviously
called. A kernel whose subject has no production caller can still be worth having; it
just cannot be a claim about the engine, and the log should say so in the row rather
than leaving the reader to assume.

## Cost

One doc comment (~35 lines). No behaviour change, no API change, no test change.
`gatherInstancedRowsParity.test.js` continues to pass against the unchanged function.

## Reports affected

| report | what it claimed | correction |
| --- | --- | --- |
| `MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md` | H-02 motivated by "45 568 allocations per frame" | the loop is not on the frame path |
| `DEVLOG.md` (14 Oct) | same figure, as the reason for the change | as above |
| `HYPOTHESIS_LOG.md` H-02 row | *kept (kernel)* | still kept; it was never a product claim, and the stated reason was wrong |

None of the three is edited here. This campaign does not rewrite historical rows —
`HYPOTHESIS_LOG.md` §"Old rows are evidence" is explicit that a finding that looks
wrong is written up **as a new row pointing at it**, which is what this report is.