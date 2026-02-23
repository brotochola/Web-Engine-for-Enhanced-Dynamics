B. getAllNeighborInstances() allocates every call
gameObject.js
Lines 1440-1449
getAllNeighborInstances() { const count = this.neighborCount; const result = new Array(count); // ... return result; }
Fix: Add a getAllNeighborInstancesMut(result) that fills a provided array, or document that this is a convenience API and not for hot paths.
C. despawnAll creates a Set every call
gameObject.js
Lines 1897-1897
const indicesToDespawn = new Set();
Fix: Reuse a per-worker Set and clear it between uses.
D. Physics worker query caching
\_cachedPhysicsEntities and \_cachedColliderEntities are reset to null each frame (lines 131–132 in physics_worker.js), so queryActiveEntities runs twice per frame.
Fix: Cache for the whole frame and only invalidate when spawn/despawn happens (or when a frame boundary is crossed).
E. List update serialization
sendListUpdatesToLogic0() uses .map() to build new arrays for every spawn/despawn batch (lines 357–368 in logic_worker.js).
Fix: Reuse a buffer and send a Transferable view, or batch updates and send less frequently.
