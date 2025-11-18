# Sprite Configuration Guide

## Overview

This guide explains the standardized `spriteConfig` format for defining entity rendering in the game engine. All entities should use this consistent format whether they use static sprites or animated spritesheets.

## Standardized Format

### Static Sprites (Non-Animated)

Use this format for entities that use a single texture without animation:

```javascript
class MyEntity extends RenderableGameObject {
  static entityType = 0; // Unique ID

  static spriteConfig = {
    type: "static", // Indicates static sprite
    textureName: "bunny", // Name of texture (must be loaded in GameEngine)
  };
}
```

**Example:** `Boid` class uses static sprite

```javascript
static spriteConfig = {
  type: 'static',
  textureName: 'bunny',
};
```

### Animated Sprites (Spritesheets)

Use this format for entities that use animated spritesheets:

```javascript
class MyEntity extends RenderableGameObject {
  static entityType = 1; // Unique ID

  static spriteConfig = {
    type: "animated", // Indicates animated sprite
    spritesheet: "person", // Name of spritesheet
    defaultAnimation: "idle", // Starting animation
    animationSpeed: 0.15, // Playback speed (0.1 = slow, 0.3 = fast)

    // Animation states - maps state index to animation details
    animStates: {
      0: { name: "idle", label: "IDLE" }, // State 0
      1: { name: "walk", label: "WALK" }, // State 1
      2: { name: "run", label: "RUN" }, // State 2
      3: { name: "jump", label: "JUMP" }, // State 3
    },
  };

  // Animation state constants for code readability
  static ANIM_IDLE = 0;
  static ANIM_WALK = 1;
  static ANIM_RUN = 2;
  static ANIM_JUMP = 3;
}
```

**Example:** `Prey` class uses animated spritesheet

```javascript
static spriteConfig = {
  type: 'animated',
  spritesheet: 'person',
  defaultAnimation: 'parado',
  animationSpeed: 0.15,

  animStates: {
    0: { name: 'parado', label: 'IDLE' },   // Idle/standing
    1: { name: 'caminar', label: 'WALK' },  // Walking
    2: { name: 'caminar', label: 'RUN' },   // Running
    3: { name: 'caminar', label: 'FLEE' },  // Fleeing
  }
};

// Constants for easy reference
static ANIM_IDLE = 0;
static ANIM_WALK = 1;
static ANIM_RUN = 2;
static ANIM_FLEE = 3;
```

## Benefits of Standardization

### 1. **Consistency**

- All entities use the same configuration structure
- Easy to understand at a glance what rendering method is used
- Reduces cognitive load when working with different entity types

### 2. **Self-Documenting**

- The `type` field makes it immediately clear if sprite is static or animated
- Animation states are colocated with their definitions
- Labels provide human-readable descriptions

### 3. **Type Safety**

- Clear structure makes it easier to add validation
- Reduces errors from inconsistent configuration

### 4. **Flexibility**

- Easy to extend with new properties (e.g., blend modes, filters)
- Can add entity-specific rendering options without breaking the pattern

### 5. **Better Tooling**

- IDE autocomplete works better with consistent structure
- Easier to generate documentation automatically
- Simpler to create visual editors or configuration tools

## How It Works

### In the Renderer (pixi_worker.js)

The renderer detects the configuration type and creates the appropriate sprite:

```javascript
if (config.type === "animated" || config.spritesheet) {
  // Create AnimatedSprite from spritesheet
  const sheet = this.spritesheets[config.spritesheet];
  bodySprite = new PIXI.AnimatedSprite(
    sheet.animations[config.defaultAnimation]
  );
} else if (config.type === "static" || config.textureName) {
  // Create static Sprite from texture
  const texture = this.textures[config.textureName];
  bodySprite = new PIXI.Sprite(texture);
}
```

### Animation State Updates

When you change an entity's animation state in code:

```javascript
// In your entity's tick() method:
RenderableGameObject.animationState[this.index] = Prey.ANIM_WALK;
```

The renderer automatically:

1. Detects the state change
2. Looks up the animation name from `animStates`
3. Switches to the new animation
4. Continues playback

## Animation States Deep Dive

### Why Use animStates?

The `animStates` object provides:

1. **Index-based access** for SharedArrayBuffer (fast, memory-efficient)
2. **Named animations** for flexibility (same state can map to different animations)
3. **Labels** for debugging and tooling

### Structure

```javascript
animStates: {
  [stateIndex]: {
    name: 'animationName',  // Must match name in spritesheet JSON
    label: 'READABLE_NAME'  // For debugging/logging
  }
}
```

### Example Use Cases

**Multiple states using same animation:**

```javascript
animStates: {
  1: { name: 'walk', label: 'WALK' },
  2: { name: 'walk', label: 'RUN' },    // Same animation, different semantic
  3: { name: 'walk', label: 'FLEE' },   // Same animation, different semantic
}
```

**Different animations per state:**

```javascript
animStates: {
  0: { name: 'idle', label: 'IDLE' },
  1: { name: 'walk', label: 'WALK' },
  2: { name: 'run', label: 'RUN' },     // Different animation
  3: { name: 'sprint', label: 'SPRINT' }, // Different animation
}
```

## Migration Guide

### From Legacy textureName

**Before:**

```javascript
static textureName = "bunny";
```

**After:**

```javascript
static spriteConfig = {
  type: 'static',
  textureName: 'bunny',
};
```

### From Legacy animations map

**Before:**

```javascript
static spriteConfig = {
  spritesheet: "person",
  animations: {
    0: "idle",
    1: "walk",
  },
  defaultAnimation: "idle",
  animationSpeed: 0.15,
};
```

**After:**

```javascript
static spriteConfig = {
  type: 'animated',
  spritesheet: 'person',
  defaultAnimation: 'idle',
  animationSpeed: 0.15,
  animStates: {
    0: { name: 'idle', label: 'IDLE' },
    1: { name: 'walk', label: 'WALK' },
  }
};
```

**Note:** The old format is still supported for backwards compatibility, but new code should use the standardized format.

## Advanced Features

### Custom Anchor Points

```javascript
static spriteConfig = {
  type: 'static',
  textureName: 'bunny',
  anchor: { x: 0.5, y: 0.5 },  // Center anchor
};
```

### Custom Scale

```javascript
static spriteConfig = {
  type: 'animated',
  spritesheet: 'person',
  defaultAnimation: 'idle',
  animationSpeed: 0.15,
  scale: 2.0,  // Double size
  animStates: { /* ... */ }
};
```

### Blend Modes

```javascript
static spriteConfig = {
  type: 'static',
  textureName: 'particle',
  blendMode: 'ADD',  // Additive blending
};
```

## Best Practices

1. **Always specify type** - Makes code self-documenting
2. **Use descriptive labels** - Helps with debugging
3. **Keep constants** - Animation state constants improve code readability
4. **Group related states** - Organize animation states logically
5. **Comment intent** - Explain why certain animations are reused

## Examples from Game

### Boid (Static)

```javascript
static spriteConfig = {
  type: 'static',
  textureName: 'bunny',
};
```

### Prey (Animated)

```javascript
static spriteConfig = {
  type: 'animated',
  spritesheet: 'person',
  defaultAnimation: 'parado',
  animationSpeed: 0.15,
  animStates: {
    0: { name: 'parado', label: 'IDLE' },
    1: { name: 'caminar', label: 'WALK' },
    2: { name: 'caminar', label: 'RUN' },
    3: { name: 'caminar', label: 'FLEE' },
  }
};
```

### Predator (Animated)

```javascript
static spriteConfig = {
  type: 'animated',
  spritesheet: 'personaje',
  defaultAnimation: 'caminarDerecha',
  animationSpeed: 0.15,
  animStates: {
    0: { name: 'caminarDerecha', label: 'IDLE' },
    1: { name: 'caminarDerecha', label: 'WALK' },
    2: { name: 'caminarDerecha', label: 'RUN' },
    3: { name: 'caminarDerecha', label: 'HUNT' },
  }
};
```

## Summary

The standardized `spriteConfig` format provides:

- ✅ Consistent API across all entity types
- ✅ Clear distinction between static and animated sprites
- ✅ Self-documenting configuration
- ✅ Backwards compatibility with legacy formats
- ✅ Easy to extend and maintain
- ✅ Better developer experience

Use this format for all new entities to maintain code quality and consistency!
