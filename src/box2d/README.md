# Weed Box2D runtime (`src/box2d`)

Classic physics worker for **Box2D 3.2.0 WASM** (pthread + SharedArrayBuffer). Scene’s `workers.physics` **is** [`box2dWasm.js`](box2dWasm.js), which loads [`weedjsPost.js`](weedjsPost.js) then [`physicsHostImpl.js`](physicsHostImpl.js). Host speaks Weed `init`/`start` and calls `weedjsDoStep` in-process.

## Layout

| File                                                  | Role                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `box2dWasm.js` / `.wasm`                              | Emscripten glue + binary                                                                            |
| `physicsHostImpl.js`                                  | Weed protocol + frame loop + `weedjsDoStep`                                                         |
| `weedjsPost.js`                                       | World create/destroy, sync, command ring drain, step                                                |
| `physicsApi.js`                                       | `PhysicsWorld` / `BodyHandle` over `cwrap` (`create` = shapeless body; `addShape*` / `clearShapes`) |
| `box2dConstantsImpl.js` + `box2dConstants.js`         | Dual-load enums / state channels                                                                    |
| `box2dCommandRingImpl.js` + `box2dCommandRing.js`     | Pose / vel / fixedRotation / LiquidFun create commands                                              |
| `box2dQueryAabbImpl.js` + `box2dQueryAabb.js`         | Single-flight gameplay QueryAABB SAB                                                                |
| `box2dOverlapCircleImpl.js` + `box2dOverlapCircle.js` | Single-flight overlapCircle SAB                                                                     |
| `box2dCastRayAllImpl.js` + `box2dCastRayAll.js`       | Single-flight castRayAll SAB                                                                        |
| `liquidFunQueryImpl.js` + `liquidFunQuery.js`         | Single-flight LiquidFun QueryAABB / RayCast SAB                                                     |
| `box2dContactRingImpl.js` + `box2dContactRing.js`     | Contact/sensor event ring                                                                           |
| `box2dHotFields.js`                                   | Bind Transform/RigidBody hot views onto WASM HEAP                                                   |

## Dist / npm bundle

`npm run make_bundle` emits **8** single-file artifacts into `dist/` (UMD/ESM × debug/prod × raw/gzip-embed workers):

| Artifact                                                        | Notes                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `weed.bundle.min.js` / `.esm.min.js`                            | Debug UI, raw worker strings (`exports["./debug"]`)      |
| `weed.prod.bundle.min.js` / `.esm.min.js`                       | Debug stubs, raw worker strings (`main` / `module` / `exports["."]` ) |
| `weed.bundle.compressed.min.js` / `.esm.compressed.min.js`      | Debug UI, gzip-embedded workers                          |
| `weed.prod.bundle.compressed.min.js` / `.esm.compressed.min.js` | Debug stubs, gzip-embedded workers                       |

WASM is gzip-embedded in all 8. `.compressed` extra-gzips worker/glue/css strings; call `WEED.ensureEmbeddedSources()` before the first `Worker()` (Scene bootstrap does this). Uncompressed skips inflate (faster first load).

At runtime `getBox2dWorkerUrl()` creates one blob URL; that blob **is** the physics worker. Pthreads re-fetch the same worker URL via `_scriptName`. Smoke: `dist/index.html` (`?bundle=` to pick an artifact).

## Rebuild from sibling Box2D tree

From `Box2d_3.2_C_-_liquidfun`:

```bat
weedjs\build_for_weed.bat
```

Default: **pthread pool 0 + `-flto=full`** (`weedjs\build_for_weed.bat`). The link does not prewarm workers. `physics.numberOfPhysicsWorkers` is 1..32 (`B2_MAX_WORKERS`, clamped by the host), default 4; the pre-rename key `box2dWorkerCount` still works with a warning; helpers started are `count - 1`. Builds with `weedjs/weed_post.js` (`importScripts('weedjsPost.js')` then `physicsHostImpl.js`), `OUTPUT_NAME box2dWasm` (not lab `box2d_wasm`), runs a post-link `wasm-opt` size pass, and copies **only** `box2dWasm.js` + `.wasm` into this folder. Do not keep a snake_case pair here — glue `locateFile` follows `OUTPUT_NAME`. After that CMake name changes, `build_for_weed.bat clean` then rebuild.

**Memory.** The link imports its memory (`-sIMPORTED_MEMORY`) and accepts 16 MB to 2 GB
(`-sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=2GB`, only so the import takes a range). `weedjs/weed_pre.js`,
prepended with `--pre-js`, creates the memory from the physics worker's name (`physics pages=N`, set from
`physics.wasmMemoryMB` by `src/box2d/box2dMemory.js`) with initial = maximum, so it never grows.
`-sABORTING_MALLOC` turns a failed grow into `abort("OOM")`, which the host shows on screen. The `.bat`
refuses a glue without the pre-js, and the host refuses a heap of the wrong size. Design and survey:
[`docs/internal/BOX2D_MEMORY_PLAN.md`](../../docs/internal/BOX2D_MEMORY_PLAN.md). The glue is committed
with CRLF line endings; the build writes LF.

**WASM only.** Weed never needs sibling native `test.exe`, samples, or `demo_*.exe`. Correctness after a C change is Weed Node WASM tests + L2/visual, not ctest.

Fluids: `liquidfun-c` is compiled into this WASM. Integration and SAB rules: [`docs/guide/LIQUIDFUN.md`](../../docs/guide/LIQUIDFUN.md).

## Shapeless bodies / Collider composition

Wrapper exports (sibling `box2d/src/wasm_wrapper.c`):

- `create_body` — body, no shapes (RigidBody-only path)
- `body_add_shape_box` / `circle` / `polygon` — **append** a new shape (compound bodies)
- `body_set_shape_*` — replace the first shape, or create if the body is shapeless
- `body_set_chain` — replace the body's shapes with one `b2ChainShape` (open polylines: first and last points are ghosts)
- `body_clear_shapes` — destroy the chain, then **all** leftover shapes; body remains (unit mass if dynamic)
- `body_set_density` / `filter` / `friction` / `restitution` — apply to every shape on the body

Weed host wiring and product semantics: [`docs/guide/PHYSICS.md`](../../docs/guide/PHYSICS.md#rigidbody--collider-composition). Node gate: `tests/node/rbColliderComposition.wasm.test.js`.
