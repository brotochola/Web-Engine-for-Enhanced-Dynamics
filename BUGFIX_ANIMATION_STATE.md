# Bug Fix: Animation State Stuck at 1

## Issue

When calling `this.setAnimation("walk_right")` or any animation other than index 0, the `SpriteRenderer.animationState` was always set to 1, regardless of the actual animation index.

```javascript
// This should set animationState to various indices:
this.setAnimation("idle_down"); // Should be 0, was 0 ✓
this.setAnimation("walk_right"); // Should be 39, was 1 ✗
this.setAnimation("run_up"); // Should be 2, was 1 ✗
this.setAnimation("spellcast_left"); // Should be 47, was 1 ✗
```

## Root Cause

The bug was in `Component.js` line 60-61:

```javascript
set(value) {
  ComponentClass[name][this.index] =
    type === Uint8Array ? (value ? 1 : 0) : value; // ← BUG!
}
```

This setter was **converting all Uint8Array values to boolean** (0 or 1):

- `value = 0` (falsy) → `0` ✓
- `value = 1` (truthy) → `1` ✓
- `value = 39` (truthy) → `1` ✗ **WRONG!**
- `value = 255` (truthy) → `1` ✗ **WRONG!**

The boolean conversion was intended for flag fields like `active`, but it broke numeric fields like `animationState` which need to store values 0-255.

## Fix

Remove the boolean conversion and store values directly:

```javascript
set(value) {
  // Store value directly - Uint8Array can hold 0-255
  ComponentClass[name][this.index] = value;
}
```

### Why This Works

JavaScript automatically handles type coercion for Uint8Array:

```javascript
// Boolean usage still works:
Uint8Array[i] = true; // → stores 1
Uint8Array[i] = false; // → stores 0

// Numeric usage now works:
Uint8Array[i] = 0; // → stores 0
Uint8Array[i] = 39; // → stores 39
Uint8Array[i] = 255; // → stores 255
```

## Affected Fields

### Fixed Fields (Now Store Full Range 0-255)

- ✅ `SpriteRenderer.animationState` - Animation index (0-255)
- ✅ `SpriteRenderer.spriteVariant` - Texture variant (0-255)
- ✅ `SpriteRenderer.blendMode` - Blend mode (0-255)
- ✅ `RigidBody.collisionCount` - Collision count (0-255)
- ✅ `Collider.shapeType` - Shape type (0=circle, 1=box, 2=polygon)

### Still Work Correctly (Boolean Fields)

- ✅ `Transform.active` - Entity active state (0 or 1)
- ✅ `SpriteRenderer.renderVisible` - Visibility flag (0 or 1)
- ✅ `SpriteRenderer.isItOnScreen` - Screen culling (0 or 1)
- ✅ `SpriteRenderer.renderDirty` - Dirty flag (0 or 1)
- ✅ `Collider.isTrigger` - Trigger mode (0 or 1)

## Renderer Worker Update

The `pixi_worker.js` also needed updating because it was using the old `config.animStates` API:

### Before (Broken):

```javascript
// OLD: Expected entity to have animStates object
if (!config.animStates || !config.animStates[newState]) return;
const animName = config.animStates[newState].name;
```

This expected the old manual mapping that we removed!

### After (Fixed):

```javascript
// NEW: Use SpriteSheetRegistry to convert index → name
const animName = SpriteSheetRegistry.getAnimationName(
  config.spritesheet,
  newState
);
```

Now the renderer uses the same registry as the logic workers for consistent animation lookups.

## Test

```javascript
// Before fix:
prey.setAnimation("walk_right");
console.log(SpriteRenderer.animationState[preyIndex]); // Was: 1 ✗

// After fix:
prey.setAnimation("walk_right");
console.log(SpriteRenderer.animationState[preyIndex]); // Now: 39 ✓

// Animation cache works correctly:
console.log(Prey._animationCache);
// {
//   "idle_down": 0,
//   "walk_right": 39,
//   "run_up": 2
// }

// Renderer correctly looks up animation name:
console.log(SpriteSheetRegistry.getAnimationName("lpc", 39)); // "walk_right" ✓
```

## Files Changed

- `src/core/Component.js` - Fixed setter to not convert Uint8Array to boolean
- `src/workers/pixi_worker.js` - Updated to use SpriteSheetRegistry instead of old `animStates` API
  - Added `SpriteSheetRegistry` import
  - Deserialize registry metadata during initialization
  - Updated `updateSpriteAnimation()` to use `getAnimationName()` instead of `config.animStates`

## Performance Impact

**Zero** - This fix actually _removes_ a conditional check, making setters slightly faster.

```javascript
// Before (slower):
value = type === Uint8Array ? (value ? 1 : 0) : value;

// After (faster):
value = value; // Direct assignment
```

## Summary

✅ Animation system now works correctly
✅ All 52 animations from lpc.json are now usable
✅ Boolean fields still work as expected
✅ Numeric Uint8Array fields can use their full range (0-255)
✅ No performance regression
