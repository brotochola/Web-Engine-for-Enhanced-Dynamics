# Validation and Legacy Code Cleanup

## Summary

Removed all legacy/backwards compatibility code and added strict validation for `spriteConfig` format. All entities extending `RenderableGameObject` must now use the standardized format.

---

## Changes Made

### 1. **RenderableGameObject.js** - Added Validation Method

#### Changed: Default spriteConfig

**Before:**

```javascript
static spriteConfig = {
  spritesheet: null,
  animations: {},
  defaultAnimation: null,
  animationSpeed: 0.2,
};
```

**After:**

```javascript
static spriteConfig = null; // Must be overridden in subclasses
```

#### Added: Validation Method

```javascript
static validateSpriteConfig(EntityClass) {
  // Validates:
  // - spriteConfig exists
  // - Has 'type' field
  // - Static sprites have 'textureName'
  // - Animated sprites have 'spritesheet', 'defaultAnimation', 'animStates'
  // Returns: { valid: boolean, error: string|null }
}
```

**Validation Rules:**

- ❌ Missing `spriteConfig` → Error
- ❌ Missing `type` field → Error
- ❌ Static sprite without `textureName` → Error
- ❌ Animated sprite without `spritesheet` → Error
- ❌ Animated sprite without `defaultAnimation` → Error
- ❌ Animated sprite without `animStates` → Error (no more `animations` map)

---

### 2. **gameEngine.js** - Early Validation

#### Added: Validation in registerEntityClass()

Validation runs when registering entities (before initialization):

```javascript
// Validate spriteConfig for entities that extend RenderableGameObject
if (
  typeof RenderableGameObject !== "undefined" &&
  EntityClass.prototype instanceof RenderableGameObject &&
  count > 0
) {
  const validation = RenderableGameObject.validateSpriteConfig(EntityClass);
  if (!validation.valid) {
    console.error(`❌ ${validation.error}`);
    console.error(
      `   Please define a proper spriteConfig in ${EntityClass.name}`
    );
    console.error(`   See SPRITE_CONFIG_GUIDE.md for examples`);
    throw new Error(validation.error);
  }
}
```

**Benefits:**

- ✅ Fails fast (at registration time, not runtime)
- ✅ Clear error messages with guidance
- ✅ Only validates when instances will be created (count > 0)
- ✅ Skips validation for base classes

---

### 3. **pixi_worker.js** - Removed ALL Legacy Code

#### Removed Legacy #1: Old textureName Property Support

**Before (lines 282-290):**

```javascript
// Fallback for legacy textureName property (backwards compatibility)
else if (EntityClass.textureName) {
  this.entitySpriteConfigs[entityType] = {
    type: "static",
    textureName: EntityClass.textureName,
  };
  console.log(
    `✅ Mapped entityType ${entityType} (${registration.name}) -> texture "${EntityClass.textureName}" (legacy)`
  );
}
```

**After:**

```javascript
// REMOVED - Now requires proper spriteConfig
```

#### Removed Legacy #2: Old animations Map Support

**Before (lines 110-113):**

```javascript
// Legacy format: animations map with direct state->name mapping
else if (config.animations && config.animations[newState]) {
  animName = config.animations[newState];
}
```

**After:**

```javascript
// REMOVED - Now requires animStates
// Only looks for config.animStates[newState].name
```

#### Removed Legacy #3: config.animations[0] Fallback

**Before (line 420):**

```javascript
const defaultAnim =
  config.defaultAnimation ||
  config.animations[0] || // ← LEGACY FALLBACK
  Object.keys(sheet.animations)[0];
```

**After:**

```javascript
const defaultAnim = config.defaultAnimation;
// No fallback - must be explicitly defined
```

---

### 4. **New Validation in pixi_worker.js**

#### buildEntitySpriteConfigs() - Strict Validation

**Now validates:**

```javascript
// Must have spriteConfig
if (!EntityClass.spriteConfig) {
  console.error(`❌ ${registration.name} has no spriteConfig defined!`);
  continue;
}

// Must have type field
if (!config.type) {
  console.error(`❌ ${registration.name}.spriteConfig missing 'type' field!`);
  continue;
}
```

#### createSprites() - Better Error Messages

**Now validates:**

```javascript
if (!config) {
  console.error(`❌ No sprite config found for entityType ${entityType}!`);
  // Create placeholder sprite
}

// For animated sprites
if (!sheet) {
  console.error(`❌ Spritesheet "${config.spritesheet}" not found`);
}

if (!sheet.animations[defaultAnim]) {
  console.error(`❌ Default animation "${defaultAnim}" not found`);
}

// For static sprites
if (!texture) {
  console.error(`❌ Texture "${config.textureName}" not found`);
}
```

---

## What This Means for Developers

### ✅ Required Format

All entities extending `RenderableGameObject` **MUST** use:

**Static Sprites:**

```javascript
class MyEntity extends RenderableGameObject {
  static entityType = 0;

  static spriteConfig = {
    type: "static",
    textureName: "bunny",
  };
}
```

**Animated Sprites:**

```javascript
class MyEntity extends RenderableGameObject {
  static entityType = 1;

  static spriteConfig = {
    type: "animated",
    spritesheet: "person",
    defaultAnimation: "idle",
    animationSpeed: 0.15,
    animStates: {
      0: { name: "idle", label: "IDLE" },
      1: { name: "walk", label: "WALK" },
    },
  };
}
```

### ❌ No Longer Supported

**These old formats will cause errors:**

```javascript
// ❌ Direct textureName property (without spriteConfig)
static textureName = "bunny";

// ❌ Using 'animations' instead of 'animStates'
static spriteConfig = {
  animations: { 0: "idle", 1: "walk" }  // Wrong!
};

// ❌ Missing type field
static spriteConfig = {
  textureName: "bunny"  // Missing type: "static"
};

// ❌ Missing animStates for animated sprites
static spriteConfig = {
  type: "animated",
  spritesheet: "person",
  animations: { ... }  // Should be animStates!
};
```

---

## Error Messages Guide

### Registration Time Errors (GameEngine)

**Error:**

```
❌ Boid extends RenderableGameObject but has no spriteConfig defined!
   Please define a proper spriteConfig in Boid
   See SPRITE_CONFIG_GUIDE.md for examples
```

**Fix:** Add `static spriteConfig = { ... }` to your class

---

**Error:**

```
❌ Boid.spriteConfig missing 'type' field! Use type: 'static' or 'animated'
```

**Fix:** Add `type: "static"` or `type: "animated"` to your spriteConfig

---

**Error:**

```
❌ Boid.spriteConfig type is 'static' but missing 'textureName' field!
```

**Fix:** Add `textureName: "bunny"` to your spriteConfig

---

**Error:**

```
❌ Prey.spriteConfig type is 'animated' but missing 'animStates' field!
   Use animStates instead of animations.
```

**Fix:** Change `animations: {...}` to `animStates: {...}` using the new format

---

### Runtime Errors (PixiRenderer)

**Error:**

```
❌ Texture "bunny" not found for entityType 0
```

**Fix:** Make sure the texture is loaded in GameEngine initialization:

```javascript
const gameEngine = new GameEngine(
  {
    /* config */
  },
  {
    bunny: "img/bunny.png", // ← Must be here
  }
);
```

---

**Error:**

```
❌ Spritesheet "person" not found for entityType 1
```

**Fix:** Make sure the spritesheet is loaded:

```javascript
const gameEngine = new GameEngine(
  {
    /* config */
  },
  {
    spritesheets: {
      person: {
        json: "img/person.json",
        png: "img/person.png",
      },
    },
  }
);
```

---

**Error:**

```
❌ Default animation "idle" not found in spritesheet "person"
```

**Fix:** Check that the animation name matches what's in your spritesheet JSON

---

## Benefits of This Change

### 1. **Fail Fast**

- Errors caught at registration time (before game starts)
- No silent fallbacks that hide problems
- Clear error messages with actionable fixes

### 2. **Consistency**

- All entities use the same format
- No confusion about which format to use
- Easier to maintain and understand

### 3. **Better Developer Experience**

- Clear validation errors
- Helpful error messages
- Reference to documentation (SPRITE_CONFIG_GUIDE.md)

### 4. **Cleaner Codebase**

- Removed ~50 lines of legacy/fallback code
- Simpler logic in pixi_worker
- Less branching and edge cases

### 5. **Type Safety**

- Enforced structure prevents typos
- Required fields catch configuration errors
- Consistent API surface

---

## Migration Checklist

If you have entities using old formats:

- [ ] Check all classes extending `RenderableGameObject`
- [ ] Add `type` field to all `spriteConfig` objects
- [ ] Convert `animations: {...}` to `animStates: { 0: { name: "...", label: "..." } }`
- [ ] Remove any `static textureName` properties (move to spriteConfig)
- [ ] Test that all entities render correctly
- [ ] Check console for any validation errors

---

## Files Modified

1. ✅ `lib/RenderableGameObject.js` - Added validation, updated default spriteConfig
2. ✅ `lib/gameEngine.js` - Added validation in registerEntityClass()
3. ✅ `lib/pixi_worker.js` - Removed all legacy code, added strict validation

---

## See Also

- `SPRITE_CONFIG_GUIDE.md` - Complete guide with examples
- `ANIMATION_SYSTEM.md` - Animation system documentation
- `README.md` - General project documentation
