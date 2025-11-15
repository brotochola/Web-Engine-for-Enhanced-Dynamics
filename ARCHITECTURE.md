# Architecture Overview

This project demonstrates a Boids simulation using PixiJS, with the ability to switch between two architectures for benchmarking.

## Configuration

Toggle between architectures by changing the config in `index.html`:

```javascript
const config = {
  useWorkers: true, // true = Workers mode, false = Main thread mode
};
```

## File Structure

### Shared Code

- **`boid.js`** - Shared Boid class and constants
  - Used by both workers and main thread
  - Contains all boid behavior (cohesion, separation, alignment)
  - Works with both `importScripts()` and ES6 `import`

### Workers Mode (`useWorkers: true`)

- **`logic_worker.js`** - Game logic worker
  - Runs boids simulation
  - Uses double-buffering for zero-copy transfers
  - Communicates with pixi_worker via MessageChannel
- **`pixi_worker.js`** - Rendering worker
  - Handles PixiJS rendering
  - Updates sprite positions from received buffers
  - Runs on separate thread from logic

### Main Thread Mode (`useWorkers: false`)

- **`main_thread.js`** - Combined logic and rendering
  - Runs both simulation and rendering on main thread
  - Direct memory access (no buffer transfers)
  - Uses same Boid class from `boid.js`

### Core Files

- **`index.html`** - Entry point with mode selection
- **`pixi4webworkers.js`** - PixiJS library (used by both modes)

## How It Works

### Workers Mode

1. Main thread creates two workers and a MessageChannel
2. Logic worker runs boid simulation
3. Logic worker transfers data buffers to render worker
4. Render worker updates sprite positions and renders
5. Buffers are returned for reuse (double-buffering)

### Main Thread Mode

1. Main thread loads PIXI library
2. Single thread runs both logic and rendering
3. Direct sprite updates (no buffer transfers)
4. Both loops run via requestAnimationFrame and PIXI ticker

## Benchmarking

Both modes:

- Use identical Boid algorithm
- Render 1200 sprites
- Display FPS for logic and render separately
- Use same PixiJS library

Compare FPS between modes to see the impact of:

- Worker overhead vs main thread blocking
- Buffer transfer costs vs direct memory access
- Thread parallelization benefits
