# Experimental report: `spatialWorker` optimization hypotheses (weed.js)

**Project:** `multithreadad-game-engine`  
**Working branch:** `exp/spatial-hyps`  
**Methodological source:** `morton_experiments` ([REPORT.md](file:///d:/xampp/htdocs/morton_experiments/REPORT.md), class `AdaptiveSpatial`)  
**Scenes:** `BallsScene`, `PredatorScene`  
**Runtime:** Chromium headed (Playwright), throttle mitigation on  
**Data:** `tests/results/spatial-hyps/campaign-summary.json`, `tests/results/spatial-hyps/confirm-summary.json`  
**Code under test:** [`src/workers/spatialWorker.js`](../../src/workers/spatialWorker.js) (restored to baseline when the campaign closed)

---

## 1. Executive summary

A set of **15 falsifiable hypotheses** (plus baseline) was written and measured, aimed at cutting the spatial worker's per-frame cost (`STEP_MS`, broken down as `REBUILD_MS` / `NEIGHBOR_MS`) on two different workloads:

| Scene | Regime | `cellSize` | Workers | Typical `visualRange` |
|--------|---------|-----------:|--------:|----------------------|
| Balls | dense, uniform, Box2D physics | 100 | 1 | ≈30–90 px |
| Predator | mixed, multi-worker, AI/lights | 128 | 3 | 0–700 px |

The main result, in line with the Morton REPORT (H5 Verlet / amortizing neighbor lists), is:

- **H3 (reuse with a Verlet-style margin, skin = 0.25·visualRange)** is **accepted** on the 5-run confirm: median of max `STEP_MS` **−70%** on Balls and **−45%** on Predator, with stable `BODY_COUNT` and a large rise in `NEIGHBORS_REUSED`.
- **H1 (honor `cellSleepingData`)** meets the metric threshold, but it is classified **conditional**: on Predator it collapses `NEIGHBOR_MS` and `BODY_COUNT` drifts slightly; it needs a correctness audit before merge.
- **H11 (Transform fallback for B's position across workers)** is **mixed**: accepted only on Balls (−5.7% confirmed); Predator does not reach −3%.
- Micro-optimizations (cell radius, sampled hash, dense cache, index pack, Morton reorder, `cellSize=96`, and the rest) are **rejected** as defaults under this protocol.
- A literal port of `AdaptiveSpatial` (hash Map / dense counting / a separate Verlet) was **not** implemented: weed.js's SAB grid + row partition is already dense; the transferable finding is **amortizing the all-neighbors phase**, not the on-demand router.

The source tree was restored to baseline; the patches lived in `tests/bench/spatial-hyps/hypPatches.mjs` (removed in `c40821ec`, with the harnesses below).

---

## 2. Research question and motivation

### 2.1 Question

> Which local changes to weed.js's `spatialWorker` reproducibly cut `STEP_MS` (and, on Predator, the maximum across workers) on Balls and Predator, without breaking load equivalence (`BODY_COUNT` ±5%), and which ideas from the Morton/`AdaptiveSpatial` bench translate to the SAB + row-ownership model?

### 2.2 Motivation

The Morton REPORT showed that, for the **allNeighbors** workload (analogous to "every entity looks up neighbors every tick"), **incremental linked-cell** and **Verlet lists** win; a full dense rebuild loses. Morton reorder and BVH did not pay. In weed.js the current path rebuilds owned rows every frame and reuses neighbors only on exact float equality plus a hash of cell versions — a regime hostile to reuse on moving Balls.

---

## 3. Conceptual frame

Let the spatial worker's cost per tick be:

\[
T_{\mathrm{step}} = T_{\mathrm{rebuild}} + T_{\mathrm{neighbor}}
\]

instrumented as `REBUILD_MS` and `NEIGHBOR_MS`. The primary bottleneck metric is:

- Balls: `STEP_MS` of the single worker `spatial0`
- Predator: the **maximum** `STEP_MS` across `spatial0..2` (latency of the worst worker); the sum is also reported

The existing reuse (`_canReuseNeighbors`) requires exact position identity; a Verlet-style margin lets `neighborData` be kept while the center's displacement is \(\le\) skin and the cell-dependency hash does not change.

---

## 4. Method

### 4.1 Design

Hypothetico-deductive: (1) falsifiable H1–H15; (2) headed 2-run screening; (3) promote if \(\Delta STEP\_MS \le -3\%\) and \(|\Delta BODY\_COUNT| \le 5\%\); (4) 5-run confirm, median+CV; (5) verdict.

### 4.2 Controls

| Factor | Value |
|--------|-------|
| Warmup / measure | 25 s / 18 s ([`benchmarkDefaults.mjs`](../../tests/bench/benchmarkDefaults.mjs)) |
| Mode | headed Chromium |
| Isolation | 1 hypothesis per run; restore from the baseline snapshot |
| Harness | `runSpatialHypCampaign.mjs`, `runSpatialHypConfirm.mjs` |

### 4.3 Hypotheses (short statement)

| ID | Statement | Change |
|----|-----------|--------|
| H1 | Skipping the rebuild of sleeping cells cuts `REBUILD_MS`/`STEP_MS` | Honor `Grid.cellSleepingData` |
| H2 | Rebuild movers only (incremental) beats a full scan | Consume `box2dMovedBodies` + a full rebuild every 8 frames |
| H3 | Verlet skin 0.25·vr raises reuse and cuts `NEIGHBOR_MS` | `_canReuseNeighbors` by distance |
| H4 | `cellRadius` without the `+1` overshoot touches fewer cells | strict ceil |
| H5 | A sampled dependency hash (stride 2) cheapens invalidation | `_computeDependencyHash` |
| H6 | A circle fast-path in the rebuild speeds Balls | Inline `SHAPE_CIRCLE` |
| H7 | A dense cache versus `Map` cuts alloc | Indexed array |
| H8 | Early skip when `visualRange==0` | Reorder the early-out |
| H9 | Lower Predator `maxNeighbors` 1024→512 | Scene config |
| H10 | Iterating actives by home-row avoids empty cells | Loop over `activeEntitiesData` |
| H11 | Transform fallback for B without a fresh `entityPos` | Inner neighbor loop |
| H12 | Bit-pack the index when `gridWidth` is a power of 2 | `<<` versus `*` |
| H13 | Stagger searches with vr≥300 | 1/2 frames |
| H14 | Morton reorder does **not** improve `STEP_MS` (falsification) | Sort actives every 8 frames |
| H15 | Static `cellSize=96` improves both | Scene config |

**Out of campaign (rejected up front):** top-down BVH, Morton XOR/MinMax as a broadphase, spatial hash `Map` (cellCount ≪ 2×10⁶ on both scenes).

---

## 5. Results

Times are **medians** of `statsSamplesAverage` over the measure window. `STEP` = `spatialStepMsMax`. Load% = `STEP / (1000/60) × 100`.

### 5.1 Screening (2 runs) — Balls

| ID | STEP_MS | Δ% vs BASE | REBUILD | NEIGHBOR | REUSED | BODY |
|----|--------:|----------:|--------:|---------:|-------:|-----:|
| BASE | 14.85 | — | 1.07 | 13.77 | 150 | 9004 |
| H1 | 12.21 | **−17.8** | 1.05 | 11.15 | 75 | 9004 |
| H2 | 14.79 | −0.4 | 1.10 | 13.69 | 82 | 9004 |
| H3 | 6.17 | **−58.5** | 1.16 | 5.00 | 7597 | 9004 |
| H4 | 15.72 | +5.9 | 0.98 | 14.73 | 3 | 9004 |
| H5 | 15.89 | +7.0 | 1.02 | 14.87 | 55 | 9004 |
| H6 | 15.61 | +5.2 | 0.87 | 14.74 | 89 | 9004 |
| H7 | 14.81 | −0.2 | 1.13 | 13.67 | 50 | 9004 |
| H8 | 15.79 | +6.3 | 1.03 | 14.75 | 142 | 9004 |
| H9 | 15.67 | +5.5 | 1.05 | 14.62 | 152 | 9004 |
| H10 | 14.75 | −0.6 | 0.86 | 13.89 | 136 | 9004 |
| H11 | 13.33 | **−10.2** | 0.99 | 12.34 | 39 | 9004 |
| H12 | 13.33 | **−10.2** | 1.00 | 12.33 | 20 | 9004 |
| H13 | 14.68 | −1.1 | 1.09 | 13.59 | 2 | 9004 |
| H14 | 15.21 | +2.4 | 2.03 | 13.17 | 73 | 9004 |
| H15 | 14.68 | −1.1 | 1.14 | 13.54 | 3 | 9004 |

### 5.2 Screening (2 runs) — Predator (`STEP` = max worker)

| ID | STEP_MS | Δ% vs BASE | REBUILD Σ | NEIGHBOR Σ | REUSED Σ | BODY |
|----|--------:|----------:|----------:|-----------:|---------:|-----:|
| BASE | 22.48 | — | 3.39 | 61.94 | 9292 | 16926 |
| H1 | 10.18 | **−54.7** | 4.36 | 24.21 | 8295 | 16178 |
| H2 | 27.81 | +23.7 | 3.41 | 78.30 | 5245 | 16979 |
| H3 | 17.66 | **−21.5** | 4.23 | 47.61 | 12112 | 16987 |
| H4 | 26.90 | +19.7 | 3.68 | 73.31 | 8990 | 17074 |
| H5 | 27.30 | +21.5 | 3.75 | 75.05 | 9250 | 17029 |
| H6 | 27.50 | +22.3 | 2.92 | 77.25 | 9042 | 17023 |
| H7 | 26.94 | +19.8 | 3.66 | 75.76 | 8536 | 17008 |
| H8 | 26.42 | +17.6 | 3.58 | 73.10 | 8707 | 16939 |
| H9 | 25.91 | +15.3 | 3.62 | 70.59 | 9036 | 17000 |
| H10 | 22.94 | +2.1 | 3.30 | 63.63 | 8874 | 16829 |
| H11 | 22.46 | −0.1 | 3.12 | 61.52 | 8655 | 16811 |
| H12 | 25.35 | +12.8 | 3.52 | 69.43 | 8742 | 16947 |
| H13 | 25.32 | +12.7 | 3.67 | 70.42 | 8746 | 16917 |
| H14 | 25.31 | +12.6 | 6.49 | 67.62 | 8621 | 16984 |
| H15 | 31.06 | +38.2 | 4.05 | 88.12 | 8412 | 16809 |

**Temporal-drift note:** from H4 on, Predator shows systematic regressions (~+15–20%) against the early BASE. That is why the confirm re-baselines in one contiguous block.

**H12:** on Balls/Predator `gridWidth` is not a power of 2 → the pack does not activate; the −10% screening on Balls is read as **noise / a confound**, and it was not confirmed.

### 5.3 Confirm (5 runs, median ± CV)

Confirm baseline (more conservative than the early Predator screening):

| Scene | STEP_MS med | CV | REBUILD Σ | NEIGHBOR Σ | REUSED Σ | BODY |
|--------|------------:|---:|----------:|-----------:|---------:|-----:|
| Balls | 15.35 | 6.5% | 1.36 | 13.87 | 38 | 9004 |
| Predator | 25.61 | 5.4% | 3.56 | 71.09 | 8815 | 16961 |

| Hyp | Scene | STEP_MS | Δ% | CV | REUSED | BODY | Δ BODY% | ≥3% and BODY OK? |
|-----|--------|--------:|---:|---:|-------:|-----:|--------:|:----------------|
| H1 | Balls | 13.06 | **−14.9** | 7.6% | 16 | 9004 | 0 | yes |
| H1 | Predator | 11.21 | **−56.2** | 11.6% | 8371 | 16510 | −2.7 | yes (metric) |
| H3 | Balls | 4.61 | **−69.9** | 6.1% | 8548 | 9004 | 0 | yes |
| H3 | Predator | 14.19 | **−44.6** | 20.0% | 12632 | 16898 | −0.4 | yes |
| H11 | Balls | 14.48 | **−5.7** | 1.3% | 53 | 9004 | 0 | yes |
| H11 | Predator | 24.97 | −2.5 | 4.1% | 8596 | 16891 | −0.4 | no |

---

## 6. Hypothesis analysis (verdicts)

| ID | Verdict | Justification |
|----|-----------|---------------|
| **H1** | **Conditional** | Clears the threshold on both scenes, but Predator cuts `NEIGHBOR_MS` ~63% and BODY drifts; risk of stale cells. Do not merge without a functional neighbor/AI test. |
| **H2** | **Rejected** | Balls neutral; Predator +24% on screening. Naive incremental (filter movers + periodic full) does not amortize multi-cell AABB + row ownership well. |
| **H3** | **Accepted** | Confirmed −70% / −45%; causal mechanism: `NEIGHBORS_REUSED` (Balls 38→8548). Aligned with REPORT H5 / Adaptive Verlet. |
| **H4** | **Rejected** | Higher STEP; worse reuse (Balls REUSED→3). The `+1` overshoot seems to protect quality/reuse. |
| **H5** | **Rejected** | No gain; a coarser invalidation that does not cheapen the bottleneck. |
| **H6** | **Rejected** | Balls `REBUILD` falls (~1.07→0.87) but `NEIGHBOR` dominates; STEP does not improve. |
| **H7** | **Rejected** | Neutral on Balls; Predator regression on screening (drift). |
| **H8** | **Rejected** | The early-out already existed; reordering does not help. |
| **H9** | **Rejected** | A cap of 512 does not cut STEP in a useful way. |
| **H10** | **Rejected** | Neutral (~±2%). |
| **H11** | **Mixed** | Accepted on Balls (−5.7% confirm); Predator not enough. |
| **H12** | **Rejected (no-op)** | Grid widths are not powers of 2; a screening false positive. |
| **H13** | **Rejected** | Staggering lights does not move the bottleneck (density/factions). |
| **H14** | **Rejected** (falsification OK) | Morton raises `REBUILD` (the sort); consistent with REPORT H3. |
| **H15** | **Rejected** | `cellSize=96` makes Predator worse (+38%); Balls neutral. Reinforces the earlier study (100/128 are local optima). |

---

## 7. Discussion

1. **The bottleneck is `NEIGHBOR_MS`, not the dense rebuild.** On Balls baseline, ~93% of the step is the search. That is why H6 (rebuild) and H2 (incremental rebuild) do not move the ranking, while H3 attacks the dominant phase.

2. **Transfer from Morton/`AdaptiveSpatial`.** The empirical winner of the allNeighbors workload (Verlet / amortization) translates here as **reuse with a skin**, not as a second structure. The Adaptive router (hash if cellCount>2e6) does not apply: Balls ≈2k cells, Predator ≈3k.

3. **Exact float equality is a reuse anti-pattern in moving simulations.** The *campaign* H3 only loosened the position equality and reused stale `neighborData` (without widening the radius or re-filtering) — fast, and semantically wrong. The integrated implementation (see §12) fixes that.

4. **H1 demands skepticism.** A −56% on Predator with a sharp drop in neighbors touched suggests omitted work, not only a skipped clear. `cellSleepingData` is written by the particle path; its meaning for logical/physical entities is not validated in this report.

5. **Drift across long hyps.** A contiguous confirm is necessary; comparing H15 screening against BASE screening underestimates machine/session noise.

6. **Multi-worker.** On Predator the max metric captures the straggler; H3 improves both the max and the sum of `NEIGHBOR_MS`.

---

## 8. Practical recommendations

| Situation | Action |
|-----------|--------|
| Engine default | **`neighborReuseSkin: 0.04`**, **`neighborReuseMaxFrames: 15`** (`SPATIAL_DEFAULTS`) |
| Predator / dense-fast flock | Scene override: **`0.01` / `30`** (best cell of the partial sweep) |
| Faster scenes / more FN risk | Lower the skin or `neighborReuseMaxFrames` |
| Sleeping cells (H1) | Do not merge; add neighbor tests + grid invariants before retrying |
| Incremental movedBodies (H2) | Redesign with a per-entity cell list; the campaign prototype is not enough |
| cellSize | Keep Balls **100**, Predator **128** |
| Morton reorder / BVH / hash Map | Not as a default (confirmed again) |

**Code status:** the *correct* Verlet H3 lives in [`src/workers/spatialWorker.js`](../../src/workers/spatialWorker.js) behind `neighborReuseSkin` (default **0.04**). The FN/FP oracle (`verifyNeighborSets`) was removed from the engine after FN=0/FP=0 was validated; see §12.

---

## 9. Limitations

- One machine / one headed session; no multi-host replicas.
- 2-run screening: high CV on some hyps; confirm only on the ones that were promoted.
- ~~H3 does not measure semantic quality~~ → validated historically with the oracle (§12); the oracle is no longer in the runtime.
- H1 does not include a visual/functional gate for Predator AI.
- Predator max `STEP` has CV 20% under H3 (confirm) — a wide band; the median is still clearly under baseline.
- The *campaign* H3 (skin only in `_canReuseNeighbors`, no candidate cache) is obsolete; do not re-run `applyHyp('H3')` from the old patcher.
- The skin×frames sweep (§12.5) is incomplete (it stopped at skin 0.25); the 0.01–0.2 band is complete.

---

## 10. Future work

- ~~Sweep of `skin` / `neighborReuseMaxFrames`~~ → partly done; optionally finish skins ≥0.35.
- A real incremental: occupancy lists + `movedBodies` + a measured periodic full rebuild.
- Combine Verlet skin + H11 and re-benchmark.
- A correct wire of `cellSleeping` with tests.

---

## 11. Reproducibility (H1–H15 campaign)

```bash
cd d:\xampp\htdocs\multithreadad-game-engine
git checkout exp/spatial-hyps

node tests/bench/runSpatialHypCampaign.mjs --dry-apply
node tests/bench/runSpatialHypCampaign.mjs --runs 2
node tests/bench/runSpatialHypConfirm.mjs
```

Artifacts: `tests/results/spatial-hyps/*.json`.

---

## 12. Semantic validation and default tuning (post-campaign)

### 12.1 Gap in the campaign H3

Reusing `neighborData` when A moves ≤ skin **without** widening the search or re-filtering produces FN/FP. `BODY_COUNT` does not detect that. The integrated implementation closes the gap (§12.2).

### 12.2 Integrated semantics

Published in `neighborData` every frame:

\[
B \in N(A) \iff \|P_B-P_A\|^2 < (vr_A + halfExtent_B)^2
\]

Implementation (`neighborReuseSkin > 0`):

1. Miss: search candidates with `searchRange = vr + 2·skin`
2. Always: filter candidates → `neighborData` at the current `vr`
3. Hit: A is inside the skin of the build, same vr/extent, age `< neighborReuseMaxFrames` (bounds B's drift)
4. `skin = 0`: no reuse (full rebuild every frame)

### 12.3 Historical oracle (removed from the engine)

FN=0 / FP=0 was validated with a brute-force oracle in the worker (`verifyNeighborSets`) and a dedicated probe scene. That scaffolding **is no longer part of the runtime** (not in defaults, not in FN/FP stats, not a gate). Historical results (headed, 2 runs):

| Phase | Variant | STEP_MS med | REUSED | FN | FP |
|------|----------|------------:|-------:|---:|---:|
| Correctness (oracle on) | skin 0 | 7.58 | 0 | **0** | **0** |
| Correctness (oracle on) | skin 0.25 | 5.10 | ~965 | **0** | **0** |
| Perf (oracle off) | skin 0 | **2.04** | 0 | — | — |
| Perf (oracle off) | skin 0.25 | **0.94** | ~960 | — | — |

Perf Δ STEP_MS ≈ **−53.7%** on that scene.

### 12.5 skin × frames sweep (partial)

Harness: `runNeighborReuseGrid.mjs`. Artifact: `tests/results/neighbor-reuse/skin-frames-grid.json` (stopped at `skin=0.25 frames=15` on Predator; skins **0–0.2** complete).

Baseline `skin=0`: Balls STEP_max **15.74 ms**, Predator **53.43 ms**.

Best cells observed (1 headed run, warmup 12s / measure 10s):

| Scene | Best cell | STEP_max | Δ vs skin0 |
|--------|-------------|----------:|-----------:|
| Balls | skin **0.05** / frames **20** | 7.48 | ≈ −52% |
| Predator | skin **0.01** / frames **30** | 18.27 | ≈ −66% |

**Ship:** global defaults **0.04 / 15** (between 0.01 and 0.05); Predator override **0.01 / 30**.

---

*Report written from the spatial_worker experimental campaign, the H3 semantic validation, and the partial skin×frames sweep. Absolute figures depend on the hardware and on system load; the verdicts are based on relative deltas under a fixed protocol.*
