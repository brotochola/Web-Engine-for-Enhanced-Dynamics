# BigAtlas Implementation

## Overview

The BigAtlas system automatically combines all game assets (individual images and spritesheets) into a single texture atlas at runtime. This optimization reduces draw calls and improves rendering performance.

## Key Features

### 🎯 Transparent to Developers
- Developers continue using original spritesheet and texture names
- No code changes needed in entity classes
- The engine handles all atlas generation and lookup internally

### 🚀 Automatic Asset Packing
- Uses MaxRects bin-packing algorithm for efficient space usage
- Configurable padding, max dimensions, and packing heuristics
- Generates atlas on game startup (no build step required)

### 🔗 Proxy Sheet System
- Original spritesheet names remain valid
- Internal redirection to bigAtlas with prefixed animation names
- Example: `lpc.idle_down` → `bigAtlas.lpc_idle_down`

## Architecture

### 1. Asset Loading Flow

```
Game Startup
    ↓
GameEngine.preloadAssets()
    ↓
SpriteSheetRegistry.createBigAtlas()
    ↓
[Load all PNGs & JSONs]
    ↓
[Extract frames from spritesheets]
    ↓
[Pack all frames using MaxRects]
    ↓
[Generate combined atlas PNG + JSON]
    ↓
[Register bigAtlas + proxy sheets]
    ↓
Transfer to PixiJS Worker
```

### 2. Proxy Lookup System

```javascript
// Developer code (unchanged):
class Prey extends Entity {
    static spriteConfig = {
        spritesheet: "lpc",
        defaultAnimation: "idle_down"
    }
}

// Internal registry structure:
{
    "lpc": {
        isProxy: true,
        targetSheet: "bigAtlas",
        prefix: "lpc_",
        animations: { idle_down: {...}, walk_right: {...} }
    },
    "bigAtlas": {
        isProxy: false,
        animations: {
            "lpc_idle_down": {...},
            "lpc_walk_right": {...},
            "person_walk_right": {...},
            "bunny": [...]  // Single-frame animation
        }
    }
}

// Lookup flow:
getAnimationIndex("lpc", "idle_down")
    → Check "lpc" is proxy
    → Redirect to bigAtlas with prefix
    → Look up "lpc_idle_down" in bigAtlas
    → Return animation index
```

### 3. Static Texture Handling

Individual images (like `bunny.png`) are converted to single-frame animations:

```javascript
// Input:
{ bunny: "/img/bunny.png" }

// Output in bigAtlas:
{
    frames: { bunny: { frame: {x, y, w, h}, ... } },
    animations: { bunny: ["bunny"] }  // Single-frame array
}

// PixiJS worker extracts to this.textures["bunny"]
// Static sprites work unchanged
```

## Implementation Details

### Modified Files

1. **`src/core/SpriteSheetRegistry.js`**
   - Added `MaxRectsPacker` class (bin-packing algorithm)
   - Added `createBigAtlas()` method (main atlas generation)
   - Updated `getAnimationIndex()` for proxy lookups
   - Updated `getAnimationData()`, `getAnimationName()`, `hasAnimation()` for proxy support
   - Added helper methods: `_loadImage()`, `_loadSpritesheet()`, `registerProxy()`

2. **`src/core/gameEngine.js`**
   - Replaced `preloadAssets()` implementation
   - Now generates bigAtlas instead of loading individual assets
   - Registers proxy sheets automatically

3. **`src/workers/pixi_worker.js`**
   - Updated `loadSpritesheets()` to populate `this.textures` from bigAtlas
   - Static textures now accessible via frame names from bigAtlas

### Configuration Options

```javascript
const bigAtlas = await SpriteSheetRegistry.createBigAtlas(assetsConfig, {
    maxWidth: 4096,      // Maximum atlas width
    maxHeight: 4096,     // Maximum atlas height
    padding: 2,          // Padding between sprites (prevents bleeding)
    heuristic: "best-short-side"  // Packing algorithm
    // Options: "best-short-side", "best-long-side", "best-area", "bottom-left"
});
```

## Usage Example

### Before (Multiple Textures)
```javascript
const gameEngine = new GameEngine(config, {
    bg: "/img/fondo.jpg",
    bunny: "/img/bunny.png",
    spritesheets: {
        person: { json: "/img/person.json", png: "/img/person.png" },
        lpc: { json: "/img/lpc.json", png: "/img/lpc.png" }
    }
});
```

### After (Same Code, BigAtlas Generated Automatically)
```javascript
// Exact same code - bigAtlas generated internally!
const gameEngine = new GameEngine(config, {
    bg: "/img/fondo.jpg",
    bunny: "/img/bunny.png",
    spritesheets: {
        person: { json: "/img/person.json", png: "/img/person.png" },
        lpc: { json: "/img/lpc.json", png: "/img/lpc.png" }
    }
});

// Entity classes remain unchanged:
class Prey extends Entity {
    static spriteConfig = {
        spritesheet: "lpc",           // Still references "lpc"
        defaultAnimation: "idle_down" // Original animation name
    }
}

class Boid extends Entity {
    static spriteConfig = {
        type: "static",
        textureName: "bunny"  // Still references "bunny"
    }
}
```

## Performance Benefits

### Draw Call Reduction
- **Before**: N draw calls (one per unique texture)
- **After**: 1 draw call (single bigAtlas texture)
- **Example**: 4 spritesheets + 2 images = 6 textures → 1 texture

### GPU Optimization
- Single texture binding per frame
- Better texture cache utilization
- Reduced texture swapping overhead

### Memory Layout
- Contiguous texture memory
- Efficient texture atlas lookups
- No texture fragmentation

## Testing

Run the test page to verify bigAtlas generation:

```bash
# Open in browser (requires local server):
http://localhost/multithreadad-game-engine/test_bigatlas.html
```

Or test with the predators demo:

```bash
http://localhost/multithreadad-game-engine/demos/predators/
```

Expected console output:
```
🎨 Creating BigAtlas from assets...
  ✅ Loaded image: bg (1920x1080)
  ✅ Loaded image: bunny (26x37)
  ✅ Loaded spritesheet: person (64 frames, 8 animations)
  ✅ Loaded spritesheet: lpc (52 frames, 13 animations)
🎨 Packing 182 images into atlas...
✅ BigAtlas created: 2048x1024 with 182 frames, 23 animations
  🔗 Registered proxy sheet: person → bigAtlas
  🔗 Registered proxy sheet: lpc → bigAtlas
✅ BigAtlas ready with 4 proxy sheets
```

## Debugging

### Check Registry State
```javascript
// In browser console:
import { SpriteSheetRegistry } from './src/core/SpriteSheetRegistry.js';

// List all registered sheets
SpriteSheetRegistry.getSpritesheetNames();
// → ["bigAtlas", "person", "lpc", "personaje", "civil1"]

// Check if proxy
const sheet = SpriteSheetRegistry.spritesheets.get("lpc");
console.log(sheet.isProxy); // → true
console.log(sheet.targetSheet); // → "bigAtlas"
console.log(sheet.prefix); // → "lpc_"

// Test animation lookup
const index = SpriteSheetRegistry.getAnimationIndex("lpc", "idle_down");
console.log(index); // → Animation index in bigAtlas
```

### Verify Atlas Generation
```javascript
// Check bigAtlas metadata
const bigAtlasSheet = SpriteSheetRegistry.spritesheets.get("bigAtlas");
console.log(Object.keys(bigAtlasSheet.animations).length); // Total animations
console.log(bigAtlasSheet.meta.size); // Atlas dimensions
```

## Future Enhancements

### Potential Improvements
1. **Build-time generation**: Pre-generate atlas during build for faster startup
2. **Multiple atlases**: Automatically split into multiple atlases if exceeding size limits
3. **Compression**: Apply texture compression (basis, etc.)
4. **Hot reload**: Regenerate atlas on asset changes during development
5. **Atlas visualization**: Debug tool to visualize atlas packing

### Advanced Features
- Rotation support for better packing
- Trim transparent pixels for space savings
- Mipmap generation for better filtering
- Atlas metadata export for external tools

## Troubleshooting

### Issue: "Could not fit X into atlas"
**Solution**: Increase `maxWidth` or `maxHeight` in options

### Issue: "Animation not found"
**Solution**: Check that spritesheet JSON has `animations` property

### Issue: Static texture not rendering
**Solution**: Verify texture name matches asset config key

### Issue: Blurry sprites at atlas edges
**Solution**: Increase `padding` value (default: 2)

## Notes

- Atlas generation happens once at startup (< 1 second for typical games)
- All assets must be accessible via fetch() at startup
- CORS headers required for cross-origin assets
- Maximum atlas size limited by GPU (typically 4096x4096 or 8192x8192)

