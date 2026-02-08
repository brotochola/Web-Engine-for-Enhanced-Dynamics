
# 🔬 Engineering Analysis: `pixi_worker.js`

## Overview

The renderer worker is a 3,545-line monolith managing **seven visual subsystems**: entity sprites, particle effects, decorations, tilemap backgrounds, decal tiles, a full-screen lighting shader, light glow sprites, and RenderTexture-based casted shadows. It extends `AbstractWorker` and renders via PixiJS 8 in an OffscreenCanvas web worker.

---

## 1. GC Pressure





### 1.5 ⚠️ `shadowsByLight` Map Allocates Arrays Per Frame

```2022:2027:src/workers/pixi_worker.js
      if (!shadowsByLight.has(lightIdx)) {
        shadowsByLight.set(lightIdx, []);
        activeLightIndices.push(lightIdx);
      }
      shadowsByLight.get(lightIdx).push(i);
```

Each frame, `shadowsByLight.clear()` runs (line 2005), then new arrays are created via `[]` for each active light. With 10 lights, that's 10 array allocations plus internal Map entries every frame — all immediately eligible for GC.

**Fix**: Pre-allocate a pool of arrays (one per `maxLights`), or use a flat structure like `lightShadowOffsets[lightIdx]` + `lightShadowCounts[lightIdx]` backed by typed arrays.

### 1.6 ⚠️ `updateDecalTiles` Allocations (Acceptable)

```1191:1201:src/workers/pixi_worker.js
      const tileRGBAShared = new Uint8ClampedArray(
        this.decalTilesRGBA.buffer,
        tileByteOffset,
        bytesPerTile
      );
      const tileRGBA = new Uint8ClampedArray(tileRGBAShared);
      const imageData = new ImageData(tileRGBA, tilePixelSize, tilePixelSize);
```

Creates a view, a copy, and an `ImageData` per dirty tile per frame. Also creates a closure in the `.then()` callback (line 2208). These allocations are acceptable because dirty tiles should be rare (only when a new decal is stamped), but if particle_worker is stamping many decals simultaneously, this could produce bursts of GC pressure.

---

## 2. Performance

### 2.1 🔴 Duplicate Light Iteration (Major)

`updateLighting()` and `updateLightGlowSprites()` **both**:
1. Call `this.queryActiveEntities([LightEmitter])` — same query, same result
2. Reset `_lightPoolSize = 0`
3. Loop through all light entities
4. Perform identical viewport culling (`influenceRadius = 10 * sqrtLightIntensity[i]`)
5. Build the sorted `_lightPool`
6. Sort by distance to camera center

This means the engine iterates all lights, culls, sorts, and processes them **twice** every frame for functionally the same data. On a scene with 500 LightEmitter entities, that's ~1000 wasted iterations + two sorts.

**Fix**: Compute the sorted visible light list once in `update()` and pass it to both methods. Or merge them into a single pass.

### 2.2 🔴 Particle Loop Iterates ALL Slots (Major)

```2421:2421:src/workers/pixi_worker.js
    for (let i = 0; i < this.maxParticles; i++) {
```

This iterates every particle slot regardless of activity. With `maxParticles = 10000` and 200 active particles, 98% of iterations are wasted (checking `!active[i]` and continuing).

Entity sprites already use `queryActiveEntities()` to iterate only active entities. Particles don't have this — they iterate the entire pool. The same applies to decorations (line 2607).

**Fix**: Maintain a compact active particle list (like `activeEntitiesData`) or use a bitset to skip inactive ranges. Even a simple counter-based early exit (`if (visibleParticleCount >= knownActiveCount) break`) would help.

### 2.3 🔴 Decoration Loop Iterates ALL Slots (Major)

```2607:2607:src/workers/pixi_worker.js
    for (let i = 0; i < this.maxDecorations; i++) {
```

Same issue as particles. `DecorationPool.activeCount[0]` is available for an early exit. But with 5000 max decorations and only 100 on-screen, this is 4900 wasted iterations. The early exit on line 2552 (`if (activeCount[0] === 0)`) only catches the zero case.

**Fix**: Break once `visibleDecorationCount >= DecorationPool.activeCount[0]`, or maintain an active decoration list.

### 2.4 🟡 Container Rebuild Every Frame

```1007:1016:src/workers/pixi_worker.js
    this.particleContainer.particleChildren.length = 0;
    // ...
    for (let i = 0; i < poolSize; i++) {
      this.particleContainer.addParticle(pool[i].sprite);
    }
```

Every frame, ALL particles are removed from the container and re-added in sorted order. With 2000 visible sprites, that's 2000 `addParticle` calls (array pushes). The shadow container (line 2032) does the same.

This is a necessary cost if Y-sorting is enabled, since depth order changes every frame. But when `ySorting === false`, rebuilding is still forced (comment on line 991: "BUGFIX: Always rebuild"). If the container had incremental add/remove tracking, the non-Y-sorted path could avoid this.

### 2.5 🟡 `changeFrameOfSprite` Called for Every Visible Entity

```883:883:src/workers/pixi_worker.js
      this.changeFrameOfSprite(bodySprite, entityIndex, deltaSeconds);
```

This function is called for **all** visible entities, including static sprites. Inside:

```1024:1025:src/workers/pixi_worker.js
    const frames = this.currentAnimationFrames[i];
    if (frames && frames.length > 1) {
```

The guard catches non-animated sprites quickly, but the function call overhead + the array dereference (`this.currentAnimationFrames[i]`) still happen. With 2000 visible entities and only 500 animated, that's 1500 wasted function calls.

**Fix**: Check `SpriteRenderer.isAnimated[entityIndex]` before calling the function, or inline the guard into `updateSprites`.

### 2.6 🟡 `Timsort` vs Insertion Sort for Nearly-Sorted Data

```1001:1004:src/workers/pixi_worker.js
    if (this.ySorting) {
      // Sort by Y position using native Timsort (O(n log n), highly optimized)
      pool.sort(sortByY);
    }
```

Entities move incrementally between frames, so the array is nearly sorted. Native `Array.sort` (Timsort) is good at this (it detects runs), but a custom insertion sort would be O(n) for nearly-sorted data and avoid the overhead of Timsort's merge machinery. For 2000+ sprites, this could matter.

### 2.7 🟡 `Math.PI` Addition in Hot Shadow Loop

```2078:2078:src/workers/pixi_worker.js
        sprite.rotation = shadowRotation[shadowIdx] + Math.PI; // Point away from light
```

`Math.PI` is looked up via prototype chain every iteration. Hoist to a local: `const PI = Math.PI;` before the loop.

### 2.8 🟡 `convertRGBtoBGR` Per Light Per Frame

```2914:2914:src/workers/pixi_worker.js
      sprite.tint = convertRGBtoBGR(lightColor[entityIndex]);
```

The `lightColor` rarely changes, but the conversion runs every frame for every visible light glow sprite. The LightEmitter component already has an optimization pattern for `sqrtLightIntensity` — the same approach could cache a `bgrLightColor` to avoid per-frame conversion.

---

## 3. Cache Locality

### 3.1 🟡 15 Separate Array Reads Per Entity

`updateSprites()` touches these arrays per entity:

| Array | Component |
|-------|-----------|
| `active` | Transform |
| `x` | Transform |
| `y` | Transform |
| `rotation` | Transform |
| `animationState` | SpriteRenderer |
| `animationSpeed` | SpriteRenderer |
| `tint` | SpriteRenderer |
| `alpha` | SpriteRenderer |
| `scaleX` | SpriteRenderer |
| `scaleY` | SpriteRenderer |
| `anchorX` | SpriteRenderer |
| `anchorY` | SpriteRenderer |
| `renderVisible` | SpriteRenderer |
| `isItOnScreen` | SpriteRenderer |
| `renderDirty` | SpriteRenderer |

Each is a separate `SharedArrayBuffer`-backed typed array. For entity index `i`, accessing `Transform.x[i]` and `SpriteRenderer.tint[i]` are in completely different memory regions. With 2000 entities, each array is at least 8KB apart, so each entity touches ~15 distinct cache lines.

This is an inherent trade-off of the SoA (Structure of Arrays) ECS design — it's optimal for systems that read only 1-2 fields from many entities (e.g., physics reads `x, y, vx, vy`), but the renderer reads nearly everything, making AoS (Array of Structures) better for this specific worker.

**Mitigation** (within current architecture): The `renderDirty` flag is already a great optimization — most per-frame iterations only touch `x`, `y`, `rotation`, `scaleX`, `scaleY`, and skip the expensive property reads. This reduces the per-entity cache footprint from 15 to ~7 arrays for non-dirty entities.

### 3.2 🟡 13 Separate Array Reads Per Particle

Same SoA problem for particles in `updateParticleSprites()`: `active`, `x`, `y`, `z`, `scaleX`, `scaleY`, `alpha`, `tint`, `textureId`, `isItOnScreen`, `rotation`, `flipX`, `flipY` — 13 arrays.

### 3.3 🟡 Sparse `bodySprites` Array

`bodySprites` is a regular JS array of size `globalEntityCount`, filled with `null` for all unused slots. When iterating via `queryActiveEntities`, the access pattern jumps around this array, likely causing cache misses on every entity. This is unavoidable given the entity indexing design, but the array being a regular JS array (boxed objects) rather than typed means V8 stores it as a pointer array, doubling indirection.

---

## 4. Architectural Observations

### 4.1 🔴 Monolithic File (3,545 Lines)

The file manages 7+ distinct rendering subsystems:

| System | Lines | Responsibility |
|--------|-------|----------------|
| Entity sprites | ~200 | Sprite lifecycle, animation, dirty flags |
| Particle sprites | ~120 | Particle rendering, texture lookup |
| Decoration sprites | ~170 | Static decoration rendering, sway |
| Tilemap background | ~170 | Tiled JSON parsing, tile rendering |
| Decal tiles | ~70 | SharedArrayBuffer decal texture updates |
| Lighting shader | ~190 | Full-screen GLSL mesh, uniform updates |
| Light glow sprites | ~250 | Additive-blend glow particles |
| Shadow RenderTexture | ~280 | Interleaved light/shadow compositing |

Each could be a separate module with a clean interface, composed by the main renderer. The current structure makes it difficult to understand, modify, or disable individual systems.

### 4.2 🟡 Initialization Order Sensitivity

The `initialize()` method (line 3150) has a carefully orchestrated sequence: textures → spritesheets → tilemaps → decals → shadow RT → particle container → lighting → glow → sprites. Several systems have cross-dependencies (shadows need BigAtlas textures, glow needs lighting enabled). This implicit ordering is fragile and hard to reason about.

### 4.3 🟡 Excessive Debug Logging

```1648:1651:src/workers/pixi_worker.js
    console.log(
      `🔍 PIXI WORKER: createLightGlowSystem() called. Checking for _lightGradient texture...`
    );
    console.log(`   Total textures available: ${Object.keys(this.textures).length}`);
    console.log(`   _lightGradient in textures: ${'_lightGradient' in this.textures}`);
```

There are ~40+ `console.log`/`console.warn` calls throughout, many with emoji prefixes and template literals. While useful during development, these:
- Allocate strings (GC pressure in init, acceptable)
- Call `Object.keys()` (line 1650) creating temporary arrays
- Clutter the console in production

The one-time logging guards (`this._lightGlowWarningLogged`, `this._lightGlowUpdateLogged`, `this._lightGlowFirstUpdateLogged`, `this._lightGlowSpriteUpdateLogged`) are a good pattern but add 4 boolean properties for a single system.

### 4.4 🟡 Inconsistent Sentinel Values

| Array | Sentinel for "empty" |
|-------|---------------------|
| `bodySprites[]` | `null` |
| `bodySpritePoolIndices[]` | `0xFFFF` |
| `previousAnimStates[]` | `-1` |
| `_shadowPrevEntityIdx[]` | `0xFFFF` |

Three different conventions for "no value." The `0xFFFF` sentinel limits pool sizes to 65,534 items — not documented.

---

## 5. Positive Engineering Highlights

| Feature | Location | Why It's Good |
|---------|----------|---------------|
| **Dirty flag optimization** | `renderDirty` check (line 855) | Skips expensive visual property updates for unchanged entities |
| **Lazy sprite creation** | Lines 820-846 | Only creates PIXI sprites when entities are visible on-screen, saving GPU memory |
| **Sprite release on off-screen** | Lines 904-921 | Returns sprites to pool when entities leave viewport — excellent memory management |
| **Centralized particle pool** | `PixiParticlePool` class | All visual elements (entities, particles, decorations) share one pool — maximum reuse |
| **Deferred pre-allocation** | `endFrame()` idle detection (lines 220-236) | Detects idle frames and pre-allocates based on demand history — avoids frame-time spikes |
| **Interpolation alpha** | Lines 959-974 | Smooth rendering at higher FPS than physics by interpolating toward physics positions |
| **Pre-calculated `sqrtLightIntensity`** | Used at lines 1444, 1829, 2112 | Avoids `Math.sqrt()` per light per frame — computed once on setter |
| **`extractRGBNormalizedMut`** | Line 1494 | Zero-allocation RGB extraction using reusable `_rgbResult` object |
| **Zoom-based decoration culling** | Lines 2564-2578 | Progressive fade-out at low zoom levels — smart LOD without complexity |

---

## 6. Summary of Recommendations (Priority Order)

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| 🔴 High | Merge duplicate light iteration | ~2× light processing speedup | Medium |
| 🔴 High | Skip inactive particles/decorations | Proportional to inactive/total ratio | Low |
| 🔴 High | Split monolithic file into subsystems | Maintainability, testability | High |
| 🟡 Med | Replace `particleTextureCache` string keys with typed array | Eliminates per-frame string allocation | Low |
| 🟡 Med | Stop using `delete` on cache object | Prevents V8 slow-mode transition | Trivial |
| 🟡 Med | Pre-allocate `shadowsByLight` arrays | Eliminates per-frame array allocation | Low |
| 🟡 Med | Guard `changeFrameOfSprite` with `isAnimated` | Skips function call for static sprites | Trivial |
| 🟡 Med | Cache `convertRGBtoBGR` result on LightEmitter | Eliminates per-frame conversion | Low |
| 🟢 Low | Hoist `Math.PI` in shadow loop | Minor CPU reduction | Trivial |
| 🟢 Low | Consider insertion sort for nearly-sorted Y-pool | Better complexity for incremental sorting | Medium |
| 🟢 Low | Standardize sentinel values | Code clarity | Low |
| 🟢 Low | Gate or remove debug console.logs | Reduce string allocation noise | Low |

The renderer is overall well-engineered with strong GC discipline (reusable pools, mutable result objects, dirty flags). The main wins are in **eliminating duplicate work** (light iteration), **skipping inactive slots** (particles/decorations), and **splitting the file** for long-term maintainability.