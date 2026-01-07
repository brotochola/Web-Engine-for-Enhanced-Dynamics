# Spatial Worker Parallelization - Boundary Problem Solution

## Overview

This document describes the implementation of the "Shared Grid, Split Work" approach for parallel neighbor detection in the multithreaded game engine.

## The Boundary Problem

When splitting entities between multiple workers using simple range partitioning:

- **Worker A**: Handles entities 0-499
- **Worker B**: Handles entities 500-999

**Problem**: Entity #499 and entity #500 might be neighbors in world space, but they're in different workers! This creates a boundary where neighbors are missed.

## Solution: Shared Grid, Split Work ⭐

### How It Works

Each spatial worker:

1. **Reads**: Transform data for ALL entities (0-999)
2. **Builds**: FULL spatial grid containing all 1000 entities
3. **Processes**: Only its assigned entity subset (e.g., 0-499 or 500-999)
4. **Writes**: Results to its section of the shared neighborData buffer

### Example with 2 Workers

**Worker A (workerIndex=0)**:

- Reads: Transform[0-999] (all positions)
- Builds: Full grid with all 1000 entities
- Processes: findNeighbors(0-499)
- Writes: neighborData[0-499]

**Worker B (workerIndex=1)**:

- Reads: Transform[0-999] (all positions)
- Builds: Full grid with all 1000 entities
- Processes: findNeighbors(500-999)
- Writes: neighborData[500-999]

### Benefits

✅ **No boundary issues** - Entity 499 can see entity 500 because both workers have the complete grid
✅ **No merging needed** - Each worker writes to its own section of the shared buffer
✅ **Simple implementation** - Just filter entities by index range in findAllNeighbors()
✅ **Efficient** - Grid rebuild is O(n), so duplicating it isn't expensive compared to neighbor searches

## Implementation Details

### Configuration

Add `numberOfSpatialWorkers` to your scene config:

```javascript
spatial: {
  cellSize: 128,
  maxNeighbors: 2048,
  numberOfSpatialWorkers: 2, // Multiple workers for parallel neighbor detection
  noLimitFPS: true,
}
```

Default is `1` (single worker, backward compatible).

### Key Changes

#### 1. ConfigDefaults.js

- Added `numberOfSpatialWorkers: 1` to `SPATIAL_DEFAULTS`

#### 2. spatial_worker.js

- Added worker identification: `workerIndex`, `totalSpatialWorkers`
- Calculate entity range: `entityStartIndex`, `entityEndIndex`
- Modified `findAllNeighbors()` to skip entities outside assigned range:
  ```javascript
  // BOUNDARY FIX: Skip if entity is not in our assigned range
  if (i < entityStartIndex || i >= entityEndIndex) continue;
  ```

#### 3. Scene.js

- Changed from single `spatial` worker to array `spatialWorkers[]`
- Create multiple spatial workers in `createWorkers()`
- Pass `workerIndex` and `totalSpatialWorkers` to each worker
- Updated worker synchronization and message handling
- Adjusted frameRateData buffer size for multiple spatial workers

### Performance Characteristics

**Grid Rebuild**: O(n) per worker

- Each worker processes all n entities to build the grid
- With k workers: k × O(n) total work for grid building

**Neighbor Search**: O(n/k) per worker

- Each worker searches neighbors for n/k entities
- With k workers: k × O(n/k) = O(n) total work (perfectly parallelized)

**Net Effect**: Slight overhead from duplicate grid building, but massive speedup from parallelized neighbor searches. For typical scenarios where neighbor search dominates, this is a significant win.

### Memory Usage

Each spatial worker maintains:

- Full spatial grid (shared structure, duplicated per worker)
- Pre-computed entity data for ALL entities (positions, half-extents)
- Processed bitmask for ALL entities

Memory scales linearly with number of workers, but the cost is relatively small compared to the performance gains.

## Monitoring Performance

The DebugUI has been updated to display FPS for all spatial workers:

- Press `H` to toggle the Debug UI
- Open the **Performance** tab
- Spatial workers display as: `S0: 60.0 | S1: 60.0`

Each spatial worker's FPS is tracked independently, allowing you to verify proper load distribution.

## Testing

The implementation has been tested with:

- 1 spatial worker (backward compatible, default)
- 2 spatial workers (recommended for most scenarios)
- More workers can be configured based on entity count and CPU cores

### Example Scene Configuration

See `demos/scenes/PredatorScene.js` for a working example with 2 spatial workers handling 1000+ entities.

### Debug UI Display

With multiple spatial workers configured, the Performance section shows:

```
Main: 60.0 | S0: 60.0 | S1: 60.0 | L0: 60.0 | L1: 60.0 | L2: 60.0 | Physics: 60.0 | Render: 60.0 | Particle: 60.0
```

Where:

- `S0`, `S1`, etc. = Spatial workers
- `L0`, `L1`, etc. = Logic workers

## Future Optimizations

Potential improvements:

1. **Dynamic worker count**: Adjust based on entity count and available CPU cores
2. **Load balancing**: Assign entity ranges based on spatial density rather than simple index ranges
3. **Hybrid approach**: Use single worker for low entity counts, multiple workers for high counts

## Conclusion

The "Shared Grid, Split Work" approach elegantly solves the boundary problem while maintaining excellent parallelization efficiency. Each worker has complete spatial awareness (no boundary issues) while only processing its assigned subset of entities (perfect work distribution).
