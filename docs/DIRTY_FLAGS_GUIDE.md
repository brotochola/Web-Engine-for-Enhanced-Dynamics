# Dirty Flags Optimization Guide

## What Are Dirty Flags?

Dirty flags are a performance optimization that tracks which entities have had their **visual properties** changed. Instead of updating all sprite properties every frame (60 times per second), we only update properties when they actually change.

## Performance Impact

**Before Dirty Flags:**

- Every frame: Update tint, alpha, flip, animation state, animation speed for ALL visible entities
- For 2000 entities: ~120,000 property assignments per second (even when nothing changed)

**After Dirty Flags:**

- Every frame: Only update position/rotation (which change frequently)
- Only update visual properties when `renderDirty` flag is set
- Typical savings: 70-80% reduction in sprite property updates

## How It Works

### Automatic Dirty Tracking

The `RenderableGameObject` class provides helper methods that automatically mark entities as dirty:

```javascript
class MyEntity extends RenderableGameObject {
  tick(dtRatio, inputData) {
    // ✅ GOOD: Using helper methods (auto-marks dirty)
    if (this.health < 30) {
      this.setTint(0xff0000); // Red when low health
    }

    if (this.isPowerUp) {
      this.setAlpha(0.5 + Math.sin(Date.now() * 0.01) * 0.5); // Pulsing effect
    }

    // Change animation based on state
    if (this.isMoving) {
      this.setAnimationState(1); // Walk animation
    } else {
      this.setAnimationState(0); // Idle animation
    }
  }
}
```

### Available Helper Methods

```javascript
// Animation control
this.setAnimationState(stateIndex); // Change animation
this.setAnimationSpeed(speed); // Change playback speed

// Visual effects
this.setTint(0xffffff); // Change color tint
this.setAlpha(0.5); // Change transparency

// Sprite modifications
this.setFlip(true, false); // Flip X, Y
this.setScale(1.5, 1.5); // Scale X, Y

// Visibility
this.setVisible(false); // Hide/show sprite

// Manual dirty marking (for advanced usage)
this.markDirty(); // Mark as needing update
```

### Manual Dirty Tracking (Advanced)

If you need to directly modify SharedArrayBuffer values, remember to mark as dirty:

```javascript
class MyEntity extends RenderableGameObject {
  tick(dtRatio, inputData) {
    // ⚠️ Direct array access - must manually mark dirty!
    if (this.shouldChangeColor) {
      RenderableGameObject.tint[this.index] = 0x00ff00;
      this.markDirty(); // ← IMPORTANT!
    }
  }
}
```

### What Gets Updated When?

#### Always Updated (Every Frame)

These properties change frequently and are always updated:

- `x`, `y` - Position
- `rotation` - Rotation
- `scaleX`, `scaleY` - Container scale
- `visible` - Visibility state
- `zIndex` - Draw order

#### Only When Dirty

These properties are expensive and only updated when `renderDirty = 1`:

- `tint` - Color tint
- `alpha` - Transparency
- `flipX`, `flipY` - Sprite flipping
- `animationState` - Current animation
- `animationSpeed` - Playback speed

## Best Practices

### ✅ DO

```javascript
// Use helper methods for convenience
this.setTint(0xff0000);
this.setAlpha(0.5);

// Check before changing to avoid unnecessary dirty flags
if (this.health < 30 && this.alpha !== 0.5) {
  this.setAlpha(0.5);
}

// Batch changes don't trigger multiple dirty flags
this.setFlip(true, false); // Single markDirty() call
```

### ❌ DON'T

```javascript
// Don't forget to mark dirty after direct array access
RenderableGameObject.tint[this.index] = 0xff0000;
// Missing: this.markDirty(); ← BUG!

// Don't mark dirty unnecessarily (wastes performance)
this.markDirty(); // Every frame for no reason

// Don't use direct array access when helpers exist
RenderableGameObject.alpha[this.index] = 0.5; // Use this.setAlpha(0.5) instead
```

## Performance Monitoring

To see the impact of dirty flags, check your renderer FPS:

```javascript
// Before: ~30 FPS with 2000 entities
// After: ~60 FPS with 2000 entities (with few visual changes per frame)
```

The performance gain is most noticeable when:

- Many entities are on screen
- Visual properties change infrequently (e.g., only on state changes)
- Entities mostly just move around (position updates only)

## Migration Guide

If you have existing code that directly modifies visual properties:

### Before

```javascript
class OldEntity extends RenderableGameObject {
  tick(dtRatio, inputData) {
    // Direct array access
    RenderableGameObject.tint[this.index] = this.currentColor;
    RenderableGameObject.alpha[this.index] = this.currentAlpha;
    RenderableGameObject.animationState[this.index] = this.currentAnim;
  }
}
```

### After

```javascript
class NewEntity extends RenderableGameObject {
  tick(dtRatio, inputData) {
    // Use helper methods (automatic dirty tracking)
    this.setTint(this.currentColor);
    this.setAlpha(this.currentAlpha);
    this.setAnimationState(this.currentAnim);
  }
}
```

## Debugging

If sprites aren't updating visually:

1. Check if you're using helper methods: `this.setTint()` vs direct access
2. Check if you're calling `markDirty()` after direct array modifications
3. Verify the dirty flag is working: `console.log(RenderableGameObject.renderDirty[this.index])`

## Technical Details

The dirty flag system works by:

1. Adding `renderDirty: Uint8Array` to SharedArrayBuffer
2. Setting `renderDirty[i] = 1` when visual properties change
3. Checking `renderDirty[i]` in `pixi_worker.js` before updating sprite properties
4. Clearing `renderDirty[i] = 0` after rendering the update

This reduces the rendering workload from O(entities × properties) to O(changed_entities × properties).
