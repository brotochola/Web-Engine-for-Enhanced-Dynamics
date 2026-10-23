# Raycasting

`Ray` is a static class in `src/core/ray.js`. It casts rays against the spatial grid using DDA (Digital Differential Analyzer) traversal. Object and array return values are borrowed by default -- pre-allocated and reused for zero GC pressure.

All methods accept an optional `mask` parameter (Uint32 bitmask, default `0xFFFFFFFF`). Only entities whose `collisionLayer` bit is set in the mask are considered. Rays do not use `collisionGroupIndex` (that filter is for entity–entity physics pairs only). See **Collision Filtering** in `bible_of_weed_js.md`.

If you need to keep a result after another `Ray` call, pass an optional `out` object/array (`castWithInfo`, `castAll`, `linecast`, `linecastDir`, `linecastBetweenEntities`, `getLineOfSightInfo`). Otherwise, consume the returned object immediately. `cast`, `castDir` and `hasLineOfSight` return a number or a boolean, so they have no `out`.

`maxDist` defaults to `Infinity` (no limit). `cast` and `castAll` clip the ray at `maxDist`. `castWithInfo` does not clip: if the distance from start to end is greater than `maxDist` it returns a miss without casting.

---

## API

### `Ray.cast(xFrom, yFrom, xTo, yTo, maxDist?, mask?)`

Returns the **entity index** of the first hit, or `-1`.

```javascript
const hit = Ray.cast(player.x, player.y, mouseX, mouseY);
if (hit !== -1) damageEntity(hit);

// Only hit enemies (layer 4)
const hit = Ray.cast(x, y, tx, ty, Infinity, 1 << 4);
```

---

### `Ray.castDir(x, y, dirX, dirY, maxDist, mask?)`

Same as `cast`, but you give a **unit** direction and a finite `maxDist > 0` (skips a square root). Returns the entity index or `-1`. `maxDist` is required: `Infinity`, `0` or a missing value returns `-1`. With `Ray.assertRotCSUnit = true` a non-unit direction logs a warning.

```javascript
const hit = Ray.castDir(x, y, Math.cos(angle), Math.sin(angle), 500);
```

---

### `Ray.castWithInfo(xFrom, yFrom, xTo, yTo, maxDist?, mask?, out?, excludeEntity?)`

`excludeEntity` (default `-1`, none) is one entity index to ignore, usually the shooter. Returns `{ hit, entityIndex, distance, hitX, hitY, fixtureIndex }`. On a miss: `hit` is `false`, `entityIndex` and `fixtureIndex` are `-1`, `distance` is `Infinity`, and `hitX`/`hitY` are the end point `xTo`/`yTo`. `fixtureIndex` is the closest `ColliderFixture` slot, or `-1` if the hit is the primary collider shape (or a miss). Without `out`, the object is reused on the next `Ray.castWithInfo()` call. Compound bodies: the DDA still keys the **entity**; the fixture walk picks the closest extra polygon when `Collider.fixtureCount > 0`.

```javascript
const r = Ray.castWithInfo(gun.x, gun.y, targetX, targetY);
if (r.hit) {
  spawnBulletHole(r.hitX, r.hitY);
  damageEntity(r.entityIndex);
}

// Result storage you reuse. Create it once (module scope or onSpawned), never inside
// tick(): a new object per call is the allocation `out` exists to avoid.
const out = { hit: false, entityIndex: -1, distance: Infinity, hitX: 0, hitY: 0, fixtureIndex: -1 };
Ray.castWithInfo(gun.x, gun.y, targetX, targetY, Infinity, 0xffffffff, out);
```

---

### `Ray.castAll(xFrom, yFrom, xTo, yTo, maxDist?, maxHits?, mask?, out?)`

Returns the entities hit along the path, sorted by distance, at most `maxHits` of them (default `10`; the nearest are kept). Each element is `{ entityIndex, distance, hitX, hitY }` (no `fixtureIndex`). Without `out`, the returned array and hit objects are reused on the next `Ray.castAll()` call. With `out`, the hits are written into that array.

```javascript
const hits = Ray.castAll(gun.x, gun.y, targetX, targetY, Infinity, 5);
for (const h of hits) {
  damageEntity(h.entityIndex, dmg * (1 - h.distance / maxRange));
  spawnBulletHole(h.hitX, h.hitY);
}

// Create this array once (module scope or onSpawned), never inside tick():
const outHits = [];
Ray.castAll(gun.x, gun.y, targetX, targetY, Infinity, 5, 0xffffffff, outHits);
```

---

### `Ray.linecast(x1, y1, x2, y2, excludeEntities?, mask?, out?)`

Checks if the path between two points is blocked. Returns `{ blocked, entityIndex, distance }`. Without `out`, the object is reused on the next linecast call.

`excludeEntities` can be a `Set<number>` or `Array<number>` of entity indices to skip, or `null`. When clear, the result is `{ blocked: false, entityIndex: -1, distance: Infinity }`.

```javascript
const los = Ray.linecast(enemy.x, enemy.y, player.x, player.y);
if (!los.blocked) enemy.shoot(player);
```

---

### `Ray.linecastDir(x1, y1, dirX, dirY, rayLength, excludeEntities?, mask?, out?)`

`linecast` with a **unit** direction and a length (skips a square root). `rayLength <= 0` returns not blocked. Here `excludeEntities` may also be a single entity index (number).

```javascript
const los = Ray.linecastDir(x, y, dirX, dirY, 300, myIndex);
```

---

### `Ray.linecastBetweenEntities(entityIndexA, entityIndexB, mask?, out?)`

Like `linecast` but takes two entity indices. Both entities are automatically excluded from the check. Returns `{ blocked, entityIndex, distance }`.

```javascript
const los = Ray.linecastBetweenEntities(predatorIdx, preyIdx);
if (!los.blocked) predator.chase(preyIdx);
```

---

### `Ray.hasLineOfSight(entityIndexA, entityIndexB, mask?)`

Returns `true` if the path is clear (nothing blocking), `false` if blocked.

```javascript
if (Ray.hasLineOfSight(enemy, player)) {
  enemy.shoot(player);
}

// Ignore bullets (layer 2) when checking line of sight
if (Ray.hasLineOfSight(enemy, player, ~(1 << 2))) { ... }
```

---

### `Ray.getLineOfSightInfo(entityIndexA, entityIndexB, mask?, out?)`

Same as `linecastBetweenEntities` -- returns `{ blocked, entityIndex, distance }`. Use when you need to know **what** blocked the line of sight.

---

### Other statics

- `Ray.SHAPE_BOX`, `Ray.SHAPE_CIRCLE`, `Ray.SHAPE_POLYGON`, `Ray.SHAPE_CHAIN`: the `ShapeType` values.
- `Ray.assertRotCSUnit` (default `false`): warn when `castDir` / `linecastDir` get a non-unit direction.
- `Ray.collectDetailedStats`, `Ray.beginFrame()`, `Ray.consumeStats()`: engine timing. `consumeStats()` returns a borrowed `{ ms, count }`.

---

## Box2D ray and overlap queries (`Box2d`)

These ask the physics worker (Box2D fixtures), not the spatial grid. The sync forms block with `Atomics.wait` and run on logic workers; the `Async` forms return a Promise and are for the Scene on the main thread. `dx, dy` is a **displacement** from the origin, not an end point. `filter` is `{ categoryBits?, maskBits? }`; it is **not** the `Ray` layer `mask`.

| Call | Returns |
| --- | --- |
| `Box2d.castRayClosest(ox, oy, dx, dy, out?, filter?)` | `out` (or a new object): `{ hit, entityIndex, fraction, hitX, hitY }`. On a miss `hit` is `false`, `entityIndex` is `-1`. `fraction` is the hit point along the displacement |
| `Box2d.castRayClosestAsync(...)` | Promise of the same |
| `Box2d.castRayClosestBatch(count, rays, entities, filter?)` | Casts `count` rays (at most 4096); `rays` is interleaved `ox, oy, dx, dy`; `entities[i]` gets the hit id or `-1`; returns how many were cast |
| `Box2d.castRayAll(ox, oy, dx, dy, out?, filter?)` | `out` (an array, or a new one) filled with `{ entityIndex, fraction, hitX, hitY }`, one per shape crossed; objects already in `out` are reused |
| `Box2d.castRayAllAsync(...)` | Promise of the same |
| `Box2d.queryAABB(x0, y0, x1, y1, out, filter?)` | Number of entities found; `out` must be an `Int32Array` |
| `Box2d.overlapCircle(cx, cy, radius, out, filter?)` | Number of entities found; `out` must be an `Int32Array` |

A `castRayAll` `out` that is not an array throws. See [Physics](./PHYSICS.md) for the single-flight rules and limits.

```javascript
const out = { hit: false, entityIndex: -1, fraction: 0, hitX: 0, hitY: 0 };
const r = Box2d.castRayClosest(x, y, 200, 0, out);
if (r.hit) damageEntity(r.entityIndex);
```

---

## Collision Layer Filtering

All methods default to `mask = 0xFFFFFFFF` (hit everything). Pass a bitmask to restrict which layers the ray can hit:

```javascript
import { layerMask } from '@weed.js/engine';

// Only hit terrain (0) and enemies (4)
Ray.cast(x, y, tx, ty, Infinity, layerMask([0, 4]));

// Hit everything except bullets (2) and particles (5)
Ray.hasLineOfSight(a, b, ~layerMask([2, 5]));

// Bitwise shorthand (no import needed)
Ray.cast(x, y, tx, ty, Infinity, (1 << 0) | (1 << 4));
```

The ray checks `(1 << (entity.collisionLayer & 31)) & mask` per entity -- one bitwise AND, no allocations.

---

## Internals

- **DDA grid traversal**: rays step through spatial grid cells, only testing entities in cells the ray actually crosses.
- **Cell-exit early-out**: once the closest hit distance is not past the current cell's DDA exit boundary (`min(tMaxX, tMaxY)`), traversal stops. Valid because spatial workers insert each entity into **every** cell its AABB overlaps — a closer hit cannot appear in a later cell. Used in `_traverseGrid` and the inlined `cast` loop.
- **Two internal functions**: `_checkCellEntities` (finds closest hit per cell) and `_collectCellHitsTopN` (keeps the closest `maxHits` hits for `castAll`).
- `_traverseGrid`: shared DDA loop used by `cast`, `castWithInfo`, and `linecast`. Returns a borrowed static `{ entityIndex, distance }` consumed immediately by callers.
- `cast` and `castAll` have their own inlined DDA loops for performance.
- All temp objects (`_tempResult`, `_tempHitInfo`, `_tempLinecastResult`, `_tempHitsArray`, `_traverseResult`) are static and reused across calls unless you pass an explicit `out`.

---

## Performance Notes

- Zero allocations in hot path (results are pre-allocated static objects by default, or caller-owned `out` objects/arrays).
- Layer mask filter is one bitwise AND per entity -- evaluated before any shape intersection math.
- `linecastBetweenEntities` uses scalar excludeA/B (no Set).
- `castAll` reuses a pool of hit objects; only allocates new ones if the pool grows (one-time cost).
- Correctness + throughput regression: `node tests/bench/rayMicrobench.mjs` (20k brute-force comparisons + timed workloads).
- WeedJS vs Box2D kernel A/B (idle Node): `pnpm bench:micro:ray-vs-box2d`. Soft hit/miss agreement only — filters/math differ.
- Busy-physics hyp (logic DDA vs physics-thread SAB cast): `pnpm bench:feature:ray-vs-box2d:weedjs:busy` vs `…:box2d:busy`. Read WeedJS `RAYCAST_MS` or Box2D `BOX2D_RAYCAST_MS` + physics `STEP_MS`/`BOX2D_MS`. WeedJS ray is **logic-thread DDA**, not a dedicated ray worker. `serviceRayCast` inside physics is still `STEP_MS`.
- Public sync API for Box2D closest ray: `Box2d.castRayClosest(ox, oy, dx, dy, out?, filter?)` (SAB, single-flight; same pattern as QueryAABB). Main thread: `Box2d.castRayClosestAsync`. All hits: `Box2d.castRayAll` / `castRayAllAsync` (borrowed `{ entityIndex, fraction, hitX, hitY }[]`).
- Optimization hypotheses + headless L1/L2/L3 campaign: `[RAY_HYPOTHESES.md](../internal/RAY_HYPOTHESES.md)`.
- Production Ray path includes tournament champion **H6+H1** (stamp dedup + `castAll` top-N early-out).
