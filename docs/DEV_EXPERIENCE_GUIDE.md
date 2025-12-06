# WeedJS Developer Experience Guide 🌿

## Minimal Boilerplate - What You Actually Need to Write

### The Absolute Minimum

Here's the **absolute minimum** code needed to create a custom entity:

```javascript
import WEED from "/src/index.js";
const { GameObject, RigidBody } = WEED;

class MyEntity extends GameObject {
  static components = [RigidBody];

  setup() {
    this.rigidBody.maxVel = 10;
  }

  tick(dtRatio) {
    // Your game logic here
  }
}
```

That's it! **No other boilerplate required.**

---

## Common Boilerplate - What's Optional vs Required

### ✅ REQUIRED: Component Declaration

```javascript
static components = [RigidBody, Collider, SpriteRenderer];
```

**Why?** The engine needs to know which components to allocate for this entity type.

---

### ⚠️ OPTIONAL (but recommended): Script URL

```javascript
static scriptUrl = import.meta.url;
```

**What it does:** Enables auto-detection of the script path for worker loading.

**Without it:** You must manually pass the script path to `registerEntityClass()`:

```javascript
// With scriptUrl (auto-detected) ✨
gameEngine.registerEntityClass(Ball, 1000);

// Without scriptUrl (manual path) 😓
gameEngine.registerEntityClass(Ball, 1000, "/demos/balls/ball.js");
```

**Recommendation:** Always include it! It's one line that saves you from tracking file paths.

---

### ❌ NOT REQUIRED: Static Instances Array

```javascript
static instances = []; // DON'T WRITE THIS!
```

**This is automatically created by the engine!** You'll see it in some example code, but it's legacy boilerplate that can be removed.

The engine handles this internally:

```javascript
// In gameEngine.js - automatically done for you
if (!EntityClass.hasOwnProperty("instances")) {
  EntityClass.instances = [];
}
```

---

## Migration Guide - Cleaning Up Old Code

If you have existing entity classes with unnecessary boilerplate, here's how to clean them up:

### Before (with boilerplate):

```javascript
class Prey extends Boid {
  static scriptUrl = import.meta.url;
  static instances = []; // ❌ Not needed!
  // entityType auto-assigned during registration (no manual ID needed!)
  static components = [...Boid.components, PreyBehavior];

  setup() {
    /* ... */
  }
}
```

### After (cleaned up):

```javascript
class Prey extends Boid {
  static scriptUrl = import.meta.url; // ✅ Keep this
  static components = [...Boid.components, PreyBehavior]; // ✅ Keep this

  setup() {
    /* ... */
  }
}
```

**Removed:**

- `static instances = []` - Auto-initialized by engine
- Comments explaining auto-assignment - Obvious from the code

---

## Advanced: Further Boilerplate Reduction

### Option 1: Create a Base Class with `scriptUrl`

If you want to eliminate `scriptUrl` entirely, you could create a helper:

```javascript
// entityHelper.js
export function captureScriptUrl(EntityClass, scriptUrl) {
  EntityClass.scriptUrl = scriptUrl;
  return EntityClass;
}

// Your entity file
import { captureScriptUrl } from "./entityHelper.js";

class Ball extends GameObject {
  static components = [RigidBody];
  setup() {
    /* ... */
  }
}

export default captureScriptUrl(Ball, import.meta.url);
```

**Trade-off:** Slightly more complex export, but eliminates a static property.

---

### Option 2: Registration Helper

Create a registration helper that captures the script URL:

```javascript
// gameSetup.js
export async function registerEntities(engine, entities) {
  for (const [EntityClass, count, scriptUrl] of entities) {
    EntityClass.scriptUrl = scriptUrl;
    engine.registerEntityClass(EntityClass, count);
  }
}

// Usage in your game
import { registerEntities } from "./gameSetup.js";
import { Ball } from "./ball.js";
import { Player } from "./player.js";

await registerEntities(engine, [
  [Ball, 1000, import.meta.url],
  [Player, 1, import.meta.url],
]);
```

**Trade-off:** Centralized registration but loses auto-detection benefits.

---

## Recommended Best Practice

For the **best developer experience**, use this pattern:

```javascript
import WEED from "/src/index.js";
const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

class MyEntity extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    // Configure component properties
    this.rigidBody.maxVel = 10;
    this.collider.radius = 20;
  }

  tick(dtRatio) {
    // Game logic
  }
}

export { MyEntity };
```

**Total boilerplate: 2 lines**

1. `static scriptUrl = import.meta.url;`
2. `static components = [...]`

Everything else is your actual game logic! 🎮

---

## Future Improvements Under Consideration

### 1. Decorator-based Component Declaration (Stage 3 proposal)

```javascript
@Entity({
  components: [RigidBody, Collider],
  scriptUrl: import.meta.url, // Auto-captured by decorator
})
class Ball extends GameObject {
  setup() {
    /* ... */
  }
}
```

### 2. Build-time Code Generation

Use a build tool to automatically inject `scriptUrl`:

```javascript
// You write this
class Ball extends GameObject {
  static components = [RigidBody];
}

// Build tool injects this
class Ball extends GameObject {
  static scriptUrl = "/demos/balls/ball.js"; // Auto-injected
  static components = [RigidBody];
}
```

### 3. Simplified Registration API

```javascript
// Register with automatic script detection via stack traces
engine.registerEntityClassAuto(Ball, 1000);
```

---

## Summary: What to Write

| Property            | Required?   | Auto-handled? | Recommendation                  |
| ------------------- | ----------- | ------------- | ------------------------------- |
| `static components` | ✅ Yes      | ❌ No         | **Always declare**              |
| `static scriptUrl`  | ⚠️ Optional | ❌ No         | **Highly recommended**          |
| `static instances`  | ❌ No       | ✅ Yes        | **Never write this**            |
| `static entityType` | ❌ No       | ✅ Yes        | **Never write this**            |
| `setup()`           | ⚠️ Optional | ❌ No         | Use if you need initialization  |
| `tick()`            | ⚠️ Optional | ❌ No         | Use if you need per-frame logic |

**In practice, you only write 2 static lines + your game logic!**

---

**Questions or suggestions for further DX improvements? Let us know!** 🌿
