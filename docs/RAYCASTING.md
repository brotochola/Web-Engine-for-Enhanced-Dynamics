# Raycasting

`Ray` is a static class in `src/core/Ray.js`. It casts rays against the spatial grid using DDA (Digital Differential Analyzer) traversal. Object and array return values are borrowed by default -- pre-allocated and reused for zero GC pressure.

All methods accept an optional **`mask`** parameter (Uint32 bitmask, default `0xFFFFFFFF`). Only entities whose `collisionLayer` bit is set in the mask are considered. See **Collision Filtering** in `bible_of_weed_js.md`.

If you need to keep a result after another `Ray` call, pass an optional `out` object/array as the last argument. Otherwise, consume the returned object immediately.

---

## API

### `Ray.cast(xFrom, yFrom, xTo, yTo, maxDist?, mask?)`

Returns the **entity index** of the first hit, or `-1`.

```javascript
const hit = Ray.cast(player.x, player.y, mouseX, mouseY);
if (hit !== -1) damageEntity(hit);

// Only hit enemies (layer 4)
const hit = Ray.cast(x, y, tx, ty, Infinity, (1 << 4));
```

---

### `Ray.castWithInfo(xFrom, yFrom, xTo, yTo, maxDist?, mask?, out?)`

Returns `{ hit, entityIndex, distance, hitX, hitY }`. Without `out`, the object is reused on the next `Ray.castWithInfo()` call.

```javascript
const r = Ray.castWithInfo(gun.x, gun.y, targetX, targetY);
if (r.hit) {
  spawnBulletHole(r.hitX, r.hitY);
  damageEntity(r.entityIndex);
}

// Stable result storage with no allocation:
const out = { hit: false, entityIndex: -1, distance: Infinity, hitX: 0, hitY: 0 };
Ray.castWithInfo(gun.x, gun.y, targetX, targetY, Infinity, 0xFFFFFFFF, out);
```

---

### `Ray.castAll(xFrom, yFrom, xTo, yTo, maxDist?, maxHits?, mask?, out?)`

Returns **all** entities hit along the path (sorted by distance). Without `out`, the returned array and hit objects are reused on the next `Ray.castAll()` call.

```javascript
const hits = Ray.castAll(gun.x, gun.y, targetX, targetY, Infinity, 5);
for (const h of hits) {
  damageEntity(h.entityIndex, dmg * (1 - h.distance / maxRange));
  spawnBulletHole(h.hitX, h.hitY);
}

// Stable array storage with no per-frame allocation:
const outHits = [];
Ray.castAll(gun.x, gun.y, targetX, targetY, Infinity, 5, 0xFFFFFFFF, outHits);
```

---

### `Ray.linecast(x1, y1, x2, y2, excludeEntities?, mask?, out?)`

Checks if the path between two points is blocked. Returns `{ blocked, entityIndex, distance }`. Without `out`, the object is reused on the next linecast call.

`excludeEntities` can be a `Set<number>` or `Array<number>` of entity indices to skip.

```javascript
const los = Ray.linecast(enemy.x, enemy.y, player.x, player.y);
if (!los.blocked) enemy.shoot(player);
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

## Collision Layer Filtering

All methods default to `mask = 0xFFFFFFFF` (hit everything). Pass a bitmask to restrict which layers the ray can hit:

```javascript
import { layerMask } from '../core/utils.js';

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
- **Two internal functions**: `_checkCellEntities` (finds closest hit per cell) and `_collectCellHits` (collects all hits for `castAll`).
- **`_traverseGrid`**: shared DDA loop used by `cast`, `castWithInfo`, and `linecast`.
- **`cast`** and **`castAll`** have their own inlined DDA loops for performance.
- All temp objects (`_tempResult`, `_tempHitInfo`, `_tempLinecastResult`, `_tempHitsArray`) are static and reused across calls unless you pass an explicit `out`.

---

## Performance Notes

- Zero allocations in hot path (results are pre-allocated static objects by default, or caller-owned `out` objects/arrays).
- Layer mask filter is one bitwise AND per entity -- evaluated before any shape intersection math.
- `_excludeSet` for `linecastBetweenEntities` is a static `Set` that gets `.clear()`-ed and reused.
- `castAll` reuses a pool of hit objects; only allocates new ones if the pool grows (one-time cost).
