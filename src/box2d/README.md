# Weed Box2D runtime (`src/box2d`)

Classic physics worker for **Box2D 3.0 WASM** (pthread + SharedArrayBuffer). Scene’s `workers.physics` **is** [`box2dWasm.js`](box2dWasm.js), which loads [`weedjsPost.js`](weedjsPost.js) then [`physicsHostImpl.js`](physicsHostImpl.js). Host speaks Weed `init`/`start` and calls `weedjsDoStep` in-process.

## Layout

| File | Role |
|------|------|
| `box2dWasm.js` / `.wasm` | Emscripten glue + binary |
| `physicsHostImpl.js` | Weed protocol + frame loop + `weedjsDoStep` |
| `weedjsPost.js` | World create/destroy, sync, command ring drain, step |
| `physicsApi.js` | `PhysicsWorld` / `BodyHandle` over `cwrap` (`create` = shapeless body; `addShape*` / `clearShapes`) |
| `box2dConstantsImpl.js` + `box2dConstants.js` | Dual-load enums / state channels |
| `box2dCommandRingImpl.js` + `box2dCommandRing.js` | Pose / vel / fixedRotation / LiquidFun create commands |
| `box2dQueryAabbImpl.js` + `box2dQueryAabb.js` | Single-flight gameplay QueryAABB SAB |
| `box2dOverlapCircleImpl.js` + `box2dOverlapCircle.js` | Single-flight overlapCircle SAB |
| `box2dCastRayAllImpl.js` + `box2dCastRayAll.js` | Single-flight castRayAll SAB |
| `liquidFunQueryImpl.js` + `liquidFunQuery.js` | Single-flight LiquidFun QueryAABB / RayCast SAB |
| `box2dContactRingImpl.js` + `box2dContactRing.js` | Contact/sensor event ring |
| `box2dHotFields.js` | Bind Transform/RigidBody hot views onto WASM HEAP |

## Dist / npm bundle

`npm run make_bundle` emits **8** single-file artifacts into `dist/` (UMD/ESM × debug/prod × raw/gzip-embed workers):

| Artifact | Notes |
|----------|--------|
| `weed.bundle.min.js` / `.esm.min.js` | Debug UI, raw worker strings (default `main` / `module`) |
| `weed.prod.bundle.min.js` / `.esm.min.js` | Debug stubs, raw worker strings |
| `weed.bundle.compressed.min.js` / `.esm.compressed.min.js` | Debug UI, gzip-embedded workers |
| `weed.prod.bundle.compressed.min.js` / `.esm.compressed.min.js` | Debug stubs, gzip-embedded workers |

WASM is gzip-embedded in all 8. `.compressed` extra-gzips worker/glue/css strings; call `WEED.ensureEmbeddedSources()` before the first `Worker()` (Scene bootstrap does this). Uncompressed skips inflate (faster first load).

At runtime `getBox2dWorkerUrl()` creates one blob URL; that blob **is** the physics worker. Pthreads re-fetch the same worker URL via `_scriptName`. Smoke: `dist/index.html` (`?bundle=` to pick an artifact).

## Rebuild from sibling Box2D tree

From `Box2d_3.2_C_-_liquidfun`:

```bat
weedjs\build_for_weed.bat
```

Default: **4 pthreads + `-flto=full`** (`weedjs\build_for_weed.bat`). Builds with `weedjs/weed_post.js` (`importScripts('weedjsPost.js')` then `physicsHostImpl.js`), `OUTPUT_NAME box2dWasm` (not lab `box2d_wasm`), runs a post-link `wasm-opt` size pass, and copies **only** `box2dWasm.js` + `.wasm` into this folder. Do not keep a snake_case pair here — glue `locateFile` follows `OUTPUT_NAME`. After that CMake name changes, `build_for_weed.bat clean` then rebuild.

**WASM only.** Weed never needs sibling native `test.exe`, samples, or `demo_*.exe`. Correctness after a C change is Weed Node WASM tests + L2/visual, not ctest.

Fluids: `liquidfun-c` is compiled into this WASM. Integration and SAB rules: [`docs/LIQUIDFUN.md`](../../docs/LIQUIDFUN.md).

## Shapeless bodies / Collider composition

Wrapper exports (sibling `box2d/src/wasm_wrapper.c`):

- `create_body` — body, no shapes (RigidBody-only path)
- `body_add_shape_box` / `circle` / `polygon` — create shape if missing, else `Set*`
- `body_set_shape_*` — aliases of add (sync path)
- `body_clear_shapes` — destroy shapes; body remains (unit mass if dynamic)

Weed host wiring and product semantics: [`docs/PHYSICS.md`](../../docs/PHYSICS.md#rigidbody--collider-composition). Node gate: `tests/node/rbColliderComposition.wasm.test.js`.
