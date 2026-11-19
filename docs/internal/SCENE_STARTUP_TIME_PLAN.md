# Scene start up time (plan)

**Opened:** 2026-11-17, planned in a chat session with the owner. **Status:** a plan, not started;
nothing in it is measured yet. **Estimate:** about 9 to 10 hours of work in a row for everything but
SST-9, 4 to 5 hours with agents in parallel; SST-9 another 3 to 5 hours, in a session of its own
(section 4). **Registry:** `DX-STARTUP` and its items `SST-0` to `SST-10` in
[`hypotheses.json`](./hypotheses.json).

The goal: every scene starts sooner, for the player opening a game and for the developer reloading
one, on any scene (not one demo), without anything getting worse once it runs.

**The owner's rule (2026-11-17): the game starts with everything ready.** Every asset is loaded and
decoded before the first frame, audio included; every texture is on the GPU and every program or
pipeline is built. Nothing loads, decodes or compiles after the start. The time comes from doing the
work in parallel, earlier and once, never from leaving it for later. So:
- starting with sounds still loading was proposed and **rejected** ("no me gusta la idea de arrancar
  el juego sin audio, tenemos que tener todo listo para arrancar");
- making something lazy is allowed only when it is never needed by the first frames (an inspector, a
  debug view); work a frame will need is made faster, not postponed.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the first commit.
- Work on a branch (`dx/startup`). One item per commit; measurement tools in their own commit before
  the change they measure.
- **The light protocol (the owner, 2026-11-17), section 2:** the suites on every commit, one quick
  first-frame number per item, no sittings per item; the full matrix once, at the end, for the total.
- SST-0 comes first: no item is started before the waterfall can show what it changes.
- With agents in parallel, partition by files (section 4): never two writers on one file.
- Tick the item here (`[x]` plus the commit hash) in the commit that finishes it, add anything new
  under "Found while building", update its row in `hypotheses.json` and write its record (then
  `node scripts/buildHypothesesPage.mjs`).
- Before any browser run: no other session benchmarking, the laptop on AC power.

---

## 1. How a scene starts today

From `GameEngine.loadScene` (`src/core/gameEngine.js`) to the first drawn frame, as read in the code on
2026-11-17:

```
main      import the scene module → new Scene → Scene.init:
            audio worklet → entity scripts → (Adobe) → reserveBox2dBlock → shared buffers
            → createSceneWorkers: new Worker × N, then preloadAssets
                (atlas ∥ tilemaps ∥ flowfields ∥ shader sources ∥ audio fetch and decode)
            → texture metadata, init data → 'init' to every worker → await readyPromise
            → config.layers content → preload() → create() → createNewGame() → spawn barrier → start
workers   module evaluated at new Worker … idle until 'init' … then each one:
            common buffers, entity scripts, engine.wasm compile, kernel binds, its own setup → ready
renderer  first draw: Pixi uploads the atlas and tilesets, links what was not linked ahead
```

Almost everything runs in a row, and the workers spend the first half of the load idle, waiting for
the atlas. What is known already:

- **The atlas.** `SpriteSheetRegistry.createBigAtlas` (`src/core/spriteSheetRegistry.js`) runs on the main
  thread: it fetches and decodes every image and sheet, reads each sheet's pixels once (trim, standing
  base, texels), packs with `MaxRectsPacker`, draws everything into a 2D canvas of up to 4096², paints
  the maps page, copies the canvas to an `ImageBitmap` and transfers it to Pixi. N-124 took the pack
  from 17 873 to 177 ms for the Buenos Aires demo's 4 386 frames; the whole `createBigAtlas` there was
  about 1.25 s after R-0852. Scenes with a baked atlas (Predator, littleCity) skip it, but
  `Scene._loadBakedBigAtlas` still draws the whole atlas into a 2D canvas on the main thread (for
  decals and the inspector).
- **Buenos Aires, 2026-11-10 (R-0849):** first drawn frame 6.1 s after `loadScene` on WebGL, 4.6 s on
  WebGPU. Not measured since.
- **engine.wasm (337 KB)** is fetched and compiled by every worker that uses it (spatial × N, particle,
  pre-render, Pixi: `compileWasmKernel` in `src/util/wasmKernel.js`), with `WebAssembly.compile(bytes)`,
  and only after 'init'. Inside a worker the kernel binds are awaited one after another (pre-render 9 in
  a row, particle 6, Pixi 5, spatial 2). R-0640 found posting a compiled module "not needed" for the
  step times of the first 2 s; load time was not measured. Box2D uses `instantiateStreaming` and starts
  early (`reserveBox2dBlock`).
- **Game scripts in the bundle.** Blob workers cannot `import()`: `expandBlobEntityScripts`
  (`src/util/utils.js`) walks the dependencies with one awaited fetch per file, then `loadSingleScript`
  fetches each file again; every worker and the main thread repeat it. In source builds the workers
  import the scene module and the browser fetches its graph in parallel.
- **Logic waits for physics.** With physics, logic reports ready only after `box2dReady`, and then runs
  `createGameObjectInstances`'s per-class setup.
- **Pixi.** In source builds the engine shaders are fetched after 'init'; `requestWeedGpu` and then
  `pixiApp.init` come after that wait; the atlas and tilesets are uploaded at the first draw;
  `loadSpritesheets` builds one `PIXI.Texture` per atlas frame; tilemap pages are built when
  `preload()` sends `setLayerContent`. E-475 links the WebGL programs ahead, before ready (Predator by
  night: 0.54 s blocked on links); E-494 (open) finds about 620 ms more in the second frame, from
  programs made on first use. On WebGPU nothing is built ahead.
- **Scene changes.** `loadScene` destroys the scene, terminates every worker and makes new ones (and a
  new canvas, since `transferControlToOffscreen` happens once): parsed code, compiled wasm, the GPU
  context and linked programs are thrown away between a menu and a game, or between two levels.
- **Smaller repeats.** Every spatial worker computes the same circle patterns into the same shared
  table; every worker deserializes the sprite and Adobe registries and registers each static
  flowfield; per-pool fills and allocations in every worker (E-209 measured such work at a few ms per
  100 000 slots).

---

## 2. How load time is measured

`HOW_WE_MEASURE.md` judges speed by `STEP_MS`; load work is judged on time to the first frame (W21e's
record said so). SST-0 adds a short "Load time" section there when the tool lands.

**The light protocol (the owner, 2026-11-17).** These changes run once, at the start, outside every
frame; when they pay, they pay seconds anyone can see. So no item gets a sitting of its own:

- **On every commit: the suites.** `npm run test:node` (about 15 s) and `npm run test:demos`, and the
  scenes still boot. The start is shared by every scene: a mistake there breaks all of them, not one.
  The delicate items get a test of their own: the message order (SST-1), the scripts' evaluation order
  (SST-3), the same atlas (SST-5: the hash of its pixels and of its JSON, as N-124 and R-0852 checked),
  a fresh load equal to a reloaded one (SST-9).
- **Per item: one quick number.** Time to the first drawn frame before and after, on the scene the
  item targets, a few runs, with the waterfall (SST-0) to see which bar moved. It goes in the commit
  message and the item's record. An item that moves nothing is said so, and dropped or kept as
  hygiene by judgment.
- **Once, at the end: the full matrix,** the base commit against the campaign's last commit, both from
  worktrees: the total for the record and the README.

The measures:
- **Time to the first frame:** from the `game.loadScene` call to the renderer's first drawn frame (not
  the first published one: in a GPU-bound scene the two differ). From navigation too, which adds the
  page's modules (`tests/bench/isolationLoadTime.mjs` measures navigation to the first published frame
  and is the base to extend).
- **Must not get worse:** the longest frame in the first 5 s after the start (everything ready means no
  hitch after it). The main thread's longest task during the load is reported (the loading screen's
  smoothness), not judged. Steady `STEP_MS` is not run per item: none of these touches per-frame code;
  an item that does follows `HOW_WE_MEASURE`.

The final matrix:
- **Scenes:** `buenosAiresScene` (packs its atlas from many sheets, big floor shader), `predatorScene`
  with `?light3d=1&hour=22` (baked atlas, physics, the most programs), `bunnyMarkScene` (few assets:
  the fixed cost of starting), and one scene change (menu → scene) when SST-9 is done.
- **Conditions:** source build and prod bundle; cold (a fresh profile, empty caches) and warm (the
  second visit, same profile); WebGL and WebGPU.
- **Machines:** the main machine, and the ASUS test laptop (2 cores, HDD), where load time hurts most.
- **Runs:** a fresh browser context per run, headed, 5 runs a side alternating A and B, medians with
  p25–p75, the image identical (`compareCaptures`).

---

## 3. Items

Each item says what changes, where, why it should pay, and how it is checked. Gains are not estimated
until SST-0's baseline: the order below is a bet from reading the code.

### SST-0 — The load waterfall (measurement tool)

- [x] 36098a8e, b4af7157 (`src/util/loadMarks.js`, `tests/bench/loadWaterfall.mjs`, HOW_WE_MEASURE "Load time"); the
  first waterfalls are in section 6

Marks for every phase on one clock (`performance.timeOrigin + performance.now()` on each thread):
- main: each `Scene.init` step, each branch of `preloadAssets`, and inside the atlas: fetch and decode,
  pixel readback, pack, draw, maps page, bitmap;
- every worker: module evaluated, 'init' received, common buffers, entity scripts, engine.wasm compile,
  each kernel bind, Pixi's GPU device and `pixiApp.init`, shader fetches, link ahead, ready;
- the renderer's first drawn frame, and the longest frame in the first 5 s.

A runner collects them and prints a table and a timeline that names the chain ending last (the
critical path of the load). Marks cost nothing measurable at load; none runs per frame. Then one
quick waterfall of each of the three scenes (source build, warm, the main machine), to order the
items; the full matrix waits for the end (section 2).

### SST-1 — Workers start before the assets: boot, then configure

- [x] 67d5c707 (the page and the workers), 4450ca64 (the renderer), d78908f6 (merged): R-1451

Split each worker's start in two messages:
- **'boot'**, sent right after `new Worker`, with what depends on neither assets nor buffers: the
  config, the worker's role, engine.wasm (SST-2), the engine shader sources, Pixi's `OffscreenCanvas`.
  The worker starts at once:
  - the game scripts (SST-3);
  - its kernels' compile;
  - Pixi: the GPU device, `pixiApp.init`, the engine programs and their links (the passes a scene uses
    are known from its config).
- **'init'** (configure) then only binds the shared buffers, the atlas metadata and the textures.

The main thread creates the workers at the top of `Scene.init`. `abstractWorker`'s message queue
already orders messages that arrive early. Expected: the workers' own start (wasm, Pixi, links)
overlaps the asset load instead of following it. Checked by SST-0 (the workers' bars move under the
atlas's), all suites, every demo booting (`test:demos`, the scene smoke).

### SST-2 — engine.wasm compiled once, on the main thread, and shared

- [x] b1750d20: R-1451

- The main thread starts `WebAssembly.compileStreaming(fetch(engineWasmUrl))` as `loadScene` begins;
  in the bundle it inflates the data URL once.
- It posts the `WebAssembly.Module` with 'boot'; `compileWasmKernel` takes a posted module instead of
  compiling its own.
- Streaming compile from an HTTP response lets Chrome cache the compiled code between visits (source
  builds, and any build that serves the .wasm as a file: SST-8).
- Inside each worker, the kernel binds that do not depend on each other go through one `Promise.all`.

Checked by SST-0 (compile bars: one instead of four or more), the WASM node tests, every scene booting
in Chrome and Firefox.

### SST-3 — Game scripts fetched once and in parallel (bundle)

- [x] 3ce60f3f, built; bundle only, not timed yet

- The main thread fetches the scene's script graph once, all files at the same time, and parses each
  file's imports as it arrives.
- It posts `{ url → text }` with 'boot'. Workers evaluate from those texts in today's dependency
  order, with no fetch of their own and no second fetch.
- Source builds keep `import()`; only check that the main thread's own load does not hold up anything
  that does not need it (SST-4).

Checked by a test that compares the evaluation order with today's walk on a graph with a shared
dependency, the bundle smokes, SST-0 on the prod bundle.

### SST-4 — The main thread's start in parallel

- [x] d4bee501: R-1451 (the asset branches start at 8 ms; the page thread stays the critical path, SST-5)

Today `Scene.init` awaits in a row: the audio worklet, the entity scripts, Adobe,
`reserveBox2dBlock`, the buffers, the workers, then the assets. Start everything that does not depend
on the rest at the top of `init` (or in `loadScene`, right after the scene module's import):
- every asset fetch and decode: atlas sources or the baked atlas, tilemaps, flowfields, shader sources,
  audio fetch and decode;
- the audio worklet;
- the workers (SST-1) and engine.wasm (SST-2).

Each result is awaited where it is consumed, and everything is still awaited before the start, audio
included (the owner's rule). First list each step's real inputs (does `reserveBox2dBlock` need the
entity scripts, through the entity count?). Also check `transitionCooldown` (100 ms awaited at the
end of `loadScene`): it delays `loadScene`'s promise, so a loading screen that waits on it stays
100 ms longer.

### SST-5 — The atlas: its layout apart from its pixels, off the main thread

- [x] 50097fd1 (step 4), 4cb18456 (steps 1-2), 129ad91e (the twin page), merged 49a206db: R-1452 (mixed: the page thread freed; a cold source build pays the atlas worker's module load, SST-13); step 3, the GPU composition, left (decals and the cache need the CPU atlas)

1. **Layout first.** The layout (rectangles, trims, bases, texels, proxy sheets: the JSON) is all the
   main thread and the workers need to configure. The pixels are needed only by the renderer, which
   waits for them before it reports ready.
2. **Off the main thread.** An atlas worker, or the per-sheet work (decode, readback, trim, texels)
   spread over a few short-lived workers, with the pack in one (it is sequential, and cheap since
   N-124). The main thread stays free, so the loading screen stays smooth.
3. **Pixels composed on the GPU.** The renderer receives the sheets as `ImageBitmap`s and draws each
   frame into the atlas texture at its packed rectangle, instead of a CPU 2D canvas, a 64 MB copy and a
   64 MB upload. The main thread's users of the CPU atlas (`extractDecalTextures`, `BigAtlasInspector`,
   the bake script) read from the source sheets or get the atlas on demand.
4. **The baked path.** `Scene._loadBakedBigAtlas` stops drawing the whole atlas into a 2D canvas on the
   main thread when only decals need some of it.

Checked by the same atlas (pixel and JSON hashes), `atlasTrim.test.js`, decals drawing the same, SST-0
on Buenos Aires.

### SST-6 — The atlas cached automatically (an automatic bake)

- [x] 7f4ca602: R-1452 (Predator by night warm 3 246 -> 2 005 ms); on by default (`assets.atlasCache`), the owner may say otherwise

- **Key:** a hash of the inputs: each source's URL with its bytes' hash (or its validators), the atlas
  options, the atlas format's version.
- **Hit:** the atlas loads as a baked one (pixels and JSON) from Cache Storage or OPFS.
- **Miss:** it is packed, then written in the background without delaying the start.

The developer iterating and the returning player skip the trim, the pack and the draw. The
invalidation must be exact: a changed sheet changes the key. `config.assets` gets a switch to turn it
off, and old entries are cleared. Compare storing a PNG with storing the raw texels (no encode or
decode). Checked by tests on the key (a changed byte, a changed option, a new engine version each miss)
and SST-0 warm against cold.

### SST-7 — The GPU ready before the first frame

- [x] 8a21a209 (step 1), 228bb256 (step 2, E-494), 67bead52 (step 3, WebGPU), 3157f110 (step 4): R-1451, the renderer's longest step after the start 109 -> 36 ms

1. Upload the atlas, the maps page and the tilesets during init, not at the first draw.
2. The programs made on first use, built and linked at init: that is **E-494**, which stays the row for
   it.
3. WebGPU: build the pipelines a scene will use during init, asynchronously
   (`createRenderPipelineAsync`); E-475's link ahead covers WebGL only.
4. Pixi's one `Texture` per atlas frame (4 386 in Buenos Aires): measure it. If it costs, build them
   more cheaply, not lazily.

Checked by the longest frame in the first 5 s and the first drawn frame (SST-0), and the image identical
on both backends.

### SST-8 — The workers' code: parsed once, cached between visits

- [x] 223612be, 041381c3, 4f63a9ba (`buildBundle.js --files`): R-1460 (Predator by night cold 5 852 -> 3 542 ms, warm and hot a tie); the single-file bundle stays the default

- **Source builds:** every worker imports the whole `src/` tree by itself: hundreds of requests times 7
  or 8 workers.
- **The bundle:** its workers are blobs, which get no V8 code cache, so every visit parses every
  worker's code again, Pixi included. engine.wasm inlined as a data URL gets no wasm code cache either.

Options:
- a bundle mode that writes the worker files and engine.wasm beside the bundle, which gets the code
  cache and streaming compile; the single-file bundle stays for embeds;
- for source builds, one pre-bundled file per worker role, or preloading.

Measure cold and warm on the ASUS first: this is where it shows.

### SST-9 — Workers kept across scene changes

- [ ] not started

`loadScene` terminates every worker, so the next scene starts from zero: code, wasm, GPU context,
programs, Box2D's memory. With a pool instead, a scene's teardown leaves the workers alive and resets
their state, and the next scene configures them again. The canvas stays with its Pixi worker. This is
the biggest change in the plan: every worker's reset must be complete. Tests load A, then B, then A
again, and A must match a fresh load (state, image). Measured on menu → scene and level → level.

### SST-10 — What the waterfall shows is left

- [ ] in progress: 5ad53c8d (the decal textures' pixels no longer go to every worker), R-1457; dd8f11e8 (the static
  flowfields' cells in shared memory, one copy for every worker: the barrio's init messages 205 -> 53 ms, R-1479)

The smaller repeats, each only if SST-0 shows it:
- circle patterns computed once, not by every spatial worker;
- the sprite and Adobe registries and the static flowfields handed over ready instead of rebuilt in
  every worker (the flowfields: done; spritesheetMetadata still goes to every worker, 7.8 ms to clone in the barrio,
  and spatial, physics and particle code read the registry too, so it is not simply left out);
- logic's per-class setup done while physics boots, not after `box2dReady`;
- per-pool fills and allocations;
- Pixi's tilemap pages built during boot instead of at `preload()`'s `setLayerContent`, when a scene
  declares them in its config.

---

## 4. Order

With the estimate of each (2026-11-17, before any measurement; each one includes its suites and its
quick number):

1. SST-0, the waterfall and the three quick waterfalls: about 45 min.
2. SST-2, then SST-1 (the boot message carries the module): about 30 min and 1.5 h.
3. SST-4: about 45 min.
4. SST-3: about 45 min.
5. SST-7, with E-494: about 1 h.
6. SST-5, then SST-6: about 1.5 to 2 h and 1 h.
7. SST-8: about 1 h.
8. SST-10, from what is left on the waterfall: about 30 min.
9. The full matrix (section 2): about 1 h, mostly the machine's.
10. SST-9, in a session of its own: about 3 to 5 h.

In a row, everything but SST-9 takes about 9 to 10 hours. With agents in parallel, about 4 to 5 hours
of clock time, partitioned by files:
- **one agent** for SST-2, SST-1 and SST-4: they share `src/core/scene.js`,
  `src/util/sceneWorkerBootstrap.js`, `src/workers/abstractWorker.js` and `src/util/wasmKernel.js`;
- **the atlas** (SST-5, then SST-6): `src/core/spriteSheetRegistry.js` and the atlas methods of
  `scene.js`, which the first agent leaves alone (agree the seam before starting);
- **Pixi** (SST-7): `src/workers/pixiWorker.js` and the Pixi patches;
- **the bundle** (SST-8): `scripts/buildBundle.js` and the build scripts;
- **the scripts** (SST-3): the script loader in `src/util/utils.js`.

SST-0 lands before the agents start. The quick waterfalls can reorder the items: the bar that ends
last goes first. Surprises (a demo that stops booting) add time; an item the waterfall shows to weigh
nothing is skipped.

## 5. Open decisions (the owner's, when we get there)

- SST-6: is the automatic cache on by default, in source builds and in the bundle?
- SST-8: does the bundle get a mode with separate files, and is it the default for deploys?
- SST-9: keeping workers changes what a scene's teardown means for a game (anything a game left in a
  worker). Settle what a game may rely on before building it.

## 6. Found while building

**The first waterfalls (2026-11-18, the main PC, source build, 2 runs a scene, a fresh context each, ms after
`loadScene`).** The first run after Chrome starts reads everything from this machine's 5400 rpm disk and is far
slower (the barrio 21.4 s to its first frame, Predator by night 8.0 s); the runs after it (the OS's file cache warm,
the browser's caches empty or full) read:

| | Predator `light3d=1&hour=22` | Buenos Aires `hour=22` | bunnyMark |
| --- | --- | --- | --- |
| first frame | 3 290 to 3 440 | 3 950 to 4 040 | 1 583 |
| assets done (the last branch) | 2 330 to 2 460 (atlas 1 669, tilemaps 1 706: the 15.7 MB tilemap JSON) | 2 130 to 2 190 (atlas about 2 180, flowfields 2 280, shaders about 1 480) | 54 |
| assets to `init sent` (the page builds the init data) | 440 to 460 | 210 to 240 | 5 |
| the workers' modules evaluated (source) | 1 060 to 2 200 | | about 900 |
| `init sent` to the last ready (the renderer) | 300 | 460 | 940 |
| ready to the start (preload, create, createNewGame and its spawns) | 190 | 1 100 (the barrio's own setup) | 550 |
| longest own step in the 5 s after it | renderer 120, spatial 90, pre-render 43 | pre-render 81, spatial 53 | renderer 61, pre-render 40 |

What it says for the order:
- **The atlas and the tilemaps are the critical path where a scene has them** (1.7 to 2.2 s on the page's main
  thread). Predator's baked atlas still costs 1.67 s (fetch, decode, the whole atlas drawn into a 2D canvas, and its
  frame texels read back: SST-5 step 4). Its tilemap is a separate bar the plan did not name: **SST-11** below.
- **The workers sit idle from their modules (about 1 s) to their init (2.5 to 2.9 s):** SST-1 and SST-2 can take
  their 300 to 940 ms of init off the critical path.
- **The page's init data takes 440 ms in Predator** (texture metadata, the decal memory and decal textures read back
  per frame, the scripts list): SST-10, or with SST-5 where it is the atlas's readback.
- **Hitches after the start:** the renderer's 120 ms step in Predator by night is E-494's first-use programs (SST-7).
- Pixi's 'first draw' mark does not come in bunnyMark (its frames reach the screen without `_submitRender` seeing
  the worker running, to look at); the runner takes the first frame from the renderer's frameTotals count instead.

### SST-11 — The tilemap off the critical path

- [x] cdf471fa: R-1452 (Predator by night tilemaps 1 463 -> 218 ms)

Predator's tilemap (`demos/map_n_flowfield/tilemap2.json`, 15.7 MB) is fetched and parsed on the page in about 1.7 s,
as long as its atlas. Parse it off the main thread (a worker, or a binary format the bake writes beside the JSON, as the
flowfields have), and hand the workers what they read. Checked by the same tile data (a hash) and SST-0 on Predator.


### SST-12 — Box2D's start off the critical path

- [x] 8f43a111 (the physics worker's load marks; the engine block zeroed only below Box2D's old heap break:
  440 ms -> 0 of Predator by night's start, R-1470); 4f2cd68f (marks in weedjsPost.js); the siblings' load read, R-1500;
  415404eb (box2dWorkerEntry.js fetches them at once: Predator by night's block 1 069 -> 677 ms warm, R-1514)

With the page thread free (SST-4, SST-5), the physics worker's answer to the engine block request became the critical
path (1.1 s in Predator, 1.6 s in the barrio after loadScene). Its marks (2026-11-18): the host's scripts evaluated
about 1.0 s after the worker is made, the module ready 5 to 10 ms later, then the block's zeroing (440 ms, now gone).
What is left is the worker's start itself: in a source build the glue loads its siblings (weedjsPost.js and the 17
files it pulls) with synchronous importScripts, one after another; the bundle inlines them (Predator by night starts in
about 1.15 s warm from the bundle against about 2.0 s from source). Next: fetch the siblings in parallel and evaluate
them in order (as SST-3 does for game scripts), and check where the rest of the second goes with marks inside the glue
(weed_pre.js and weed_post.js, a Box2D rebuild).

**Read 2026-11-18 (R-1500):** the 16 siblings take 760 to 880 ms of Predator by night's source start and 1 335 ms of the
barrio's, 10 to 175 ms a request among the ~2 000 a source start makes. But physics now ends with the atlas branch and
the workers' scripts (warm Predator: block 1 040, atlas 1 090, logic's boot scripts 1 076 ms), so loading the siblings
at once would take about 100 ms off the barrio, where physics still ends last, and nothing off Predator. It waits for
SST-13 and SST-14 to bring the other two down: an entry script that fetches the glue, weedjsPost.js, the host and the
siblings at once, then runs them in order from blob URLs as the bundle does (pool threads load the glue directly).

### SST-13 — The atlas worker started earlier

- [x] dropped 2026-11-19 by reading the start (R-1511): ES modules are all fetched before any runs, so the engine's code
  first runs right before loadScene; an atlas worker started then would start about 10 ms sooner. SST-14 and the bundle are what shorten its modules.

In a cold source build the atlas worker evaluates its 22 modules in 1.4 to 1.6 s before it starts (R-1452), longer than
the page took to pack the atlas itself. Starting it when the engine is imported (not at the scene's assets) would overlap
that with the page's own module loads; the bundle's blob workers fetch nothing, so it matters for source builds only.

### SST-15 — Physics primed before the start

- [x] f3e180ec (R-1503: Predator by night's first physics step 197 -> 56 ms warm, 100 cold; the start about 96 ms later)

The waterfall's longest step after the start read physics at 128 ms or more in every Predator run: its first step made
the spawned world's bodies (18 248, 91 ms), drained their commands (52 696, 47 ms) and then stepped with every contact
new (51 ms). Under the owner's rule (everything ready before the start) the scene now sends the physics worker 'prime'
once the world is spawned and waits for it: the host makes the bodies, joints and commands then. Left: Box2D's first
step (a collide-only export in the prime) and the body creation's own cost.

### SST-16 — The atlas cache decoded beside its key

- [x] 6753b301 (R-1504: Predator by night's atlas on the page 1 090 -> 1 006 ms warm from source)

The bundle's critical path on a warm visit was the atlas branch: the key hashed every source (113 ms), then the entry
was read and decoded (145 ms). A slot holds one entry, so its decode now starts beside the key and is kept when the
keys match.

### SST-17 — The spawns' transforms a new body already reflects

- [x] b463325c (R-1505: Predator by night's physics prime 96 -> 62 ms warm)

A spawn's x and y setters each enqueue a SET_TRANSFORM; physics made the body from those columns and then moved it twice
to where it was (36 496 commands in Predator's prime). A command claimed before the sync is now skipped for a body that
sync made: its setter wrote the columns before it claimed the slot.

### SST-18 — The physics prime beside the spawns

- [x] 9d0144cc (R-1507: Predator by night's prime after the spawns 63 -> 4 ms warm)

logic0 spawns the flushed world for 114 ms and the prime then made the bodies for 63 more. The scene now sends
'primeBegin' after create(), and physics makes the bodies of the spawns done so far every millisecond until the final
prime, as it does beside logic's spawns during play.

### SST-19 — The atlas uploaded before the renderer's init

- [x] 908ff6be (R-1508): the page posts the atlas's pictures as soon as the atlas is in, and the renderer makes their sources and
  uploads them while the page builds the init data (Predator by night: atlas uploaded 1 104 ms, the init 1 147).

### SST-14 — Workers that evaluate the page's engine graph

- [ ] first step 072915a0 (R-1513: the debug overlay loads when shown, 17 modules and 251 KB off each worker); Scene.init's
  page-only imports left

In a source build each worker's boot loads the scene's module first, and its entity scripts `import WEED from
'/src/index.js'`: every worker evaluates scene.js (121 KB) and what Scene.init uses (sceneSharedBuffers, gpuPackClient,
the queue and visibility memories), gameEngine.js, saveGame and DebugUI with its panels, canvas renderers and tools,
93 modules and 983 KB in Predator on top of logic's own 171 (2.2 MB). Logic's boot scripts take about 330 ms after its
modules (warm Predator by night), ending with the atlas and physics. First: DebugUI's panels and renderers (about 19
modules, 260 KB) loaded when the UI opens (page-only, never needed by the first frames). Then whether Scene.init's
page-only imports can be skipped in workers without delaying the page's own start.
