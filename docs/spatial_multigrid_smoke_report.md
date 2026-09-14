# Smoke report: dual spatial hash (fine + 4× coarse)

**Project:** `multithreadad-game-engine`  
**Algorithm name:** hierarchical / multi-resolution spatial hash (**H-grid** style) — here the minimal 2-level form  
**Scenes:** BallsScene, PredatorScene  
**Runtime:** headed Chromium, warmup **8 s** / measure **6 s**  
**Data:** [`tests/results/multigrid-hyps/smoke-summary.json`](../tests/results/multigrid-hyps/smoke-summary.json), [`confirm-summary.json`](../tests/results/multigrid-hyps/confirm-summary.json)  
**Prototype:** [`tests/bench/multigrid-hyps/m1SpatialWorker.js`](../tests/bench/multigrid-hyps/m1SpatialWorker.js) (not merged)

---

## 1. Idea

Keep the existing fine grid (`cellSize` as today). Add a **worker-local coarse grid** at `4 × cellSize` (Predator 128→512, Balls 100→400). On rebuild, insert every active into **both**. On neighbor miss, if `visualRange > cellSize`, walk the coarse grid; otherwise use fine.

---

## 2. A priori opinion

Large-`visualRange` queries (lights) should see fewer cells on coarse. Rebuild must roughly **double** insert work. With Verlet + stagger already amortizing most walks, net STEP win was expected to be thin or negative once rebuild tax lands — especially on Balls (small vr).

---

## 3. Results

### Smoke (1 run)

| Scene | STEP Δ% | REBUILD Δ% | NEIGHBOR Δ% | CELLS Δ% | BODY Δ% |
|-------|--------:|-----------:|------------:|---------:|--------:|
| Balls | −25.3 | +35.9 | −32.3 | −48.1 | 0 |
| Predator | **−5.3** | **+73.7** | −28.1 | −72.4 | −0.1 |

### Confirm (2-run median)

| Scene | STEP M0→M1 | STEP Δ% | REBUILD Δ% | NEIGHBOR Δ% | CELLS Δ% |
|-------|------------|--------:|-----------:|------------:|---------:|
| Balls | 9.82 → 8.80 | **−10.3** | +46.3 | −17.6 | +0.7 |
| Predator | 7.45 → 7.05 | **−5.4** | **+87.0** | −28.0 | −75.2 |

BODY stayed within ±5%.

---

## 4. Verdict: **reject as production default** (mechanism interesting)

| Claim | Evidence |
|-------|----------|
| Coarse reduces cell walks for large vr | **Yes** — Predator `GRID_CELLS_CHECKED` **−75%**, `NEIGHBOR_MS` **−28%** |
| Net STEP improves enough to pay for complexity | **Weak** — Predator only **−5%** STEP while `REBUILD_MS` nearly **doubles (+87%)** |
| Balls benefits cleanly | **Noisy / dubious** — confirm cells ≈ flat (+0.7%) while STEP still dropped; short warmup +1–2 runs; not a clean causal story |

**Decision:** Do **not** merge dual-grid into production. The hierarchical-hash idea is real (neighbor phase likes coarse buckets for big radii), but the naive “insert everyone into both grids every frame” tax eats almost all of the gain on the current Verlet+stagger baseline.

**If revisited later:** insert into coarse **only** entities with `visualRange > cellSize` (or only lights), or share one coarse SAB across workers instead of rebuilding a full local coarse per spatial worker (Predator ×3 workers amplifies the tax).

---

## 5. Reproducibility

```bash
node tests/bench/runMultigridSmoke.mjs
node tests/bench/runMultigridSmoke.mjs --confirm
```

Restores [`src/workers/spatialWorker.js`](../src/workers/spatialWorker.js) from `tests/bench/multigrid-hyps/baselineSpatialWorker.js` after runs.
