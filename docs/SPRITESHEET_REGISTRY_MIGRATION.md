# SpriteSheetRegistry - Migration Guide

## Overview

The SpriteSheetRegistry provides automatic animation indexing from spritesheet JSON files, eliminating manual configuration and reducing errors.

## What Changed

### ❌ OLD API (Before)

```javascript
class Prey extends Boid {
  static spriteConfig = {
    type: "animated",
    spritesheet: "lpc",
    defaultAnimation: "idle_down",
    animationSpeed: 0.15,

    // Manual mapping - error-prone!
    animStates: {
      0: { name: "idle_down", label: "IDLE" },
      1: { name: "walk_right", label: "WALK" },
    },
  };

  // Manual constants - must stay in sync!
  static anims = {
    IDLE: 0,
    WALK: 1,
  };

  updateAnimation() {
    if (speed > 0.1) {
      this.setAnimationState(Prey.anims.WALK); // Using constants
    } else {
      this.setAnimationState(Prey.anims.IDLE);
    }
  }
}
```

### ✅ NEW API (After)

```javascript
class Prey extends Boid {
  static spriteConfig = {
    type: "animated",
    spritesheet: "lpc", // That's it! All 52 animations automatically available
    defaultAnimation: "idle_down",
    animationSpeed: 0.15,
  };

  // No manual mapping needed!

  updateAnimation() {
    if (speed > 0.1) {
      this.setAnimation("walk_right"); // Use string names directly!
    } else {
      this.setAnimation("idle_down");
    }
  }
}
```

## Benefits

### 🚀 Performance (Zero Overhead)

```javascript
// COLD PATH (once per animation per class):
this.setAnimation("walk_right")
  → Registry lookup: "walk_right" → index 39
  → Cache result in Prey._animationCache["walk_right"] = 39

// HOT PATH (subsequent calls):
this.setAnimation("walk_right")
  → Read cached index: 39
  → Write to SharedArrayBuffer: SpriteRenderer.animationState[i] = 39
  → No string operations, no registry access!
```

**Result:** Same performance as manual numeric indices, but with better DX!

### ✅ Automatic Validation

```javascript
this.setAnimation("wlak_right"); // Typo!

// Console output:
// ❌ Animation "wlak_right" not found in "lpc"
//    Available animations: 52
//    Did you mean: walk_right, walk_up, walk_down?
```

### 📦 All Animations Available

No need to manually list animations - the entire spritesheet is automatically indexed:

```javascript
// lpc.json has 52 animations - ALL instantly available:
this.setAnimation("idle_down");
this.setAnimation("walk_right");
this.setAnimation("run_up");
this.setAnimation("spellcast_left");
this.setAnimation("shoot_down");
this.setAnimation("hurt");
// ... 46 more!
```

### 🔒 Type Safety

```javascript
// Optional: Custom animation settings
static spriteConfig = {
  spritesheet: "lpc",
  defaultAnimation: "idle_down",

  // Override speed for specific animations
  animations: {
    "walk_right": { speed: 0.15 },
    "run_up": { speed: 0.25 },
    "idle_down": { speed: 0.05 }
  }
};
```

## How It Works

### 1. Asset Loading (Main Thread)

```javascript
// GameEngine.preloadAssets() automatically:
const lpcJson = await fetch("lpc.json").then((r) => r.json());

// Registers spritesheet with animation index:
SpriteSheetRegistry.register("lpc", lpcJson);
// Creates mapping:
// {
//   "idle_down": { index: 0, frameCount: 2 },
//   "walk_right": { index: 1, frameCount: 9 },
//   "run_up": { index: 2, frameCount: 8 },
//   ...
// }
```

### 2. Worker Initialization

```javascript
// GameEngine sends serialized metadata to workers:
worker.postMessage({
  msg: "init",
  spritesheetMetadata: SpriteSheetRegistry.serialize(),
  // ... other data
});

// Logic workers deserialize:
SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
```

### 3. Runtime Usage

```javascript
// In your game code:
this.setAnimation("walk_right");

// Under the hood (GameObject.setAnimation):
// 1. Check class cache (first time only):
if (!Prey._animationCache["walk_right"]) {
  // Look up in registry (ONCE per animation per class)
  const index = SpriteSheetRegistry.getAnimationIndex("lpc", "walk_right");
  Prey._animationCache["walk_right"] = index; // Cache: 39
}

// 2. Use cached index (all subsequent calls):
const index = Prey._animationCache["walk_right"]; // 39

// 3. Write to SharedArrayBuffer:
SpriteRenderer.animationState[entityIndex] = 39; // Fast!
```

### 4. Rendering

```javascript
// Renderer worker reads numeric index from SharedArrayBuffer:
const animIndex = SpriteRenderer.animationState[i]; // 39
const animName = sheet.indexToName[animIndex]; // "walk_right"
const frames = sheet.animations[animName].frames; // Array of frame IDs
// Render the animation
```

## Performance Characteristics

| Operation              | Complexity | Notes                                                 |
| ---------------------- | ---------- | ----------------------------------------------------- |
| Registry lookup (cold) | O(1)       | Hash map lookup, happens once per animation per class |
| Cached lookup (hot)    | O(1)       | Direct property access from class cache               |
| Setting animation      | O(1)       | Direct SharedArrayBuffer write                        |
| Game loop overhead     | **0**      | Uses numeric indices directly, no string operations   |

## Migration Checklist

- [x] Remove `animStates` object from `spriteConfig`
- [x] Remove `static anims = { ... }` constants
- [x] Replace `this.setAnimationState(Entity.anims.WALK)` with `this.setAnimation("walk_right")`
- [x] Update all entity classes in your project
- [x] Test animations work correctly

## API Reference

### SpriteSheetRegistry Methods

```javascript
// Get animation index (returns undefined if not found)
const index = SpriteSheetRegistry.getAnimationIndex("lpc", "walk_right");
// → 39

// Get all animations for a spritesheet
const anims = SpriteSheetRegistry.getAnimationNames("lpc");
// → ["idle_down", "walk_right", "run_up", ...]

// Check if animation exists
const exists = SpriteSheetRegistry.hasAnimation("lpc", "walk_right");
// → true

// Get animation metadata
const data = SpriteSheetRegistry.getAnimationData("lpc", "walk_right");
// → { index: 39, frameCount: 9, frames: [...] }
```

### GameObject Methods

```javascript
// Set animation by name (recommended)
this.setAnimation("walk_right");

// Set animation by index (legacy, still works)
this.setAnimationState(39);

// Set animation speed
this.setAnimationSpeed(0.15);
```

## Advanced Usage

### Debug Logging

```javascript
// In development, log available animations:
console.log(
  "Available animations:",
  SpriteSheetRegistry.getAnimationNames("lpc")
);
```

### Custom Animation Settings

```javascript
static spriteConfig = {
  spritesheet: "lpc",
  defaultAnimation: "idle_down",

  // Per-animation configuration
  animations: {
    "walk_right": { speed: 0.15, loop: true },
    "hurt": { speed: 0.3, loop: false },
  }
};
```

### Validation During Development

```javascript
// Entity registration automatically validates spriteConfig:
gameEngine.registerEntityClass(Prey, 100, "demos/predators/prey.js");

// If invalid:
// ❌ Prey: Unknown spritesheet "lcp" (typo!)
//    Available: lpc, enemy_sprites, ui_icons
```

## Files Changed

- ✅ `src/core/SpriteSheetRegistry.js` - New registry implementation
- ✅ `src/core/gameEngine.js` - Integration with asset loading
- ✅ `src/core/gameObject.js` - Added `setAnimation()` method
- ✅ `src/workers/logic_worker.js` - Registry deserialization
- ✅ `demos/predators/prey.js` - Migrated to new API
- ✅ `demos/predators/predator.js` - Migrated to new API

## Summary

The SpriteSheetRegistry provides:

- ✅ **Automatic indexing** from spritesheet JSON
- ✅ **Zero runtime overhead** via per-class caching
- ✅ **Better error messages** with typo suggestions
- ✅ **Simpler API** - no manual mapping needed
- ✅ **Type safety** - validates animations exist
- ✅ **Backwards compatible** - `setAnimationState()` still works

**Result:** Cleaner code, fewer errors, same performance! 🚀
