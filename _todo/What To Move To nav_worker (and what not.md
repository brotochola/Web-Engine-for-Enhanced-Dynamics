What To Move To nav_worker (and what not)
Move first: entity visibility pass from particle_worker.updateEntityScreenVisibility() to nav_worker.
nav_worker already reads Transform, Collider, LightEmitter, ShadowCaster, Grid, camera data, and runs every frame.
Have nav write:
SpriteRenderer.isItOnScreen
optional compact visibleEntityIndices SAB
Then particle_worker can keep particle/deco visibility + unified render queue build.
Do not move: particle physics and decal stamping (updateParticlePhysics, stampCollectedParticles).
Those are tightly coupled and have good temporal locality (particle data is hot in cache right after physics).
Moving them would re-read large particle arrays in another worker and increase cross-worker staleness risk.
Probably keep in particle for now: full render queue assembly/sort.
It currently collects entities + particles + decorations in one pass and writes one SAB.
Splitting queue ownership across workers adds merge/sort complexity and more memory traffic.
Key Architecture Findings (high-impact)
nav_worker is not truly “idle” by design: it always runs buildShadowRenderQueue() + updateDerivedProperties() every frame (plus path work on demand).
nav_worker uses Set/Map request queues and string keys ("${fromCell}_${toCell}") for paths: avoidable allocation/GC.
NavScratch.bucketQueue is Array<[]> with push/pop in Dijkstra: this is allocation-heavy for a hot algorithm.
There are stale ownership comments and drift (e.g. shadow queue comments still mention particle in places), increasing maintenance cost.
particle_worker.updateCellSleepingStates() exists but appears unused from runtime flow; likely dead/forgotten path.
Query fallback paths still allocate typed arrays, though precomputed SAB path seems primary.
For Your Goals (zero alloc / no GC / less reads-writes / cache locality / less code)
Priority order I’d use:
1) Eliminate dynamic containers in hot paths
Replace nav request Set/Map + string keys with fixed-size ring buffers in SAB (Uint32 packed keys).
Replace Dijkstra bucket Array<[]> with typed-array bucket linked lists (head[], next[], cell[]).
2) Tighten worker ownership
particle_worker: particles + decals + particle/deco culling + render queue write.
nav_worker: nav/path + entity culling + shadows + derived rigidbody properties.
physics_worker: integration/collisions only.
This reduces duplicated reads of entity transforms and keeps responsibilities clearer.
3) Reduce writes
Write-on-change for visibility flags and screen coords (already partially done in some places; enforce everywhere).
Avoid writing queue entries for fully static, unchanged decorations each frame (cache static segment once).
4) Improve cache locality
Keep SoA (already good), but split hot/cold fields further (e.g., render-only vs physics-only).
Consider spatial reordering (Morton/cell-local active lists) for loops that touch neighbors repeatedly.
5) Reduce code surface
Remove dead methods, stale comments, and moved-but-not-updated docs.
Consolidate duplicate “camera bounds / screen bounds” math in one shared utility used by workers.
Direct answer to your question
Yes — you can offload from particle_worker to nav_worker, and the best candidate is entity visibility/culling (not particle simulation or decal stamping).
If you want, next step we can design the exact SAB contract for visibleEntityIndices + migration order with zero-regression checkpoints.