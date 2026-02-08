
# 🔬 Engineering Analysis: `pixi_worker.js`

## Overview

The renderer worker is a 3,545-line monolith managing **seven visual subsystems**: entity sprites, particle effects, decorations, tilemap backgrounds, decal tiles, a full-screen lighting shader, light glow sprites, and RenderTexture-based casted shadows. It extends `AbstractWorker` and renders via PixiJS 8 in an OffscreenCanvas web worker.

---

## 1. GC Pressure




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