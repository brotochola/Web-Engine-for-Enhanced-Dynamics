# Less code in src/ without losing speed (N-303)

A plan, not started. The owner asked on 2026-11-18 for less code overall: duplicated code, code kept for backwards
compatibility, dead code, and code that could be managed better, all without losing speed. Register row N-303
(`REVIEW_PLAN.md#N-303`); the audit behind it is its first record (R-1430). Items CR-0 to CR-39 below.

## Where it stands

Main at e3283426. Counted without the generated files (`src/box2d/box2dWasm.js`, `src/wasm/engine.js`,
`src/vendor/pixi.min.js`):

| folder | code lines | comment lines |
| --- | --- | --- |
| `src/core` (with `debug/` 7 578 and `save/` 2 249) | 33 333 | 8 240 |
| `src/workers` | 22 909 | 4 851 |
| `src/render` | 15 777 | 4 823 |
| `src/box2d` | 10 325 | 874 |
| `src/util` | 9 829 | 3 755 |
| `src/shaders` | 3 355 | 666 |
| `src/components` | 3 067 | 931 |
| **`src/` in all** | **98 992** | **24 187** |

Shipped bytes: `src/wasm/engine.wasm` 351 269, `src/box2d/box2dWasm.wasm` 419 229,
`dist/weed.prod.bundle.min.js` 3 832 896 (1 218 729 gzipped at level 9).

**How it was found.** The audit had three parts:

- A clone scan: windows of normalized code lines, comments and imports left out.
- A reference scan: every export and method of `src/` searched for by whole word in `src/`, `demos/`, `tests/`,
  `scripts/` and `types/`.
- Six read-throughs, one per area: pixiWorker with the backends, the other workers, render with the shaders, the large
  core modules, debug with save, and box2d with components and util.

Ten of the largest findings were checked again by hand. Two of them:

- `instancedSpriteBlend.frag.glsl` is byte-identical to `instancedSprite.frag.glsl`.
- Emscripten's `cwrap` returns the raw export when every type is `"number"`, so the 447 lines of `physicsApi.js`
  that hold only `"number",` do nothing.

**What it found.** Literal copies are few: 122 clone pairs of 12 lines or more. Most copies of hot loops are on
purpose, and they stay. The volume is structural:

- layouts written by hand three to five times;
- lists of names kept twice or four times;
- losing variants left in shipped code;
- JavaScript references that only tests call, kept in `src/`;
- old code paths the engine can no longer reach.

The estimate is 5 000 to 6 500 code lines out of `src/` (5 to 7 %), plus about 1 000 moved into `tests/`, with the
public API whole (rule 9). Phase E (physics as a module worker) adds about 700 more. The line estimates are the
audit's; the result is counted (CR-0, and at the end).

**Main moved before this plan landed.** At fa12bc91, `src/` has 97 517 code lines, `engine.wasm` 355 529 bytes and
the prod bundle 3 800 634 bytes (1 215 877 gzipped). DX-ONELIGHT was merged (85ca7900, OL-15: `src/` 2 783 lines
shorter). It deleted the visibility-polygon and self-lit batches with their shaders, which the audit had listed for
CR-14, CR-17 and CR-28. Those parts are gone from the items below, and CR-28 with them. Line numbers in
`pixiWorker.js` and `preRenderWorker.js` are e3283426's: rule 1 re-checks them.

## Rules

1. **Re-check before cutting.** The audit's findings are leads, not facts. Each item starts by grepping again: `src`,
   `demos`, `tests`, `scripts`, `types` and the user guide's examples, including dispatch by string (message `type`s,
   `this[name]`, export names built from a variant). A bug the audit names gets a failing test first.
2. **One change per commit.** The title says what code changed. Measurement tools (CR-0, a kernel case, a scene
   knob) go in their own commit, before the change they measure.
3. **Cold code: removal is a hygiene keep.** Cold code is code that runs at init, at config, at compile time, on a
   message, in the debug bundle only, or never. It stays removed unless a primary worker gets 3 % worse
   (`HOW_WE_MEASURE.md`, "Judgment first", third lane). The suites are its check, and a Predator gate per batch
   covers anything that reaches shared infrastructure.
4. **Hot code: the speed lane.** Hot code runs per frame, per entity, per ray, per query or per command. Kernel
   first: it calls the shipped function, warms through short calls (`warmNormalCompile`), and checksums equal. Then
   the owner scene, ABAB from worktrees, 4 pairs, 4 more only if they do not decide, with the session's A/A for the
   detection limit. Then the next batch's Predator gate. A hot item that reads 3 % worse goes back, whatever lines it
   saved.
5. **The copies the repo keeps on purpose stay.** No shared helper and no loop-invariant branch inside a hot loop
   (review R8: 10 to 30 %). Hot callees stay under the inlining budget (E-59, the inlining limit; E-85, no doubles
   across a call TurboFan may leave out).
6. **Same output where it is free.**
   - A generated shader is byte-identical to the file it replaces: a test compares them before the file is deleted.
   - A save's bytes stay equal (`saveEncodeGolden`).
   - A shipped WebAssembly export stays bit-identical (its parity test).
   - A render change shows identical images: `compareCaptures` on WebGL and WebGPU, on Predator crowd 2.5 plain and
     on Predator `light3d=1` by day and by night, the same set as N-256 (the pixiWorker split).
7. **Shape rules hold** (CLAUDE.md). A dropped field goes together with its writes. A table that generates
   accessors uses compiled code per field (`component.js` `fieldAccessors`, E-170: closures from one function share
   their feedback, 26.6 ns against 8.8). Closures made per instance are not used.
8. **No backwards compatibility** (owner, 2026-11-18).
   - Old save formats, deprecated aliases, and shims for old builds or old WebAssembly go, with no notice period.
   - A save from an older format is refused with the existing version error, and nothing migrates it.
   - What a game can see changing is written in `NEXT_RELEASE.md`; that is the release notes, not compatibility.
9. **The public API stays, whole** (owner, 2026-11-18): nothing of it is deleted, whether this repository calls it or
   not, since a game outside it may.
   - "Public" means exported by `src/index.js` or `workerWeed.js`, declared in `types/`, or shown in `docs/guide/`.
     Before an item deletes something, the re-check (rule 1) also greps those three places.
   - A refactor may reimplement a public method, but its name, its arguments and what it returns stay.
   - The one exception is the deprecated aliases of CR-34, which the owner decided to remove (rule 8). Removing one
     updates, in the same commit:
     - `types/weed.d.ts` or `types/utils.d.ts`, with `npm run check:types`;
     - the guide's examples that use it;
     - `NEXT_RELEASE.md`;
     - `RETIRED_CONFIG_KEYS`, for a config key, so a scene that still sets it is told what replaced it;
     - the demos that call it, moved to the name it aliased.
10. **Tests that pin source text move in the same commit as the code they pin**, as behavioural tests where possible.
   - `bundleEngineShaders.test.js` matches the `fetchEngineShader('…')` literals.
   - `instancedSpriteBatchPma.test.js` reads source lines.
   - `devChecks.test.js` reads both webpack configs.
   - `engineFeatureCatalog.test.js` requires a row's module under `src/`.
11. **Line endings.** `particleWorker.js` is mixed. These are CRLF: `liquidFun.js`, `sun.js`, `liquidFunQuery*.js`,
    `gpuShadowCasters.js`, `liquidFunDensitySplat.js`, `liquidFunRender.js`, `liquidFunGroups.js`,
    `particleTween.js`. Edit them with a script that keeps their endings.

## How it is measured and tested

| when | what runs | decides |
| --- | --- | --- |
| CR-0, once | `scripts/codeSize.mjs` (to write, its own commit): code, comment and blank lines of `src/` by folder, without the generated files; the bytes of both `.wasm` files and the four bundles, minified and gzipped; the node suite's count and time. The baseline goes into a record. | the starting numbers |
| every commit | `npm run test:node`; `npm run test:demos` when a demo changes or a game can see it; `npm run check:types` when a `.d.ts` changes; `npm run test:bundle:build` when the webpack configs, the stubs, the shader files or the bundle's embed change | green, or the commit does not exist |
| a commit that changes `wasm/*.c` or `modules.json` | `scripts/buildWasm.mjs` with the pinned toolchain (`assertToolchain`), the shipped exports' parity tests, `engine.wasm`'s bytes before and after | bit-identical exports, fewer bytes |
| a phase that touches render | `compareCaptures` on the rule 6 set, plus one WebGPU scene (gpuGalaxyScene or meshGalleryScene) and one custom-layer demo | identical images |
| a phase that touches worker init or the physics host | `node tests/bench/sceneCycleSmoke.mjs`; one V8 deopt summary of a Predator run (`summarizeV8Deopt.mjs`) | every scene boots; no new steady deopt loop |
| a batch of kept changes | the Predator gate (`runPredatorAbab --name gate-cr-<phase> --vs <rev before the batch> --hyp-rev HEAD`, 4 pairs, the session's A/A) | hygiene: no worker 3 % worse past its detection limit |
| a hot item (phase C) | its kernel, then its owner scene (named per item), then the batch gate | a speed keep, a tie, or back out |
| the end | one scoreboard sitting against the revision before CR-1 (`npm run bench:scoreboard -- --vs <rev>`) and a Predator gate, both against the same base; `codeSize.mjs` again | the campaign's measured total: lines and bytes saved, no worker 3 % worse |

One A/A per session, in the scenes used that day. One benchmark at a time, on a quiet machine. Each item gets a
register record with its commit the day it lands (`node scripts/hypotheses.mjs record --hyp N-303 …`); records are
committed once per session.

No speed claim is made for phases A, B, D and E. Their claim is lines and bytes, and their guard is that nothing gets
3 % worse. A speed claim belongs to a phase C item, decided by its own sitting.

## Items

Lines are the audit's estimates. "Moved" lines leave `src/` but are not deleted.

### Phase 0: the ruler

| item | what | lines | check |
| --- | --- | --- | --- |
| CR-0 | `scripts/codeSize.mjs` and the baseline record (the table above, counted by the script) | +80 in `scripts/` | suites |

### Phase A: dead and no-op code (cold, hygiene keep)

| item | what | where | lines | check |
| --- | --- | --- | --- | --- |
| CR-1 | **`cwrap` type lists that do nothing.** `wrap(name)` takes only the name, because every argument and return is a number. weedjsPost also wraps 13 `body_*` exports a second time, which physicsApi already wraps. | `src/box2d/physicsApi.js` (170 `wrap` calls), `weedjsPost.js:3352-3475` | ~600 | suites, smoke |
| CR-2 | **physicsApi surface no one calls.** `BodyHandle` (868-949) and about 30 `PhysicsWorld` methods (`castMover`, `collideMover`, `overlapBox`, the world-anchor joint creators, ten `getParticleGroup*` getters, …), plus the wraps only they use. `create`/`createBox`/`createCircle` survive only as `createBodyDirect.test.js`'s oracle: the oracle moves into the test. This is the physics worker's internal API, not the public one: check weedjsPost's dispatch first. | `src/box2d/physicsApi.js` | ~400 | suites, smoke |
| CR-3 | **Query buffers written and never read.** `entityMetadataSAB` and `queryCacheSAB` with their size functions and plumbing. The test first: a scene with 65 precomputed queries throws a RangeError today, because the cache is sized for 64. | `querySystem.js:37-155, 404-429, 613-720`; `sceneSharedBuffers.js:1056`; `sceneWorkerBootstrap.js:218`; `abstractWorker.js:987-1009`; `scene.js:396` | ~110 | suites |
| CR-4 | **pixiWorker dead fields and imports**, each dropped together with its writes. `physicsWorkerIndex`, `_gpuParticleLiveRecords`, the three visible-unit report fields, `_rqPrevCount`, the `decalsTilesRGBA` view, `_lightGradientTexId`, `_lampVolumesSeen`, `maxShadowRenderItems`, `_shadowUploadQ`/`_shadowUploadOpts`, `_shadowTransform`/`_lightingTransform`, the decoration zoom fields (pre-render owns them), `particleFreeListTop`, `_rendererBackend`, `maxShadowsPerLight/PerEntity`. Imports: `sortByY`, `normalizeAngleDifference`. Commented-out `console.log` blocks and stale JSDoc. Not `entityLastTextureId`: it has 22 references and is checked apart. | `src/workers/pixiWorker.js` | ~120 | suites (workerShape) |
| CR-5 | **Dead code in the other workers.** particleWorker's `'REBUILD'` message and `rebuildWalkability` (NavGrid only sends `REBUILD_FROM_INDICES`). AbstractWorker's `getActiveEntityCount`/`Index`, `emptyQueryWarnings`, `_emptyUint16Array`, `_queryEntityMetadata`, `impactBuffer`, and the unused imports. spatialWorker's `_getCirclePattern`, and the two arrays the gather's views replace. logicWorker's `activeEntityCount`, `frameStartTime` (a `performance.now()` a frame with detailed stats on) and the branch at 424-427 that always yields null. pre-render's three warn flags that are never used. Commented-out logs in logic, particle and abstract. | `src/workers/*.js` | ~200 | suites |
| CR-6 | **Audio mixer branches the engine never takes.** SoundManager always creates `channelSab` and `levelsSab`, so `_mixDirect` and the null branches never run. `audioMixerLoop.test.js:460-470` moves to `_mixBuses`. The change is a deletion only, on the audio thread. | `audioMixerProcessor.js:205, 221, 278-296, 427` | ~30 | suites |
| CR-7 | **Shader code that is never chosen.** `instancedSpriteBlend.frag.glsl` (identical to `instancedSprite.frag.glsl`), `mainFragBlend` in both WGSL sprite files, the `alphaCut`/`alphaDiscard` plumbing that only chooses between the two identical files, and `colliderFillGlProgram`'s copy of `instancedSpriteGlProgram`. | `src/shaders/`, `instancedSpriteBatch.js:726, 1337`, `webgl/instancedSpriteGlsl.js` | ~60 | suites, bundle, captures |
| CR-8 | **Debug dead code.** `stubs/debugFlags.js` goes: the real module imports nothing, so the stub saves nothing. Its alias leaves both webpack configs, and the two configs share one stub list, since today one lists hotReload and the other hotSwap. In prod, `selectedEntity` then starts at -1 like the debug build. Also: toolManager's `toggleDecoEraser` and `deactivateAll`; `debugCanvas.hasActiveNavVisualization`; performancePanel's `LEAN_KEYS`, `DEFAULT_EXPANDED` and `fpsSmoothing.frameCount`. | `src/core/debug/`, `webpack.config.js`, `webpack.bundle.config.js` | ~200 | suites, bundle |
| CR-9 | **Save dead code.** `decodeUtf8`. The eight saveGame re-exports nothing imports through it, and the double import. The `name === 'Transform'` and `'RigidBody'` branches, which never match, since component maps are camelCase: check this first. Stale JSDoc. `buildLayoutHint` goes with CR-33, which changes the bytes. | `src/core/save/` | ~50 | suites (saveEncodeGolden) |
| CR-10 | **Exports and functions nothing references.** `isReservedLookUniform`, `isStaticType`, `_getStateNameByIndex`, `composeRotTo`/`Into`, `_cantorResult`, `isVerboseWorkers`, `bitsFloat`, `gpuVelocity`, `gpuParticleWorkerWriterSlot`, `visitParticleFeed`, `PAIR_U32_STRIDE`, `createEntityIdList`, `viewEntityIdList`, `resetMeshRendererFixtureWarn`, `warnMeshRendererNeedsFixtures`. Constants: `BODY_STRIDE_BYTES`, `INSTANCED_SPRITE_STRIDE`, `LF_LIGHT_SPLAT_STRIDE`, `PARTICLE_STRIDE_BYTES`, `PAINTER_RADIX_URL`, `GATHER_EV_OCCLUDER`, `DECAL_F_SCALAR`, `lampTileTag`, `meshFillHasLocals`, the facade constants in `box2dQueryAabb`, `liquidFunQuery` and `liquidFunUserDataList`. Also command-ring's `EXTRACT_PARTICLES` opcode and `enqueueExtractParticles`. Exports used only inside their own file lose `export` in the same commit (no lines, a smaller surface). | many | ~200 | suites |
| CR-11 | **Losing variants in the shipped `engine.wasm`.** bulletTick ships `bullet_tick_lean`. The other three variants and the stamp path go: `readyBulletStamps` runs every tick for stamps nothing reads, and `bulletStamp` reserves 4 bytes per entity. The painter ships `simd_inplace`: the other 14 radix, order and reinsert exports go, with `CORES`, `VARIANTS`, `variantCore` and `variantExports`. `premultiply_scalar` goes too. The variants move to a test module (`wasm/test/`, built into `tests/fixtures/wasm/`), and the tests and benches that pick a variant load it from there. | `wasm/bulletTick.c`, `wasm/painterRadix.c`, `wasm/decalPremultiply.c`, `wasm/modules.json`, `bulletTickClient.js`, `bulletPool.js:380`, `painterRadixClient.js:50-84`, `wasmMemoryMap.js:316`, `renderQueueMemory.js:274` | ~250 (JS and C) | wasm, suites; the bullet tick does less work: joins the batch gate |
| CR-12 | **Test-only code out of `src/`** into `tests/reference/`, `tests/helpers/` or `tests/bench/`, next to `painterJs` and `gpuPackJs`, which already live there. | see below | ~1 000 moved | suites; `engineFeatureCatalog` rows repointed |

CR-12 moves these:

- Whole modules: `decalBlitPack.js` (stale: 16 floats against the batch's 15), `sceneryCamPack.js`, `meshFillCamera.js`,
  `poseQueueInterp.js`, `util/toyWorldBounce.js`, and the old spawn queue of `util/createSpawnBatch.js:29-160`.
- The JavaScript copies of shader math:
  - `tilemapGid.js:192-285`, `lampShadowMap.js:66-127` and `volumeShadowMap.js:141-166` (`lampVolumeRayT`);
  - `edgeLightAt`, `pixelDepthValue`, `sunMapLanding`, `turnFrameNormal`, `meshLookPassUvs`;
  - `TWIN_GLSL` and `TWIN_WGSL`.
- colliderFillBatch's old row pack: `packMeshUvFill`, `writeUvTri`, the `R_UV*` rows and the
  `MESH_UV_FILL_*` constants (996-1134). Review R10 kept `writeUvTri` as a copy while it was the product; today it is
  only the tests' reference. Its old pose functions go with it, the ones `trackMeshFillPose` replaced (262-386,
  686-695), along with the dead UV branch of `rewriteCornersWasm`.
- utils' `readLightDataTexel`. The utils that only tests call but that `types/utils.d.ts` declares stay, by rule 9:
  `calculateDecalTileBounds`, `calculateTileClipRegion`, `cantorPair`/`Unpair`, `normalizeAngleSigned`,
  `calculateSpeed`, `countTrailingZeros`, `extractRGB*`. `utils.d.ts` says they are re-exported from the package
  entry, but `index.js` exports 16 utils and none of these. The owner decides whether to fix the types or add the
  export; nothing is deleted meanwhile.
- `computeSunFramesInto`, whose own comment says the frame passes no longer use it.

A parity test keeps comparing the reference with the product's code.

### Phase B: duplicates collapsed where the code is cold (hygiene keep)

| item | what | where | lines | check |
| --- | --- | --- | --- | --- |
| CR-13 | **One list of names for `WEED`.** Each symbol is written three times in index.js and twice more in workerWeed.js. One module of worker-safe `export { } from` lines plus `enums`; index.js does `export *`, then builds `WEED` from the namespace and adds the main-thread names; workerWeed spreads the same module and adds its stand-in Scene. The repeated `DEBUG_FLAGS`, `DEBUG_SELECTED_ENTITY_OFFSET` and `SPRITE_TILE_MODE` after `...enums` go. | `src/index.js`, `src/workers/workerWeed.js` | ~400 | suites (`workerWeed.test.js`), types (`checkTypesDrift`), bundle |
| CR-14 | **Shader variants generated from their base**, using the `// #if` that `shaderWithFlag` (`faceMap.js:664`) already reads, or exact replacements as `applyPixelSnap` does. The pose shaders come from instancedSprite: 4 lines differ in each language. The additive fragments come from their bases. lfLightSplat comes from lfSplat. A test first: the generated text equals today's file byte for byte; then the file goes, and the tests that read it use one shared reader. | `src/shaders/`, `opaquePass.js:123` | ~280 | suites, bundle, captures |
| CR-15 | **Shader chunks written once.** A `// #include` that `fetchEngineShader` and the bundle's embed resolve, for the group 0/1 header (copied in about a dozen `.wgsl` files) and `weedUv()` (9 files and `faceMap.js`). A JS constant for the three inline copies (`lightEdges.js:175`, `unshadedComposite.js:48`, `volumeShadowMap.js:499`). The same test: the resolved text equals today's. | `src/shaders/`, `pixiWorker.js:386`, `scripts/buildBundle.js:276` | ~300 | suites, bundle, captures |
| CR-16 | **One `render/shaderEdit.js`** for the seven local string-edit helpers, the about 30 inline `split(mark).length !== 2` checks, and the three "attributes become globals read from a texture" rewrites. | `opaquePass.js`, `spriteIndexed.js`, `pixelSnap.js`, `volumeShadowMap.js`, `sunShadowMap.js`, `lampShadowMap.js`, `gpuParticleBatch.js` | ~60 | suites, captures |
| CR-17 | **pixiWorker's cold copies.** See the list below, and the order section on N-256. | `pixiWorker.js`, `render/webgpu/`, `rendererBackend.js` | ~600 | suites, bundle, captures |
| CR-18 | **Render modules' cold copies.** ColliderFillBatch and MeshUvFillBatch share their setup (pose source, resources, program, State, Mesh, `_send`, `uploadPoseTable`); their per-entity loops stay. `makePackContext` and `_beginUpload` become one, which also declares `_uploadCtx.particleCount` from the start. gpuPackClient's keyed pair and its 16-word params block. InstancedSpriteBatch's five `_make*Buffer` and the `dummyLutSource` branches. The four ViewContainer render steps and the doubled `STENCIL_*`. The `GpuProgram.from` group 0/1 layouts. `meshCornersClient`'s generation slots. | `src/render/` | ~400 | suites, captures |
| CR-19 | **Layouts written by hand, one table each.** Joint: the declaration, `getBufferSize`, `initializeArrays` and `reset` from one `[name, ArrayType, alignment]` table, in today's order (physicsHostImpl mirrors it), plus the `update()` props table and the `add*` header. Layer's config buffer (four copies) and its three state resets. Tween's buffer layout (written twice). Component's aligned-layout loop (four copies). Hot readers keep their named loads, so nothing they compile changes. | `joint.js`, `layer.js`, `tween.js`, `component.js`, `sharedResource.js` | ~330 | suites |
| CR-20 | **The physics host's copies.** `PHYSICS_STATS` in one place (`box2dConstantsImpl.js`, already shared with the classic worker; R5's bundle constraint holds). LiquidFun's tuning defaults in one place, with the hand merge at `weedjsPost.js:2864-2898` as a key loop. The five cold LiquidFun ring writers through one `claimSlot()` that takes and returns integers (`enqueue`, the hot one, stays as it is). The host passes the bound views through instead of packing 119 views and rebuilding them on the other side in the same realm. | `physicsHostImpl.js:29-40, 107-523, 745-960`, `weedjsPost.js:142-155, 230-275, 291-449, 3560-3640`, `box2dCommandRingImpl.js`, `workersUtils.js:157-205` | ~700 | suites, smoke, deopt summary, batch gate |
| CR-21 | **Workers' init boilerplate.** One `createWasmMemory` in `wasmMemoryMap.js` for the seven `*Memory.js` copies of the page cap, the try/catch and the fit check. A `columnSlots()` helper and shared column writers in `wasmColumnTable.js`. The nine "`<name>.wasm` did not load" wrappers, since `loadWasmKernel` already names the kernel. logicWorker's `box2dReady` through `super`, with a binder table in AbstractWorker. AbstractWorker's four published-list bindings and its core/optional component loops. pre-render `initialize`'s fallbacks for a null `emitLayout`, which throws before them. The double `fixedFps` reads and `configKeyAliases`' fallback to keys the schema does not have. | `src/util/*Memory.js`, `src/workers/` | ~250 | suites, smoke |
| CR-22 | **Core's cold copies.** spriteSheetRegistry: the nine built-in texture blocks through a `pushBuiltIn`, and `getAnimationIndex`'s two identical branches. Scene: `_applyConfigDefaults`' fourteen spreads as one loop. SoundManager: `reset()` that repeats `unloadAll()`, and the doubled buffer setup. GameObject: `setTileWorld`/`setTileLocal`/`clearTile` as one `_setTile(mode)`, and `set tint`/`set visible` calling `setTint`/`setVisible` (integers only, so nothing is boxed; they join the batch gate). | `spriteSheetRegistry.js`, `scene.js`, `soundManager.js`, `gameObject.js` | ~260 | suites |
| CR-23 | **Debug UI from tables.** DebugFlags' nineteen `show*` methods as one-liners, one `{key: flag}` table driving `enable()`, `getState()` and the visual-aids panel (method names and key sets kept). An `el(tag, className, text)` DOM helper. One `PANEL_DEFS` and a `DebugPanel` base. toolManager's tool selection as one helper. Shared grid and arrow drawing for the physics and nav renderers. savesPanel's busy skeleton. statsCollector's doubled init. All of it ships only in the debug bundle. | `src/core/debug/` | ~560 | suites, bundle |
| CR-24 | **Save code's copies.** One framing helper for `encodeSave`/`decodeSave` and their uncompressed twins. A constructor table and `writeOptTyped`/`readOptTyped`. One worker-request helper for the four promise, timeout and listener skeletons. worldBufferSave's apply skeleton. `assertPayloadCompatible` without its per-entity `find`. | `src/core/save/` | ~100 | suites (saveEncodeGolden: same bytes) |

CR-17 covers these pixiWorker copies:

- the 37 shader fetches as a `[path, key]` table;
- one WGSL layout builder for the GpuProgram factories in `webgpu/` (`instancedSpriteWgsl.js`, `colliderFillWgsl.js`,
  `pixiMeshWgsl.js`);
- the `rgba32float` data texture and its upload dispatch (six copies each);
- the render-into-target and display-sprite boilerplate (19 and 9 sites; check the leftover option state);
- the render-queue fields copied three times on their way to `_bindSpriteQueue`;
- the GL upload preamble, and the Pixi-version guards the vendored Pixi does not need;
- config read twice;
- `rendererBackend.js`'s doubled backend-to-key ternary and the dead `if` at 367 (`resolveYSort` is CR-34's);
- the scenery creators;
- `_snapshotComputePose`.

### Phase C: copies on hot paths, each measured

| item | what | kernel | owner scene (primary) | lines |
| --- | --- | --- | --- | --- |
| CR-25 | **Ray's one-hit cast as `_traverseGrid` without exclusions.** `_castUnitDir` (282-391) becomes `_traverseGrid(null, mask, -1, -1)`. Then the cell-walk setup that remains twice becomes one helper writing into the module `Float64Array`/`Int32Array` (E-85: only integers cross the call). Also checked with the Chrome heap pass, which must show no new heap numbers. | `rayMicrobench.mjs` | rayStressScene (logic); bulletStressScene (particle) | ~125 |
| CR-26 | **One QuerySystem in both places.** Today the class path (831-1000) and the worker path (1062-1332) duplicate the masks, `query`, `queryActiveEntities`, `queryPublishedFrame`, the slow-query fallback and the publish. They have drifted apart: a commented-out warning, and 4 result buffers against 1. Workers build the class from serialized data, and each worker still sees one receiver class. | `querySystemMicrobench.mjs`, `querySnapshotReadMicrobench.mjs` | queryChurnScene, queryAabbStressScene (logic) | ~150 |
| CR-27 | **The lamp-frame JavaScript passes through `lampTurnFrame`.** They run only when the WASM pack declines or overflows. The doubles come through the module array. | `lampFramesMicrobench.mjs` with the kernel off; `castFramesParity` | none reaches the fallback in its normal regime: a kernel tie suffices (hygiene) | ~55 |
| CR-28 | **pre-render's self-lit record write, written four times.** Gone: DX-ONELIGHT deleted the self-lit batch before this plan landed. | — | — | 0 |
| CR-29 | **Accessor tables in compiled form** (rule 7). Gamepad's 34 three-line getters, Sun's about 20 static get/set pairs, Decoration's about 16 accessor pairs. | a call-cost case against today's hand-written accessors: must tie | Predator gate only if the kernel ties | ~280 |
| CR-30 | **Draw-call counting only when it is read.** Four wrappers allocate a rest array and spread on every WebGL draw, whether or not detailed stats are on. Install the hook only with `collectDetailedStats`, built by a loop. Work removed. | none | renderer, in the batch gate | ~15 |
| CR-31 | **box2dQueryAabb's filter for an old wasm.** The `seenStamp` duplicate filter at 195-234 is kept "for a wasm of that age", from before the WASM list became one entry per compound body. A compound-body query test on the shipped wasm comes first. | a query kernel | box2dQueryAabbScene (logic) | ~20 |
| CR-32 | **Per-frame literals that gain fields after the loop starts**: `makeBatchViews()` (`type`, `sortKey`, the shadow terms, `key`), `_computePose` (`poseAlpha`), the mesh-fill skip literal (`_skipRt`, `localsReady`, and `lastVertGen` that starts `null`). Found on the way, not a reduction. `workerShape.test.js` is extended to literals made by a factory. | heap and deopt pass (`heapSampleWorkers.mjs`, `summarizeV8Deopt.mjs`) | renderQueueStressScene or keyedPackStressScene (renderer) | 0 |

### Phase D: the owner's decisions (public API and compatibility)

Each row says what goes and what a game sees. A row the owner approves is then a cold removal (rule 9) and joins
phase A; a row the owner refuses is marked here and in the register. On 2026-11-18 the owner decided (R-1431):

- CR-33 and CR-34 go: no backwards compatibility.
- Nothing of the public API is deleted: CR-35 and CR-36 stay.

CR-37 and CR-38 touch no public API; they are still open.

| item | what | lines | the owner decides |
| --- | --- | --- | --- |
| CR-33 | **Reading old saves.** The legacy tags 8 to 11 and 14, the u16-entity and layout-1 tween paths, LiquidFun's `feedLayerId`, `Layer.maskFromLegacy`, the "appended after v4" guards, the `components[name]` lookups of an old snapshot shape, and `buildLayoutHint` with the `layout` field nobody reads. When the writer's bytes change, the format goes to 6: `decodeSave` refuses 5 with its version error, and `saveEncodeGolden` takes the new bytes. | ~75 in `src/`, ~120 in tests | **Decided 2026-11-18: they go.** The old saves were the owner's own test saves and are not needed. Done as a phase A removal (hygiene), with no migration. |
| CR-34 | **Deprecated aliases** (marked `@deprecated` or "alias" in the code). `physics.maxFixtures`, with the downstream fallbacks in sceneSharedBuffers, pixiWorker, weedjsPost and physicsHostImpl, and one line in `RETIRED_CONFIG_KEYS` naming `maxFixturePoolSize`. `box2dWorkerCount`. Mouse's 13 aliases of the `isButton*` names: 4 demos and uChainScene move to `isButton*`. Also `loadStaticFlowfieldsFromJSON` (the old name of `loadStaticFlowfields`), LiquidFun's `getParticleViews` and `getParticleGroups` (of `getViews` and `getGroups`), and `DECORATION_NO_PARENT`, a fixed `0xffff` that is wrong with 32-bit entity ids (of `decorationNoParent()`). The internal aliases: `BODY_TYPE`, `resolveYSort`, `warnMeshRendererNeedsFixtures` and AbstractWorker's `configKeyAliases`. Not aliases, so they stay (rule 9): `Ray.castDir` and `Ray.getLineOfSightInfo`, both documented in `RAYCASTING.md`. | ~150 | **Decided 2026-11-18: they go now**, with no notice period. Done as a phase A removal, with types, guide, demos and `NEXT_RELEASE.md` in the same commit. |
| CR-35 | **Public API with no caller in the repo.** Scene's config getters (`needsParticleWorker` is always true, `numberOfPreRenderWorkers` always 1). Grid's cell-sleeping methods. spriteSheetRegistry's `validateSpriteConfig`, `getAnimationData` and `getAnimationFrameCount`. Scene's `getMemoryUsageSummary`. NavGrid's `isPositionWalkable` and `setWalkability`. TileMap's `hasTile`, `getLayerNames` and `tileToWorld`. GameObject's `clearTile`, `setAnimationLoop`, `getAllNeighborInstances` and `getJoints`. SoundManager's `unloadMany` and `getSoundId`. LiquidFun's seven range wrappers. DebugFlags' `SHOW_PROFILER`, `SHOW_COLLISION_CANDIDATES`, `enablePerformanceDebug` and `colors`. The workers' `self.PIXI`. The work that remains: a behavioural test for each, so they cannot break unseen (none has one today), and types for the LiquidFun range wrappers, four of which the guide shows. | 0 out, tests added | **Decided 2026-11-18: all of it stays** (rule 9). |
| CR-36 | **The four `config.wasm.*F32` switches.** They are typed public config. | 0 | **Decided 2026-11-18: they stay** (rule 9). |
| CR-37 | **The untiled light path.** `_lightTilesOn` is always true. The `!TILES` blocks in `lightingBasic.frag.glsl` and `lightingBasic.wgsl` stay only as `tests/bench/gpuPass/passes.js`'s baseline. | ~30 | whether that baseline is still needed |
| CR-38 | **pre-render's JavaScript visibility gather** (`preRenderWorker.js:6025-6204` at e3283426). It runs when sceneSharedBuffers does not lay out the gather regions: physics on with no RigidBody pool, no Collider pool, or no spatial publish. Laying them out in every case lets it go. The scenes that move onto the kernel get a pre-render owner sitting. | ~180 | an engine layout change |

### Phase E: physics as a module worker (large; its own plan when it is reached)

| item | what | lines | blockers |
| --- | --- | --- | --- |
| CR-39 | The physics worker loads as a module. Out go the 14 ESM facades, the Impl `global.X = {…}` blocks, the IIFEs and load-order guards, the host's copies of the frame clock, frame totals, time scale and stats, the importScripts shim in `scripts/buildBundle.js`, and the globalThis wait meter. | ~700 | Box2D's glue rebuilt with `-sEXPORT_ES6` in the sibling repository; an `import()` after the `em-pthread` check, so the pthreads do not run the engine's imports; webpack bundles the physics worker; about 25 tests that evaluate the classic sources move to imports; the component schemas move to modules without imports. Gate: Predator plus ballsHeavyStressScene, contactDrainStressScene and liquidFunStressScene (physics), `test:bundle`, and the isolation service worker's path. After CR-20. |

### Not to do

- **The light-term preamble copied four times in pixiWorker** (centre, elevation, colour per light). It was inlined on
  purpose after boxing losses (the comments cite E-109 and E-311).
- **The light-splat packers' setup.** Measured and kept as copies: R8 (sharing the setup cost the loops 10 to 30 %).
- **The copies on purpose.** spatialWorker's inline collider bounds (653/1076/1464, `spatialGridMovers.test`),
  logicWorker's tick-loop pairs, spriteDirections' wrap and distance code (283-349), the per-entity loops of
  colliderFillBatch, the splats and `packMeshUvVerts`, the U16/F32 free-list pairs, and the command ring's `enqueue`.
- **Generating WGSL from GLSL with a translator** (naga, tint). The emitted text changes, so GPU time would need
  measuring again, and it adds a toolchain. CR-14 and CR-15 get the same lines with identical text.
- **Generating GameObject's accessors.** Most are custom; the few plain ones save about 30 lines through the
  compiled form, which is not worth it.

## Order and coordination

- **Phase A first**, with CR-33 and CR-34, which the owner decided. It depends on nothing, it is mostly deletion,
  and it shrinks what N-256 (the pixiWorker split into subsystem classes) has to move.
- **pixiWorker and N-256.** N-256 is not started, and DX-BARRIOS's group R lands before its PW-1.
  - CR-4 and CR-7 go before PW-1.
  - CR-17 is done subsystem by subsystem, right after the PW item that moves that subsystem, in its new module. That
    way the two plans never edit the same lines twice.
  - If N-256 does not start within the campaign, CR-17 goes on its own, with Pixi frozen meanwhile (N-256's rule 6).
  - CR-14 and CR-15 touch `pixiWorker.js` only at the shader fetches, which CR-17's table replaces: do CR-17's fetch
    table first.
- **Phase B order.** Its items are independent, with two exceptions: CR-20 comes before CR-39, and CR-13 before
  CR-34, so there is one list to edit.
- **Parallel work, one writer per file.**

  | owner | items |
  | --- | --- |
  | box2d | CR-1, CR-2, CR-20, CR-31 |
  | shaders and render | CR-7, CR-14 to CR-16, CR-18 |
  | core | CR-3, CR-19, CR-22, CR-25, CR-26, CR-29 |
  | debug and save | CR-8, CR-9, CR-23, CR-24 |
  | workers other than Pixi | CR-5, CR-6, CR-21, CR-27 |
  | Pixi | CR-4, CR-17, CR-30, CR-32 |
  | wasm | CR-11 |
  | cross-cutting, alone | CR-10, CR-12, CR-13 |

  Every commit runs the full suite, whichever owner made it.
- **Phase C.** One sitting per item, one benchmark at a time, the A/A once per session.
- **Phase D** waits for the owner, item by item. Phase E comes last, with its own plan.

## Estimate

| phase | items | lines out of `src/` | agent time | machine time |
| --- | --- | --- | --- | --- |
| 0 | CR-0 | +80 in `scripts/` | an hour | none |
| A | CR-1 to CR-12, plus CR-33 and CR-34 (decided) | ~2 300, plus ~1 000 moved | two and a half days | one A/A and one Predator gate |
| B | CR-13 to CR-24 | ~4 100 | four days | captures per render item, two Predator gates |
| C | CR-25 to CR-32 | ~650 | two days | about seven owner sittings and one gate |
| D | CR-35 (tests and types only), CR-37, CR-38 | ~210 if CR-37 and CR-38 are approved | a day | one pre-render sitting (CR-38) |
| E | CR-39 | ~700 | its own plan | Predator and three physics scenes |

The phases add up past the 5 000 to 6 500 lines given above, because the audit's estimates overlap: several items
touch the same lines. The count after each phase is the one that stands.

## Done when

- `codeSize.mjs` shows `src/` at least 5 000 code lines smaller than the CR-0 baseline without phase E, and
  `engine.wasm` and the prod bundle smaller.
- Every commit's suites were green. The captures were identical. The batch gates and the closing scoreboard against
  the revision before CR-1 show no worker 3 % worse past its detection limit, and each verdict states that limit.
- Every phase C item has its verdict: kept, tie (kept as hygiene) or backed out. Every phase D item has the owner's
  decision.
- Every item has a register record with its commit under N-303, and `README.md` and CLAUDE.md name what moved
  (`tests/reference/` and the shader includes).
