# Diary of a one-night campaign

Night of 15–16 September 2026. Target: 10 hours, cushion 11. Keep tree (HASH + P2 + P6 + hygiene + collision + counters) versus `main` `0695a8d` plus the same load counters.

This file is the **human** diary of that night. The runner writes [`tests/results/scoreboard/report.md`](../tests/results/scoreboard/report.md). The hypothesis index is [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). The feature map is [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md).

Protocol: primary = `STEP_MS` (or kernel ops/s). A speed keep requires the primary at least 3% cheaper and the load within ±5% with cv under 50%. FPS at 60 Hz does not count. Artistic Predator is not a row. Do not claim a "perfect WeedJS".

## Clock

Start: 15 September 2026, ~21:25 Argentina time.

Planned commands:

```bash
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
pnpm bench:scoreboard --vs 0695a8d --headed-only box2d,visPoly,steadyCombat --skip-node
```

Machine: Chromium headed and visible, not suspended, those windows not minimized.

---

## Block 0 — `--headed-only` flag

**What was done.** In [`tests/bench/measureLib.mjs`](../tests/bench/measureLib.mjs): `sceneWantsHeaded`, `--headed-only id,id`. `--headless` still wins. In [`tests/bench/runScoreboard.mjs`](../tests/bench/runScoreboard.mjs) the scene cache uses the **effective** headed bit (`scene.key|0|smoke` or `scene.key|1|smoke`), not the catalog's `scene.headed`. Tests in `workloadCountsAlways.test.js`.

**Setup.** No product bench yet.

**Numbers.** Not applicable.

**Verdict.** The runner no longer opens compute or zenithal when `--headed-only box2d,visPoly,steadyCombat` is passed.

## Block A — Inventory

**What was done.** [`docs/INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md): glossary, map of the 21 rows, box2d smoke-vs-confirm note, QueryAABB burst dropped. Pointers in HOW_WE_MEASURE, FEATURE_BENCHMARKS, docs/README. Correction in FEATURE_HYP_PROGRAM (burst was not shipped).

**Setup.** Documentation only.

**Numbers.** Not applicable.

**Verdict.** The product expectation is a map per row, not a global champion.

**Next.** Tilemap.

## Block B — Tilemap made measurable

**What was done.** [`tests/bench/stressScenes/tilemapStressScene.js`](../tests/bench/stressScenes/tilemapStressScene.js): seed `0x711e`, 64 queriers × 64 `getTileId` per tick, 64×64 map. Catalog: `scene` + `primary: logic0_STEP_MS` + `load: ENTITIES_PROCESSED`.

**Setup.** Node tests: `engineFeatureCatalog.test.js` and `--headed-only` in `workloadCountsAlways.test.js`.

**Numbers.** `pnpm test:node`: 437 pass, 0 fail (includes `tilemap has a seeded stress scene` and `--headed-only forces headed only`).

**Verdict.** The tilemap row is no longer NA for lack of a scene. There are still no stress numbers versus `0695a8d` (those go in block D).

**Next.** Block C, the keep as a package.

## Block C — Keep as a package (closed)

**What was done.** Not Predator. Not `runProductConfirm`.

```bash
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
```

Durable copy: [`tests/results/scoreboard/keep-bundle/report.md`](../tests/results/scoreboard/keep-bundle/report.md) (the block D board will rewrite `report.md`).

**Setup.** `test:node` 437/437. Visual lockstep **failed**: `spawn timeout: 0 need 9004` on Balls (0 bodies). The runner continued the speed rows. Headed 5 × 25000/18000 ms on Balls and steady combat. Emit stress 2 × 8 s / 10 s. Baseline `0695a8d` + counters. `src/` restored (`src/` git status clean).

**Numbers.**

- **emit KEPT.** Kernel 7073 → 7966 ops/s (**+12.6%**). `particle_STEP_MS` 0.277 → 0.273 ms (−1.2%, scene tie). `ACTIVE_PARTICLES` 2114 / 2112 (−0.1%).
- **box2d TIE.** `physics_STEP_MS` 6.893 → 7.067 ms (**+2.5%**, within 3%). `BODY_COUNT` 9004 / 9004. Physics cv 1.9% / 2.6%. This **does not cancel** the earlier five-run confirm (−5.2%). Beside it, `logic0_STEP_MS` 0.339 → 0.474 ms (+39.6%): not this row's primary, noted.
- **steadyCombat KEPT.** `logic0_STEP_MS` 0.328 → 0.249 ms (**−24.1%**). Particles 0.411 → 0.421 (+2.5%). Spatial 0.100 → 0.100 (+0.7%). `BODY_COUNT` 204/204. `ACTIVE_PARTICLES` 4023/4025 (+0.1%, low cv). Load OK.

**Verdict.** The keep package is the champion of emit (kernel) and of steady combat (logic0). Balls physics ties on this sitting. Do not claim "faster than main": lockstep failed. The product JSON says speed does not count.

**Next.** Block D: the rest of the catalog, `--skip-node --skip-lockstep`, `--headed-only visPoly`. emit/box2d/steadyCombat are not remeasured (the cache is per process; they are excluded with `--only` so we do not spend another ~20 min headed or overwrite these numbers).

## Block D — Rest of the catalog (closed)

```bash
pnpm bench:scoreboard --vs 0695a8d --headed-only visPoly --skip-node --skip-lockstep --only ray,rayVsBox2d,decals,integrate,spatial,liquidfun,liquidfunCouple,liquidfunQuery,queryAabb,nav,visPoly,tilemap,queryPublish,preRender,compute,decorations,bullets,spawn
```

Report: [`tests/results/scoreboard/catalog-rest/report.md`](../tests/results/scoreboard/catalog-rest/report.md). ~36 min. `src/` restored when the runner finished.

**Setup.** Stress 2 × 8 s / 10 s. visPoly headed 5 × 25 s / 18 s. compute and zenithal **without** a window. Detailed stats off. `VISIBILITY_MS` came out 0.

**Numbers (map).** Load OK except preRender (`BODY_COUNT` 0: the queue scene does not spawn bodies; the kernel +9.3% does not count). spawn FAIL: the Treiber kernel blew up on the `0695a8d` baseline (the scene did run, logic0 −4.2%).

| Row | Verdict | Primary | Note |
|------|-----------|----------|------|
| ray | WORSE | kernel +3.4%; logic0 +4.4% | `ray.js` did not change vs main; logic0 is noise or a logic keep |
| rayVsBox2d | WORSE | kernel −6.4%; physics +5.8% | |
| decals | WORSE | particle +4.7% | |
| integrate | WORSE | kernel −4.4% | |
| spatial | TIE | spatialMax −2.1% | |
| liquidfun | TIE | physics −0.3%; kernel −1.7% | |
| liquidfunCouple | WORSE | kernel +9.2% ms (more expensive) | physics scene +0.7% |
| liquidfunQuery | WORSE | physics +9.3%; logic0 −40.5% | one worse primary kills the row |
| queryAabb | WORSE | physics 0.132 → 2.718 ms (**+1964.9%**) | AABB burst **was still** in the keep; logic0 −98.5% (the cost moved to physics) |
| nav | WORSE | kernel −10.8% | the microbench **copies** Dijkstra; it does not import `src/`. Scene logic0 +2.9% |
| visPoly | WORSE | kernel −28.4%; preRender −1.2% | `angularSweep.js` **did not** change vs main: unstable kernel. `VISIBILITY_MS` = 0 |
| tilemap | WORSE | kernel −5.1%; logic0 −1.1% | the new scene closes load (64 entities). Kernel `tileMap.js` did not change vs main |
| queryPublish | KEPT | logic0 0.353 → 0.339 (−4.1%) | |
| preRender | FAIL | BODY_COUNT 0 | not a cull regression |
| compute | WORSE | kernel −34.4%; pixi +4.8% | `computeLayer.js` did not change vs main |
| decorations | WORSE | kernel −56.2%; pixi +5.4% | `decorationSpatial.js` did not change vs main |
| bullets | TIE | particle +1.6% | cache of `rayStress` |
| spawn | FAIL | kernel BASE failed | scene logic0 −4.2% does not count |

**Verdict.** Do not claim a better WeedJS. The actionable finding: the QueryAABB burst was still in `serviceQueryAabb` even though isolation had **dropped** it. WORSE kernels in modules that are not in the diff versus `0695a8d` are noise, not a worse champion.

**Next.** Revert the burst. Remeasure queryAabb only. visPoly with `--detailed-stats` (there is room). Nav: two hypotheses on the production Dijkstra.

## AABB burst reverted (keep hygiene)

**What was done.** `serviceQueryAabb` in [`src/box2d/weedjsPost.js`](../src/box2d/weedjsPost.js) again calls only `servicePendingQuery` (one at a time). The burst was a leftover: AABB isolation **dropped** it (+835%) and the keep package was not supposed to include it.

```bash
pnpm bench:scoreboard --vs 0695a8d --only queryAabb --skip-node --skip-lockstep --skip-kernels
```

**Setup.** Stress 2 × 8 s / 10 s, headless.

**Numbers.** Physics 0.130 → 0.127 ms (**−2.5%**, TIE). `BODY_COUNT` 201/201. logic0 ~16.57 / 16.61 ms (the cost went back to logic, as on main). Report: [`tests/results/scoreboard/queryaabb-after-burst-revert/report.md`](../tests/results/scoreboard/queryaabb-after-burst-revert/report.md).

**Verdict.** TIE. The +1964% was the burst, not Box2D WASM. The keep set now matches "no AABB".

## visPoly with detailed stats (closed)

```bash
pnpm bench:scoreboard --vs 0695a8d --only visPoly --headed-only visPoly --skip-node --skip-lockstep --detailed-stats
```

Report: [`tests/results/scoreboard/vispoly-detailed/report.md`](../tests/results/scoreboard/vispoly-detailed/report.md).

**Setup.** Headed 5 × 25 s / 18 s. Sub-timers on.

**Numbers.** `VISIBILITY_MS` now exists: 0.071 → 0.070 ms (−1.2%). `preRender_STEP_MS` 0.129 → 0.125 ms (**−3.3%**, scene keep). Kernel 106449 → 98185 ops/s (−7.8%). `BODY_COUNT` 56/56.

**Verdict.** Row WORSE because of the kernel. `angularSweep.js` did not change vs main: that kernel is noise. With detailed stats the angular sweep is a tie and pre-render is a bit cheaper. VP is not reopened (cache dropped).

## Block E — Nav (closed)

Two hypotheses against the current tree. Scene `NavStressScene`, headless 2 × 8 s / 10 s. Primary `particle_STEP_MS`. Report: [`tests/results/nav-hyps/report.md`](../tests/results/nav-hyps/report.md).

**N1_floor.** `Math.floor(cell / gridWidth)` → `| 0`. TIE: particles 2.217 → 2.183 ms (−1.5%). **Not merged.**

**N2_gridHeight.** Local `gridHeight` in `computeFlowfield`. KEPT: particles 2.263 → 2.143 ms (**−5.3%**), logic0 −2.1%, load OK. n=2 screening. **Merged** in `src/workers/particleWorker.js`.

**Verdict.** N2 is the current champion of that row against tonight's code, not against main. Do not claim Nav cheaper than `0695a8d` (board D was a WORSE from the copied kernel).

## Map at the close of the night

Do not claim a perfect WeedJS. Do not claim faster than main (lockstep failed; many rows WORSE/FAIL).

Keep as a package (headed 5 runs): emit KEPT, box2d TIE, steadyCombat KEPT. AABB burst removed: queryAabb TIE vs main. Nav N2 merged (screening n=2). Diary: this file. Scoreboards: `tests/results/scoreboard/keep-bundle/`, `catalog-rest/`, `queryaabb-after-burst-revert/`, `vispoly-detailed/`.

`src/` is left with: the original keep + AABB burst revert + N2 gridHeight.

---

## Pre-merge strip (2026-09-16)

**What was done.** The log said "Left reverted" but the tree still had TICK, ECB, PACT, BULLET compact, LIGHT skip, VP cache, and the dead API `servicePendingQueryBurst`. `src/` was aligned to the documented keep. `test:node` 438/438. Visual lockstep **ok** (the Balls `spawn timeout` disappeared with the ECB strip).

**Remeasure.**

```bash
pnpm bench:scoreboard --vs 0695a8d --only queryAabb --skip-node --skip-lockstep --skip-kernels
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
```

- queryAabb: physics +6.3% (0.201→0.213 ms) protocol WORSE; **not** +thousands %. Copy: `tests/results/scoreboard/queryaabb-after-strip/`.
- emit KEPT; box2d KEPT (logic0 −51% after removing TICK); steadyCombat WORSE because spatialMax +3.5% (logic0 −16.9%). Copy: `tests/results/scoreboard/keep-bundle-after-strip/`.

**Merge.** Keep set + bench platform. Do not claim WeedJS is faster than main. On merge: squash to two logical commits (`feat(bench): measurement platform` + `perf: keep set …`), not the `micro opts` pile.

Suggested PR body: measurement + partial keep (HASH/P2/P6/hygiene/collide/load/N2); the stack and the product-confirm **do not** win; see `HYPOTHESIS_LOG` and this section.

---
