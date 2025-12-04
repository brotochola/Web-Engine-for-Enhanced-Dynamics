# Debug System Guide

The game engine includes a powerful debug visualization system for diagnosing physics, AI behavior, and performance issues.

## Quick Start

### Using Keyboard Shortcuts

Press these keys during gameplay:

- **[1]** - Toggle collision shapes
- **[2]** - Toggle velocity vectors
- **[3]** - Toggle acceleration vectors
- **[4]** - Toggle neighbor connections
- **[5]** - Toggle spatial grid
- **[0]** - Disable all debug overlays

### Using the API

```javascript
// In console or code
gameEngine.debug.showColliders(true);
gameEngine.debug.showVelocity(true);
gameEngine.debug.showNeighbors(true);

// Chainable API
gameEngine.debug.showColliders(true).showVelocity(true).showSpatialGrid(true);

// Bulk enable
gameEngine.debug.enable({
  colliders: true,
  velocity: true,
  neighbors: false,
});
```

## Debug Features

### 🟢 Collision Shapes (`showColliders`)

Visualizes collision boundaries for each entity.

- **Green circles** = Normal colliders
- **Yellow circles** = Trigger colliders (no physical response)
- Helps debug collision detection issues

**Use case:** "Why aren't my entities colliding?"

### 🔵 Velocity Vectors (`showVelocity`)

Shows blue arrows indicating movement direction and speed.

- Arrow length = velocity magnitude
- Arrow direction = movement direction
- Helps visualize entity movement patterns

**Use case:** "Why is my entity moving in the wrong direction?"

### 🔴 Acceleration Vectors (`showAcceleration`)

Shows red arrows indicating applied forces.

- Arrow length = acceleration magnitude
- Arrow direction = force direction
- Helps debug AI steering behaviors

**Use case:** "Why aren't my flocking forces working?"

### 🔵 Neighbor Connections (`showNeighbors`)

Draws cyan lines between entities and their neighbors.

- Shows spatial query results
- Line opacity indicates relationship strength
- Helps visualize AI perception

**Use case:** "Which entities can my prey see?"

### ⬜ Spatial Grid (`showSpatialGrid`)

Displays the spatial hash grid used for optimization.

- Gray grid lines show cell boundaries
- Helps understand performance characteristics
- Cell size = `config.spatial.cellSize`

**Use case:** "Is my spatial hash grid properly sized?"

### 🔢 Entity Indices (`showEntityIndices`)

Shows the index number for each entity.

- Small white dots mark entity center
- Useful for debugging specific entities
- Reference these indices in console logs

**Use case:** "Which entity is index 42?"

## Debug Presets

Quick presets for common debugging scenarios:

### Physics Debugging

```javascript
gameEngine.debug.enablePhysicsDebug();
// Enables: colliders, velocity, acceleration
```

### AI Behavior Debugging

```javascript
gameEngine.debug.enableAIDebug();
// Enables: neighbors, velocity, entity info
```

### Performance Debugging

```javascript
gameEngine.debug.enablePerformanceDebug();
// Enables: FPS graph, profiler, spatial grid
```

### Disable Everything

```javascript
gameEngine.debug.disableAll();
```

## Console API

The debug object is available in the browser console:

```javascript
// Check current state
debug.getState();

// Toggle specific features
debug.showColliders(true);
debug.showVelocity(false);

// Check if feature is enabled
debug.isEnabled(0); // 0 = SHOW_COLLIDERS
```

## Advanced Usage

### Access from Entity Classes

The debug system works with SharedArrayBuffer, so debug visualization happens automatically based on component data.

```javascript
class MyEntity extends GameObject {
  tick(dtRatio) {
    // Debug overlays will automatically show:
    // - This entity's collider (if showColliders is on)
    // - This entity's velocity (if showVelocity is on)
    // - This entity's neighbors (if showNeighbors is on)
    // Your game logic here...
  }
}
```

### Debug Flags Reference

Available debug flags (for advanced use):

```javascript
import { DEBUG_FLAGS } from "/src/core/Debug.js";

DEBUG_FLAGS.SHOW_COLLIDERS; // 0
DEBUG_FLAGS.SHOW_VELOCITY; // 1
DEBUG_FLAGS.SHOW_ACCELERATION; // 2
DEBUG_FLAGS.SHOW_NEIGHBORS; // 3
DEBUG_FLAGS.SHOW_SPATIAL_GRID; // 4
DEBUG_FLAGS.SHOW_ENTITY_INFO; // 5
DEBUG_FLAGS.SHOW_AABB; // 6
DEBUG_FLAGS.SHOW_TRAIL; // 7
DEBUG_FLAGS.SHOW_FPS_GRAPH; // 8
DEBUG_FLAGS.SHOW_PROFILER; // 9
DEBUG_FLAGS.SHOW_ENTITY_INDICES; // 10
```

## Performance Considerations

Debug rendering is **lightweight** but will impact performance with thousands of entities:

- **Colliders**: ~0.1ms per 1000 entities
- **Velocity vectors**: ~0.1ms per 1000 entities
- **Neighbor connections**: ~1-2ms per 1000 entities (most expensive)
- **Spatial grid**: Constant ~0.5ms (independent of entity count)

**Tip:** Use neighbor visualization sparingly with large entity counts (10,000+).

## Troubleshooting

### "Debug overlays not showing"

- Check that you've called `gameEngine.init()` successfully
- Verify entities are active (`Transform.active[i] === 1`)
- Check entities are on screen (`SpriteRenderer.isItOnScreen[i] === 1`)

### "Colliders look wrong"

- Verify `Collider.radius` values in your entity's `setup()` method
- Check that collision shapes match sprite size

### "Velocity vectors are huge/tiny"

- Adjust velocity magnitude in your entity logic
- Vectors are scaled 10x for visibility
- Acceleration vectors are scaled 50x

### "Too slow with debug enabled"

- Disable neighbor visualization for large entity counts
- Consider reducing visible entity count with frustum culling
- Profile with `gameEngine.enableProfiling(true)`

## Examples

### Debug a Specific Entity

```javascript
// In console, inspect entity 42
const entity = GameObject.instances[42];
console.log("Position:", entity.x, entity.y);
console.log("Velocity:", entity.vx, entity.vy);
console.log("Neighbors:", entity.neighborCount);

// Enable debug to visualize
debug.showColliders(true).showVelocity(true);
```

### Debug Flocking Behavior

```javascript
// Show how boids interact
debug.enable({
  velocity: true, // See movement direction
  neighbors: true, // See who affects each boid
  acceleration: true, // See steering forces
});
```

### Debug Collision Detection

```javascript
// Visualize collision boundaries
debug.enable({
  colliders: true, // See collision shapes
  velocity: true, // See collision response
});
```

## Color Reference

- 🟢 **Green** (0x00ff00) = Colliders
- 🟡 **Yellow** (0xffff00) = Triggers
- 🔵 **Blue** (0x0088ff) = Velocity
- 🔴 **Red** (0xff0044) = Acceleration
- 🔵 **Cyan** (0x00ffff) = Neighbors
- ⬜ **Gray** (0x444444) = Grid
- 🟠 **Orange** (0xff8800) = AABB
- ⚪ **White** (0xffffff) = Text/Info

## Future Features

Coming soon:

- Entity info tooltip on hover
- FPS history graph
- Memory profiler
- Entity trails
- Performance heatmap
- Frame timing breakdown

---

**Pro Tip:** Use `debug.enableAIDebug()` while developing behaviors, then `debug.disableAll()` for performance testing!
