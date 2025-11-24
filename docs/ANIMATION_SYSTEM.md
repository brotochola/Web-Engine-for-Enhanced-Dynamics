# Animation System Documentation

## Overview

The game engine now supports animated sprites using spritesheets! This system combines the performance of SharedArrayBuffer with the flexibility of PixiJS AnimatedSprites.

## Architecture

### Key Components

1. **RenderableGameObject** - Base class that extends GameObject with rendering properties
2. **Spritesheet Loading** - Automatic loading of JSON + PNG spritesheet files
3. **Animation State Buffer** - Fast SharedArrayBuffer-based animation control
4. **Per-Entity Containers** - Each entity has its own PIXI.Container for complex visuals

## How It Works

### 1. Data Flow

```
Logic Worker (Prey/Predator)
    ↓ (writes to SharedArrayBuffer)
RenderableGameObject.animationState[i] = ANIM_RUN
    ↓ (reads from SharedArrayBuffer)
Pixi Worker
    ↓
Sprite changes animation to "run"
```

### 2. Class Structure

```
GameObject (physics, transform)
    ↓
RenderableGameObject (rendering properties)
    ↓
Boid (flocking behavior)
    ↓
Prey / Predator (game-specific logic)
```

## Usage Guide

### Step 1: Configure Spritesheets

In `index.html`, configure your spritesheets:

```javascript
const gameEngine = new GameEngine(
  {
    /* config */
  },
  {
    // Simple textures
    bg: "img/fondo.jpg",

    // Spritesheets
    spritesheets: {
      person: {
        json: "img/person.json",
        png: "img/person.png",
      },
      perro: {
        json: "img/perro.json",
        png: "img/perro.png",
      },
    },
  }
);
```

### Step 2: Define Sprite Config in Entity Class

In your entity class (e.g., `Prey.js`):

```javascript
class Prey extends Boid {
  static entityType = 1;

  // Configure which spritesheet to use
  static spriteConfig = {
    spritesheet: "person", // Name from spritesheets config
    animations: {
      0: "parado", // Animation state 0 → "parado" animation
      1: "caminar", // Animation state 1 → "caminar" animation
      2: "correr", // Animation state 2 → "correr" animation
    },
    defaultAnimation: "parado", // Starting animation
    animationSpeed: 0.15, // Playback speed
  };

  // Define constants for readability
  static ANIM_IDLE = 0;
  static ANIM_WALK = 1;
  static ANIM_RUN = 2;
}
```

### Step 3: Control Animations in Logic

In your `tick()` method, set animation states:

```javascript
tick(dtRatio, neighborData, inputData) {
  const i = this.index;

  // Calculate speed
  const speed = Math.sqrt(GameObject.vx[i]**2 + GameObject.vy[i]**2);

  // Set animation based on speed
  if (speed > 5) {
    RenderableGameObject.animationState[i] = Prey.ANIM_RUN;
  } else if (speed > 1) {
    RenderableGameObject.animationState[i] = Prey.ANIM_WALK;
  } else {
    RenderableGameObject.animationState[i] = Prey.ANIM_IDLE;
  }

  // Flip sprite based on direction
  RenderableGameObject.flipX[i] = GameObject.vx[i] < 0 ? 1 : 0;

  // Change tint based on state
  RenderableGameObject.tint[i] = isPanicking ? 0xFF0000 : 0xFFFFFF;
}
```

## Available Rendering Properties

All accessible via `RenderableGameObject` arrays:

### Animation Control

- `animationState[i]` - Animation index (0-255)
- `animationFrame[i]` - Manual frame control
- `animationSpeed[i]` - Playback speed multiplier

### Visual Effects

- `tint[i]` - Color tint (0xFFFFFF = normal)
- `alpha[i]` - Transparency (0-1)

### Sprite Modifications

- `flipX[i]` - Flip horizontally (0/1)
- `flipY[i]` - Flip vertically (0/1)
- `scaleX[i]` - X scale
- `scaleY[i]` - Y scale

### Rendering Options

- `spriteVariant[i]` - Sprite variant/skin
- `zOffset[i]` - Z-index offset for layering
- `blendMode[i]` - Blend mode
- `renderVisible[i]` - Force visibility override

## Advanced: Message-Based Commands

For rare/complex operations that can't be done via SharedArrayBuffer:

```javascript
// Set complex sprite property
this.setSpriteProp("texture", someTexture);

// Call sprite method
this.callSpriteMethod("gotoAndPlay", [10]);

// Batch updates
this.updateSprite({
  set: { alpha: 0.5, "scale.x": 2 },
  call: { method: "play", args: [] },
});
```

## Entity Containers

Each entity has a PIXI.Container, allowing you to:

- Add multiple sprites (body, hat, weapon, shadow)
- Layer sprites with z-index
- Apply transforms to the entire entity

The main body sprite is automatically created and managed by the renderer.

## Performance Considerations

### Fast (SharedArrayBuffer)

✅ Animation state changes
✅ Tint/alpha changes
✅ Flipping sprites
✅ Scale modifications

### Slow (Messages)

⚠️ Adding/removing sprites
⚠️ Changing textures
⚠️ Complex sprite operations

**Best Practice:** Use SharedArrayBuffer for frequent updates, messages for rare events.

## Example: Complete Entity Setup

```javascript
class MyEntity extends RenderableGameObject {
  static entityType = 3;

  static spriteConfig = {
    spritesheet: "mycharacter",
    animations: {
      0: "idle",
      1: "walk",
      2: "run",
      3: "attack",
    },
    defaultAnimation: "idle",
    animationSpeed: 0.2,
  };

  static ANIM_IDLE = 0;
  static ANIM_WALK = 1;
  static ANIM_RUN = 2;
  static ANIM_ATTACK = 3;

  constructor(index, config, logicWorker) {
    super(index, config, logicWorker);
    // Initialize your entity...
  }

  tick(dtRatio, neighborData, inputData) {
    const i = this.index;

    // Your game logic...

    // Update animation
    const speed = Math.sqrt(GameObject.vx[i] ** 2 + GameObject.vy[i] ** 2);
    if (this.isAttacking) {
      RenderableGameObject.animationState[i] = MyEntity.ANIM_ATTACK;
    } else if (speed > 3) {
      RenderableGameObject.animationState[i] = MyEntity.ANIM_RUN;
    } else if (speed > 0.5) {
      RenderableGameObject.animationState[i] = MyEntity.ANIM_WALK;
    } else {
      RenderableGameObject.animationState[i] = MyEntity.ANIM_IDLE;
    }

    // Flip sprite based on direction
    if (Math.abs(GameObject.vx[i]) > 0.1) {
      RenderableGameObject.flipX[i] = GameObject.vx[i] < 0 ? 1 : 0;
    }
  }
}
```

## Creating Spritesheets

Your spritesheet JSON must follow the PixiJS format with an `animations` object:

```json
{
  "frames": {
    "idle/0.png": {
      /* frame data */
    },
    "walk/0.png": {
      /* frame data */
    }
  },
  "animations": {
    "idle": ["idle/0.png", "idle/1.png"],
    "walk": ["walk/0.png", "walk/1.png"]
  },
  "meta": {
    "image": "spritesheet.png"
  }
}
```

Tools like [TexturePacker](https://www.codeandweb.com/texturepacker) or [Free Texture Packer](http://free-tex-packer.com/) can generate this format.

## Summary

The animation system provides:

- ✅ **Performance**: SharedArrayBuffer for fast state changes
- ✅ **Flexibility**: Message system for complex operations
- ✅ **Simplicity**: Just set `animationState[i]` to change animations
- ✅ **Power**: Full control over sprite properties and effects
- ✅ **Scalability**: Works with thousands of animated entities

This architecture follows Unity's philosophy: **logic sets data, renderer interprets it**.
