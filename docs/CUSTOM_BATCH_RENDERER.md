# Custom Batch Renderer - Direct SharedArrayBuffer to GPU

## Overview

The `CustomBatchRenderer` bypasses PIXI's traditional sprite system and reads **directly from SharedArrayBuffer** component arrays (`Transform.x`, `Transform.y`, etc.) to build vertex data for the GPU.

## Performance Pipeline Comparison

### Traditional PIXI Rendering (SLOW)

```
SharedArrayBuffer (Transform.x/y)
  ↓ (read in updateSprites)
Sprite properties (container.x/y = ...)
  ↓ (PIXI reads back)
WorldTransform calculations
  ↓ (PIXI batching)
Vertex buffer packing
  ↓
gl.bufferData() → GPU
  ↓
gl.drawElements() → Render
```

### Custom Batch Renderer (FAST)

```
SharedArrayBuffer (Transform.x/y)
  ↓ (direct read)
Vertex buffer packing
  ↓
gl.bufferData() → GPU
  ↓
gl.drawElements() → Render
```

## What Gets Bypassed

❌ **Eliminated Overhead:**

- Setting sprite properties (`container.x = x[i]`)
- PIXI reading properties back
- WorldTransform matrix calculations (container → parent → world)
- Intermediate object allocations

✅ **Direct Path:**

- Read from SharedArrayBuffer
- Write to GPU vertex buffer
- Render

## How It Works

### 1. Initialization

```javascript
// In pixi_worker.js
this.customBatchRenderer = new CustomBatchRenderer(
  this.pixiApp,
  this.entityCount
);
this.customBatchRenderer.setupEntityTextures(
  this.entitySpriteConfigs,
  this.textures,
  this.spritesheets
);
this.customBatchRenderer.initGeometry(PIXI);
```

### 2. Each Frame

```javascript
// updateSprites() now calls:
this.customBatchRenderer.render();

// Which does:
// 1. Read Transform.x[i], Transform.y[i], Transform.rotation[i]
// 2. Calculate quad vertices (4 corners)
// 3. Pack into vertex buffer: [x, y, u, v, color, textureId] × 4
// 4. Call gl.bufferData() → Upload to GPU
// 5. Call gl.drawElements() → Render
```

### 3. GPU Upload Location

The actual GPU upload happens in `CustomBatchRenderer.flush()`:

```javascript
flush() {
  // Update buffer (calls gl.bufferData internally)
  this.vertexBuffer.update(dataToUpload);

  // Bind and draw (calls gl.drawElements)
  renderer.geometry.bind(this.geometry, this.shader);
  renderer.geometry.draw(gl.TRIANGLES, indexCount, 0);
}
```

## Usage

### Enable/Disable

In `pixi_worker.js`, line ~55:

```javascript
this.useCustomRenderer = true; // Custom renderer (fast)
this.useCustomRenderer = false; // Traditional PIXI sprites (slower, more features)
```

### Console Toggle (for testing)

```javascript
// In browser console:
// Disable custom renderer
postMessage({ msg: "customRenderer", enabled: false });

// Enable custom renderer
postMessage({ msg: "customRenderer", enabled: true });
```

## Current Limitations

### Static Textures Only

- Currently uses first frame of animated sprites
- No animation frame updates (yet)
- To add: Update texture UVs based on `SpriteRenderer.animationState`

### Single Texture Batch

- All sprites must share same texture atlas
- To add: Multi-texture batching (like PIXI's batch renderer)

### No Nested Transforms

- Reads world position directly from `Transform.x/y`
- Doesn't support parent-child hierarchies
- This is fine for most game entities (they're already in world space)

## Performance Gains

### Eliminated Operations Per Sprite

- `container.x = x[i]` → **4 bytes write**
- `container.y = y[i]` → **4 bytes write**
- `container.rotation = rotation[i]` → **4 bytes write + trig recalc**
- `container.scale.set()` → **8 bytes write + matrix recalc**
- WorldTransform update → **24 bytes matrix multiply**

**Total saved: ~50+ bytes of memory writes + matrix math per sprite**

### For 10,000 Sprites

- Traditional: ~500KB memory writes + 10K matrix calculations per frame
- Custom: Direct vertex buffer write only

### Expected FPS Improvement

- Small scenes (<1000 sprites): 5-10% faster
- Medium scenes (1000-5000): 15-25% faster
- Large scenes (5000-10000): 30-50% faster
- Massive scenes (10000+): 50-100%+ faster

## Testing

### 1. Benchmark Tool

Add to your demo HTML:

```javascript
// Toggle custom renderer on/off every 5 seconds
setInterval(() => {
  const newState = !pixiRenderer.useCustomRenderer;
  console.log(`Switching to ${newState ? "CUSTOM" : "TRADITIONAL"} renderer`);
  pixiRenderer.useCustomRenderer = newState;
}, 5000);
```

### 2. Performance Metrics

Monitor in browser DevTools:

- **FPS**: Performance → Rendering
- **CPU Time**: Performance → JavaScript profiling
- **Memory**: Memory → JS Heap

### 3. Visual Verification

Both renderers should look identical. If not, check:

- Anchor points (currently hardcoded to 0.5, 1.0)
- Rotation direction
- Scale application

## Future Improvements

### 1. Animation Support

```javascript
// Add to render() loop:
const animState = SpriteRenderer.animationState[i];
const texture = this.getAnimationFrame(entityType, animState);
this.computeUVs(i, texture);
```

### 2. Multi-Texture Batching

```javascript
// Group sprites by texture
// Draw each texture batch separately
// Like PIXI's batch renderer does
```

### 3. Instanced Rendering

```javascript
// Use gl.drawElementsInstanced
// One draw call for all sprites with same texture
// Even faster than batching
```

### 4. Transform Buffer Upload

```javascript
// Instead of CPU-side vertex calculation:
// Upload Transform.x/y arrays as texture/UBO
// Calculate vertices in vertex shader
// Eliminates ALL CPU-side math
```

## Summary

✅ **Use Custom Renderer When:**

- You have 1000+ sprites
- All sprites use same texture atlas
- You don't need per-frame animation changes
- You want maximum performance

❌ **Use Traditional PIXI When:**

- You need complex animations
- You need multi-texture support
- You need parent-child transform hierarchies
- Visual quality > performance

---

**The key insight:** By reading directly from `Transform.x/y` SharedArrayBuffers and bypassing PIXI's sprite system, we eliminate an entire layer of property assignments and transform calculations, going straight from component data to GPU vertex buffers.
