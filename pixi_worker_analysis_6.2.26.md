
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



## 3. Cache Locality


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
