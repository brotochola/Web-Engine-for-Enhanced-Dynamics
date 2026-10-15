# Experimental report: sleep-neighborhood neighbor amortization

**Project:** `multithreadad-game-engine`  
**Follow-on to:** [`spatial_worker_hypothesis_report.md`](./spatial_worker_hypothesis_report.md) (H1–H15 campaign)  
**Scenes:** `BallsScene`, `PredatorScene`  
**Runtime:** Chromium headed (Playwright), background-throttle mitigation on  
**Baseline under test:** current [`src/workers/spatialWorker.js`](../src/workers/spatialWorker.js) with integrated Verlet reuse + `neighborTickInterval` freeze (not the older campaign baseline)  
**Data:** [`tests/results/sleep-neighbor-hyps/campaign-summary.json`](../tests/results/sleep-neighbor-hyps/campaign-summary.json), [`confirm-summary.json`](../tests/results/sleep-neighbor-hyps/confirm-summary.json)  
**Patches:** [`tests/bench/sleep-neighbor-hyps/sleepHypPatches.mjs`](../tests/bench/sleep-neighbor-hyps/sleepHypPatches.mjs) (tree restored to baseline after each campaign)

---

## 1. Executive summary

Box2D exposes per-body sleep on the WASM HEAP (`RigidBody.sleeping`). The particle worker aggregates that into per-cell flags (`Grid.cellSleepingData`). Until this campaign, **production spatial never read those flags**.

This campaign asked whether sleep information can safely amortize **neighbor refresh** (on top of Verlet + stagger), and whether the older **H1 grid-rebuild skip** still pays off on the new baseline.

| ID | Verdict | Headline |
|----|---------|----------|
| **S0** | Baseline | Confirm STEP max ≈ **7.3 ms** (Balls) / **5.9 ms** (Predator) — already much cheaper than the old H1–H15 baseline thanks to Verlet + stagger |
| **S1** | **Rejected (correctness)** | Large metric wins (Predator STEP **−47%**) but home-cell-only freeze is unsafe: awake bodies can enter visual range from other cells |
| **S2** | **Conditional / promising** | Neighborhood sleep freeze: Balls **−11%**, Predator **−18%** STEP; high `SLEEP_NEIGHBOR_SKIPS`; BODY stable. Needs neighbor-set / AI correctness tests before merge |
| **S3** | **Conditional** | Body sleep ∩ neighborhood: smaller wins (≈ **−11% / −12%**); stricter, safer predicate; still needs semantic tests |
| **S4** | **Rejected** | Re-filter-only on neighborhood sleep **regressed** (Predator STEP **+54%** screening) — extra pattern walk without enough savings |
| **S5** | **Rejected on current baseline** | Old H1 grid skip: Balls screening −8% but Predator only **−1.8%**; rebuild is no longer the bottleneck |
| **S6** | **Conditional** | S2+S5: best confirm numbers (Balls **−19%**, Predator **−29%**) but inherits S2 correctness risk **and** H1 stale-grid risk |

**Recommendation:** Do **not** merge yet. Prefer continuing with **S2 or S3** behind a feature flag only after a neighbor-list oracle / Predator AI smoke. Treat **S1** as a cautionary upper bound on how much sleep can “buy” if you freeze too aggressively. Do **not** revive H1-style rebuild skip (S5) as a default on the Verlet+stagger baseline.

---

## 2. Prior art (H1) — what this campaign is not

The earlier report’s **H1** skipped **grid rebuild** clear/re-insert for sleeping cells. It did **not** implement “if my visual neighborhood is asleep, neighbors stay the same.”

| | Prior H1 | This campaign |
|--|----------|----------------|
| Target phase | Mostly intended `REBUILD_MS` | Primarily `NEIGHBOR_MS` |
| Mechanism | Preserve cell membership for sleeping cells | Freeze or cheapen neighbor refresh from cell/body sleep |
| Prior verdict | Conditional — Predator STEP −56% but suspicious `NEIGHBOR_MS` collapse + BODY drift | Re-tested as **S5** on new baseline; Predator no longer promotes |

Context shift matters: old BASE Predator STEP was ~22 ms; **S0 today is ~6 ms**. Room for sleep wins is smaller, and any hyp must beat an already-amortized neighbor path.

---

## 3. Research question

> Given cell sleep flags derived from Box2D body sleep, can we safely freeze (or cheapen) neighbor refresh for entity A when its visual-range cell neighborhood is “asleep,” on top of Verlet + stagger, with reproducible `STEP_MS` / `NEIGHBOR_MS` gains and stable `BODY_COUNT`?

---

## 4. Correctness model (fixed before coding)

1. **Empty cells are marked awake (`0`).** Strict “every pattern cell == sleeping” almost never fires. Predicates use: **no occupied awake cell** in the visual-range pattern (empty = OK).
2. **Lag:** particle writes cell sleep after spatial consumes the grid (≥1 frame). Same risk class as prior H1.
3. **Sleep early-out order:** after home cell / `visualRange > 0`, **before** stagger/Verlet, so a dead island can skip even on-tick refresh.
4. **Instrumentation:** `SPATIAL_STATS.SLEEP_NEIGHBOR_SKIPS` counts entities that took the sleep early-out (avoids misreading a bare `NEIGHBOR_MS` collapse).

---

## 5. Hypotheses

| ID | Claim | Change |
|----|--------|--------|
| S0 | Baseline | Current spatial (Verlet + stagger); sleep counter stays 0 |
| S1 | Home cell sleeping ⇒ freeze `neighborData` | Weak correctness |
| S2 | Visual-range neighborhood asleep ⇒ freeze | User-intended hyp |
| S3 | `RigidBody.sleeping[A]` ∧ S2 neighborhood ⇒ freeze | Stricter |
| S4 | Neighborhood asleep ⇒ re-filter candidates only | Safer freshness, less win |
| S5 | Prior H1 rebuild skip only | Rebuild phase |
| S6 | S2 + S5 | Combined |

**Promotion (screening):** median \(\Delta STEP\_MS \le -3\%\) and \(|\Delta BODY\_COUNT| \le 5\%\), plus non-trivial `SLEEP_NEIGHBOR_SKIPS` (except S5).

---

## 6. Method

| Factor | Value |
|--------|-------|
| Warmup / measure | 25 s / 18 s ([`benchmarkDefaults.mjs`](../tests/bench/benchmarkDefaults.mjs)) |
| Mode | headed Chromium |
| Isolation | One hyp per apply; restore from snapshot baselines under `tests/bench/sleep-neighbor-hyps/` |
| Screening | 2 runs ([`runSleepNeighborCampaign.mjs`](../tests/bench/runSleepNeighborCampaign.mjs)) |
| Confirm | 5 runs median + CV for S0, S1, S2, S3, S6 ([`runSleepNeighborConfirm.mjs`](../tests/bench/runSleepNeighborConfirm.mjs)) |
| Primary metric | Balls: `spatial0` STEP; Predator: **max** STEP among spatial workers |
| Same-session S0 | All deltas vs S0 measured in the same campaign/confirm session |

---

## 7. Screening results (2-run medians)

`STEP` = spatial step max (ms). `SLEEP` = sum of `SLEEP_NEIGHBOR_SKIPS` across spatial workers.

### Balls

| ID | STEP | Δ% | NEIGHBOR sum | REBUILD sum | SLEEP | BODY | Promote? |
|----|-----:|---:|-------------:|------------:|------:|-----:|:---------|
| S0 | 7.05 | — | 5.92 | 1.13 | 0 | 9004 | — |
| S1 | 6.00 | **−14.9** | 4.85 | 1.15 | 1837 | 9004 | yes |
| S2 | 6.77 | **−4.1** | 5.55 | 1.21 | 1657 | 9004 | yes |
| S3 | 6.48 | **−8.1** | 5.30 | 1.17 | 2567 | 9004 | yes |
| S4 | 7.36 | +4.4 | 6.21 | 1.15 | 1610 | 9004 | no |
| S5 | 6.46 | **−8.4** | 5.28 | 1.17 | 0 | 9004 | yes* |
| S6 | 6.46 | **−8.5** | 5.26 | 1.19 | 1005 | 9004 | yes |

\*S5 promote rule allowed zero sleep skips (rebuild-only hyp).

### Predator

| ID | STEP | Δ% | NEIGHBOR sum | REBUILD sum | SLEEP | BODY | Awake | Promote? |
|----|-----:|---:|-------------:|------------:|------:|-----:|------:|:---------|
| S0 | 5.68 | — | 12.08 | 4.29 | 0 | 16859 | 6740 | — |
| S1 | 3.09 | **−45.6** | 4.68 | 4.39 | 12956 | 16728 | 7087 | yes |
| S2 | 4.65 | **−18.1** | 9.05 | 4.39 | 8693 | 16852 | 7203 | yes |
| S3 | 5.22 | **−8.1** | 10.72 | 4.37 | 5376 | 16776 | 7070 | yes |
| S4 | 8.75 | **+54.0** | 20.66 | 4.39 | 5896 | 16856 | 6885 | no |
| S5 | 5.58 | −1.8 | 11.88 | 4.21 | 0 | 16816 | 7987 | no |
| S6 | 4.33 | **−23.8** | 8.27 | 4.16 | 8624 | 16795 | 7766 | yes |

**Negative control note:** Balls still shows thousands of sleep skips despite Awake≈9000 because **static** occupants mark cells sleeping (floors/walls). That is expected under cell-sleep semantics, not a counter bug.

---

## 8. Confirmation results (5-run medians)

### Absolute

| ID | Scene | STEP med | STEP CV | NEIGHBOR | SLEEP | BODY | Awake |
|----|-------|---------:|--------:|---------:|------:|-----:|------:|
| S0 | Balls | 7.33 | 2.2% | 6.01 | 0 | 9004 | 9000 |
| S0 | Predator | 5.87 | 1.8% | 12.65 | 0 | 16817 | 7348 |
| S1 | Balls | 6.33 | 7.7% | 5.24 | 1312 | 9004 | 9000 |
| S1 | Predator | 3.12 | 5.3% | 4.98 | 12198 | 16778 | 7029 |
| S2 | Balls | 6.53 | 18.1% | 5.50 | 1388 | 9004 | 9000 |
| S2 | Predator | 4.83 | 3.8% | 9.54 | 8724 | 16824 | 6822 |
| S3 | Balls | 6.50 | 6.4% | 5.34 | 2868 | 9004 | 9000 |
| S3 | Predator | 5.16 | 1.7% | 10.83 | 4865 | 16786 | 7525 |
| S6 | Balls | 5.92 | 4.9% | 4.92 | 610 | 9004 | 9000 |
| S6 | Predator | 4.18 | 2.0% | 8.03 | 7845 | 16781 | 7721 |

### Deltas vs confirm S0

| ID | Balls STEP Δ% | Predator STEP Δ% | Balls NEIGHBOR Δ% | Predator NEIGHBOR Δ% | \|BODY Δ%\| max |
|----|--------------:|-----------------:|------------------:|---------------------:|----------------:|
| S1 | **−13.6** | **−46.8** | −12.8 | −60.6 | 0.23 |
| S2 | **−10.9** | **−17.6** | −8.5 | −24.6 | 0.04 |
| S3 | **−11.4** | **−12.1** | −11.1 | −14.4 | 0.18 |
| S6 | **−19.3** | **−28.8** | −18.1 | −36.5 | 0.21 |

---

## 9. Per-hypothesis analysis

### S1 — home-cell freeze — **Rejected (correctness)**

Metric upper bound is real and reproducible. Predicate is wrong for visual neighbors: an awake agent can cross into A’s range while A’s home cell remains a sleeping static/sleep cluster. Matches the plan’s a-priori rejection. Do not ship.

### S2 — neighborhood freeze — **Conditional**

Implements the intended claim. Predator confirm **−18%** STEP with ~8.7k sleep skips/frame and stable BODY. Balls win is smaller and noisier (CV 18% on STEP).  

**Open risks (same class as prior H1 skepticism):** one-frame cell-sleep lag; lights / large `visualRange` freezing while movers approach; no neighbor-set oracle in this campaign. Treat as the best candidate for a correctness follow-up, not a merge.

### S3 — body ∧ neighborhood — **Conditional**

Stricter gate → fewer skips than S2 on Predator (~4.9k vs ~8.7k) and smaller STEP win (~−12%). Preferable if shipping a conservative flag. Still needs semantic validation.

### S4 — re-filter only — **Rejected**

Screening: Predator STEP **+54%**, NEIGHBOR **+71%**. Walking the neighbor-cell pattern every frame to decide “asleep,” then still publishing, costs more than it saves when Verlet/stagger already amortize most work. Falsified.

### S5 — old H1 rebuild skip — **Rejected on current baseline**

Predator screening failed the −3% bar (−1.8%). Rebuild is a minority of S0 STEP (~4.3 of ~5.7 ms sum phases on Predator; neighbor still dominates). The spectacular prior H1 Predator win does **not** reproduce on the Verlet+stagger floor; that supports the earlier suspicion that old H1’s NEIGHBOR collapse was entangled with incomplete work, not pure rebuild savings.

### S6 — S2+S5 — **Conditional (do not merge)**

Best confirm deltas, but stacks two risky mechanisms. Only reconsider if S2 alone is proven correct **and** a separate grid invariant suite clears S5.

---

## 10. Discussion

1. **Sleep is now a second-order win.** Verlet + stagger already cut the neighbor floor; sleep freezes still help where static/sleep islands exist (Predator, Balls walls), but they are not another −50% story unless you freeze unsafely (S1).

2. **`SLEEP_NEIGHBOR_SKIPS` prevented the H1 measurement trap.** Large NEIGHBOR drops on S1/S2/S6 line up with high skip counts; S5’s Predator near-no-op lines up with zero sleep skips.

3. **Empty-cell predicate matters.** Occupied-awake checks allow freezes around sparse static geometry; strict “all cells sleeping” would barely fire.

4. **S4 shows predicate cost.** Checking neighborhood sleep is not free; it must buy a full freeze (S2) or be gated more carefully, not a half-measure re-filter.

5. **No merge without semantics.** BODY_COUNT ±5% does not prove neighbor lists are correct for AI/lights — the same lesson as post-H3 Verlet validation in the prior report.

---

## 11. Recommendations

| Situation | Action |
|-----------|--------|
| Production default | Keep current Verlet + `neighborTickInterval`; **no** sleep early-out |
| Next engineering step | Port **S2** (or **S3**) behind a scene flag; add neighbor-set sampling / Predator AI smoke; then re-bench |
| Home-cell-only (S1) | Never |
| Rebuild skip (S5/H1) | Not as default on this baseline |
| Docs | `SPATIAL_HASHING.md` updated: cell sleep is written by particle, **not** consumed by production spatial |

---

## 12. Limitations

- Single machine / headed session; no multi-host replicates.
- No neighbor-set oracle in this campaign (BODY_COUNT + skip counters only).
- Balls sleep skips come largely from **static** cell marking, not dynamic sleepers.
- Cell-sleep lag vs spatial not eliminated.
- S2 Balls confirm CV ~18% — wider band; Predator S2 CV ~3.8% is healthier.

---

## 13. Reproducibility

```bash
cd d:/xampp/htdocs/multithreadad-game-engine

# Dry-apply all patches
node tests/bench/runSleepNeighborCampaign.mjs --dry-apply

# Screening (2 runs)
node tests/bench/runSleepNeighborCampaign.mjs --runs 2

# Confirmation (5 runs; S0,S1,S2,S3,S6)
node tests/bench/runSleepNeighborConfirm.mjs
```

Artifacts: `tests/results/sleep-neighbor-hyps/*.json`. Working tree spatial/scenes are restored from `tests/bench/sleep-neighbor-hyps/baseline_*` after runs.

---

## 14. Relationship to `spatial_worker_hypothesis_report.md`

| Topic | Prior report | This report |
|-------|--------------|-------------|
| Verlet skin | Accepted (H3) → shipped | Assumed present in S0 |
| Tick stagger | Not in prior baseline | Assumed present in S0 / documented in `SPATIAL_HASHING.md` |
| Cell sleep | H1 rebuild skip, conditional | S5 re-test (reject); S1–S3/S6 neighbor freezes (new) |
| Bottleneck | Neighbor ≫ rebuild | Still true; sleep freezes attack neighbor further |

Future work from the prior report (“wire `cellSleeping` with tests”) remains open: this campaign supplies **metric evidence and preferred predicates (S2/S3)**, not a merge-ready implementation.
