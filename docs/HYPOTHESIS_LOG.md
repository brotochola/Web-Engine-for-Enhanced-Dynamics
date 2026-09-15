# Hypothesis log

Living record of speed claims already measured. **Read this before you reimplement an idea.** After every measurement, add or update a row. Long essays stay in the linked docs; this file is the index.

Status words: `kept` · `dropped` · `rejected-in-kernel` · `not-measured` · `superseded`.

Do not reopen a `dropped` or `rejected-in-kernel` claim unless the user asks for an explicit retest with a new protocol.

Protocol: [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md).

---

## This branch (`more_micro_opts` versus `main` `0695a8d`)

Isolation campaign, 2026-09-15. Each change applied alone on `main` files. Gameplay scenes headed, 5 runs, warmup 25 s, measure 18 s, `collectDetailedStats` off. Stress scenes headless 2 × 8 s / 10 s when Balls or Predator cannot see the code. **Load counts were still gated**, so `BODY_COUNT` and `ACTIVE_PARTICLES` read as 0 on production runs. Isolation keep/drop used step time only. Do not treat those zeros as “empty worlds.”

Product confirm of the keep set (HASH + P2 + P6 + HYGIENE + COLLIDE, PACT and LIGHT removed) is a separate row and uses the ungated counts.

| Name | Claim | Status | When | How | Numbers | Why keep or drop | Link |
|------|-------|--------|------|-----|---------|------------------|------|
| Debug hygiene | Replacing leftover `console.log` on workers with `debugWorkerLog` does not slow the game; may help a little when logs were hot. | kept | 2026-09-15 | Gameplay headed 5-run Balls + Predator | Predator logic0 step −5.9% | Hygiene: keep unless a 3% regression. Predator logic also got cheaper. | `tests/results/micro-opts-ab/HYGIENE/` |
| Collision pair key | `GameObject.isCollidingWith` should use a stable pair key (bugfix), not a speed trick. | kept | 2026-09-15 | Gameplay headed 5-run | Predator logic0 step −13% | Bugfix: keep unless a 3% regression. | `tests/results/micro-opts-ab/COLLIDE/` |
| QueryAABB burst | Servicing many pending QueryAABB calls in one physics burst is cheaper than one-at-a-time. | dropped | 2026-09-15 | Stress scene `QueryAabbStressScene`, headless | Physics step **+835%** | Burst made the physics worker much slower. Do not reintroduce `servicePendingQueryBurst`. | `tests/results/micro-opts-ab/AABB/` |
| Particle emit field list (P2) | Caching `_cfgFieldList` on emit makes spawn cheaper. | kept | 2026-09-15 | Kernel emit + gameplay Predator | Kernel emit +7.2% ops/s; Predator particle step −6.5% | Kernel and Predator both improved. | `tests/results/micro-opts-ab/P2/` |
| Free-list pop (P6) | `popFreeIndices` / `acquireIndices` batch is cheaper than one-by-one pop. | kept | 2026-09-15 | Kernel emit; Predator did not move 3% | Kernel emit about **+27%** ops/s; Predator particle −1.4% | Kernel claim only. Do not sell as a Predator win. | `tests/results/micro-opts-ab/P6/` |
| Particle expectedActive (PACT) | Size the active-list build from live emitters (`live + 32`) instead of `maxParticles`. | dropped | 2026-09-15 | Isolation NA (load counts gated); later removed from keep set | Isolation with detailed stats showed `ACTIVE_PARTICLES` **+86%** — not the same load | Not proven cheaper. Reverted to `expectedActive = maxParticles`. | `tests/results/micro-opts-ab/PACT/` |
| Compact bullet list | Tick only compact active bullets instead of scanning the pool. | dropped | 2026-09-15 | Gameplay headed | Particle step +1.9% (no 3% win) | Did not pay. Compact list stays off this branch. | `tests/results/micro-opts-ab/BULLET/` |
| Skip pixi light re-cull (LIGHT) | If pre-render already filled `visibleLightsData`, pixi can skip the influence-radius cull. | dropped | 2026-09-15 | Isolation NA; Predator particle **+61%** with detailed stats on | Load not comparable; no clean speed win | Reverted: pixi always culls with `lightInfluenceRadius`. | `tests/results/micro-opts-ab/LIGHT/` |
| Visibility polygon cache (VP) | Cache vis-poly output and skip the angular sweep when inputs match. | dropped | 2026-09-15 | Gameplay / pre-render (`lighting.raycasted` is off on Predator by default, so this path is easy to miss) | `VISIBILITY_MS` +10.8% when the path ran | Cache lost. Left reverted. | `tests/results/micro-opts-ab/VP/` |
| Cached tick function (TICK) | Call `EntityClass.prototype.tick` via a cached function instead of `obj.tick`. | dropped | 2026-09-15 | Gameplay headed Balls | Balls logic0 step **+27%** | Much worse on Balls. Do not cache `tickFn`. | `tests/results/micro-opts-ab/TICK/` |
| Spawn/despawn batch (ECB) | Batch `spawnDespawnBatch` postMessages on entity churn. | dropped | 2026-09-15 | Stress scene SpawnStorm, headless | SpawnStorm −2.8% (below 3%) | Not enough. Left reverted. | `tests/results/micro-opts-ab/ECB/` |
| Spatial dep-hash removal (HASH) | Stop hashing spatial dependency versions every neighbor rebuild. | kept | 2026-09-15 | Gameplay headed Predator | Predator spatial-max step **−10.2%** | Real Predator spatial win. This is the strongest isolated gameplay win on the branch. | `tests/results/micro-opts-ab/HASH/` |
| Full stack (all hyps at once) | The whole `more_micro_opts` pile is faster than `main`. | dropped | 2026-09-15 | Gameplay headed 5-run | Predator particle step **+3.5%** | Product lost on particles. Do not ship the full pile. | `tests/results/micro-opts-ab/STACK/` |
| Keep set after drops (2-run screen) | HASH + P2 + P6 + HYGIENE + COLLIDE + PACT + LIGHT together beat `main`. | not-measured | 2026-09-15 | Gameplay headed, **n=2** only (noisy) | Balls physics 7.35 → 7.02 ms (−4.5%); Predator particle 2.53 → 2.63 ms (+3.8%) | Too few runs; PACT/LIGHT still in the tree. Superseded by the 5-run product confirm. | `tests/results/micro-opts-ab/stack-after-revert.json` |
| Always-on load counts | Publish `BODY_COUNT` / `AWAKE` / `MOVED` and `ACTIVE_PARTICLES` even when detailed stats are off. | kept | 2026-09-15 | Gameplay headed (required for any later confirm) | First confirm still saw Balls `BODY_COUNT` 0: lean `doStep` returned before `writePhysicsStats`. After calling `writePhysicsStats` on that path, Balls `BODY_COUNT` 9004 both sides. | Hygiene for measurement, not a speed hyp. Keep. | `src/box2d/weedjsPost.js` `writePhysicsStats` + lean `doStep` |
| Keep set product confirm | HASH + P2 + P6 + HYGIENE + COLLIDE (no PACT, no LIGHT), plus always-on load counts, is faster than `main` `0695a8d`. | dropped | 2026-09-15 | Gameplay headed 5-run Balls + Predator; kernel Node emitFlat; detailed stats off; load ±5% | Balls load OK (`BODY_COUNT` 9004 / 9004). Physics 6.911 → 6.554 ms (−5.2%), logic0 0.339 → 0.271 ms (−20.1%). Predator `BODY_COUNT` −0.1% but `ACTIVE_PARTICLES` 76.0 → 82.7 (**+8.8%**, cv ~75–80%): **pair does not exist**. Kernel emitFlat 7079 → 8570 ops/s (+21.1%). | Product “faster than main” is false: Predator load missed ±5%. Balls-only would keep. P6 stays a kernel claim. HASH Predator spatial not confirmed on this keep set. | [`tests/results/product-confirm/report.md`](../tests/results/product-confirm/report.md) |
| Scoreboard platform vs `0695a8d` | Catalog runner can compare every engine feature with load gates. | kept | 2026-09-15 | Scoreboard smoke; 5 rows | emit:KEPT, spatial:KEPT, box2d:WORSE, visPoly:WORSE, steadyCombat:KEPT. No. 2 fila(s) FAIL/WORSE. No se afirma mejor WeedJS. | Platform shipped. Do not claim best WeedJS unless every catalog row is KEPT or TIE and none WORSE/FAIL. | [`tests/results/scoreboard/report.md`](../tests/results/scoreboard/report.md) |

---

## Historical index (already on `main` — do not reopen without new evidence)

| Name | Claim | Status | When | How | Why | Link |
|------|-------|--------|------|-----|-----|------|
| Ray H6 + H1 | Stamp instead of `Set` in `castAll`, plus top-N early-out, is cheaper. | kept | 2026-08 (headed Predator pick with D2 + P4/P5) | Kernel + stress RayStress + Predator | Shipped. Many other ray hyps rejected in the same docs. | [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md) |
| Decal D2 | UV DDA stamp is cheaper than the old nearest-neighbor path. | kept | 2026-08-04 | Headless screen 2 × 8 s / 10 s, then accepted | Champion merged. D1/D3–D6 rejected. | [`DECAL_HYPOTHESES.md`](./DECAL_HYPOTHESES.md) |
| Particle P4 + P5 | Integrate + emitFlat champion stack. | kept | 2026-08-04 | Headless screen; P2/P6 were later re-tested on this branch | Champion merged. Do not run `bench:particle:tournament` (it overwrites `src/`). | [`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md) |
| Spatial Verlet H3 | Reuse neighbor lists with a Verlet-style skin (0.25 × visualRange). | kept | spatial campaign, headed 5-run confirm | Gameplay Balls + Predator | Balls spatial step about −70%, Predator about −45%. Already on `main`. | [`spatial_worker_hypothesis_report.md`](./spatial_worker_hypothesis_report.md) |
| Spatial H1–H15 (except shipped Verlet / stagger) | Cell-sleep respect, Morton reorder, sampled hash, dense cache, `cellSize=96`, AdaptiveSpatial port, and the rest of that battery. | dropped | same campaign | Headed gameplay + kernels as documented | Rejected as defaults. H1 is correctness-conditional. Do not re-port AdaptiveSpatial. | same report; patches in `tests/bench/spatial-hyps/` |
| LiquidFun shipped set | H2–H4, H6–H14, H16, H21, H26 (reuse OverlapAABB across sub-steps), cell cache H3, and related C/WASM work. | kept | 2026-08 → 2026-09 | Kernel + LiquidFun stress scenes | Already on `main` / sibling C. | [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md) |
| LiquidFun rejected set | H5 insertion sort, H15/H17–H20/H22, H24–H25, H27–H28, **H29 SIMD distSqr** (+1.6% kernel). | dropped | through 2026-09-14 | Kernel and stress scenes as logged | Do not retry gather-4 SIMD. Fase C (dense per-cell neighbor lists in sibling C) is future work, not this JS program. | same doc, “Fase C” section |
| Feature program waves C–K leftovers | AngularSweep, NavGrid, QuerySystem, decorations, tilemap, Treiber rings, and the older “Wave H light skip / vis-poly” notes. | mixed | see program | Kernel and/or stress; some never gameplay-confirmed | Treat [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md) as a catalog, this log as the verdict. Wave H light-skip and vis-poly cache lost on this branch (LIGHT, VP). | [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md) |

Older write-ups still say L1/L2/L3. That means kernel / stress scene / gameplay.
