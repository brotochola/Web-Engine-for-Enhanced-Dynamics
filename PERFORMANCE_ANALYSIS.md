# Performance Analysis: Person.js & SoldierBehaviorFSM.js

## Critical Performance Issues

### 🔴 **CRITICAL: Excessive Ray.hasLineOfSight() Calls**

**Problem:** `Ray.hasLineOfSight()` performs expensive grid traversal raycasting. It's being called:

1. **In `findClosestCivilian()`** - Called for EVERY neighbor (line 35)
   - Called in IDLE state every frame (line 102)
   - Called in GOING_TO_ENEMY state when target invalid (line 215)
   - **Cost:** O(neighbors × raycast_complexity) per entity per frame

2. **In `isStoredTargetValid()`** - Called every frame in GOING_TO_ENEMY state (line 55)
   - **Cost:** 1 raycast per entity per frame (when chasing)

3. **In `updateTeamData()`** - Called for EVERY team neighbor (line 198)
   - Called via `groupWithMyTeam()` in IDLE and GOING_TO_DESTINATION states
   - **Cost:** O(team_neighbors × raycast_complexity) per entity per frame

**Impact:** With 100 entities, each with 50 neighbors, this could be **5,000+ raycasts per frame**!

**Solutions:**
- Cache line-of-sight results with timestamps (recheck every N frames)
- Skip LOS check for close-range targets (if within visual range, assume LOS)
- Only check LOS for the closest few candidates, not all neighbors
- Use distance-based heuristics before expensive LOS checks

---

### 🟠 **HIGH: updateTeamData() Called Every Frame**

**Problem:** `updateTeamData()` is called via `groupWithMyTeam()` in:
- IDLE state (line 127)
- GOING_TO_DESTINATION state (line 149)

This function:
- Loops through ALL neighbors
- Performs `Ray.hasLineOfSight()` for each team member
- Calculates separation forces
- Does `Math.sqrt()` for separation (line 215)

**Impact:** With many entities, this runs hundreds of times per frame.

**Solutions:**
- Cache team data and update every N frames (e.g., every 3-5 frames)
- Only update when team composition changes significantly
- Skip LOS checks for team members (assume they're visible if in neighbor list)

---

### 🟠 **HIGH: findClosestCivilian() Called Multiple Times**

**Problem:** Called in:
- IDLE state every frame (line 102)
- GOING_TO_ENEMY state when target lost (line 215)

Each call loops through all neighbors and performs LOS checks.

**Solutions:**
- Throttle scanning frequency (scan every N frames, not every frame)
- Use cached results with expiration
- Early exit optimizations (stop after finding first valid target within range)

---

### 🟡 **MEDIUM: Math.sqrt() in Hot Paths**

**Problem:** `Math.sqrt()` is expensive and called in:
- `updateTeamData()` line 215 (separation calculation)
- `GoingToEnemyState.onUpdate()` line 204 (chase direction)

**Solutions:**
- Use squared distance comparisons where possible
- For normalized direction, use fast inverse square root approximation
- Cache sqrt results when distance doesn't change much

---

### 🟡 **MEDIUM: setTimeout in shoot() Method**

**Problem:** `setTimeout()` in `shoot()` (line 355) is:
- Asynchronous and adds overhead
- Creates closure that captures context
- Not frame-synced with game loop

**Solutions:**
- Use frame-based timing instead
- Store flash time in component and check in tick()
- Use the FSM's time tracking system

---

### 🟢 **LOW: Redundant Distance Calculations**

**Problem:**
- `distanceSq2D()` called multiple times for same target
- `getNeighborDistanceSq()` already cached, but recalculated in some paths

**Solutions:**
- Reuse cached distance data from neighbor system
- Store distance with target index

---

## Recommended Fixes (Priority Order)

### 1. **Throttle LOS Checks** (Biggest Impact)
```javascript
// Add to PersonComponent
static lastLOSCheckTime = new Float32Array(maxEntities);
static LOS_CHECK_INTERVAL_MS = 200; // Check every 200ms

// In findClosestCivilian, only check LOS every N frames
if (performance.now() - PersonComponent.lastLOSCheckTime[owner.index] < LOS_CHECK_INTERVAL_MS) {
  // Skip LOS check, use cached result or assume visible
}
```

### 2. **Cache Team Data Updates**
```javascript
// Update team data every 3-5 frames instead of every frame
static lastTeamUpdateFrame = new Uint16Array(maxEntities);
const framesSinceUpdate = frameNumber - PersonComponent.lastTeamUpdateFrame[i];
if (framesSinceUpdate >= 3) {
  owner.updateTeamData();
  PersonComponent.lastTeamUpdateFrame[i] = frameNumber;
}
```

### 3. **Skip LOS for Close Targets**
```javascript
// If target is very close (within visual range), skip LOS check
const VISUAL_RANGE_SQ = owner.collider.visualRange ** 2;
if (distSq < VISUAL_RANGE_SQ * 0.5) {
  // Assume LOS for close targets
  continue; // Skip LOS check
}
```

### 4. **Early Exit in findClosestCivilian**
```javascript
// Stop after finding first target within attack range
if (distSq <= weapon.rangeSq) {
  return _closestResult; // Found valid target, stop searching
}
```

### 5. **Remove Math.sqrt() from Hot Paths**
```javascript
// In GoingToEnemyState, use fast inverse sqrt or avoid normalization
// Instead of: const dist = Math.sqrt(distSq);
// Use: const invDist = fastInvSqrt(distSq);
// Or: normalize using distSq directly
```

---

## Performance Metrics to Track

- Number of `Ray.hasLineOfSight()` calls per frame
- Time spent in `updateTeamData()`
- Time spent in `findClosestCivilian()`
- Average neighbors per entity
- FPS impact of team grouping

---

## Expected Performance Gains

After implementing fixes:
- **50-70% reduction** in raycast calls
- **30-40% reduction** in team data updates
- **10-20% overall FPS improvement** with many entities
