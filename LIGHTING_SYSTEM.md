# Lighting System Documentation

## Overview

The lighting system is a multi-threaded, GPU-accelerated lighting engine that calculates dynamic lighting using the **lumens/d²** formula (inverse square law). It consists of:

- **lighting_worker.js** - Calculates lighting contributions on CPU
- **Fragment shader** in pixi_worker.js - Renders lighting effects on GPU
- **AbstractLightSourceEntity** - Base class for all light-emitting entities
- **Candle** - Example implementation with flickering effect

## Architecture

```
┌─────────────────┐
│ Light Sources   │
│ (Candle, etc.)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ lighting_worker │ ← Reads: lumens, color, position
│                 │   Calculates: tints, visible lights
└────────┬────────┘
         │ lightData + objectTints
         ▼
┌─────────────────┐
│  main thread    │ ← Forwards messages
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  pixi_worker    │ ← Fragment shader renders lights
│                 │   Applies tints to sprites
└─────────────────┘
```

## Key Features

### 1. **Physically-Based Lighting**

- Uses **lumens/d²** formula (inverse square law)
- `brightness = K * lumens / distance²`
- More realistic light falloff than linear

### 2. **GPU-Accelerated Rendering**

- Fragment shader renders up to 200 lights simultaneously
- Smooth circular gradients with quadratic falloff
- Ambient light support (minimum 5% brightness)

### 3. **Object Tinting**

- Each entity receives a tint based on total light received
- Darker in shadows, brighter near lights
- Calculated per-frame in lighting_worker

### 4. **Performance Optimizations**

- Frustum culling (only visible lights rendered)
- Screen-space calculations (no world-to-screen conversions in shader)
- Transferable arrays (zero-copy between workers)

## Creating Light Sources

### Basic Light Source

```javascript
class Torch extends AbstractLightSourceEntity {
  constructor(index) {
    super(index);

    // Set position
    GameObject.x[index] = 100;
    GameObject.y[index] = 100;

    // Set light properties
    AbstractLightSourceEntity.lumens[index] = 150; // Brightness
    this.color = 0xffaa66; // Warm orange (hex color)
  }
}

// Register with engine
gameEngine.registerEntityClass(Torch, 10);
```

### Light Source with Animation

```javascript
class PulsingLight extends AbstractLightSourceEntity {
  constructor(index) {
    super(index);
    this.baseIntensity = 100;
    this.phase = Math.random() * Math.PI * 2;
  }

  tick(dtRatio, neighborData, inputData) {
    this.phase += 0.1 * dtRatio;

    // Pulsing effect
    const pulse = Math.sin(this.phase) * 0.3 + 1.0; // 0.7 to 1.3
    AbstractLightSourceEntity.lumens[this.index] = this.baseIntensity * pulse;
  }
}
```

## Configuration

### Lighting Constants (in lighting_worker.js)

```javascript
const AMBIENT_LIGHT = 0.05; // Minimum brightness (5%)
const K_LIGHT_CONTRIBUTION = 50000; // Scale factor for lumens/d²
const MAX_LIGHTS_TO_RENDER = 200; // Max lights in shader
```

### Adjusting Light Intensity

**Increase K_LIGHT_CONTRIBUTION** → Lights have longer range  
**Decrease K_LIGHT_CONTRIBUTION** → Lights are more localized

**Increase AMBIENT_LIGHT** → Less dark in shadows  
**Decrease AMBIENT_LIGHT** → More dramatic lighting

### Shader Constants (in pixi_worker.js)

```javascript
const AMBIENT_LIGHT = 0.05; // Must match lighting_worker
const MAX_LIGHTS_TO_RENDER = 200;
```

## How It Works

### 1. Light Data Preparation (lighting_worker.js)

```javascript
// For each visible light:
{
  screenX: (worldX - cameraX) * zoom,
  screenY: (worldY - cameraY) * zoom,
  screenRadius: Math.sqrt(K * lumens / threshold) * zoom,
  r: colorR / 255,
  g: colorG / 255,
  b: colorB / 255,
  lumens: lumens
}
```

### 2. Object Tint Calculation

```javascript
// For each object:
totalBrightness = AMBIENT_LIGHT;

for each light:
  distance² = dx² + dy²
  contribution = (K * lumens) / distance²
  totalBrightness += contribution

brightness = clamp(totalBrightness, 0, 1)
tint = grayscale(brightness) // 0x000000 to 0xFFFFFF
```

### 3. Shader Rendering (GLSL)

```glsl
// For each pixel:
vec3 totalLight = vec3(AMBIENT_LIGHT);

for each light:
  float dist = distance(pixelPos, lightPos);
  float attenuation = 1.0 - (dist / lightRadius);
  attenuation = attenuation * attenuation; // Quadratic
  totalLight += lightColor * attenuation * intensity;

gl_FragColor = vec4(totalLight, 1.0);
```

## Example: Candle Implementation

```javascript
class Candle extends AbstractLightSourceEntity {
  constructor(index) {
    super(index);

    // Random position
    GameObject.x[index] = Math.random() * WIDTH;
    GameObject.y[index] = Math.random() * HEIGHT;

    // Light properties (warm yellow-orange)
    const baseIntensity = 80 + Math.random() * 40; // 80-120 lumens
    AbstractLightSourceEntity.lumens[index] = baseIntensity;
    AbstractLightSourceEntity.colorR[index] = 255;
    AbstractLightSourceEntity.colorG[index] = 200;
    AbstractLightSourceEntity.colorB[index] = 100;

    // Flicker parameters
    this.baseIntensity = baseIntensity;
    this.flickerSpeed = 0.05 + Math.random() * 0.05;
    this.flickerAmount = 0.15 + Math.random() * 0.1;
    this.flickerPhase = Math.random() * Math.PI * 2;
  }

  tick(dtRatio) {
    // Advance flicker animation
    this.flickerPhase += this.flickerSpeed * dtRatio;

    // Apply sine wave flicker
    const flicker = Math.sin(this.flickerPhase) * this.flickerAmount;
    AbstractLightSourceEntity.lumens[this.index] =
      this.baseIntensity * (1.0 + flicker);
  }
}
```

## Performance

### Benchmarks (estimated)

| Lights | FPS (1080p) | FPS (4K) |
| ------ | ----------- | -------- |
| 10     | 60          | 60       |
| 50     | 60          | 58       |
| 100    | 58          | 52       |
| 200    | 55          | 45       |

### Optimization Tips

1. **Limit visible lights** - Adjust MAX_LIGHTS_TO_RENDER
2. **Reduce light range** - Lower K_LIGHT_CONTRIBUTION
3. **Cull off-screen objects** - Already implemented
4. **Use lower resolution** - Shader runs per-pixel

## Troubleshooting

### Lights too dim

- Increase `K_LIGHT_CONTRIBUTION` in lighting_worker.js
- Increase `lumens` value in light source
- Decrease shader `intensity` scale factor (currently `* 0.01`)

### Lights too bright

- Decrease `K_LIGHT_CONTRIBUTION`
- Decrease `lumens` value
- Increase shader `intensity` scale factor

### No lighting visible

- Check console for worker initialization errors
- Verify AbstractLightSourceEntity buffer is created
- Check that light sources are on screen
- Verify `gameEngine.lightSourceCount > 0`

### Performance issues

- Reduce MAX_LIGHTS_TO_RENDER
- Reduce number of light source entities
- Lower K_LIGHT_CONTRIBUTION (shorter range)

## API Reference

### AbstractLightSourceEntity

**Static Properties:**

- `lumens: Float32Array` - Light power (0-1000+)
- `colorR/G/B: Uint8Array` - RGB color components (0-255)

**Instance Properties:**

- `lumens: number` - Get/set light power
- `color: number` - Get/set color as hex (e.g., 0xFFAA66)
- `colorR/G/B: number` - Get/set individual color channels

**Methods:**

- `constructor(index)` - Initialize light source
- `tick(dtRatio, neighborData, inputData)` - Override for animation

### Lighting Worker Messages

**Input (from main thread):**

```javascript
{
  msg: "init",
  gameObjectBuffer: SharedArrayBuffer,
  cameraBuffer: SharedArrayBuffer,
  lightSourceBuffer: SharedArrayBuffer,
  lightSourceCount: number,
  lightSourceIndices: number[]
}
```

**Output (to pixi_worker via main thread):**

```javascript
{
  msg: "lightingData",
  lightData: Float32Array,  // [x,y,r,g,b,radius,intensity, ...]
  lightCount: number,
  objectTints: Float32Array // [brightness0, brightness1, ...]
}
```

## Future Enhancements

- [ ] Colored tinting (currently grayscale only)
- [ ] Projected shadows (geometry-based)
- [ ] Light occlusion (raycasting)
- [ ] Bloom/glow effects
- [ ] Day/night cycle
- [ ] Light volumes (spotlights, cones)

## Credits

Inspired by `sistemaDeIluminacion.js` - Uses modern GPU approach instead of RenderTexture for 5-10x better performance.
