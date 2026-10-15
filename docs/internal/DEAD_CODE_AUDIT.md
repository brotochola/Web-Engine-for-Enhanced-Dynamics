# Dead / unused / duplicated code audit (src)

## Done

| Item | Action |
|------|--------|
| `tests/results/` | Gitignored; untracked from index |
| `spatialWorker` cell-range | Uses `ColliderUtils.getCellRange` |
| `AngularSweep` angle normalize | Uses `utils.normalizeAngleSigned` |
| Commented dead in particle/pixi workers | Removed |
| Stale `pixi4webworkers` comment | Removed |
| Unused utils helpers (no in-repo use, not intentional game API) | **Deleted** + `types/utils.d.ts` synced |
| Unused Grid helpers (`clearCell`, `getEntitiesInRect`, `getNearestEntity`, `isRowOwnedBy`, `getOwnedRows`) | **Deleted** + `types/weed.d.ts` synced |

### Deleted from `utils.js` (examples)

`binarySearchRange`, `clamp01`/`clamp01Fast`, `rayCircleHit`/`rayBoxHit`, direction helpers, `distance2D`/`isWithinRange*`, AABB/clampVelocity helpers, `computeCircleMass`/`computeBoxMass`, `rayOBBIntersect`, utils-side `getCellIndex`/`getCellCoords*`, `getParentClasses`, `lerpAngle`, unused light-tint helpers, Pixi `drawLine`/`drawCircle`/`drawCross`.

### Kept on purpose

- **`layerMask`** — documented in bible / raycasting docs as collision-mask helper
- **`Grid.getCellIndex` / `getCellCoords` / `getEntitiesInRadius`** — core Grid surface (used by Ray/debug or natural API)
- **`DebugDraw.drawLine` / `drawCircle`** — real debug API (not the deleted utils Pixi helpers)
- **`workers-utils.formatNumber`** — isolated worker stats formatting
- **`getPrecomputedQueryInfo`** — still in `types/weed.d.ts` (typed public QuerySystem method; no in-repo callers yet)
- **`src/core/debug/stubs/*`** — webpack prod stubs

## Follow-ups

1. Optionally remove `QuerySystem.getPrecomputedQueryInfo` + types if confirmed never for games.
2. knip / unused-export ESLint for CI.
3. Clean dead imports in `pixiWorker` if any remain.
