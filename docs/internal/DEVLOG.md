# WeedJS Dev Log

Newest first. This is not a changelog. This is the journey of trying to make the browser behave like a console — like a PlayStation.

Every entry here is something I wanted: more speed, an easier API, a feature that still holds 60 FPS, or something I had to learn about how engines, or the machine itself, actually work. A lot of it came from benchmarking, breaking things, and figuring out why. Titles are the want, not the API. The systems and the APIs live in the body of the entry.

Demos are how the engine gets tested. They are not the product. The engine is the product.

## Friday 13 November 2026 (evening) — Collect Every Lead First, Then Measure Them All

Until today each idea was found, coded and measured on the spot. Today it went the other way: first a harvest with no
measuring at all, then a campaign that takes the list in order. The harvest ran every scene the engine has, 65 of them,
through four lenses: where each worker spends its CPU, line by line; where it makes garbage; where V8 throws compiled
code away; and Box2D's own functions by name, from a build that keeps them. It wrote twelve new leads. The deopt pass found
no new loop, only one already known and already judged not worth its fix.

While the passes ran, the changes were written on branches of their own, each with its tests. Then the owner scenes were
probed: a verdict now needs the owning worker at 6 ms or more, and many stress scenes ran far under it at their default
load, so they got knobs.

The spatial worker was the big one. With two spatial workers, each re-read the head of every neighbour row nobody reads,
a cache line per entity, just to see it was still empty; only a row's owner writes it, so a byte per entity now remembers
that it was empty last frame (-39 %). Without a physics worker nobody said which entities moved, so the grid was rebuilt
whole every frame; now the worker compares each collider's bounds with the ones it last binned and rewrites only what
changed, byte for byte the same grid (-34 %). And the grid stopped writing the count of every empty cell (+34 % in a
sparse world's kernel). Together, 145 000 still entities: the spatial worker from 7.67 to 2.32 ms, -70 %.

The navigation lookup scanned all 64 flowfield slots with an atomic load each, for every agent, every frame. A plain read
of the slot's target first, and the atomic only on a match: logic in the nav stress scene from 6.20 to 3.02 ms, -51 %.

Garbage went too. A tick's three doubles were boxed again for every entity (2.8 MB/s to 28 KB/s); the collider fill passed
its corners through module variables (3.5 MB/s to 0.3); each sound played built a closure (7.3 MB/s to nothing); the
bullet collect carried a double from one bullet to the next (650 KB/s to 60). Where that was timed, the frame did not
move, GC was already cheap, and nothing got slower. The bullet one went into main; the other three wait on a branch
for Predator's gate with every keep together. Two ideas lost honestly: rewriting the painter's index list only past what it holds saved
1.2 %, exactly what the trace said and under the 3 % bar, and a smaller `rng()` still was not inlined.

## Friday 13 November 2026 (afternoon) — Lights Masked by Sprites in One Batch, and a Million Decorations

A self-lit sprite with a mask drew one mesh per sprite and light, each with its own buffer uploads and uniforms: Sun
Street made 168 draws and 329 buffer uploads a frame for it. Now every masked sprite goes into one batch per texture, with
its own small shader on both backends. In a stress scene with 20 000 of them, Pixi went from 10.35 to 1.38 ms, -86.8 %,
and the pixels came out identical on WebGL and WebGPU. Pixi also stopped re-creating its float data textures every frame:
the light data was uploaded twice per frame with `texImage2D`, now it updates in place.

The decoration pool learned to hold a million: the free list's index grew to 20 bits, its tag shrank to fit. That went
into a bundle for the Buenos Aires game, on a branch of its own.

The bar moved too: a speed verdict now needs the owning worker at 6 ms, not 3. Under that, the noise is a large share of
the number.

## Friday 13 November 2026 (morning) — Physics That Stops Asking the Time

Box2D asked JavaScript for the time about 800 times a frame in Predator, and each answer was a fresh number on the heap:
the profiler's clock read `performance.timeOrigin` on every call, the scheduler's spin read the clock every 64 turns, and
every yield read it for a timer this build does not have. Three fixes in Box2D's C, both of its builds: the origin read
once, the spin counting turns instead of time, the yield processing its queue without a clock. The physics worker's
garbage in Predator went from 634 KB/s to 87.5. On the clock it is a tie, and that is fine: it was never the time, it was
the garbage.

The same hunt elsewhere: the WebGL shader sync rebuilt its plan at nearly every bind (Pixi 1.27 MB/s to 0.27), the
LiquidFun splat boxed three doubles per particle (1.57 MB/s to 0.11), the mesh fill's pose went through a scratch object.
And the spatial passes learned to bound a turned box without a call, +21.7 % in their kernel.

## Sunday 1 November 2026 (afternoon) — Shadows That Know Who Cast Them, and Grass With a Name

The keyed frames left the shadows behind. Each caster is a sprite whose statics are already in Pixi's texture, yet
pre-render still packed 22 floats a caster for the sun and copied that row again, with a light, into every point-light
stamp. Now Pixi writes, in the keyed header, the queue frame its texture holds. While that frame is no more than two
behind, pre-render writes keyed caster rows instead: a position, a key and the shadow terms, 7 floats, and 11 with the
light for the stamps. Pixi draws them with a shadow program that reads everything else by key. The first build never
ran a single keyed row: the GPU pack's view of the queue had no key column, so 22 860 casters of 22 860 looked keyless
and every frame quietly fell back. A probe that counted the keyed frames found it in minutes. With the column in,
pre-render at Predator's crowd 1.5 went from 6.23 to 5.21 ms, -16.8 %, every pair agreeing. Then the casters stopped
being listed in JavaScript at all: one C pass finds them and writes their rows as it goes, -6.5 % more.

Zooming in took all of it away. Past zoom 0.5 Predator draws its 20 000 grass blades, and they had no key, so each went
up whole every frame, 64 bytes a blade. After ten losing frames the keyed frames paused for half a minute, and the keyed
shadows paused with them. A blade now has a key, its pool slot past the entities. The emit keeps, per slot, the statics
it last sent: scale, alpha with the zoom's fade, tint, texture, anchor, 32 bytes. A blade is marked changed only when one
of them moves, or when Pixi has asked for everything again. At crowd 1.5 and zoom 0.6 the renderer went from 4.08 to
2.60 ms, -38.2 %.

The day's last gate, wave14 against main at Predator's defaults: pre-render 4.41 to 3.30 ms, -23.6 %, no worker worse.
Merged, bundles rebuilt and tested.

## Sunday 1 November 2026 (early afternoon) — Is the Bundle Slower Than the Source?

The shipped bundle read spatial and pre-render 5 to 10 % slower than the sources it was built from, twice in a row.
The bundle is what npm installs, so that would be a bug.

It was not one. The spatial and pre-render code inside wave13's bundle is wave12's, byte for byte, but for one constant.
The WASM it embeds is the source's, byte for byte. A CPU trace of Boids, where both sides move the same 20 000 entities,
put every hot spatial function at the same speed, and the bundle's spatial at 454 ms a second against 469. Terser does
rewrite every function called once as an inline anonymous function, the loops E-179 kept apart among them. A probe in
Chrome timed both shapes at 145 to 150 µs a call. Boids with eight pairs said neutral.

What moved was Predator. Its physics decides how many bodies move, and that swung by a third between runs. During one
sitting my own Chrome was eating almost two cores. So every merge's bundle check now runs Boids with eight pairs beside
Predator, on a machine I look at first.

## Sunday 1 November 2026 (late morning) — Still Frames Cost Nothing, and the Sun Draws What Is Already There

The particle worker tested all 20 000 grass blades against the screen every frame, even when nothing had moved. The
decoration pool now counts list changes and moves in a header. The worker skips the screen test and the snapshot copy
when neither count, the camera nor an attached blade moved: -50.9 % with a still camera. The particle lists' C kernel
also learned to write sixteen entries at once when a block is all on screen or all off.

Then the shadows. Pixi's copy and upload turned out to be 80 % casters: 1.6 to 2.1 MB a frame, against 0.38 MB for
the keyed sprites. The sun's pass now draws the entity batch's own instances, already uploaded, with three floats of
shadow terms a slot. The first sitting read +0.0 %. The trace showed why: the new stream fell outside the batch's
arena and was copied word by word. With the arena sized for it, the renderer at crowd 1.5 dropped 4.4 %, six pairs of
eight. Wave13's gate against main: the renderer -12.4 %.

## Sunday 1 November 2026 (morning) — Keep the Sprites on the GPU, Send What Changed

Predator keeps 95 % of its sprites' statics from one frame to the next (texture, scale, anchor, tint), and the renderer
sent all of them, 60 bytes a sprite, every frame. The keyed frames keep a texture with each entity's statics on the
GPU, and a frame sends 24 bytes a sprite: the pose and a key, plus the rows that changed.

The first build was 30 to 44 % slower. Pixi compared every sprite's statics against its key table, which cost three
times the old pack, and scattering the changes into the texture stalled on one `gl.getParameter` a frame, a question
the GPU process answers. So the comparison moved to pre-render. Comparing there cost pre-render 12 %, and flags set on
change cost it 6 to 8 %, because the walkers set the flag on every tick. Split apart in the kernel, the culprit was
the store behind the flags. Version eight keeps no store, and marks a sprite when its flag, its texture or its
repetition changed. Against main over eight pairs: the renderer -16.7 %, no pair worse; the same build with the keyed
frames on and off: renderer -15.7 %, pre-render -1.7 %. Wave12 merged with it.

## Sunday 1 November 2026 (small hours) — Bodies That Sit Still, and Four Bugs Out of the Way

The pages-site work had left four engine bugs on the list. `Joint.getJointCount()` with no argument never returned.
`X.spawn({ speed: 2 })` on a key with only a getter threw and stopped the logic worker; it now warns once and skips the
key. `collisionMask = 0` collided with every layer, because Box2D read 0 as "the default"; now a body collides with
none, as the guide always said. A bundle's workers could not load a module with `export default`. Each fix came with a
test that failed first.

Then the moved-bodies list. Box2D wakes bodies that never actually move, and every awake body counted as moved, so
spatial redid their cells. The solver's export now compares the pose and leaves a still body out. In the Adobe scene
with 40 000 characters, physics went from 5.24 to 3.97 ms, and spatial fell 84 %. Neighbor lists are built only for
entities that read them: spatial -29.2 % on a quiet machine. The decoration screen test lost its branch, its form chosen
from how often visibility flips along the list: -10 % on Predator-like grass. Interval buckets rebuild only when their
own type's list changes: -16.8 % of logic in the churn scene. Wave11's gate against main came out neutral, and its
bundle no slower than its sources.

## Saturday 31 October 2026 (night) — A Faster Loop That Was Slower

Whether each decoration (in Predator, a blade of grass) is on screen is tested every frame, and that is 17 % of Predator's particle worker. I wrote the test without a branch: every decoration is written to the visible list, and the answer decides only whether the list grows. In its kernel, on Predator's grass, with about half of it on screen in random order, that ran two to three times faster: 7.8–12.2 → 3.8–3.9 ns a decoration. With almost nothing on screen it fell from 18 353 to 13 021 calls a second, because the branched loop stops at the first failed test and the branchless one always writes.

So the win is real where the answer is random and the loss is real where it is not, and the grid scene is the second kind. Its 40 000 decorations stand in spawn order, a quarter of them on screen, and the answer repeats from one blade to the next, which is exactly what a branch predicts. The particle worker went from 0.756 to 0.892 ms, +18 %, worse in 3 of 4 pairs. That is under the 3 ms floor, so it is not a verdict, but it is the wrong way, and more than the kernel's extra 1.1 ns a decoration predicts. Rejected as built. Next: keep both loops and pick one per frame from how often the last frame's answers flipped.

## Saturday 31 October 2026 (evening) — Neighbors Nobody Asked For

The `pages-site` branch went into main this evening with its bundle check: the production bundle against its own sources. Predator read every worker 7 to 12 % lower on the bundle, mostly drift shared by all of them; read against the other workers, logic was still 5.1 % lower, and painterMove tied. The bundle is not the slower side.

Then Wave 11, the next batch, began with the spatial worker, which builds a neighbor list for every entity that has a visual range, even in scenes where no code reads one. An accessor now marks its type the first time its code reads neighbors, and the worker skips the pass for a type nobody marked; active lights keep theirs, since pre-render reads them for occluders, and a type's first read gets its lists a frame or two late. On movedBodiesMixedScene, 22 000 entities with a range of 170 and no reader, spatial went from 4.36 to 0.95 ms (−78.2 %, no pair worse). Predator's types do read, so its accessor pays for the mark, 4.40–4.60 → 4.55–4.95 ns a read, and its gate came back neutral.

The scene I had picked to own the change was the wrong one. adobeAnimateScene's characters have a range of 0, which the pass already skipped, and the 37 % of its spatial worker that went to `_findNeighbors` was the skip itself: it wrote every skipped entity's row count on every frame, a dirtied cache line each. Writing a row only when it is not already clear took spatial at 20 000 characters from 4.53 to 3.12 ms (−30.4 %, none of 8 pairs worse) and made logic 5.7 % slower, in 7 of 8 pairs, in a worker this code never runs in. An A/A moved logic 2.1 %. The change writes less shared memory, not more, so I suspect two busy workers contending, but nothing I measured shows it. It stays out of main until a fit of logic against its load, or a second scene, decides.

## Friday 30 October 2026 (small hours) — A Front Page That Is the Engine, and the Five Bugs It Found

The repository got a front page, and the front page is the engine: its name in Box2D bricks that spring home when the pointer shoves them. GitHub Pages serves the repository from a subfolder and cannot send the isolation headers, so the first job was where it runs. The service worker from the 23rd sits at the repo root, adds the headers and answers the demos' root paths under their own URLs; below the site root the scene picker runs the debug bundle through an import map.

The first night found three engine bugs. A sweep of the 32 scenes started 30 clean; two threw `simplify2 is not defined`, because a bundle's workers leave `export default` as it is and a module ending in one never registers (N-96). The landing's bricks flying home with `collisionMask = 0` stayed jammed, 709 of 1 261 still far from home after seven seconds, because the Box2D glue reads a mask of 0 as the default mask (N-97); with `1 << 31` all were home in three seconds. And `GalaxyArm.spawn({ speed })` threw "which has only a getter" and stopped all four logic workers (N-98).

Then the page became a tour of six chapters: the title, then a lake of LiquidFun water under a waterfall; jelly a swipe cuts in two; lanterns and crates on ropes beside a plank bridge, lit by ray-cast lights; a night camp whose fire and explosions are GPU particles; and a card that shows each worker's step against a 60 fps frame, live. At 1440×900 every chapter held 60 fps, physics at 3.1 to 4.7 ms, logic 0.7 to 1.6, the renderer 1.2 to 1.9.

The ropes were the fourth bug. A swipe removes the joint nearest the stroke: 125 joints became 122, yet the lanterns kept their height for 1.4 seconds. `syncJoints` built the new list of live joints in the array it was still reading the old one from, and `Joint.remove` swaps the last active joint into the removed slot, so the new list overwrote the removed entry before the pass that destroys joints read it. Only a joint that was last was ever destroyed. The new list goes into a second array now (N-99). Probing it also froze the page: `Joint.getJointCount()` with no argument walks a list that never ends (N-100). N-97, N-98 and N-100 were still open when I stopped.

## Thursday 29 October 2026 (afternoon) — Send the Order, Not the Sprites

E-159 had already taught painterSort, where nothing moves, to keep its statics while the draw order stands (pre-render −29.9 %, Pixi −65.1 %). painterMove has 300 000 y-sorted sprites, a tenth of which cross a neighbor every swing, so its order moves every frame, and every frame scattered all 60 bytes of each sprite into draw order for Pixi to copy and upload.

But only the depth follows the order, and the depth is a function of the draw slot. So the statics stay in the queue's row order, written and uploaded when they change, and an indexed frame carries the pose and the row to fetch them from (a texture on WebGL, a storage buffer on WebGPU): 24 bytes a sprite instead of 60 (E-162). On WebGL it drew the same pixels in a 40-step lockstep check, and painterMove's pre-render went 37.3 → 19.8 ms (−43.6 %), Pixi 4.99 → 2.28 ms (−54.4 %). On WebGPU, −28.0 % and −17.5 %.

painterSort, whose order holds, was the guard, and it caught something: pre-render −9.4 %, but Pixi +0.49 ms, because an indexed frame sent its slot pairs though they were last frame's. They go up only when the order moved now: pre-render −11.7 %, Pixi −13.7 %. No layout loses to the old frames in either stress scene, so indexed frames are the default where pre-render sorts; Predator on that path was neutral.

Pixi's cost is almost all upload, except in Predator, where 2.2 ms of a 6.5 ms renderer step was Pixi's other work, and the call tree pointed at the decal tiles: 800 sprites, a texture each, never culled, under a container the camera moves every frame. As a render group they cost the renderer 5.0 % less, and hiding the ones outside the view took another 3.2 %, at the edge of Predator's noise. The culling's check, six camera views, found one drawing a tile with another's texture, 10 746 pixels the same on every run: a raw upload had landed on whatever texture unit was active because Pixi's own bind skipped it, and Pixi still believed that unit held its old texture (N-94).

Wave 10, the afternoon's batch, went into main three times; at the last, the production bundle ran Predator's logic 6.2 % faster than its sources. That evening carScene logged two GL_INVALID_OPERATION warnings, Pixi's integer texture formats allocated with the wrong enum (N-95).

## Thursday 29 October 2026 (morning) — The Entity Was Carrying Too Much

Wave 9, the day's batch of work, began with a CPU profile of 34 scenes, and Predator's top line was the shadow stamp, 37 % of pre-render. The old fixture for it, one frame with 48 lights picked by hand, had said about a quarter of what the scene's own calls cost. A tool replays the stamp's real inputs, and packing the casters' x and y in the grid's own order took a call from 1.139 to 1.005 ms (−11.8 %). Predator's pre-render read +0.9 %, inside what four pairs can see.

The second line was the component getter, 36 % of waterAndBoxes' logic: 20 000 balls each reading `this.rigidBody.speed` a tick, about 23 ns a read where the kernel that had timed the getter said 6.7. That kernel read a hot cache; a tick reads an entity, its slot array and an element, three objects out of cache. A class's first eight components became fields of the entity, and minimalTick's logic fell 17.6 %. painterMove's rose 13.9 %: each of its 300 000 entities had grown by eight fields, and a tick loop reads every entity's bytes. An entity now declares only the fields of the components its class uses, and its config, worker and flags moved to prototypes. Against the code before the fields, painterMove's logic went 8.87 → about 7.5 ms and minimalTick's 3.33 → about 2.1. Despawn found the logic worker through the worker's global, 91 % of its own time; bound once, spawnStorm −27.8 %.

A second map found four more costs, all V8 giving up on sites that see too much variety: loops that read or write by many different names, and closures of one function literal, which share one set of type feedback. A spawn config's x and y by name: spawnStorm −22.4 %. Each component field's accessors compiled apart: 26.6 → 8.8 ns a field access in Chrome, and the guide now says a CSP must allow `unsafe-eval`. emitGpu's key check and the CPU emit's config merge likewise, in kernel: −23 % a call, −36 % to −54 %.

An agent read the riskiest commits apart from me, three times, and found six of the morning's eight bugs, among them a hot swap that reloaded the page on every edit to an entity class. Predator, branch against main: logic 3.57 → 3.31 ms (−8.1 %). Seventy-three commits went into main before noon.

## Thursday 29 October 2026 (small hours) — Particles That Do Not Freeze With the Page

A GPU particle ages by the simulation clock, and that clock was stepped once per main-thread frame. When the main thread stalled, every GPU particle hung in the air while the CPU particles went on. I decided to change it that night: the clock keeps wall time times the time scale, any thread can read it, and a worker saw it move 40 ms in 40 ms while the main thread stood still. By four the other GPU particle features I had planned (a clear, a follower, wind) were behind speed and bugs.

The gate said GPU Galaxy, eight million particles on WebGPU, paid for the clock. Presented frames fell 55.0 → 50.1 a second (−8.2 % over the pairs, four of four worse), and a two-pair bisect put −9.4 % on that one commit. It was not the load (204 164 records a second a ring against 203 418), not the cadence: with wall time every tick of every arm emits, and a knob that gave the old cadence back returned 14 % of logic but not one frame. With E-161 on the branch, which makes the emitGpu calls of one frame share a group (300 movers went from 18 048 groups a second to 60), the gate read −4.9 %.

For the rest I watched the card with nvidia-smi. The GPU did the same work per drawn frame, 2.67 against 2.69 % of its time at the same clock, and sat idle more, 79.6 → 74.9 % busy, while the page's frames slowed, main 56.3 → 53.1 a second and every worker following. The frames were not lost on the GPU. So the clock moves once per main frame again, and its readers carry it on only when the main thread has given no frame for 100 ms: presented 51.8 → 54.7 fps (+6.0 %), and a stalled page still does not freeze the particles. E-174 went after what was left: every read of a running clock had asked the wall clock, 321 ns in Chrome against 1.5 for a typed-array read, and each frame loop notes its wall time now (emitGpu 1 285 → 625 ns a call). Eight pairs on Galaxy read +1.6 % presented, after −9.4, −4.9 and −2.1 %. Identical code moves that scene 1 to 2 %, so I cannot say whether the last 2 % was ever the clock.

## Wednesday 28 October 2026 (night) — Work That Was Already Done

The spatial workers keep an entity's neighbor list while it stays inside its skin, which saves the gather, but a kept list was still published again every frame: 46 and 61 % of the spatial worker's time in the two scenes that keep nearly all theirs. I wanted a row left alone when nothing it reads has moved (E-136). After a frame where any pose a worker writes differs from the one already there, it adds 2 to a generation in the publish memory; a kept row that last saw the same generation is skipped, and a test holds every row to the full publish. `stationarySpatialWideScene` went from 11.54 to 5.16 ms, −55.2 %, no pair worse. It only pays when no pose moves anywhere: a scene where bodies move on most frames gets 2.3 %, Predator nothing.

The idea that lost the same day was a neighbor gather in float32x4. I captured a frame in Node and replayed it in Chrome, which decides: 9 to 12 % faster, with rows identical to the double gather's once it decided in double near the range edge. The scenes said no. Boids came out 1.4 and 3.0 % dearer in the two forms I built, the second in every pair: its cells hold so few ids that a block of four mostly loads rows the scalar loop skips. A kernel win does not ship past a scene 3 % worse.

Then physics, on Boids. A trace gave `publishPose` 13 % of the physics thread, and 42 % of that was one line, the per-body generation load that a fast path skips while no body has respawned. Boids never respawns, and the fast path never ran: the workers' buffer list carried the generations but not the epoch that says whether they moved, so physics never bound it. With it: physics 7.18 → 6.67 ms, −7.2 %, no pair worse. An earlier screen blamed Predator's respawns; it never latched anywhere.

The force and torque pass, a Box2D call per body, became one call (W28, on the wave8 branch): 14.1 → 11.8 ns a body, velocities bit for bit the old calls'. The first sitting read 1.7 % worse, and a probe showed why: the batch never ran. A SharedArrayBuffer posted to a worker is another object than the module's own, even when it is the same memory, so the check for Box2D's memory said no. Boids −1.9 %, two pairs of four worse; Predator neutral.

## Wednesday 28 October 2026 (afternoon) — What the Service Worker Costs a Player

The service worker is what lets a static host serve a game with SharedArrayBuffer, and I had never timed what it costs a player. The new tool measures from the navigation to the renderer's first published frame: ten runs in rotating order, a fresh browser context each, after one visit that is not counted.

For a deployed bundle the answer is good. The first visit costs about 125 ms, once, 572 against 698; a return visit is inside the noise of real headers, 429 against 443. Predator through the worker shows no difference in any worker, since it only touches loading. Rewriting every response instead of page loads and worker scripts tied on the bundle and lost 17 % from source, so the narrow filter stays.

From source it was not good. A return visit through `npm run dev:sw` took 1 431 ms against 1 063 with real headers, and Chrome's Static Routing API, which should have kept the worker out of the way, only tied it. The page's own 175 modules were not the cost: 140 to 153 ms controlled or not. The slow requests were the engine workers' module imports, 728 of them, 55 ms each with real headers and 204 through the worker. A probe worker that logged every request explained it. The filter that picks out worker scripts also matched their imports, since a module worker's imports carry the worker's destination too; their mode is `cors`, a worker's own script `same-origin`. So all 728 went through fetch and a new Response, and the routing rules sent them to the handler for the same reason, which is why routing tied. The worker leaves `cors` requests alone now: 1 415 → 1 114 ms on a return visit from source, real headers 1 071; the bundle is unchanged.

The rest was ticking boxes. All eight bundles pass the first visit, the return visit, the hard reload and real headers, 32 of 32; Firefox 159 passes three of three; a worklet loaded by URL receives its SharedArrayBuffer through the worker; `npm run dev` still swaps a script in place. One case cannot work, and is written down now: an isolated game portal embedding a game from a host without the headers refuses the frame, because that response comes before a worker can be installed. The host has to send them; itch.io's SharedArrayBuffer option does.

## Wednesday 28 October 2026 (morning) — A Million Particles on WebGL, and the Engine's Code in Predator's Logic

PR #5, the GPU particles branch, merged before five. GPU Galaxy had left one wall standing: on WebGL it drew 262 144 particles at 60 frames a second and 15 to 44 at a million, while WebGPU drew four million at 60. I suspected the upload, a `bufferSubData` every frame into a ring the GPU is still drawing from. A kernel that draws instanced quads from records in the engine's layout, in a visible Chrome window, said no: at a million records a frame took 50.9 ms with no upload at all and 51.4 with the frame's records. The cost was the attributes: seven instanced vec4 attributes 51.1 ms, three 25.3, one 11.6, about 7 ms per attribute per million records, because ANGLE's D3D11 fetches them slowly. The same records in a texture, read by instance id: 6.1 ms. WebGL's rings are textures now (E-157), and GPU Galaxy at a million went from 144 frames in eight seconds to 480, 18 → 60 fps; two and four million draw at 60 too. One triangle per particle instead of a quad lost (E-158).

Then Wave 7, the list Monday's profile of every scene had produced: about half of Predator's logic was the engine's own code around the game's. Component getters read a name from an object filled in whatever order each entity first touched its components; they read a numbered slot now, 23 → 6.7 ns a read, Predator's logic −8.0 %. The tween tick passed its eased value to a function too big to inline, a heap number per live tween per frame: −14.2 % with 131 072 tweens. Every type reset three accelerations, body or not; deleting those stores outright, to see the ceiling, gave −22.4 %, so types without a body got their own copies of the loops: −18.0 %. A class that overrides only `onCollisionEnter` had the empty `onCollisionStay` called for every touching pair, every frame: +64 % in the contact kernel. The FSM tick took two changes together to win, +6.4 and +11.3 %; each alone tied or lost.

Three leads said no. The neighbor accessors cost 1.5 ns over reading the row, and the only faster form needs private fields. `getTileId`'s divisions were not its cost. And the three Box2D solver threads the profile showed at 1 000 ms/s were waiting: Windows says the whole renderer process used 73 ms/s over its 36 threads. The sampler counts a blocked thread as busy.

## Tuesday 27 October 2026 (late night) — Two Demos That Found What the Tests Had Not

Blastforge, the demo that fires explosions from the engine's particles, began as a port of a standalone explosion lab, and that evening I brought the rest of the lab home: all 32 of its preset fields, two of which the demo had dropped, with a slider each; a Speed control on `Time.scale`; four grounds with blast light, shockwave rings, heat haze and scorch; a 64×64 frame guide at the cursor; and a Pixel size from 1× to 6×. That last one needs a layer's resolution to change while the game runs, which the engine could not do. `Layer.resolution` has a setter now, any worker can write it, and the renderer remakes the layer's render textures when it moves, the way a canvas resize does.

Doing it found a bug the tests had never seen (N-83). A resize released the bind groups on a look layer's old render textures before destroying them, and a layer that sorts with the entities draws its regions through a bind group of its own, so the release destroyed that one too. The next frame threw inside Pixi and the layer drew nothing from then on. In Chrome: Blastforge, `scene.resize(1100, 700)`, then a fireball: no fire, no smoke, only its ground light. Main never had it; the regions came with the branch. They go to an empty texture before the release and onto the new target after, and a test runs the real resize on one and fails without the fix.

Past midnight the other demo went in. GPU Galaxy keeps as many GPU particles alive as the engine can: each logic worker runs one arm of a spiral and refills its own ring at the rate that keeps it 97 % full, every dot living five seconds. On the GTX 1650, WebGPU held 4 194 304 slots 96 % full at 58 to 60 frames a second, and 8 388 608 drew 36. When a frame's new records crossed the end of a ring, Pixi, which keeps one pending range per buffer, uploaded the whole ring, and a ring of a million particles is 112 MB. The two pieces go up as two ranges now (E-156). At 8 388 608, four pairs: renderer 3.87 → 3.23 ms, −16.6 %, presented 57.4 → 60.0 frames a second. WebGL was the other wall, 15 to 44 at a million, and it got a row of its own.

## Tuesday 27 October 2026 (evening) — GPU Particles Must Not Make Garbage

PR #5, the GPU particles branch, where particles are written once into a ring and moved by the vertex shader, stood within 2.4 % of main in the CPU particle scene after the afternoon. The evening went to garbage, which Chrome shows and Node does not: I read the branch with the heap profiler on every worker.

The biggest find was not in the branch. Pixi's WebGL shader sync walked every shader's groups and resources with `for…in` over integer keys on every draw, and V8 builds a key array for each such loop. Every WebGL draw in every scene made garbage: 7.4 MB/s in the GPU particle scene, 0.7 in Predator (E-148). The build swaps the sync for a plan per shader, checked against the group slots' identity and key count. Pixi's garbage in Predator went from 1 214.5 to 522.6 KB/s.

The branch's own path came next. `emitGpu` drew every number through a closure TurboFan cannot inline, so each came back boxed. It reads its config into typed samplers once per call and takes its random numbers in batches: 66 to 80 % faster, and with the feed syncs' closures written out, logic's garbage went from 1 838.6 to 106.5 KB/s. One site Node never showed: the proxy collector's growth helper built its arrays through an arrow function that captured a local, so every call allocated a context, for every group, every frame. Node inlined it away. Chrome did not, and pre-render fell from 175 to 16 KB/s. Pixi's WebGPU path had the same disease in more shapes (E-152): `for…in` over bind groups and vertex buffers, a string key per cached bind group, an options object per draw, a double used as a map key. Patched at build time, with byte-identical frames: Pixi's garbage 6 000.7 → 131.2 KB/s, and the renderer 5.22 → 3.63 ms, −35.6 %. The loops cost time as well as garbage.

Then the gate against main. Predator: no worker worse, the renderer 5.91 → 5.12 ms. The particle integrate scene: pre-render 3.66 → 3.93 ms, +7.0 %, four pairs of four. Not the evening's work; the branch against the afternoon's commit was level. The ground-row key alone cost 3.1 % against main's formula, and in that scene nothing y-sorts, so the key orders nothing. One loop skips it when no layer y-sorts: pre-render −4.3 %, and the branch 4.6 % under main there.

## Tuesday 27 October 2026 (afternoon) — What a Pull Request Costs Main

PR #5 is the GPU particles branch, and the afternoon went to the question a branch owes main: what does it cost the scenes that never use it? In the CPU particle scene, with nothing y-sorting, pre-render was 10.9 % slower, four pairs of four. The branch keys particles on the ground row they stand on, so a spark in the air no longer slips behind a tree it is in front of, and the key used `Math.round`. A trace put the extra 150 ms per eight seconds inside the inlined `Math.round`. `floor(y + 0.5)` gives the same key for every float32 y, and a parity test holds them equal (E-153). The branch came to +2.4 %, under the 3 % bar.

The integrate kernels cost too. The branch gave each tween pass six per-property eases, inlined; the module more than doubled, and the ease helper that clang inlines only while it has one caller became a call for every particle. Against main the double kernel ran 14.3 % slower. A particle with mixed eases now takes its tweens out of line, each kernel's own path is main's code again, and the gap is 1.7 %. The WebAssembly had also been built with a different clang than the pinned one, and it was rebuilt.

The y-sort proxies, which put a cloud of GPU particles between the trees in front of it and behind it, sorted the frame's groups by insertion: 1.5 ms a frame at 2 048 live groups. They sort runs of 32 and merge them, and a frame already in order costs about one pass: 0.25 ms (E-154).

And a bug. Pixi's WebGL uploads a buffer's last update range only at the next draw that binds it. A ring that published records in a frame that drew none of them, because its layer was hidden or every group was off screen, lost them, and a cloud emitted off screen was missing when the camera got there. Each range flushes as it is published now; WebGPU writes at once and never had it. Along the way `emitGpu` became the only way to emit, and it warns once, not every call, when it writes over live particles or cuts a call to the ring.

## Monday 26 October 2026 (night) — Particles the CPU Never Touches Again

I wanted particles with no CPU cost per frame and no 65 535 ceiling. It began with three corrections to the ones that do cost. A falling particle that reached the floor used to land; with `bounces`, `bounciness` and `bounceFriction` it rebounds, and a rebound weaker than two frames of gravity counts as a landing, so the floor's behavior runs as before. A spark in the air was keyed on `y + z`, so it sorted as if it stood further north and slipped behind a tree it was in front of; it keys on its ground row now, the way a sprite keys on its feet, and is still drawn at `y + z`. And the emitter kept one ease per particle, the last tweened property's, so `alpha` on `quad.in` beside `scale` on `quad.out` eased both on `quad.out`. Each property keeps its own now.

Then the new kind. A GPU particle is written once and computed in the vertex shader from its spawn record and its age. Nothing reads it back, so it has no collisions, no decals and no floor, and it is not saved. Every thread that emits writes 112-byte records into its own ring of one shared buffer, a group row per `emitGpu` call, and Pixi uploads only the new records, as one range, and draws the live window as one or two instanced draws. It also needed a clock every thread agrees on, because each worker kept its own accumulated time and none could agree on "born at" and "now". The clock's block grew from four bytes to sixteen: a double behind a seqlock, written by the main thread alone, advanced once a frame by the clamped frame time and stopped by a pause or a hitstop. `Time.simNowMs` reads it anywhere, and the particles age by it.

The last piece was smoke behind a tree. With `sortWithEntities`, a GPU group draws among the entities at its `sortY` instead of at its layer's z-index, and the painter is untouched: its packed order is sorted by key, so a group's place is where its key would be inserted, a binary search over the packed instances. Headless, in 150 lockstep frames of a stress scene of y-sorted trees, smoke columns and fire, the sorted output is the same picture on WebGL, on WebGPU and with Pixi packing the entities, and the frame's collect and write cost 7.5 microseconds for 64 groups over 20 000 packed entities in Node. There are no frame times yet.

## Monday 26 October 2026 (afternoon) — Merged, Released, and What Is Left

In the afternoon the WASM migration merged into `main`: eighteen kernels in one `engine.wasm`, and the JavaScript they replaced under `tests/reference`. The merge message could claim only what a sitting had measured, against the last commit before the migration: pre-render −42 % on Predator and −70 % in the Adobe demo with 10 000 characters, −39 % and −76 % on four cores, no scoreboard row worse, the first two seconds no worse, the one-module build neutral. 1 986 node tests passed, 85 demo tests, and 61 scenes boot in Chrome and in Firefox 158. Two things were left open: Chrome's GPU process keeping about 87 MB after `destroy`, and physics 7 % dearer in the Adobe demo. At four I released v0.13.0, the first release since v0.12.210 on Saturday morning.

Then I asked where the time is now. The sweep profiled every scene one at a time, headed, from source, with six seconds of warm-up and an eight-second window: 64 of 65 scenes, since one failed on an import that another session was writing into `gameObject.js` at that moment. That was the catch: the machine was not quiet. A session working on the visual editor in the same folder ran headless scene loads in the middle of it and left half-edited spawn checks in three files from about 17:08, so two groups of scenes need profiling again before they decide anything.

What it said. Box2D's solver threads read 1 000 ms/s in every scene with physics, even with no bodies: in BunnyMark physics steps in 0.13 ms with nothing in the world, and the threads sit 99.6 % in one function. Either the sampler counts a thread blocked in its wait as busy, or they spin; an OS thread-time check decides. About half of each of Predator's two logic workers is engine code around the game's: the component getter 14 and 10 %, `neighborCount` 8 %, the interval bucket 8 %, against 27 % for the game's own code. In the Adobe demo one getter is 44 % of logic. Spatial is the largest engine sum: `gather_batch` adds up to 1 599 ms/s over 18 scenes, `publish_batch` 1 447.

That became Wave 7 of the plan: nine hypotheses (E-139 to E-147) ranked 1 to 9, Box2D's threads first, then the logic items, spatial, the tweens and Adobe on the GPU; the open review items; and a triage of the 39 older pending rows in the register, 14 done, 22 stale and 3 small speed items.

## Monday 26 October 2026 (small hours) — A Total Is Measured, Not Added

The second batch of JavaScript copies left `src/` overnight: the painter sort, the sprite collect, the decoration sway, and the visibility sweep, gather and raster. Each lives under `tests/reference` now as the oracle its kernel's parity test compares against, and where a kernel cannot take a configuration, an error names it. Booting every scene keeps paying: after Sunday's gpuPack removal it found Pixi reading a queue buffer that pre-render may be writing (N-76), and the new tests found two re-init bugs, a painter binding and a sway binding that kept the last init's.

Then the question the migration owed me: all of it against the last commit before it, in one sitting, not added up from the kernels' records. The fear was the start, when workers compile modules while others are busy. It did not hurt: in the first two seconds Predator's pre-render went from 14.36 to 7.08 ms (−52.5 %) and physics from 18.69 to 10.62 ms (−43.3 %). The scoreboard's 40 rows came out seven kept, seven ties and none worse: ray casts −37 % in logic, the visibility pass −49 %, bullets −53 %. The runner still tells me not to claim a faster WeedJS: three rows failed on loads that were not comparable, and twelve more are protocol ceilings, rows whose scene cannot reach 3 ms in the code they test. Then four physical cores, since every gain so far was measured on sixteen logical processors: Predator's pre-render 4.87 → 2.87 ms (−39.0 %), the Adobe demo's 45.7 → 11.1 ms (−76.4 %). Physics reads +7 % in the Adobe demo, where pre-render now runs at 60 frames a second instead of about 24, so the machine's other work grew; or the block moved Box2D's heap. Both are suspects.

Sunday's loose ends closed. `game.destroy()` had kept the last scene's memories alive through the components' static views: Predator was +579 MB over its start after destroy, and is +156 MB now (N-75). And the grouping of the kernels, which I had screened on Sunday as saving 1.3 KB and under a millisecond of compile a worker, got built, because the plan puts it last: eighteen sources linked into one `engine.wasm`, 240 471 bytes against 241 765 apart, compiled once per worker and instantiated once per memory. Of 88 named functions, 65 are the same code byte for byte and 23 differ only in the indices of their calls. Every owner scene is within 1.3 %.

## Sunday 25 October 2026 (afternoon) — Pixi Copies Faster, Then Gets Slower on Purpose

Pixi copies the render queue's rows into arrays of its own before it uploads them, since Saturday showed that uploading straight from shared memory slows every other worker. In the Adobe demo at minimum zoom that copy, 15.7 MB a frame, was 65 % of Pixi's busy time. `TypedArray.set` from a view of a shared memory copies word by word; WebAssembly's `memory.copy` between two memories is the engine's memmove, and in Chrome 15 MB took 1.99 ms by `set` and 1.25 by `memory.copy`. So the entity batch lives in an unshared `WebAssembly.Memory` of its own (W30), and the copy is a module I assembled by hand, because C has no syntax for a second memory. Four pairs showed spatial, which the change cannot reach, 4 % worse in every one, and an A/A in the same sitting moved physics +2.6 %, so I added four: Pixi 7.94 → 6.55 ms (−17.8 %, none worse), spatial +0.6 %. The glow, cookie and caster batches got memories too: Predator's Pixi −8.1 %, −3.6 % against the other workers.

Then I made Pixi slower on purpose. On a presorted frame nobody reads the sort keys or the shadow terms, 16 of a piece's roughly 61 bytes, so the emit stops writing them (E-138 again). Pre-render went from 13.13 to 11.37 ms (−14.5 %, none worse) and the renderer from 6.57 to 6.92 ms (+5.5 %, worse in all four), and the gate's letter says REGRESSION. The call is which worker bounds the frame, and at that zoom it is pre-render, at 11.4 ms, against physics at 7.7 and the renderer at 6.9: the change took 1.76 ms off the worker that sets the limit and put 0.35 ms on one 4.5 ms below it, so the frame's headroom grew. Kept, to be looked at again if a scene where Pixi is the limit takes the same path.

By the afternoon the emit's JavaScript had left `src/`: the kernel writes every row type now, and an Adobe asset with no room in `preRender.adobeTablesMB` is an error, not a quiet fall back. Predator was neutral. The Adobe demo read pre-render +4.6 % in its first four pairs, REGRESSION again; an A/A of that scene gave +1.4 %, and eight pairs of the real comparison +2.5 %, worse in seven, under the 3 % line and in no phase timer. Kept as hygiene. Spatial is the open one, +3.65 % though no change reaches its work, except that the batch moved several regions inside Box2D's block; a layout effect is the first suspect.

## Sunday 25 October 2026 (small hours) — Two Shortcuts That Never Ran

Two optimizations measured as ties tonight, for the same reason: the code that was meant to take the shortcut never ran in a scene.

The first was in bullets. A quarter of the bullet stress scene's pre-render was the part of the emit that handles rows the kernel hands back to JavaScript: bullets and their trails. The kernel writes them now, and at 64 000 bullets pre-render went from 4.19 to 3.61 ms (−14.1 %). The same profile showed the collect sending each of 32 700 bullets a frame through the general dispatch to land on the one collector they all land on. I gave it the shortcut sprites already had: write the collector's rows yourself when the layer mask is zero. It tied, 3.605 → 3.665 ms. A bullet's mask is never zero: `BulletPool.spawn` gives every bullet the entities layer's bit. Accept that bit too, and 3.623 → 3.016 ms (−17.3 %, E-137). A shortcut on "no mask" has to check the mask the spawn path writes by default.

The second was bigger. In the Adobe Animate demo at minimum zoom, 20 000 characters expand into 261 744 queue rows, pre-render is saturated, and a third of it is the pack writing each row to its painter slot, a random write per character's run of pieces. On a queue already in order the kernel screen says 2.41 ms instead of 5.31, so a frame whose emit expands its rows now sorts the collector first. The first pair tied: 20.64 → 20.29 ms. The gate read last frame's emitted-row count from a field the frame loop clears before the collect runs, so the presort never ran in a scene, and every unit test passed. Read from a field of its own: 20.52 → 15.82 ms (−19.7 %, E-138). The renderer read +18.4 % with its busy time per second unchanged: a saturated pre-render had been delivering fewer frames, so more of Pixi's steps now had a new queue to commit. A consumer of a faster producer.

Two things lost. The Adobe expansion in float32, four pieces to a vector (W27b), was +55 % in its kernel and 2.1 % slower in the scene, because that loop is bound by its stores, not its arithmetic; reverted. And Pixi's pose pack through the kernel, which a profile said was 71 % of Pixi's time in BunnyMark, tied at −2.0 %: in Chrome that packer costs about 2.3 ms a frame, and Node's 11 ms had overstated it five times. Meanwhile the bundles took the kernels gzipped: 310 KB of raw base64 became 81 KB.

## Saturday 24 October 2026 (evening) — Do the Kernels Add Up, and a Firefox That Was Not Firefox

Phase 6 was the question every kernel's own record left open: eighteen kernels, each measured alone, across four workers on one machine. Do they still win together? I cut the sitting short, so it became one pair per scene, all JavaScript against all WebAssembly on one build. Predator: pre-render 5.40 → 3.72 ms (−31.0 %), spatial 6.04 → 4.94 (−17.8 %), Pixi 3.86 → 3.53 (−9.8 %), and logic, which has no kernel, +1.4 %, inside its A/A limit. The particle stress scene −52.6 %. BunnyMark at 250 000 bunnies: Pixi 6.09 → 2.01 ms (−67.0 %), pre-render 14.05 → 8.75 (−37.4 %). I skipped leave-one-out: every winner has its own pair on record, and no worker gave a gain back here.

Covering what the kernels still handed back to JavaScript turned up two bugs. A bullet's owner column stayed 16 bits at 32-bit entity ids, so a shooter past index 65 535 was cut: its own bullets could hit it. And a scene with physics off could not spawn a type with a RigidBody at all; the spawn reset wrote fields only Box2D's heap binds, and logic threw on the first spawn. The bullet tick and the visibility gather work without physics now, in a block of memory of their own: 40 000 bullets, particle 5.09 → 3.29 ms (−35.7 %).

Then Firefox, where every kernel seemed to lose: in Playwright's Firefox 153, spatial +155 % and pre-render +106 %. It was the browser build, not the engine. A two-loop probe over shared memory ran its integer loop at 5.78 ns an element in Playwright's Firefox and 5.4 in the same binary started by hand, against 1.08 in release Firefox 158 and 1.07 in Chrome; the float loop 20.7 against 1.3. The same loops in JavaScript cost the same in all four. The runner drives the installed Firefox now, and there, on Predator, all WASM against all JS is pre-render −36.2 % and spatial −10.3 %. Physics read +26 %, but in three of four pairs it moved about twice the bodies on the WASM side, which I read as load. All 61 scenes boot in release Firefox. Safari is out: it does not matter.

At ten that night the JavaScript started to leave. Once a kernel's tests are green and its scenes boot, its JS copy moves under `tests/reference`, where its parity test compares against it, and its switch goes. By midnight the decals, navigation, mesh corners, shadow stamp, particles and spatial search had lost theirs, and booting found what the tests did not: the destructible-terrain scenes have a mesh layer with no geometry, which the first version of the mesh-corner change refused.

## Saturday 24 October 2026 (afternoon) — A World Bigger Than the View, and Two Ports I Did Not Make

A scene with a world much bigger than its view paid for every sprite in it: with the visible count fixed at 18 643, doubling the world from 250 000 to 500 000 static sprites took the collect from 2.03 to 3.70 ms, because the cull tests every one. Static scenery is opt-in now. A type that declares `static isStatic = true` does not move after it spawns, so pre-render bins those entities in a grid of its own and the collect walks only the cells that meet the view, drawing exactly what the linear cull drew (E-127). At 500 000 sprites with 2.5 % in view, pre-render went from 4.23 to 1.35 ms (−68.0 %). Pixi's half of BunnyMark followed: a moving plain sprite changes only the 16 bytes of its pose, so the packer writes its other 44 only when something changed, and at 250 000 bunnies the renderer went from 4.95 to 1.70 ms (−65.6 %) and pre-render from 9.21 to 7.01 ms (−23.8 %).

Most of the afternoon, though, was profiles saying no. The plan had the contact classifier going to C. On the hunt scene it was 63 % of logic, but 55 % of that function is the game's own `onCollisionStay`, which stays JavaScript whatever classifies, and 35 % was the generation check. I had guessed scattered reads. It was the `Atomics.load` itself: read plainly, since a missed bump is caught on the next frame's walk anyway, the stay loop got 31 % faster in its kernel and the scene's logic went from 4.12 to 3.59 ms (−12.9 %, E-131). The port was dropped. The next one, compound outlines in WASM, was 0.6 % of pre-render even in the worst case, and that trace pointed elsewhere: Pixi's self-lit batch wrote every fill triangle as three fresh vertices, though a ring's vertices are shared by about three triangles. Indexed, the same 142 triangles come from 152 vertices instead of 352, and Pixi went from 3.36 to 2.88 ms (−15.6 %, E-135).

Predator's profile gave the shadow stamp as 46.7 % of pre-render, and in it a sort nobody read. With `maxShadowsPerEntity` each light's kept casters land in slots that order themselves by distance and light index, whatever order the casters arrive in, so sorting them first changed nothing (E-133). Without it Predator's pre-render is 12.0 % lower. A screen also found SpawnStorm warning 470 times a second that `createBody` had failed, when it had only lost a race with a despawn: warnings 112 083 → 0, and physics −6.9 % while holding 2.2 times the bodies. And scenes past 65 535 entities, which had been taking the JavaScript spatial search silently, run the kernels at 32-bit ids now (W8b): 70 000 stationary entities, spatial 18.6 → 12.2 ms (−33.0 %), and a scene may hold 500 000 entities instead of 300 000.

## Saturday 24 October 2026 (late morning) — Kernels Meet Their Scenes

By eight, agents had screened another round of kernels in Node. A Node win is not a scene win, so the rest of the morning put each on its own scene in Chrome, against the same build with only its switch off.

The biggest was the sprite collect, 70 % of BunnyMark's pre-render. Without physics it already had what it needed in the render-queue memory: 5.25 → 4.74 ms (−9.4 %). With bodies it has to read poses Box2D publishes, so the render-queue memory now lives inside Box2D's own memory (Phase 4), a block the physics worker allocates at boot, with Transform, Collider and both pose buffers beside the queues. One kernel reads a body and writes its row with no copy. Predator's pre-render went from 4.36 to 3.76 ms (−13.3 %, no pair worse).

The pairs said what a kernel's win is worth: its share of the worker. The bullet tick in C took the bullet scene's particle worker from 4.84 to 3.17 ms (−33.9 %). But the particle lists in float32 were +49 % in Node and −1.5 % in the scene, since the lists are a small part of the step by now.

Pixi's sprite pack in C came back too (E-123). I had reverted it on Friday because logic got 6 % dearer, in a worker it cannot reach, and blamed a faster Pixi overlapping logic. On one build, with a switch the only difference, the price showed on every other worker: physics +9.5 % and spatial +6.3 % in all four pairs. The other difference was where the upload read from: straight from the shared rows. Copied into an array of Pixi's own first, the price vanished and the renderer kept −10.6 %. Probably Chrome copying shared-memory uploads on other threads; I did not trace it.

The gate changed twice. Workers keep exact running totals of the frames they publish, where the runner sampled one frame in six; and an A/A that swung every worker 5 to 15 % together taught me to read each worker against the median of the others in the same pair, which brings that A/A down to 2 to 7 % a worker. Read so, the batch passed at eight pairs: pre-render −17.9 %, renderer −6.4 %, no pair worse.

In the small hours, before any of this, Box2D's memory became a per-scene setting, 128 MB by default instead of a fixed 512, since no shipped scene peaks above 89.7 MB, and the version number stopped counting commits: only `npm run release` changes it. Over the morning, pools of particles, decorations and bullets learned to pass 65 535 slots; 200 000 particles ran in Chrome at 60 frames a second.

## Saturday 24 October 2026 (morning) — BunnyMark's Persist Frames, Four Agents, and a Folder That Moved

BunnyMark draws 250 000 bunnies, and on almost every frame nothing about them changes but their positions, which the collect already wrote. Pre-render still walked all of them twice to make sure, and once more after any frame where something did change. All three walks are now one C call in the same memory as the queue, then one walk instead of two, and finally a walk that leaves alone the shadow terms of a scene with no shadows. Pre-render went from 6.1 to 5.2 ms.

Four agents worked in parallel on four more kernels: grass sway, decal stamping, mesh corners and the navigation flow fields. I ran their timings one at a time. All four won; the flow field search runs sixteen times faster than the JavaScript. Grass sway is wired, and runs in its own corner of the render-queue memory.

Then a Predator gate said everything got slower, physics included, which none of the changes touch. The gate runs the new code from the main folder, and an agent was editing files there. The gate can now take the new side from a worktree of its own, so the agents can keep working while it measures.

## Saturday 24 October 2026 (small hours) — The Shadow Stamp in C, and a Minimized Window

The shadow pass was half of Predator's pre-render once the emit went to C: every light gathers the shadow casters in its range, keeps the closest ones, and each kept caster is copied into the stamp queue with the light. All of it is now one C call on the render-queue memory, the same bits out, down to which caster wins a tie. In its kernel it runs twice as fast as the JavaScript; in Predator pre-render went from 5.29 to 4.69 ms, 10 % with every pair agreeing.

The night's real lesson was the gate. One sitting said physics got 18 % slower from a pre-render change, which cannot happen. I had minimized the Chrome window the benchmark opens. With the flags the bench launches Chrome with, the page never finds out it is minimized, but Windows slows the window down anyway, and for half an hour every sitting measured that. The runner now asks Chrome four times a second whether its window is minimized, puts it back and measures that run again, and restores a window that opens minimized. Measured again that way, the emit and the stamp both held. An A/A still leans one way, so the gate has one more ghost to find.

## Friday 23 October 2026 (late night) — The Emit in C

Pre-render's emit writes the render queue: every visible sprite and grass blade gets its pose, scale, tint, texture and shadow terms copied into the columns Pixi draws from, and every animated sprite's clock moves on. In Predator that is about a fifth of pre-render, and E-98 had already taken the JavaScript as far as it went. The next step was C.

The first kernel sitting tied: 882 against 885 calls a second, both sides stuck at 47 nanoseconds a row. The same kernel on a small population was twice as fast as the JavaScript, so something in memory was eating it. It was the queue itself. My bench gave it 32 768 rows, a power of two, which puts every float column exactly 128 KB from the next, and every column of a row in the same cache set. At 33 000 rows the JavaScript got 11 % faster and the C 2.4 times faster. Predator's real capacity, 119 298 rows, does not alias; the bench now uses it, and the C runs the emit 2.17 times as fast as the JavaScript, with the same bits out.

What made it doable tonight is that the emit needs no physics memory: the collect already writes the poses into the queue, and the queue already lives in a WebAssembly memory for the pack kernel. What had to move were the components the emit reads, SpriteRenderer, ShadowCaster and the decorations, and a component could only bind from byte 0 of its own buffer. Now it binds at an offset, and those three live in the render-queue memory with the emit's own state beside them. The kernel writes the sprite and decoration rows; particles, glows and bullets are listed and written after it in JavaScript, so a frame with a few bullets still goes through C. Thirty frames with and without the kernel come out byte for byte the same.

In Chrome the emit went from 1.24 to 0.92 ms, less than in Node, because in the game those columns arrive cold from the logic workers. Predator's pre-render went from 5.05 to 4.67 ms over eight pairs. The gate called it a regression on spatial, which barely reads what moved; a pair with only the kernel switched off did not reproduce it, and an A/A, the same code on both sides, called a regression too, on the renderer, at 6.6 %. Tonight this machine moves one worker or another by 4 to 8 % for no reason, so the owner's sign across sittings is what I read, and finding out why the gate drifts is now on the list.

The next prize is in plain sight: the shadow pass is half of Predator's pre-render.

## Friday 23 October 2026 (night) — Animated Sprites Keep Their Persist Frames

The render queue has two buffers that alternate. When one buffer's frame moved an animated sprite on to its next frame, the other still remembered the old one, and its persist check gave up: in a scene of animated sprites nearly every frame was a full emit. A test with two sprites on different periods kept 20 frames of 60 on the persist path. The check now gives that row the current frame's texture, the one the full emit would write, and carries on: 58 of 60, and the two full emits are each buffer's first frame. A new stress scene, 100 000 civilians walking on the spot at different speeds, all in view: pre-render 8.89 → 7.10 ms, −19.3 %.

The Predator gate for this and the two collect changes before it said "regression" twice, and both times it was the machine. Four pairs: pre-render +7.1 %, physics +14.3 %, every worker worse, while other work ran beside it. Eight pairs on an idle machine: pre-render −0.3 %, and spatial +6.8 %, a worker none of the changes reaches. Then an A/A, the same code on both sides: one side came out 5.0 % faster in pre-render, four pairs of four, and 7.4 % faster in logic. Tonight, on this machine, a four-pair Predator verdict cannot see 5 %. The changes stand on their own scenes.

And this log caught up. It had stopped on 18 October with a sign bug in the painter; everything above that, and the Saturday below it, was written tonight from the commits and the measurements on record.

## Friday 23 October 2026 (evening) — No Headers, No Homework

I wanted a game to run on GitHub Pages without the person shipping it ever reading the words "cross-origin isolated". SharedArrayBuffer needs two headers on the page, and a static host cannot send them. The usual answer is coi-serviceworker, a service worker that adds them. This is the same idea, our own and narrower, and the engine does the setup.

`weed-sw.js` adds COOP and COEP to page loads and to worker scripts, and to nothing else: images, sounds and WASM go straight to the network. `GameEngine` registers it before anything loads, waits until it is active, and reloads once. It never replaces a service worker the site already has. Every way it can fail has its own sentence in the error overlay: plain HTTP, a Firefox private window, the browser built into an app, a game embedded by another site, a missing file, another worker. The template's `npm run build` copies it next to `index.html`, and it is on by default.

The first bug it found was older than the plan. `new GameEngine()` built its presenting flag on a SharedArrayBuffer, so on a page without isolation the constructor threw a ReferenceError, and the message DEPLOY.md promised for exactly that page had never once appeared. The flag is a plain buffer there now.

Then the hard reload broke it, twice. The isolated page's COOP moves it into a new browsing context group, and that group gets a copy of the tab's sessionStorage. The marker that says "I already reloaded once" was cleared in the copy, never in the original, and a hard reload, which skips the worker and so has no COOP, sees the original. A hard reload within ten seconds of a first visit looked like a reload loop. The marker counts to two now. And in Chromium a reload issued while a hard reload is still loading comes back without the worker, while the same reload issued after `load` has it. The gate waits for `load`.

Eleven cases in Chromium against a server with no isolation headers, all passing: first visit two loads, return visit one, hard reload two, a stopped worker, real headers (nothing registered), a missing worker file, no service worker API, another worker owning the folder, an embedding site, plain HTTP, and the folder rule.

Then it failed in my own Chrome: "the page reloaded twice and weed-sw.js still does not control it". My DevTools had "Bypass for network" ticked, from some other day, and that box keeps every service worker off the page while DevTools is open. Through the DevTools protocol it reproduces exactly, three loads and that message; "Disable cache" does not. A player never has DevTools open with that box ticked. The message now opens with the box to untick.

On a first visit I could see the menu and the debug bar for about a second before the reload took them away. The engine now lays a black veil over the page from its constructor whenever it is going to try the worker, in the top layer so no z-index rises above it, and lifts it unless the page reloads. The smoke test hit-tests the page's UI every animation frame before the reload: exposed for 75 frames before, for none after. And the debug bar showed its bare HTML for two frames on every load from source, because its stylesheet is a fetch. It stays hidden until the stylesheet is in.

`npm run dev:sw` is the dev server without the headers, to see what a GitHub Pages deploy will do. Both dev servers now open with the logo, the URL, how that mode isolates the page and whether hot reload is on, and they log only failed requests: a demo page asks for hundreds of modules, and the banner was gone in a second. From source the engine looks for `weed-sw.js` at the site root, because its workers load from `/src/`. All of it is on `main`.

## Friday 23 October 2026 (afternoon) — Lights Per Frame, Not Per Light

Raycasted lighting cost Pixi per light. Each light drew an umbra disc and a visibility fan as two meshes, each with its own uniforms: over 700 draws a frame in `visPolyStressScene`, and most of Pixi's step was Pixi's own work per draw, the shader binding and the buffer bookkeeping. The light's terms became vertex attributes, and every light's disc and fan went into one mesh, in light order, so the additive blend sums in the same sequence. Renderer 5.47 → 1.36 ms, −75 %, and Pixi's garbage 36.5 → 8.7 MB/s. Pixel-identical on WebGL and on WebGPU.

What was left was the self-lit pass, each occluder's own footprint lit again, with a transmit wedge behind occluders that let light through. It was still a render call per light, 46 % of what remained. The scene could not show it: the engine caps self-lit fills at 512 a frame, which gave only a few dozen lights a pass. With the cap raised to 65 536, the same move, one mesh with every light's fills and then its wedges, took the renderer from 3.40 to 1.20 ms, −65 %, and the garbage from 8.7 to 1.8 MB/s. The rest of that was one call: `_emitTransmitWedge` took nine doubles per occluder per light and boxed them all, even when it returned at its first line. Through a module array, 6.8 → 0.3 MB/s. No committed scene had a transmit wedge in it, so the stress scene grew a `?block=` knob, and the lockstep visual suite now holds both lighting scenes pixel for pixel.

Before that, the visibility sweep itself stopped making heap numbers: 37.0 → 2.7 MB/s, pre-render −4.1 %.

Adobe Animate characters write their pieces into consecutive queue rows under one sort key, and the painter radix sorted every piece. It sorts the runs now and expands them, the same order a stable sort of every row gives: pre-render −9.8 %. The pieces and every plain sprite also wrote zeros into the tile columns every frame, though only a repeating sprite ever writes anything else there: those zeros are written only once something has tiled, −10.2 %. Hoisting the piece loop's 23 columns into locals made it +3.6 % slower, four pairs of four. Twenty-three more live values in a function that size spill. It went back.

The rest lost. Caster positions in bin order for the shadow stamp tied in its kernel; the stamp's loads were cache stalls, not arithmetic. Splitting the decal pixel loop by blend mode tied; TurboFan already handled the branch. The decal stamp in plain C tied JS, 50.2 against 49.9 ms; the loop is bound by its bytes, and what is left there is SIMD with a tolerance, or the GPU. Pixi's own sprite pack through the WASM kernel made the renderer 9 % cheaper and logic 6 % dearer, seven pairs of eight, in a worker it cannot reach. A faster Pixi overlapping logic is still a slower Predator. Reverted. And every kernel rebuilt with the optimisation flags came out byte-identical or tied: the pinned clang already did it.

## Friday 23 October 2026 (late morning) — 250 000 Bunnies: Pre-render From 21 ms to 6

BunnyMark at 250 000 sprites. The first number was wrong: pre-render read about 5 ms because a frame skipped for backpressure published a step of zero, and the average mixed those in. Counted per frame that built a queue, it was 21.7 ms.

Pixi first. Uploading 24 of the 68 bytes a sprite carries (garbage on screen, a ceiling, not a change) halved its step. So the pose-interpolated sprite became two streams: the pose every frame, the statics only when pre-render says they changed. Renderer 13.6 → 3.2 ms, and the page went from 55 frames a second to 44. A fast Pixi was handing the GPU frames faster than it could finish them, and the browser dropped what it never showed. Pixi now waits on a fence two frames back before it draws: presented frames 54.8 → 59.9 on WebGL, and +38 % on WebGPU, which counts finished work against submitted work. On top of that the split was renderer −67.7 % with the page at 60. The pair runner judges presented frames now; a renderer that gets faster by dropping frames is not faster.

Then pre-render, six steps, none of them WASM:

- The Y-sort line was computed for every sprite though BunnyMark does not Y-sort: −36.4 %.
- A frame where only the sprites moved still ran the emit loop just to count the rows: −3.7 %. On the way, a bug: sprite animations froze on those frames, because the emit loop was the only place they advanced.
- A sprite with no layer mask went through `collectRenderable`'s type dispatch and bit scan to land in the one collector it always lands in: −14.2 %.
- The poses went into a stash and were copied into the queue; with no Adobe row in the frame they now go straight into the queue's columns: −14.1 %.
- The collect called `_writeRenderable` per sprite, and each call re-read a dozen fields from `this`. The loop writes those rows itself, the columns taken once: −15.8 %.
- `_displayPose` was a call per sprite, for a branch a sprite without a body reduces to three loads. Read inline: −18.4 %.

21.7 to 6.07 ms per queue, every step better in at least three pairs of four. What cost the time was dispatch and loads, not arithmetic. Parity tests hold each step to what the general path writes, column by column; two mutants of the collect fail them.

## Friday 23 October 2026 (morning) — Garbage First, Then the Pack in C

The morning was heap numbers. The sampling heap profiler now reaches every worker the page starts, the Box2D thread included, and a Node version of it shows the same allocation sites in a kernel.

The bullet and ray path made 279 MB/s in the particle worker. The cause is a V8 rule the code kept breaking: a double passed to a function TurboFan does not inline becomes a heap number, and the global `Infinity` in a branch that never ran turns the variable it merges into into "any value". The traced ray lives in a module `Float64Array` now and only integers cross the calls: 2.1 MB/s, the bullet stress −26.6 %. `castAll` reuses its results: the ray stress logic −25.8 %. The same rule, over and over: sort keys passed per renderable (22 MB/s to 0.05, −4.0 %), `Atomics` results outside the small-integer range, which Chrome returns as heap numbers (the body dirty words became 16-bit halves: logic −4.0 % in the spawn storm), body creation through a 25-field options object (24 MB/s to 0.4, a tie), a closure per spawn (a tie), `setSprite` building a cache key string per call (−3.1 %), and the public `Ray` methods, too big to inline into game code (17.6 MB/s to 0.3, a tie).

Then the first big WASM win on the render side. The render queues moved into one `WebAssembly.Memory`, and the instanced-row pack went to C: 3.1× in its kernel, but only −3.5 % in the painter stress scene, because at 300 000 rows the pack was bound by its gather, reading 18 columns in painter order across a 14 MB queue. Reading the queue in order and scattering each row to its slot: −18.3 %. The same scatter in Pixi's JavaScript pack was +6.4 % and went back.

Predator gated each batch. One gate flagged physics +3.6 % on a change that cannot reach physics; the second sitting said −7.9 %. Across the day's gates Predator's physics moved from −9.3 % to +6.7 % with nothing reaching it. That is the floor of what a Predator gate can see.

## Friday 23 October 2026 (small hours) — Half the Particle Worker in C

Three WASM kernels shipped before six. The spatial candidate gather: the cell walk, the dedup and the range test, in double, the JavaScript arithmetic, for a whole batch of entities per call. Predator spatial 5.20 → 4.21 ms, −18.6 %, six pairs of six. The particle integrate, `ParticleComponent` living in a `WebAssembly.Memory`, the dead list drained back through JavaScript in its order, and rotation through fdlibm compiled in: the particle stress −31.3 %, the state identical after every one of 60 frames. The active and visible particle lists, 16 slots at a time with empty blocks skipped: −15.1 %, and +1 070 % in the kernel on Predator's sparse 10 000 slots. Sorting each gather batch by home cell first kept the cells in cache: boids spatial −8.4 %.

Two smaller ones. Adobe Animate assets are looked up by id, not through their name and a string-keyed map: −9.6 %. Box2D reads its clock through `emscripten_get_now` instead of WASI's, which made a BigInt per call: a tie, kept because it removes work nobody reads.

The plan for what comes next got its map. A sweep profiled every scene the way the first premise question profiled four, and added the decal stamp, the Adobe Animate emit, the Box2D glue and its clock reads to the candidates. And the decision that unblocks the biggest of them: the engine's shared data will live in Box2D's memory, so a kernel can read bodies without a copy.

## Thursday 22 October 2026 (night) — Questions Before Any C

I wanted to know which hot loops would be faster, or more predictable, in WebAssembly, and I wanted the answer to be measured one loop at a time before any of them met another. The record already said when WASM pays. On 6 October a SIMD publish that copied its data in was +126 % in its kernel and made Predator's logic 9 % worse; the same publish working in place cut Predator's spatial 14.6 %. SIMD did nothing for a gather. So the rule going in: the data already lives in WASM memory, one call does a batch, and the loop needs something JavaScript does badly.

The plan, E-76, set its rules before its first kernel. Freestanding C, built by one script with pinned flags, maths in double wherever JavaScript does it, no fast-math. A kernel owns no memory: one import, the memory, no start function, no globals, no data, a check after every build that says so. One memory map, every region on its own cache line. One loader that refuses any other import. One switch per module, so a bench can time both paths in one build. A coexistence test runs three modules in four threads against canaries and must match the solo runs byte for byte. Kernels are timed against the shipped JavaScript, never a copy, alternating sides, warmed to TurboFan; Node screens and Chrome decides. My first numbers were on battery, which halved the clock. The rest are on AC.

The first defect was in the module already shipped. It had been built by emcc with a command nobody recorded, with WASI imports, a start function that wrote at address 1028, and a stack pointer inside the 128 KB header. A second module in that memory would have collided with it. The freestanding rebuild went from 1 354 bytes to 876.

Five questions. Where the time actually goes, profiled again after the morning's import fix, because every share on record predated it: Predator's spatial neighbour search was 61.8 % of its worker, Pixi's pack 33.9 %, the decoration sway 45.1 % of the particle worker. Whether compiled fdlibm matches `Math.*`: in Node atan2 matched; in Chrome none of them did, each off by one ulp in 3 to 17 % of inputs, but sin and cos agree after float32 rounding, so a float32 rotation can stay identical. What a call into WASM costs: about 4 ns, free per batch or per light, real per entity. How close each shipped loop is to its floor. And whether the shipped float32 publish agrees with the double JavaScript path: on 35 million real candidate pairs over 45 Predator frames, it never disagreed; on three million pairs placed one float32 step from the range edge, 0.9 % did. The C went to double the same night: 571 bytes, and in Chrome, on Predator's rows, a little faster than float32. Its Predator gate was neutral.

## Thursday 22 October 2026 (evening) — The Source Was Slower Than the Bundle

Predator ran faster from the bundle than from source, in every worker: pre-render 12 % faster, physics 6.5 %, spatial 3.8 %, the renderer 3.3 %. Same code. The difference was the imports. A native module import is a live binding: a cell read at run time with a check that the binding exists, which TurboFan cannot fold. webpack turns the same import into a getter it inlines and folds away.

Four hot modules now copy their imports into module constants, and a test fails if one stops. From source: spatial −16.2 % and pre-render −22.7 % in the minimal tick, three of three. Predator: the particle worker −27.6 %, six of six, and the bundle got faster too, −17.9 %. Copying into locals at function entry did not reproduce. Self-contained workers made the bundle 64 % bigger and went back. None of it shows in Node.

On the way: the seeded random kept its state in a double that passed 2⁵³ at call 4 917 760 and stopped being mulberry32 from there. The state is an `Int32Array` now, and the first 4 917 760 numbers are unchanged.

The visual editor got a plan, no code: for me first, inside the debug panel, the fastest in-page version before any bundle. A level is a scene file. The first milestone is to open the platformer, press E, drag a platform, widen it, save, reload, and still have it.

## Thursday 22 October 2026 — Save, Reload, Keep Playing

Hot reload that throws the game away is a page refresh with extra steps. Now a change saves the scene, reloads, and restores it, every entity at its own index with its plain fields. Boids had lost all 40 000 boids on the first try; thirty demo scenes came back identical after the fix. Then better: a changed game script is swapped into the running page and into every worker, with no reload at all. On Windows, reading a file moved its last-access time and pinged the watcher, so the page reloaded while it loaded; it pings only when the content changed now.

Spawning had too many doors: `scene.spawnEntity`, `game.spawnEntity`, `GameObject.spawn(Class, cfg)`. There is one now. `Enemy.spawn(cfg)` returns the instance or `null`, `Enemy.despawn(entity)` and `Enemy.despawnAll()`, the same on every thread, and the page holds the same instances the workers do. 123 stress-scene call sites moved. A pinned entity's collision callbacks and messages run on its own worker. Seven demos could not run from the bundle at all; the blob loader had three bugs. `setAnimation` with the animation already playing built a string every call: 7.5 million calls a second to 48 million, no garbage. Two older bugs surfaced in this work: spritesheet ids followed load order instead of declared order, so ants drew as fire, and an active list lost an entity whose index was reused at once, so Predator's flashes froze.

## Wednesday 21 October 2026 (evening) — An API I Would Want to Use

I went through the API as someone writing a game would, and said no more often than yes. No engine UI or text, no auto-generated fields, no input action maps, no restructured `static config`, no Tiled object spawning for now, no timers per entity. The rules that came out of it: an instance method asks about its own entity, and asking about another is a static that takes the index; a condition that repeats warns once, not per call; a duplicate API is deleted and its callers moved, no aliases.

What went in: `this.is(Coin)` and `GameObject.is(other, Coin)`; `applyForce`, `applyTorque` and the impulses on the entity itself; `setDisplaySize`, `collider.fitToSprite`, `flipX`; `loadScene(url, { data })` with progress; `onSaveGame` and a per-entity save filter; entity messages, `sendTo` and `onMessage` through a shared inbox; tweens with delay, repeat, yoyo and a callback, cancelled on despawn; `onAnimationEnd`. Workers print a game's `console.log`; a throw in game code names the entity and no longer stops the worker; a full pool warns once and counts what it dropped; the SharedArrayBuffer error names the two headers. `npm create weed-game`, a first-game guide that builds Coin Rush, a deploy guide, and a page for people coming from other engines.

## Wednesday 21 October 2026 (later) — One Undeclared Field

One field, written for the first time after the frame loop had started, reshaped the pre-render worker's object, and every method that had seen the old shape deoptimized: 688 deopts of one code object over about eight seconds. Declaring 47 pre-render fields and 52 Pixi fields in their constructors took pre-render's deopts from 726 to 221, and the particle-emit stress 9.6 %. The same lesson had a second half: a field declared `null` that later holds a typed array is typed "any value", and per-entity code that tests it pays: starting it as an empty array of the same class was +17.7 % and +17.8 % in the emit kernel. Both are rules in CLAUDE.md now, with an audit script.

Garbage, in Chrome, where Node showed none: pre-render made 30 MB/s of heap numbers through a pose scratch object and comparators that returned `a - b`. A typed scratch and comparators that return a sign: 0.27 MB/s; the scratch alone took Predator's pre-render down 8.7 %. The contact "begin" set became a stamp per slot: Predator logic −9.5 %. The particle ease function shrank from 717 bytecode bytes to 245, under the 460 TurboFan inlines: +22 to 29 % in its kernel, minor GCs from about 15 per thousand steps to none, the tween stress −10.3 %. Audio `play()` had started walking its bus list on every call, a regression of ten times; −86.6 %. A save of 4 000 entities encodes in 83 ms instead of 345, byte-identical.

A turned camera culled with an axis-aligned box twice the size of the view at 45°: sprites tested in view space now, 30 589 queued to 15 997, pre-render −38.3 %; particles the same way, −29.4 %.

Lost: a getter profile that got slower, three spatial kernels −4 to −10 %, a wait that only moved between workers, a Box2D build without its thread pool (a tie). Removing the pack's fast path made the renderer 18.7 % worse in Predator, which is why it is there. `Time.scale` above 2 now really runs more physics, up to four steps a frame; at scale 3 Balls physics is 7.0 → 11.5 ms, the work it used to skip. The merge to `main` was gated on Predator and failed once on a load key `main` did not publish before passing on matched load.

## Wednesday 21 October 2026 — Compound Shadows at a Third of the Cost

A light near a compound occluder, rings built of many fixtures, was the slowest thing in the lighting path, and the review had left it open. Five changes, every one bit-identical against a golden or a parity test. A compound-only light merged against its circle placeholder three edges per bin: pre-render 6.47 → 4.07 ms. A cos/sin table for the polar bins: 4.03 → 2.32 ms, so 6.47 to 2.32 for the two. Each sweep edge tests only the rays inside its own arc: +1 451 % in the merge kernel, the boxes variant 11.61 → 3.46 ms, −69.8 %. The outline rastered in chain order, reusing the previous edge's angle: −20.8 % with 64-segment rings; its first version crossed TurboFan's 460-byte inline limit and lost 7 to 14 %. The merge without atan2 was a third cheaper inclusive and tied in the scene. The compound edge table went into typed arrays: rebuilds 12 to 18 times faster, the remesh-every-frame renderer −29.2 %. A sparse array of solids had fallen into dictionary mode; filled densely, lookups went from 35 to 108 million a second.

## Tuesday 20 October 2026 — A Review of Forty-Seven Commits

Forty-seven commits from 17 to 20 October, read line by line and turned into a plan: 29 bugs, 12 measurement defects, 11 pieces of dead code, 13 duplications, and the GC, deopt and speed items. 28 of the 29 bugs were fixed the same day, one commit each, a failing test first wherever Node could show it, and the test checked by breaking the code it guards. A headed smoke run of the planet, the terrain and the city after each batch caught one regression of my own.

The ones a game would have felt. A sound freed on the audio thread stayed on its bus's list, so another bus reused the slot and a quiet click could drop while a louder one stole an explosion. Chain colliders solved the ray with a negated denominator: real hits missed, rays pointing away hit, and the old test expected the wrong answer. Sprites flickered at 30 Hz after one tint change, because one dirty flag served two alternating queue buffers. Traffic cars steered toward what they were avoiding. A body spawned into a slot could be created under the old generation, then destroyed and recreated, dropping its joints. Skinned polygons weighed one to four times the mass they were given. A throw during a restore hung the load forever, and a save could catch a physics step half done. `despawnAll` never freed fixtures, so every load leaked the terrain's. No cull handled a rotated camera: at 90°, two bands of about 200 pixels drew nothing, and the planet scenes rotate every tick. Clicks used the eased camera, 90 pixels off at 600 px/s.

Then the waits. A synchronous overlap or ray query from logic only woke physics if it was an AABB query; anything else waited a whole physics frame. Logic was 16.6 ms of which 16.5 was waiting. Every query kind wakes it now: 2.9 to 3.4 ms, −82 %.

Two rules came out of the measuring. Merging three copies of a light packer through one helper ran 10 to 30 % slower, and one `if (turned)` inside the loop cost 21 %: the copies stay, tied by a test. And the test suite's random crashes were each Box2D test instance committing 512 MB; free commit fell from about 6 GB to 0.2. One shared instance, and the suite went from 13.6 s to 10.2.

## Monday 19 October 2026 — Rings That Cast Shadows, and Fingers

Each edge of a moving compound solid was its own occluder in the light sweep. A 512-bin polar nearest-hit replaces them: the compound stress, 40 moving rings and 24 moving lights, pre-render 37.9 → 6.9 ms. Clearing a body's shapes read 32 ids and stopped, so a body with 96 shapes kept 64 of them; the WASM does the work now, which made it slower to clear and correct. Closing a spawn window scanned every pending flag; a list of the marked slots is about 1 150 times faster at 65 536 entities.

The mouse became pointers: the cursor, a pen and up to four fingers, `isDownAt`, `pinchRatio`, the pinch centre. Particles can light the scene, one additive quad each, `lighting.particleLights`. Saves learned shared resources, chains, fixtures, meshes, navigation, time and tweens. Box2D's thread pool stopped starting four threads before anyone asked, the cap went from 4 workers to 32, and the option is `numberOfPhysicsWorkers`. The Box2D planet was rebuilt on the destructible terrain's grid: 4 182 lines deleted; chunks that break off become loose islands, and the ship carries lights.

## Sunday 18 October 2026 (evening) — Every Worker Was Waiting for the Screen

A new campaign, and its rule: every hypothesis gets a probe of its premise and a named primary before any run. The first probe found that `WAIT_MS` had been published as zero and never incremented anywhere. Measured for real, every worker was idle 75 to 99 % of the frame, and step plus idle came to 16.67 ms on each: they were all paced by the screen. A shared frame clock showed it from the other side: over 302 Predator frames every worker started within 0.06 ms of the main thread. The idle is the vsync. Running without the frame limit made pre-render 4.8 % slower.

Moving the sprite pack from Pixi to pre-render made the renderer 36.6 % cheaper and the slower of the two 12.6 % slower: pre-render is the critical path. Caching the shadow stamp's cell won 79 % in its kernel and lost 3.1 % in Predator; a 52 KB table traded divides for cache misses. Four allocation hypotheses in a row were wrong, so allocation count stopped being a reason to try something. A 32-bit entity id costs 1.73 times the 16-bit one, because the key becomes a double. Four Box2D threads are confirmed: Balls physics 10.7 ms with one, 5.8 with four. And the September regression that had "no mechanism": the changed function ran only on logic, but it wrote shared memory that three other workers read. "Worker X cannot run this code" is not "worker X cannot be affected".

## Sunday 18 October 2026 — Sprites That Sort The Way They Draw

Little City, zoomed all the way out, entities flickered for one frame now and then, fighting over a zIndex. Not Predator, not at the same zoom. Deleting the people, the cars and the trees did not stop it, which ruled out almost everything I would have guessed. Two defects, and they are one defect: the Y-sort line and the Y-sort order were two different ideas about what a sprite is.

The order first. The painter does not re-sort every frame. It keeps last frame's order, pulls out the slots whose key changed, and merges them back. The rebuild path, `radixSortIndicesBySortKey`, buckets on `ord >>> shift` — unsigned, correct. The merge compared `ord` directly, and `ord` is a JavaScript number with bit 31 set for every **positive** float key. Read as a signed int32, every positive key was *smaller* than every negative one, so half the city sorted behind the other half. Keys are `Math.round(footY) * 128`, so a key goes negative the moment an entity sits above the world origin. Little City's world is 4992 tall and its camera is free, so `minZoom` makes the view exactly the world height and `latchCamera` pins the camera to `y = 0`. World `y = 0` lands at the vertical middle of the screen. 170 queued rows carried negative keys, 22 of them within ten pixels of the origin: houses and trees, on the wrong side of their neighbours for a frame. Predator's squad camera stays inside the map, so its keys are all positive and the identical code is correct there. That is the entire difference between the two scenes.

One frame, and only one, because `painterSameSet` takes the reinsert path only when the visible set size is unchanged. Change the size and it rebuilds by radix, which was never wrong. Right, wrong, right, wrong — and only the rows that had actually moved changed, which is why it never looked like a sorting bug at all.

No trace and no benchmark for this one. I read, then replayed the real `sortKey` column out of the shared render-queue buffer through the real painter functions, in the page, over live frames. Twelve rebuild frames, zero inversions. Eighteen reinsert frames, eighteen inversions, every one of them at the sign boundary and never between two keys of the same sign — which is the shape a wrong comparator makes and nothing else does. In Node, against the shipped module, 500 frames with every key positive came out sorted 500 out of 500; 500 frames with half the keys negative came out wrong 499 out of 499. The fix is one call: `floatBitsToOrd`, already in that file, already carrying the `>>> 0` the merge's private copy had dropped.

Then the part I do not like. Sixteen painter tests were green the whole time, and the checker had the same bug: it compared `keysU32[a] <= keysU32[b]`, which is the ordinal order only while every key is positive. Every key in every one of those tests was positive. A reference that shares the bug is a mirror — the keyboard keymap said that on 14 October, and here it is again, in the test instead of the source. The checker orders by ordinal now, and the mixed-sign cases are the ones that matter. The suite went from 1039 to 1047.

The sort line had the mirror image of it. `inheritTransformRotation` says a sprite carries its own rotation instead of taking the body's, and three places honoured that: the emit, the pixi self-lit path, and the sort line. Before, only the sort line ignored it, and the fix was already sitting uncommitted in the working tree — I kept it. A `Car` sets the flag to 0, leaves `spriteRotation` at 0 so the sprite is drawn axis-aligned with its facing baked into the frame, and calls `setFixedRotation(0)`, which is the *free* flag, so the body steers. The sort line was therefore built from the steering angle while the sprite was drawn unrotated, off by `ox·sin θ + oy·(cos θ − 1)` — tens of world pixels at ninety degrees, changing every time the car turned. 300 of Little City's 9608 entities take that branch, all of them TrafficCars, so it was never dead code.

That function was a method on the worker, which is most likely why nothing covered it. It is `spriteSortFootY` now, in `sortIndexByKey.js`, next to the key it feeds, and it has eight tests. Two things I decided rather than asked. The feet-anchor early-out stays in the worker as well as in the helper: lifting it out of the worker would resolve a texture the early-out used to skip, and that resolver can warn. And the cached component arrays are dropped in `initialize()`, because a first call that arrived before they existed would cache nulls and silently pin every sort line to the pose for the rest of the session. Live, after both edits: 74 frames at `minZoom`, camera at `y = 0`, about 108 negative keys a frame, zero inversions.

The radix still has its own inlined copy of the transform. It is correct — it only ever feeds `&` and `>>>` — and it is the hottest loop in the file, so it stays, with a comment saying why it agrees with the merge. I did not benchmark the `floatBitsToOrd` call against the inline expression it replaced: 208 thousand reinserts a second on a 20k-slot moving set, and V8 inlines it, but that is a number from a loop I wrote, not from a scene.

## Saturday 17 October 2026 — Chains, a Gear Train, and a Camera With Manners

Box2D chain shapes came in, and a gear train to show them, and a scene where you drag a mesh's vertices along a chain. The camera got a deadzone and a shake. Time got a scale, with its own clock so the simulation can slow down and speed up, and the physics API a prismatic joint. The night before, the engine was pinned to Box2D 3.2.0: Balls physics 20 % cheaper at the same body count, the LiquidFun pass 3.7 % slower in its kernel, so the scoreboard as a whole was not a keep, and the pin stayed for the bodies.

## Thursday 15 October 2026 (later) — A Planet You Can Dig

I wanted the round planet from the old page. A million cells, a brush, a walker that sticks to the dirt, and water that sits in the holes. Box2D cannot be that grid. The ground is a bit array the scene owns. The picture is one world rectangle, and the scene shader colors it. WebGL and WebGPU each have a file. The engine does not know it is a planet. It copies bytes into a picture.

The call is the same shape as a uniform. `Layer.get('planet').updateTexture('cells', PlanetGrid.cells, x, y, width, height)`. The name is the picture. The array is the shared field the game just wrote. The rectangle is the part that changed. A private array, one thread only, is rejected. A compute pass that already writes that name is rejected too.

I asked where the time went. A stress picture, the whole thing every tick, put 89 % of the renderer inside the copy to the card. The JavaScript around that call did not show up. Asking for the one row that changed took the renderer from about 10 ms to about 0.17 ms. The brush already asks for the dirty chunk. There was no engine edit left in that trace.

## Thursday 15 October 2026 — A Mixer I Can Hear, and Then See

I wanted guns, voices, and music to be different things. One gain on the master was a mute switch with extra steps. A scene now names up to eight buses. Each one has a volume, a pan, a mute, a cap on how many voices it will keep, and a compressor. A louder shot on a full bus replaces the quietest voice on that bus instead of dying in a queue of slots the mixer will never play. The master sits after the buses, with its own compressor. `play` takes the bus name. `SoundManager.channel('sfx')` is the handle.

The Audio tab is the mixer desk. A status line for the context, the rate, the latency, the voice count, and how many plays were dropped. One card per bus, with a fader, a pan, mute, and the two sounds that bus is playing right now. Under that, the live voices, the loaded assets, and the stereo output: the history, the two peaks, and one RMS, because the level ring is not a stereo RMS. No icons. A colored edge on the card is enough. The fader you are dragging is not overwritten by the next refresh.

Then I asked where the time went. A stress scene that only calls `play`, 800 times a tick, put 96 % of the logic worker inside `_writeSlot`. The line was not the claim. It was the walk. Every play on the voice bus still visited the gun slots and the music slots to find out they were not voice. At 800 plays the step was 6.6 ms, under the 8 ms bar, so the knob went to 1200. Headed, live source, detailed stats off, logic was 8.8 ms.

Each bus now keeps the slots it actually holds, and the quietest voice and the one after it. A shot that is not louder than that minimum is a drop after one read. A louder shot takes that slot. The walk, when it still happens, is that bus's list, not the whole table. The worklet updates the list when a one-shot ends. The kernel, same voices left on the buses, same drop count, was 21 thousand calls a second to 262 thousand, five rounds out of five. The scene went from 8.8 ms to 0.28 ms. The fast side is under 8 ms. The baseline had cleared it, and the step got cheaper, so the keep stands. Predator is not that number. Last time this function showed up there it was 4 % of logic.

## Wednesday 14 October 2026 (later) — Make the Mesh Busy, Then Look

The gallery is eight pictures. It can show that `setMesh` and a rope and a polygon all draw. It cannot say where the frame goes. I wanted a scene that fills the vertex arena and then a trace of that scene, before another guess about what to speed up.

The stress scene is one mesh layer: rigid fans that only turn, grids whose vertices are rewritten every tick, ropes rebuilt every tick, quads with their own UVs, and a smaller set of boxes that still fill from the collider. Headless, the renderer sat at 2.4 ms, under the floor. Headed, the same scene was 3.8 ms, which is enough to judge.

The trace does not point at ear-clipping or at `Math.sqrt`. Half of the renderer's busy time is the upload of the instance buffer. A quarter is writing the three corners of each triangle whose vertices moved. The pose table was walking every triangle to store one pose per entity. A grid of 768 triangles was writing the same pose 768 times.

Walking that table once per run of triangles, instead of once per triangle, was 2.9 thousand calls a second to 11 thousand, and the table matched. Loading an entity's vertices once for the whole run, instead of once per triangle, was 28 % more calls a second, and every float matched. Dropping the unary plus on `writeVertices` was slower. That one stayed out.

Headed, after both edits, the renderer was 3.03 ms and then 2.76 ms. Against 3.78 ms that is about 23 % cheaper. The second window fell under 3 ms. The baseline had cleared the floor and the changed side was cheaper, so the keep stands. The upload of triangles that actually move is still half the trace. An indexed mesh would shrink that. It was not this change.

The write-up is [`MESH_API_TRACE_REPORT.md`](./reports/MESH_API_TRACE_REPORT.md).

## Wednesday 14 October 2026 (night) — Hand the Renderer a Mesh

`MeshRenderer` could already fill whatever the collider was. What I wanted was a mesh I write myself. Vertices, a subdivided plane, a rope, a polygon, optional UVs, in a shared arena the Pixi worker reads and gameplay writes. The Box2D worker does not bind that pool. If an entity has called `setMesh`, that geometry is what gets drawn. If it has not, the fill still comes from the fixtures. A debug overlay draws the triangles. Mesh Gallery is the scene that lines the cases up so they can be looked at.

The arena is first-fit spans. Replacing meshes of different sizes will fragment it. The upgrade, when many entities draw the same mesh, is one shared asset id. `MeshGeometry`, `setVertices`, `setPlane`, `setRope`, `setPolygon`.

## Wednesday 14 October 2026 — The Plan Was a Reading of the Source

The math-allocation audit started as a census of `src/`. Seventeen hypotheses, written down before a trace of the scene they were supposed to speed up. The first run measured the wrong scene. `npm run … -- --scene X` ate the flags, so a Predator command came back as Balls. The harness now refuses a capture whose body count and symbols are not the scene that was asked for.

Then the real Predator trace. Pre-render 8.4 ms, physics 7.9 ms, spatial 7.1 ms. Not one function from the math census is in it. Visibility polygons are absent. `Math.sin` is absent. Decoration sway is real and small, about 3 % of a worker that is 11 % of the frame. Physics is still 3.48 cores, and two thirds of that is `wasm-function[102]`, the mailbox, the same function disassembled on the morning of 1 October. The largest JavaScript costs are ones this plan never named: `packInstancedRows`, the neighbor walk, shadow stamping. The list and the machine agreed on almost nothing. That is why the trace comes before the kernels.

The morning was twelve bugs. None of them is a speed claim. The one that freezes the game: the renderer consumes a queue frame, then returns early because the GPU is unavailable, and the release lives in a `finally` that return never reaches. `renderQueueSync` stays put. Pre-render decides it is more than a frame behind and skips every frame after that, with no error. A looping sound pitched past its own length reads off the end of the channel. The sample is `undefined`, the interpolation is `NaN`, and the output clamp lets it through because `NaN > 1` is false. The audio context stays poisoned for as long as it lives. A sync Box2D query on the main thread calls `Atomics.wait` and throws a `TypeError` that names neither the thread nor `queryAABBAsync`. The query snapshot reader took the index before the count. Path reconstruction wrote one past its buffer. The decal dirty flag had two writers. A moved-body view could straddle two publishes. The list-update queue grew without a bound while its consumer was paused. The suite went from 812 to 873.

One of the cleanups shipped a bug the test agreed with. Caching `Object.keys` and `Object.values` of the keymap looks like the same list twice. Numeric keys `'0'` through `'9'` come out of `Object.values` first, as array indices, so the held state of `a` was written into the slot for `0`. The parity test built its lists the same way and passed six for six. A reference that shares the bug is a mirror. It now inverts the map and asks which key owns the slot, and it calls `updateKeyboardBuffer` instead of a transcription of it. `flattenKeyMap` does the pairing in one `Object.entries` pass.

I also repeated the worktree mistake from 30 September. `git worktree remove --force` followed the `node_modules` junction and emptied the main repo again. `npm test` stayed green, because `node:test` needs no packages. The sitting died later, on `Cannot find package 'playwright'`. A green suite does not mean the benchmark can run. `pretest` and `prebench` now resolve `playwright` before anything is measured.

What the hypotheses actually did:

The sway-frequency bucket is cached instead of recomputed per decoration. Kernel −18 % at 65 535 decorations, exact parity. The stress scene moved −5.8 %, four pairs of four, and the worker is under the 3 ms floor, so the product verdict is neutral. An earlier sweep of that scene was void. The decoration count in the command never arrived at the worker. Once the parameter landed, the cost is linear: 22.3 ns per decoration.

`collectVisibleEntities` hoists what the loop was rereading. The worker headline was −12.6 %. The loop that changed, `COLLECT_MS`, is −6.7 %. The gap is `EMIT_MS`, which jumps about 1.3 ms when the pose-only shortcut does or does not fire. The keep is the 6.7 %.

`gatherInstancedRows` copies each sprite row in a loop instead of one `subarray` per row. At the real depth, 45 568 rows, the kernel is 1.32×, and the output is bit-identical. A `PerformanceObserver` over that run counted zero GC events on both sides. The allocation story was the reason to do it, and there is no allocation in the number. The sprite-pack scene did not move a judged 3 %. It stays as a kernel keep.

`Math.hypot` against `Math.sqrt` of the two squares is about 16× in the kernel, at every magnitude from a thousandth to ten million. About 64 % of in-range pairs are bit-identical. The rest differ by a few ulps, inside float32. Hygiene. A decoration spawned at angle +0 skips `cos` and `sin`. The test is `Object.is`, so −0 still takes the transcendental and keeps its sign. The all-zero case is −24 % of that spawn microbench. The fully rotated case is +6.7 %. No scene. The Predator trace does not name `setRotCSFromAngle`.

The visibility polygon got four small edits and no sitting, because the trace names none of those functions. The constant end direction is hoisted. The ε samples use a first-order expansion. An arc of at most four steps uses angle addition. `normalizeAngleSigned` drops `%`. The gate was written down first: a three-circle fixture snapped from the old sweep must stay within 1e-4 world units. It passed. Comparing squared distances before the occluder square root did not ship. That extra branch already lost four pairs of four on 6 October, and Predator has no visibility-polygon vehicle that would show the loss.

Sorting packed spawn keys instead of a comparator was +147 % in the kernel at 256 items, and −0.6 % on the spawn storm, three pairs of eight the wrong way. Dropped. That sitting was also dirty: a toolchain check launched Chromium in the middle of the pairs. The gate no longer prints a percentage for a worker under 3 ms. Minus 21 % of 0.238 ms is not a result.

The decal dirty scan and the `castAll` comparator were left alone. The scan is also the early-out, and at 64 000 tiles it costs 0.57 ms. The ray stress that is actually hot is `castRayClosest`. It does not run that sort.

Balls lockstep had been failing on both sides of the board. `spawnBalls` scheduled 9000 `setTimeout`s, and headless Chromium did not get them out inside 120 seconds, on this tree and on the tree the audit started from. The balls are created before the flush now. Lockstep passes. Physics is 8.013 ms to 7.997 ms, a tie, 9004 bodies awake on both sides. The scoreboard against that morning's revision is still not a faster engine. LiquidFun, the coupled liquid scene, and decal blit came out a few percent more expensive. A first pass had also blamed the ray, the tilemap, and the painter radix. Those files were not edited, and a second sitting of them flipped sign. The keeps that belong to this day are visPoly's pre-render and the sway-bucket kernel.

The essay is [`MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md`](./reports/MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md). The rows are in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md).

## Friday 9 October 2026 — Count a Particle Pair Once

`FindParticleContacts` walks the nine neighboring cells and never checks that it is standing in the particle's real cell. Two diagonal cells can land in the same bucket, and the pair is pushed twice. The filter marks only those aliases. Contact count unchanged, 25328. One worker got 16 % more expensive in the microbench. Four workers, 3.6 %. Balls physics +0.9 %. The liquid stress +1.5 %. Both scenes tie on load. It stays because the pairs were wrong. The step did not get cheaper.

## Monday 6 October 2026 — One Wait for Three Thousand Rays

The campaign opened on a Predator A/A that was neutral, and on the same mailbox as 1 October: three helper threads at 100 %, `wasm-function[102]` still about 60 % of them. The pool stays at four. The other obvious lever was how many of our own workers to run, and every change made a worker it did not own more expensive. Two spatial workers cut spatial 35 % and raised the renderer 8 %. Three logic workers cut logic 16 % and raised the particle worker. One logic worker nearly doubled logic. The default stays at one spatial worker and two logic workers.

A synchronous `queryAABB` posted from logic after the physics step sat inside that step until the next animation frame. The stress was 16.6 ms of logic for 201 bodies. The physics worker now wakes on the shared status and services the query between frames. Logic fell to 0.15 ms. Predator did not move. Leaving that wake armed all the time made the LiquidFun query worse, physics +4 % and logic +15 %, so the always-on form went back. The keep is the query that waits only when a query was actually posted.

Neighbor lists were still being copied out of WASM. Poses, candidates, and `neighborData` already live in one `WebAssembly.Memory` the size of the scene, so the filter writes the published row where the readers already look. Kernel +118 %. Predator spatial went from 7.94 ms to 6.64 ms, every pair better, and no other worker crossed 3 %. A SIMD build of a publish that still copied was +126 % in its kernel and made logic and pre-render worse in the scene. That one went back. The neighbor cap stays at 1024. A visual range of 400 with 32 entities in a cell can pass 64, and the readers already stop at `neighborCount`.

`ParticleEmitter` takes `renderOnly`, default off. One shared counter says how many emitters asked for it. Zero means integrate and emit never touch the column. Above zero, those particles age on the CPU and stay on the compute layer that already draws them. If the shader does not move the pose, nothing is drawn. This is an opt-out of the CPU integrate, not a new GPU integrator.

The busy Box2D ray stress was 50 ms of logic because each of 3072 `castRayClosest` calls was its own trip through the shared buffer. They go into one pending batch, and the physics worker casts them in one pass. Logic went from 49.9 ms to 16.6 ms. Physics went from 6.3 ms to 4.5 ms. 2800 bodies on both sides.

The rest of the wave lost.

Eight sprite fields packed into one block were 26 % cheaper to read, in a microbench that did not do the write. With the extra write on emit, sixteen Predator pairs put the renderer 8 % slower. The write ate the read. Dropped.

Skipping the second separating axis in `b2CollidePolygons`, once the first axis had cleared the speculative band, passed the WASM tests and made Balls physics 4.6 % worse, six pairs of eight. The binary and the C went back. Predator was not run. A scene that rises 3 % ends that wave.

Three edits taken from the trace after the ray keep, all reverted. Caching the squared range in the candidate loop made spatial 9 % slower, four pairs of four. The half-extents change, and the branch does not pay. Skipping the previous pose when interpolation is off looked like a win for four pairs and tied at eight, while physics and logic, which never call that function, had moved with it. Taking `|| 0` off the bounds half-extents made pre-render 5 % slower, four of four.

Against the revision the campaign started from, Predator spatial is 7.27 ms to 6.50 ms. Logic and physics came out higher, with the variation around 10 %, and the runner does not call that a regression. The scoreboard is not one verdict. The query wake, the neighbor publish, and the ray batch are the product keeps. Eleven rows failed or went the wrong way, some of them because the stress sat under the 3 ms floor, and the Box2D ray row had no baseline on the old revision because that scene used to publish 0 ms. The rows are in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md).

## Thursday 1 October 2026 (later) — A Hundred Sines for Twenty Thousand Blades

The morning entry closed the grass question: a faster sine is not a measurement when twenty thousand blades have twenty thousand frequencies. Quantizing the frequency still leaves a distinct phase on every blade, so a lookup of the sine is the wrong shape. What stayed is a grid. `sin(i * 0.1)` and `cos(i * 0.1)` are built once. Each frame does a hundred sines, and the blade loop is a product. Thirty-two buckets and a hundred tied in the kernel. A hundred stayed. `particle.swayFrequencyBuckets` defaults to 0, so every other scene keeps `Math.sin`. Predator writes the grid `1 + bucket * (2/99)` at spawn. Against the old worker the kernel was +35 %, within 1e-3 of the real sine. The particle step went from 2.03 ms to 1.81 ms. Physics rose 3.6 %, five pairs of eight the wrong way, which is short of a regression.

The loop also grew a shear. `SWAY_LOOP_SKEW` stores a sentinel in `rotC` and the angle in `rotS`, so the quad shears instead of turning, and the shadow pass can tell that value from a cosine. Grass that bends is still a sprite the shadow system is allowed to drop.

A dynamic collider fill whose published rotation was still zero was painting the old orientation. The pack takes the live Transform in that case.

The GPU clock came out. Timestamp queries, and `onSubmittedWorkDone`, wedged Chrome. The WebGL timer queries were coming back empty. The performance panel stopped printing those milliseconds. What it shows for the sprite path is the last upload, and whether the queue that frame was new.

The procedural tree is a demo: a plant that grows, drops dead branches, and dies. The index opens a scene from the URL, so a refresh comes back to the one you had open.

## Thursday 1 October 2026 — The Thread That Was Waiting, and the Load That Was Not

The trace we had been reading was already a day old. Neighbors, the spatial cell walk, and the painter radix had landed since then, so I took another CPU profile of Predator before believing any percentage. The shape of the threads barely moved. Emit was still a quarter of pre-render. The pose publish on the physics thread still spent almost half of itself on one atomic load per body. And the three Box2D helper threads were still pegged, sixty percent of that time inside a single wasm function whose name the binary had thrown away.

LTO strips the name section, so the index in the profile is just a number. Disassembling the shipped wasm showed that `wasm-function[102]` is not the solver's spin loop. It is Emscripten's pthread mailbox: read the clock, compare-and-swap a word, time out. The solver spinner the C file still marks with a todo is a different function, and it is not in the top of the profile. That changed the experiment. Cutting the pool from four threads to two should have freed a core if those threads were only waiting. Predator said otherwise. Physics step went from 8.7 ms to 10.9 ms, every pair worse. The renderer and the pre-render worker did get cheaper, which is what less idle spinning looks like, and it was not worth a solver that fell behind. The four-thread build went back.

On the JavaScript side the same rule kept showing up. Emitting sprites in entity order instead of cell order is a beautiful memory story and a sort that made the real pre-render worker 69 % slower in the kernel, checksum identical, so it never saw a scene. Hoisting the shadow-caster columns looked like a 7 % win until the same edit was measured inside the worker's own function, where it tied. The win had been the act of recompiling the method in the bench, not the hoist.

The one that stayed is smaller than the trace made it sound. Pose publish now skips the per-body generation load when nothing has respawned since the last clean pass. The kernel more than doubled. Predator did not move: physics is still the wasm step, 8.7 ms either way, and nothing else regressed. A doubled function that is not the bottleneck gets to stay, and it does not get to be called a faster game.

The soldier scan that is twelve percent of logic looked like a win for eight pairs and disappeared when the sitting was extended to sixteen. It also changes which civilian gets shot for a few frames. It went back. A faster sine for grass was never a measurement: twenty thousand decorations in that scene have twenty thousand different frequencies.

## Wednesday 30 September 2026 (night) — The Kernel Said 138 %. Predator Said Nothing

Second round, same night, same rules: kernel first, then the patched `src/` in a worktree, then a parity test, then eight counterbalanced Predator pairs. Six ideas went in. Two changed the scene, two only changed their kernel, two got thrown out. The ones that got thrown out taught me the most.

The best result came from the one I almost dropped. The spatial worker walked every cell of its rows, read every cell count, and kept a per-entity marker so an entity spanning two cells ran once. But `rebuildOwnedRows` already touches every entity with its position a few microseconds earlier. It can just write down which ones live in this worker's rows, and the neighbor search walks that list. In the kernel this tied, dead even. In Predator spatial went from 4.18 ms to 3.46 ms, every pair better. The kernel runs the three spatial workers one after another on one thread; the browser runs them at the same time over one shared grid, and that is where walking cells and stamping markers actually hurt. It also fixed a bug nobody had hit: an entity whose home cell was full never got its neighbors refreshed again.

The neighbor getters on `GameObject` went the other way. Reading `Grid._neighborData` directly instead of building a view and calling through it was 28 % faster in the kernel. The first eight Predator pairs said −5.7 % for logic, but only five of eight agreed, so I added eight more. Sixteen pairs: −0.1 %. It stays, as a kernel claim, because nothing got worse.

Then the pack. Pixi spends 38 % of its time in `packInstancedRows`, and its lines are all first reads of each column through the painter's index list, which looks like random access. Invert the list once, read the queue in order, write each row where the painter wants it. The kernel said +145 %. On the way there, the kernel itself turned out to be wrong: with sprites and casters timed in the same process, the function had seen both kinds of call before the clock started and ran almost twice as fast as it does in an engine worker, where it only ever sees one. Each case now gets its own `worker_thread`. That also reproduced the deopt I thought was gone, an OSR'd loop bailing out on a property store after the loop, though fixing that store alone changed nothing. With the kernel fixed, the patched `src/` was still +138 %.

Predator: the renderer didn't move, and pre-render got 5 % slower in eight pairs out of eight. A trace with the change in it showed the new function at 36 % of Pixi, about where the old one was. It runs; it just isn't faster. The queue it reads was written by pre-render on another core a moment earlier, so every cache line has to come over from that core no matter what order you ask for it in. In the kernel the data sits warm in the core's own cache, and order looks like everything. Reverted.

The query copy got thrown out too, more strangely. A per-element copy loop became one `TypedArray.set`: +21 % in the kernel even with the lists in shared memory like the engine has them. Predator regressed twice in a row, on workers that never run that copy. I ran an A/A sitting, the same code on both sides, to make sure the harness wasn't tilting things. It wasn't. I can't explain Q1, so it doesn't ship.

The painter's radix sort did the four histograms in one read of the keys and skipped any pass whose byte is the same for every key. Sprite keys are `round(y) * 128`, so the low byte never changes. That was +48 % in the kernel, identical order against a reference radix, and −2.9 % on the renderer in Predator, a hair under the line. It stays.

What's left needs tools that don't exist yet: a pre-render kernel built from the real worker, and a physics harness that can reach code living inside the Emscripten post-js. One idea, a faster sine for decoration sway, isn't a measurement question at all, because it changes the numbers you see on screen.

## Wednesday 30 September 2026 — The Trace Says Where, Predator Says Whether

I had a folder full of microbenchmarks and I no longer trusted most of them. Some measured hypotheses we had dropped weeks ago. Worse, a whole family of "campaign" runners worked by copying old snapshots of worker files on top of `src/`, running a scene, and copying them back. If a run crashed halfway, the working tree was left holding code nobody had written on purpose. The want was simple to say: a benchmark never edits the engine. It calls the real function, or the real worker, and it prints a number of operations per second. Then every optimization idea gets tested with that number first, and only then with a real scene.

So the first day was mostly deletion. Eight campaign folders, their runners, twenty-odd one-sitting A/B scripts, a test that copied files around. Their verdicts stayed in `HYPOTHESIS_LOG.md` and their code stayed in git history. What replaced them is small. A kernel imports the actual worker module in Node with a `self` stub, sends it the same `init` message the browser sends, and times the method on that instance, with a checksum of what it produced. A hypothesis lives inside the bench as an exact textual diff over the shipped method source, compiled in memory; if the anchor text no longer matches the engine, it throws instead of quietly measuring something else. Comparing against another revision means a git worktree in a sibling folder, never swapping files in the working tree.

That rule got tested the hard way. On Windows, `node_modules` in each worktree is a junction back to the real one, and `git worktree remove --force` follows junctions. It deleted every package from `@babel` to `f` in the main repo before I killed it. Now the junction is unlinked with `lstat` first, and the helper refuses to delete a worktree whose `node_modules` is a real directory.

### Reading the trace like a profiler, not a spreadsheet

The old trace summary counted samples per function. It could not say which thread, or how many milliseconds, or which line. The new parser streams the Chrome trace, weights every sample by the real time until the next one, splits by worker (`logic@…`, `spatial@…`, `preRender@…`), reports self and inclusive time with callers, and prints the hottest lines of each hot function with the source text next to them. A CPU-only capture preset brought the trace from 190 MB to 7 MB. One thing I could not fix: Chrome on Windows samples about every 630 µs no matter what interval you ask for.

That changed the conversation. Instead of "`_gensMatch` is 30 % of logic", the trace said "62 % of that function is this line", and the line was two `Map.get` calls per contact pair per frame.

### Contacts: a bug first, then two wins

While building a reference model for the contact flow, I found a real bug. `_applyContactBegin` stored the two body generations in the order Box2D sent the event, and the stay pass compared them in `(min, max)` order. When the event arrived as (larger id, smaller id) and one of the bodies had respawned, the pair was purged while the bodies were still touching: no stay, no exit, `isCollidingWith` false. It is fixed, and a test pins it.

Then the table itself. Tracked pairs moved from a `Set` plus two generation `Map`s to one `Map` from key to slot and four `Uint32Array` columns, deleted by swap. The stay pass walks columns and hashes nothing. The contact kernel, running the real `LogicWorker` on the pairs that actually touch in a captured Predator frame, went +84 % at contact density and +216 % in the dense regime. In Predator, logic went from 6.61 ms to 4.12 ms.

The second trace, taken after that, still had the same function at 19 % of logic, and the reason was sitting in plain sight. Predator runs three logic workers. Each one validated every pair every frame, but only fires callbacks for the third it owns. The other two thirds of the work existed so that `isCollidingWith` would answer correctly on any worker. Now the foreign pairs sit in a second table and are validated when someone asks, plus a sweep every 30 frames so the table does not grow. Kernel +73 %. Predator logic 4.43 ms to 3.87 ms, no pair of the eight worse.

### Audio: a full parking lot

The captured Predator frame had all 2048 audio slots busy. Every `play()` walked all of them doing `compareExchange`, found nothing, and dropped the sound. A CAS takes the cache line exclusive even when it fails, and three logic workers were doing it at once. Reading the slot with a plain `Atomics.load` before trying the CAS is the old test-and-test-and-set trick. Saturated with three threads: +53 %. Empty pool: 19 % slower, which is 37 ns becoming 46 ns, against microseconds saved when the pool is full. Predator logic −6.1 %.

### Spatial: one read, 29 %

The hottest line in the spatial worker was `candData[candBaseA] > 0`. Predator runs 1024 max neighbors and a neighbor tick interval of 15, so almost every entity takes the "skip this frame" branch, and that single read lands at the head of a 2 KB candidate row per entity. One cache miss per entity, sixteen thousand times a frame. A dense per-entity count array holds the same number. Spatial went from 6.12 ms to 5.13 ms. Inlining the circle bounds in `rebuildOwnedRows` won 13 % in the kernel and did not move Predator by a consistent 3 %; it stays as a kernel claim.

### The ones that lost

This part is the reason the method exists. Giving every `GameObject` component cache the same shape per class won 8 % in its kernel and made Predator logic 4.4 % slower, six pairs out of eight. The kernel had three synthetic classes; Predator has real ones. It was reverted. A specialized `packInstancedRows` without the branches that never change per call was 24 % slower: those branches always go the same way, and the branch predictor had already made them free. Swapping distance and index together inside `takeClosest`, instead of sorting a permutation, lost 4 to 6 %: moving two arrays costs more than one indirection. Hoisting two counters and two statics out of the spatial loop gained under 3 % and did not ship.

Physics was a diagnosis, not a fix. The trace showed thousands of samples in `_emscripten_get_now` and three Box2D threads at 100 %. A kernel counting WASM import calls per `step_world` found zero: the solver never asks for the time. The cost is the pthread pool spinning while it waits for work. That fix belongs in the Box2D build, not here.

### The method got corrected along the way, three times

The Predator gate runs A B A B, eight pairs of ten seconds against ten seconds, and watches every worker, not only the one the change touched. The first spatial sitting ran A before B every time, and every worker the change did not touch looked 2 to 6 % worse. Drift inside a pair always landed on B. The order is now counterbalanced. A regression also has to be consistent now, at least six of the eight pairs worse, because a +3 % median out of eight scattered pairs is noise.

One gate read +1.8 % and was wrong: the "before" copy of the file had been saved in the same batch as the edit and already contained half of the change. Baseline copies are saved in their own step now, and checked.

And at the very end, the kernel comparison against `HEAD` flagged `packInstancedRows` 11.9 % slower. The file had not changed. Five processes of the same code on the same tree gave 1875 to 2128 ops/s; one process per side cannot resolve 3 %. The comparison now runs five alternating rounds per side, takes medians, and also asks the rounds to agree: the new side has to win at least 23 of the 25 round-against-round comparisons. The same "11.9 % slower" comes out as a tie.

Predator also turned out not to be deterministic across two runs of the same commit, not in pose hashes and not in pixels. Its lockstep visual check only catches a black canvas. Behavior is locked by parity tests instead: the contact table is checked against a reference model on every pair, every frame, with respawns and deactivations.

After the campaign, the second trace had logic at about 305 busy ms per second, down from about 620, and spatial at about 335, down from 424. That was before the second contact change. The third trace, with it, has logic under 200.

### Against main

Then the whole branch against `main`, 24 commits back, which also carries the earlier pre-render, shadow and pack sessions. Every one of the 28 kernels runs on both sides. None is worse. Spatial is +36 %, the saturated audio claim +90 %, shadow stamping +41 %, decal premultiply +36 %. The contact kernel is +320 % and its checksum changed, which is exactly the bug fix and nothing else: I checked it against a build that has only the fix.

In Predator, eight counterbalanced pairs, every worker kind got cheaper and not a single pair went the other way. Logic went from 5.22 ms to 2.99 ms, spatial from 4.80 to 3.88, pre-render from 8.08 to 6.00, the renderer from 4.91 to 3.66. The load gate flagged the pair anyway, and it was right to. The branch also has the adaptive shadow caster budget, so it draws 20 % fewer casters than `main`. The renderer and pre-render numbers are partly less work, not only faster work. Logic and spatial never touch a caster.

The deopts I had lined up to chase next were gone. The `packInstancedRows` store that deopted 421 times in steady state deopts five times now, none of them steady, after this morning's change to that loop. The OSR exits in the neighbor search all land in the first two seconds while the world fills up. The CPU profile still shows where the time goes. The deopt log just doesn't show any of that time being wasted on deopts anymore.

## Friday 25 September 2026 — F5 Is Not Alt-Tab

The presenting path from 21 September kept the sim alive and only stopped the canvas. That is correct when you hide the tab. It is wrong when you hit F5. Burning Boxes is the scene that shows it: a 1000×750 fire lattice, Jacobi twenty times, vis-poly lights, OffscreenCanvas WebGPU in a worker. Play five seconds, refresh, Chrome is gone.

`visibilitychange` and `pagehide` used to do the same thing: store 0 on the SAB and post `presenting: false`. The worker then called `unconfigure()` on the swapchain. That call waits for the compute queue. Chrome is already tearing the document down. The GPU process never comes back.

They are split now. Hide writes the SAB immediately so the current frame can skip the rest of its submits, including `ComputeLayer.step` before `queue.submit`. The presenting post waits one turn. F5 fires `pagehide` in that same turn with `persisted === false`, cancels the post, and `terminate()`s every worker. No `unconfigure`. The bfcache case (`persisted`) still only stops presenting. Alt-tab still gets the unconfigure on the next turn, which is the TDR fix from before.

The demo found it again. The contract is in the engine: [WORKERS_ARCHITECTURE.md](../guide/WORKERS_ARCHITECTURE.md#presenting-vs-pause).

## Wednesday 23 September 2026 — The Sort Key Sits on a Pixel

A sprite's Y key was the raw pose times 128. Half a pixel of Box2D noise flipped two neighbors that had not crossed. `Math.round(pose.y) * 128` for sprites and Adobe pieces stops that. On the moving 300k grid, reinsert went from 205 to 1985 ops/s in the kernel because the jitter no longer counts as a change. Pixi stayed put: 23.8 ms to 24.4 ms, inside the 3% line. That is a bugfix, not a speed win.

A fractional entity id inside the pixel would have kept same-pixel ties stable when the queue repacks. It doubled Pixi (24.4 ms to 50.6 ms) and pre-render spent the window in the backpressure skip. The fraction is gone. Ties on one pixel stay ties.

Precomputing the float-to-ordinal once was 6.4% more ops/s in Node and 11.5% more expensive on Pixi (24.4 ms to 27.2 ms). The extra array is gone. Pixi's `Buffer.update` already uploads the same typed array. No copy to delete there.

Numbers: `tests/results/ysort-quantize/report.md` (not kept).

## Wednesday 23 September 2026 — One Hook, `onSpawned`

`setup()` is gone from `GameObject`. Pool construct no longer runs a lifecycle hook. Spawn still applies `spawnConfig` keys first, then `onSpawned`, then `syncMassFromCollider`. Same cadence as before, one name.

## Wednesday 23 September 2026 — Reinsert Is the Painter

`renderer.painterSort` is gone. `ySorting` is the only knob: on, reinsert (radix only when the slot set changes); off, no sort. Radix-every-frame and decimate were measurement knobs. They are not a public API. Predator no longer names a sort mode. Tree, Rock, and Barrel now call `setSprite` in `onSpawned`, so a recycled pool slot is visible again.

## Wednesday 23 September 2026 — Kill the Two-Pass

The GPU two-pass is gone. One painter, ENTITIES treated as a sprite layer, no `entitiesParticleBatch`, no `coverageMesh`, no `BATCH_DEPTH.SORT_KEY`. `renderer.painterSort: 'off'` now means reinsert. Predator no longer pins the old path.

What actually broke persist+Adobe was a write-index mismatch, not `_painterSameSet` and not Predator's shard count. `_type0PersistHit` used to approve a frame that still contained type 6, then `_writeType0PosesOnly` wrote at the collector index. Adobe expands one collector row into N emit rows, so those writes land on the wrong queue slots. Persist now returns false the moment type 6 is in the list. Predator itself has no Adobe; the leftover two-pass plus a hard alpha discard on the merged particle list is the more likely reason that scene needed `'off'`. Particles now share the blend batch (`alphaDiscard: false`).

`updateSpritesFromRenderQueue` and `updateCustomLayers` both call `_uploadSortedSprites`. `InstancedSpriteBatch.upload` / `_uploadPose` share `_beginUpload` / `_finishUpload`. Depth is always painter index. The second `maxItems` particle buffer is gone.

`painterShardedStressScene.js` already covers two pre-render workers. `painterAdobeStressScene.js` is the Adobe-piece sibling. Unit tests encode the persist type-6 guard and the missing two-pass symbols.

Headless smoke (`--src`, 3s/3s), no crash: `PainterSharded2WReinsertScene` renderer 1.109 ms at 60 FPS; Bichos 1.612 ms at 60; littleCity 0.529 ms at 60; `PainterAdobe2WReinsertScene` 1.184 ms at 60; Predator 26.708 ms renderer / 36 FPS (loaded, two pre-render workers, default reinsert). No demo currently opts a custom sprite layer into `ySorting` (they pin `false` or are TILEMAP); that path is the same `_uploadSortedSprites` call the unit tests already lock. Windowed pixel check still wanted.

## Wednesday 23 September 2026 — One Painter, Not Two

Predator still had `renderer.painterSort: 'off'` in its config, added the same day the reinsert default shipped, with no comment saying why. Deleted it to see what would happen. Sprites disappeared, swapped texture, drew at the wrong z-order — the exact class of bug the previous entry was supposed to have killed. Put the line back.

Traced the algorithm by hand first. `_painterSameSet` (now `painterSameSet` in `sortIndexByKey.js`) approves reusing last frame's order whenever the count matches and the slot-number set matches. Predator is the only Y-sorted scene running `preRender.numberOfPreRenderWorkers: 2` — each worker owns an entity-id block and writes its slice of the queue at a prefix computed fresh every frame from sibling counts. The published queue is always dense from zero, so two workers' counts can move in opposite directions and leave the total the same while every slot past the boundary holds something else. That felt like the bug. It is not, or at least not by itself: `reinsertChangedSlots` only asks whether a slot's key changed, not why, and a shard reshuffle changes the key at the boundary every time. Proved it with a unit test — dense set, same count, values reshuffled underneath, still lands sorted — and with a new stress scene, `painterShardedStressScene.js`, two pre-render workers and culling doing the reshuffling for real. No corruption in either.

Checked the other two things Predator has that the stress scenes never did. Adobe piece expansion — not applicable, Predator does not use `AdobeAnimComponent`. Particle sortKey scale — same `Y_SORT_K` as entities, not it either. Found something else on the way, unrelated: `Tree`, `Rock`, and `Barrel` set their sprite once in `setup()` and do nothing in `onSpawned()`. Pool recycle zeroes `spritesheetId` and `renderVisible` on every respawn, and nothing puts them back for those three. If any of them is ever destroyed and its slot reused, the new one is invisible forever. Predates this session, independent of `painterSort` — an invisible entity never reaches the queue, sorted or not — so it does not explain what reappeared, but it is real and it is not fixed.

Could not get further than that here. This sandbox has no GPU — WebGL and WebGPU both fall back to SwiftShader, and a full Predator boot (asset load plus the initial spawn) would not finish inside a two-minute budget. Even Balls, much lighter, needed over two minutes to reach 3504 of 9004 bodies. So the sharding half of the hypothesis is proven clean in isolation; the exact Predator regression — sharding plus decorations plus particles plus bullets plus glow plus lights, all sharing one painter-sorted list — is not proven either way.

Shipped the part that was unambiguous: the main queue and every Y-sorted custom layer now call the same four functions (`createPainterState`, `painterSameSet`, `radixPainterOrder`, `orderPainterSlots`), instead of custom layers being stuck on the old GPU depth path unconditionally while the main queue got the fix. `renderer.painterSort: 'off'` stays as a real fallback on both paths, not deleted — Predator is still using it, and deleting it before someone with a real GPU confirms `reinsert` is correct there would be trading a documented, working escape hatch for a codebase that only looks cleaner.

Numbers and the full trace: `tests/results/painter-shard-coverage/report.md` (not kept).

## Tuesday 22 September 2026 — Sprites Should Composite Like a PNG

Stacked bugs looked wrong. A soft edge, or a fire with real alpha, would show the background color in a fringe. Zoom made it obvious. The PNG itself was fine. The draw was not.

Y-sort used to stuff `sortKey` into GPU depth and, when the edge was transparent, draw the sprite twice. The almost-opaque core wrote Z. The rim blended in a second pass and did not. That is not how a PNG works. A PNG is source-over, back to front. Depth remembers one winner per pixel and forgets the sprite that should have been underneath. A linear sample on a hard-edged atlas invents alphas that were never in the file, and the 254/255 cut then threw those pixels out of the pass that paints. Sampling the whole atlas as nearest made the bugs crisp and broke everything that is actually a gradient: fire, and the radial glow on lights.

Sorting every index, every frame, on the Pixi worker, was the obvious fix and it lost. On 300k static sprites Pixi went from 15.2 ms to 26.2 ms. That pair stays dropped.

The version that stayed is smaller. With `ySorting`, entities, particles, decorations, bullets, and liquid share one list. Pixi keeps last frame's order and only pulls out the slots whose `sortKey` changed, then merges them back. One blend. No Z. No second mesh. Glow stays an ADD batch after that, because that blend cannot share the draw, but its own indices follow the same key.

On a moving grid of 300k, 10% crossing a neighbor every frame, that reinsert landed at 30.1 ms against the two-pass at 30.6 ms. The two-pass samples were 41.6 and 19.7, so this is a tie, not a speed win. A full radix on the same scene was 38.3 ms. Sorting only every third frame was 28.0 ms and draws a stale order in between, so it is not the default. `renderer.painterSort` can still force `off`, `radix`, or `decimate`. Unset, Y-sort means reinsert. No Y-sort means no sort. Bunny does not enter this path.

I tried rounding atlas frames and turning smoothing off on the pack blit, so nearest would not sit on a half pixel. It shifts every sheet that comes in with a fractional rect. Bichos and Predator already looked right without it. That rounding is gone.

Checked in the demos, zoomed, with the ground and without: Bichos and Predator both composite. Fire sits on the bugs the way a PNG would.

Numbers: `tests/results/sprite-painter/move-report.md` (not kept). The dropped full sort: `tests/results/sprite-painter/report.md` (not kept). Where the workers do it: [WORKERS_ARCHITECTURE.md](../guide/WORKERS_ARCHITECTURE.md).

## Monday 21 September 2026 — I Looked Away and the Tab Died

It kept happening that when I left the tab in Chrome and came back, a scene with a compute shader was hanging. The tab crashed. Not even the HTML elements worked. Burning Boxes: the fire lattice covers the whole world, Jacobi twenty times a frame, vis-poly lights on top. I would play for a minute, switch to Cursor or another tab, come back, hit F5, and Chrome was gone. The second time I did not even get to F5. I just returned and the tab was already dead. GPU memory was stuck at 51 MB the whole time, so it was not a leak filling up. It was the driver.

Pixi's ticker was still calling `getCurrentTexture` after Chrome had dropped the swapchain. I first tried skipping only the present. The worker kept submitting the fluid in the background. Same hang. `pause()` was the wrong button anyway. That is the debug freeze. It did not even stop Pixi — `usesCustomScheduler` left the ticker running. I did not want the boxes to freeze when I alt-tab. I wanted the canvas to stop touching the GPU.

So now there are two APIs. `pause` / `resume` stop every worker, and Pixi actually `ticker.stop()`s. `setPresenting` is just the compositor. Hidden tab or `pagehide` posts `{ presenting: false }` to the renderer only. Not `blur`: that also fired when I opened DevTools, and the canvas died while the tab was still in front. The queue still consumes so pre-render does not stall. Then nothing: no fire dispatch, no lighting RT, no swapchain. Visible or `pageshow` calls `rebindSurface` (WebGPU `configure` again; WebGL has no swapchain) and starts the ticker. `presentWhenHidden: false` is the default.

`device.lost` and `webglcontextlost` go through `reportError` if the driver comes back and the page is still alive. A TDR that kills the tab will never print. That is the browser.

The demo found it. The contract is in the engine: [WORKERS_ARCHITECTURE.md](../guide/WORKERS_ARCHITECTURE.md#presenting-vs-pause).

## Monday 21 September 2026 — 250k Bunnies, and the Sprite Shouldn't Step

The mark is 250k. Physics off, ids at 32, `skipCull`, `renderer.interpolation` on. Pre-render still packs every frame. When it falls behind the display, the picture should keep moving instead of hitching on the last queue.

`preRender.interpolation: true` blends the last two **physics** poses while packing. Bunny does not want it. No rigid bodies. It would only make the pack heavier.

`renderer.interpolation` is the display clock. Pre-render publishes two queues. Pixi stores both x,y on the entity instance (17 floats, and only when the flag is on — everyone else stays at 15). The shader mixes them with `uPoseAlpha`. A frame where the queue did not change does not walk the sprites again. It writes the alpha. Rotation, scale, tint, and the texture stay on the new queue. If the count changes, that frame snaps. Particles, glow, shadows, and custom layers are not in this.

The first time I looked, the selection box slid and the sprites stepped with the publish. The box was never the interpolation. Debug reads live `Transform`, and logic was still at 60. The sprites were the queue. The alpha was a `Float32Array`, and Pixi's WebGL path for an `f32` is `if (cv !== v) uniform1f`. Same array every frame, so it uploaded once and stuck. A new number each frame is a different `v`. Then they slide.

The 0.8/0.2 in the timer is not the blend. It only smooths how long the gap between publishes was. The blend is time since the last publish, divided by that gap. If pre-render keeps up with the display, there is no in-between frame and you will not see a mix. That is fine. The flag is for when it doesn't.

The Performance tab will still look wrong if you multiply the columns. Step is the last `update()`. FPS is how often the loop woke up, averaged over 60 samples, cheap backpressure skips included. Load is step against 16.7 ms. Twenty-four milliseconds next to 137 fps is those three clocks.

Headed, 175k, pre-render slower than the display: pixi median 4.29 ms down to 2.32 ms. The samples split into quiet frames and upload frames, so the spread is ugly. Pre-render's own step did not get cheaper. The mark is the 250k scene, not that row.

Numbers: `tests/results/renderer-interp/report.md` (not kept). Where it sits in the workers: [WORKERS_ARCHITECTURE.md](../guide/WORKERS_ARCHITECTURE.md).

## Sunday 20 September 2026 — I Wanted this.x = 10 Without a Solver

The want was a board game. Cards. A mark of 65k sprites that write `this.x` themselves. I did not want a Box2D world sitting next to that, compiling WASM, spinning a worker, and stepping an empty solver so a typed array could exist.

`config.physics.enabled` defaults true. That is still the engine. `false` is the opt-in: no `box2dWasm.js`, no physics worker, no HEAP bind. Pose is five float channels on a Weed SAB. `bindWeedPoseFields` runs once at init. After that `Transform.x` is a `Float32Array` and the hot loop does not ask which buffer it is. Pre-render already reads live `Transform` when pose publish never ticks — same path as a sprite with no `RigidBody`.

Queries and `explode` throw if you forgot the flag and called a solver API. `this.vx` stays unbound. A null-check on the getter would tax every scene that does use Box2D. Do not.

We measured it as Bunny Mark C against A. `logic0_STEP_MS` did not move a clean 3% — both sides were under the 3 ms floor. The win is boot, not the frame. The playable mark now sets the flag. Stress A still boots WASM beside the same `tickAll` so we can measure the tax. D, the solver moving the bunnies, stays dropped.

Contract: [PHYSICS.md](../guide/PHYSICS.md#scenes-without-box2d). Numbers: [HYPOTHESIS_LOG.md](./HYPOTHESIS_LOG.md), `tests/results/bunny-mover/report.md` (not kept).

## Saturday 19 September 2026 — The Tilemap Was Smooth. The Car Wasn't

The want was simple once the GID pages were in: drive a police car across a 50,000-pixel map at 1200 px/s and have the _car_ stay glued to the road. The background had just become honest — one camera matrix, no chunk stream. Then the sprite started hitching every four seconds, straight and fast, while the tilemap kept sliding.

Two `requestAnimationFrame` loops. Physics publishes a pose. Logic follows it. Pre-render packs the sprite from the same latch. When the clocks lap — 60 against something like 59.75 is about four seconds — physics skips a publish so it will not overwrite the slot pre-render is still reading. The sprite freezes on the last snapshot. `followEntity` did not. It kept easing the camera toward that frozen point. The tilemap is the camera. The car is the sprite. The world slid under a parked drawing.

Look-ahead had already learned this lesson: freeze HEAP velocity until pose xy actually publishes. The missing half was the pan. Logic now stamps the pose generation it latched. If `poseReady` has not moved, `followEntity` holds the camera and still stamps `followUsed` so pre-render's slide is a no-op. Next publish, both jump together. The ship in the terrain demo uses the same call. The contract lives in [PHYSICS.md](../guide/PHYSICS.md#display-pose-publish). The test is `followEntity holds pan when pose generation is unchanged`.

## Saturday 19 September 2026 — I Didn't Want a Tile Library

CarScene at full speed used to hitch every time `@pixi/tilemap` built another chunk. `CompositeTilemap.tile()` on the CPU, then the first GPU upload on present. `STEP_MS` stayed under a millisecond and the frame still stuttered, because the cost was not in `update()`. Every `tilemapCull` knob we tried moved the hitch; none of them deleted it.

The want was a Tiled map that is already a texture. Raw GIDs in the SAB — flags and all — packed once into RGBA8 pages, 2048 tiles on a side because that is WebGL2's portable max. One world-space quad per non-empty page. A shader that does `page UV → tile → texelFetch → atlas`, same contract in GLSL and WGSL. After create, the pixi worker only moves the parent container. Empty GID 0 discards. We do not raise the page size to `MAX_TEXTURE_SIZE`: carScene is 2082 tiles wide, and a 2082-wide NPOT page hitchs the driver the same way the chunks did.

`pixiTilemapModule.js` is gone. `tilemapCull.js` is gone. `config.renderer.tilemapCull` is ignored if a scene still sends it. The query API (`getTileId`, `hasTile`) did not change. The old Hyp 7 cull scratch is a measurement of a path that no longer exists; do not reimplement `listVisibleChunks`. Spec: [TILEMAP.md](../guide/TILEMAP.md).

## Friday 18 September 2026 — A Grid Is Not a Component

I wanted a world that is a field of cells, not ten thousand entities with an `x` and a `y`. Amount, material, a marching-squares mesh — that is one blob, sized by the map, shared with every worker. `Component` is the wrong shape. Components are SoA × `entityCount`. This is one SAB per class.

`SharedResource` is the name plus the schema. The scene declares it:

```js
static sharedResources = [
  [WorldGrid, { cells: { type: Float32Array, length: COLS * ROWS } }],
];
```

`WorldGrid.cells[i] = v` on main and on every worker after bind. No Atomics. No FieldView. One writer per field, same rule as Mouse. The subclass needs `static scriptUrl` or the worker cannot `import()` it and `bindFromInit` throws — better a boot failure than two threads writing the same cells. Pin the writer with `forceProcessOnLogicWorker` so `tick` does not stride across logic workers.

The destructible terrain demo is how this got tested: one `WorldGrid`, one manager forced onto a logic worker, carve and fall. The demo is not the product. The product is a typed array that is not pretending to be an entity. Layout: [MEMORY_STRUCTURE.md](../guide/MEMORY_STRUCTURE.md) §1b.

## Friday 18 September 2026 — One Body, Many Shapes

Worms-style dirt is not one box. It is an island: one rigid body, N convex polygons, and you replace the list when the player carves. The primary `Collider` slot is one shape. That was the whole API until this week.

`ColliderFixture` is a global pool (`physics.maxFixturePoolSize`, default 0 — opt in or the replace calls no-op). Intrusive list per entity. `replacePolygons` / `replacePolygonsFlat` / `clearFixtures`. WASM adds every fixture to the same body. Mass sums. Spatial uses a cheap oriented box so the grid does not transform every vertex; rays and `pointInCollider` stay tight and report `fixtureIndex` (−1 is the primary). MESH fill fans the fixtures, or the primary box / polygon / display octagon if the pool is empty. Light occluders still see only the primary. That is a known hole, not a forgotten one.

The terrain demo is the champion scene, not a special case inside the engine. Isolation work for the pool (MF1–MF5) is in [HYPOTHESIS_LOG.md](./HYPOTHESIS_LOG.md). The API is in [PHYSICS.md](../guide/PHYSICS.md).

## Monday 14 September 2026 (evening) — The Fire Was There. The Light Wasn't

The want was a drip of fire that lights the cave the same way a crate does. Burning Boxes already had the pieces: Q writes LiquidFun onto the fire compute layer, `lightIntensity` on the emit, a group splat ADD into `lightingRT`. The crates shoved. The compute fire showed up. The landscape stayed black. Turning the intensity from 50 to 5330 did nothing. The instinct was the shader, or a missing uniform, or to cheat and also splat Q onto oil. That last one is a demo hat pretending to be an engine fix.

The pack already refused to draw a slab unless `sqrtLightIntensity[gid] > 0`. Reach is `10 * sqrt(I)`, same helper as `LightEmitter`. Pixi and logic bind the groups SAB with `groupFlags` between `lastIndex` and `viscousScale`. The physics host bind skipped that column and still claimed it mirrored the util. Stamp wrote `I` and `sqrt(I)` by group id into physics columns 11–12. Pixi read those bytes as `angle` and `lightIntensity`. Column 13 — the one pack uses for radius — was never written. Always zero. Intensity could not save it.

One layout. Physics bind, init payload, `weedjsPost` `handleInit`. Then Q lights the rock wall. Oil stays caramel. Crate `LightEmitter` still does the crates.

The same afternoon, the sibling C tree was still compiling `box2d_wasm.*`. Weed had renamed everything to camelCase and loads `/src/box2d/box2dWasm.js`. The copy script papered over it by dropping both names into the engine folder. Glue camelCase still `locateFile("box2d_wasm.wasm")`. Two copies, they drift. `BOX2D_WEED_INTEGRATION` now emits `box2dWasm.js` / `.wasm`. Lab `build_wasm.bat` stays snake. Weed copies only camelCase. The leftover snake files in `src/box2d` are gone.

## Monday 14 September 2026 (later) — Don't Compute What Nobody Reads

Yesterday logic was cloning eight thousand Box2D contacts for a scene that never asked. The same pattern was still sitting in the other workers: physics copying the contact ring into a SAB nobody drained, the particle worker `hypot` of every dynamic body so `RigidBody.speed` would be fresh for readers that didn't exist, keyboard edge flags on spatial and pre-render, and balls asking spatial for neighbors they never looked at. The want was not a new system. It was to stop paying for opt-in features on scenes that never opted in. One hyp at a time. Headed bench, live `/src`, Predator as the guard — that scene has `CollisionListener` and it does read speed.

Physics still published every begin/end pair, `Atomics.load` on generation per endpoint, even when `anyTypeNeedsCollisions` was false. WASM still has to generate contacts. JS does not have to copy them. Scene now stamps `publishContactRing` from whether any registered type has `CollisionListener`. Balls is false. Predator stays true (Drop listens). The balls physics STEP did not move a clean −3%: BOX2D itself wandered by more than the afterStep copy is worth. Predator physics was flat. The skip still ships. A file that existed only to wrap `=== true` did not.

`RigidBody.speed` was the clearer win. Particle was walking every dynamic body, every frame, for a number Balls never reads. `GameObject.deriveSpeed` defaults false. Person, Boid, Car, CarPart, the flowfield walker, and Bug set it true — the types that already touched `this.speed` or `RigidBody.speed[i]`. Balls particle STEP went from 0.243 ms to 0.083 ms. Predator still derives, and its particle STEP did not go up. That is the contract: the scene that needs the number still gets it.

Keyboard and gamepad edges were running on every AbstractWorker, including the ones with `needsGameScripts = false`. Main already snapshots in `Scene.updateInternal`. Logic still needs the edges for `isPressed`. Spatial, particle, and pre-render do not. The call sat outside `STEP_MS`, so the benches could not show it. The skip is still the right site.

Balls had `visualRange = radius * 3` and never used the neighbor list. That is a demo hat, not an engine one. Spatial already `continue`s at `visualRange <= 0`. Setting the default to 0 dropped balls neighbor time from 5.3 ms to 0.87 ms, spatial STEP from 6.2 ms to 1.7 ms. Floor keeps a range. The pile looks the same.

One hyp did not ship. Particle writes `Grid.cellSleepingData` every frame. Production spatial does not read it — `SLEEP_NEIGHBOR_SKIPS` stays zero. The debug overlay **Sleep Cells** does. Skipping the write to save particle time would have lied to the overlay. Skipping it only on Balls would have been special-casing a demo inside the engine. Cancelled.

Sleep itself got a closer look because the magenta overlay flickered while the cyan cells looked right. They are not the same buffer. Entities sample live HEAP `RigidBody.sleeping` on a rAF that does not wait for `world.step`, and they also required `SpriteRenderer.isItOnScreen` with no AABB fallback — colliders already had one. HEAP pose tears during substeps; that is why display pose is double-buffered. Sleeping had no snapshot. Cells are a particle-worker aggregate, one bit per cell, viewport only. Writing `RigidBody.sleeping[i] = 0` from a predator FSM `onEnter` did not wake Box2D either. `addAcceleration` already does, and `applyForcesAndTorque` passes wake. Those HEAP pokes are gone. Despawn still clears the byte so a reused slot is not a stale 1. Mamushka far-LOD stays `setAwake`, not `rigidBody.static` — that would be a body-type change, frozen walls, welds as anchors. The overlay now uses the same `isOnScreen || viewport AABB` idea as colliders, and it pins the published pose.

Numbers in `tests/results/skip-work-hyps/`. The two that moved: particle hypot nobody asked for, and neighbor search for balls that never looked.

## Monday 14 September 2026 — One Name, Several Layers, and the Pool Stay Off the Hot Path

The want was the same sentence twice: a crate that draws on ENTITIES and still feeds fire, oil that splatters one layer and heats another, and a call site that says `layer: 'oil'` instead of `Layer.getId(...)` stuffed into a u8. One mask. Bits are layer ids. Omit the field and you land on ENTITIES. `setLayer('fire')` on a compute-only layer keeps the sprite where it belongs.

That comfort almost paid for itself in the worst currency this engine has. Every visible sprite walked `0..Layer.count` with two method calls per slot. Every compute pack walked the whole collider pool to find the handful that actually subscribed. The old dense feeder list was still allocated — SharedArrayBuffers, spinlocks, counts — and the helpers that filled it had been deleted when `layerId` became a mask. The infrastructure survived. The write path did not.

The list comes back as a diff on the mask, not a second API. Spawn and despawn write bits; add and remove run then, not every frame. Pack copies the live indices out from under the lock and walks that snapshot. Collect bit-scans `mask & _spriteQueueBits` instead of testing every layer id. On the collect microbench the old loop is 0.177 of the new one — five times the work for the same set. Sweep pack at 512 bodies went from 167 ms to 88 ms. The all-fed no-sweep case is a hair slower (copy plus lock when every body is already in the list) and that is the honest number: the win is a large pool and a small subscription, which is the scene, not the microbench that feeds everyone.

The compute stress bench had been shouting a 404 with no URL. Chromium does that. The missing file was `/demos/img/bola.png`, a demo texture, not an engine one. The bench now uses `_white`. The static server prints the path when something is actually gone.

## Sunday 13 September 2026 (evening) — The Random Was Working. That's Why It Lined Up

Two nights ago `Math.random()` got replaced with `rng()` across every demo, so nothing could quietly reintroduce the non-determinism the lockstep test had just killed. BallsScene was the first place it showed on screen: colors in bands, small balls on the left, big ones on the right. Swap `rng()` for `Math.random()` and the pile looked random again. The feeling was that the seeded generator was broken.

It wasn't. Mulberry32 was fine. Main and logic0 each built `seededRandom(123456)` — same seed, two closures, two copies of `t`. Spawn on main burns two draws for `x` and `y`, then posts the entity. `onSpawned` on the worker burns two draws for radius and tint. Floor never touches `rng()`, so both streams still sit at the start when the balls begin. Draw 1 on main is draw 1 on the worker. Radius is a linear function of X. Color is a function of spawn Y, and gravity keeps spawn-Y in the pile, so the bands survive.

`Math.random()` only looked honest because it is a different stream. The engine PRNG was being too faithful: one seed, cloned onto every thread, lockstepped by accident.

The want is that `rng()` is seeded, deterministic, and safe to call from whichever thread happens to own that bit of the spawn. Mixing the worker id into the seed is the smallest thing that holds. Main gets `'main'`. Logic0 gets `'logic0'`. Same scene seed, independent streams, same stream if you run it again. The demo did not need a workaround. The engine had been handing every worker the same dice.

## Sunday 13 September 2026 — Eight Thousand Balls, and Logic Doing Physics's Job

BallsScene on the overlay: eight thousand circles in a pile, physics working as hard as a pile that size should, and the **logic** worker sitting at sixteen milliseconds. Tick was five. Entity was a fifth of a millisecond. Rays were zero. The step was still sixteen. The expensive work wasn't in the meters.

The contract was already written down. If no type in the scene has `CollisionListener`, logic does not drain contacts. Zero Sets. Zero iteration. Balls and floors never opted in. The kill switch, `anyTypeNeedsCollisions`, was false. Then contact-hit rings landed. Physics always allocates `hitSab`. Logic always bound it. `useBox2dHits` became true on every scene, listening or not, and that boolean was ORed into the gate **without** the listener check that joint-breaks already had. One `true` reopened `processCollisionCallbacks()`, which still built the full pair Set — `previousCollisions`, a BigInt generation Map, `Atomics.load` on every live pair in the Stay pass — for every Box2D contact in the pile. Physics solving eight thousand overlapping circles is expected. Logic cloning that graph, on a scene that never asked for enter/stay/exit, is not.

The overlay had been making it worse on purpose. `GameEngine({ debug: true })` is the DebugUI. Fine timers are a profiler. They had been collapsed into one: opening the overlay forced `collectDetailedStats`, so every entity `tick` got two `performance.now()` calls around it. Eight thousand of those is not free, and the Tick chip was summing quantized crumbs into a number that looked like work. Overlay stays overlay. Profiler stays `debug: { collectDetailedStats: true }` on the scene that actually wants it.

And `Keyboard.m` in every ball tick was going through a Proxy: `in` check, `toLowerCase`, alias table, map lookup, for a key that never changes name. Comfort API. Not a hot-path tax. Getters get stamped once at `initialize()` now. `Keyboard.m` is a property read. `isDown('ArrowUp')` still normalizes, for the cases that need a string.

The demo did not break. The engine had quietly started doing physics's bookkeeping on the logic thread. The meters couldn't show it, because that work ran before the timers started.

## Friday 11 September 2026 (night) — Same Hundred Steps, Same Pixels

Once the test could actually run, it lied in a useful way at first. Two lockstep runs, `LiquidFun` and `OrientedBoxScene`, same hundred steps, same 16.67 ms each time — and the pixels didn't match. Not close. Different.

The instinct was to blame the obvious thing: Box2D's own solver runs four worker threads in production, and threads plus floating point is a classic recipe for "of course it's not deterministic." That instinct was wrong, and finding out why mattered more than the fix itself. `FindParticleContacts` — the part of LiquidFun that finds which particles are touching — was already splitting its work across worker threads and dumping each thread's contacts into its own bucket, then concatenating bucket 0, then 1, then 2, then 3. Same contacts, every run. Different order, depending on which thread happened to finish first that particular run. Addition in float32 is not associative. Walk the same list in a different order, get a very slightly different number, and a few frames later a puddle has drifted into a different puddle.

The fix wasn't turning multithreading off — production runs four Box2D worker threads and the test had to respect that, not weaken it into something that would never actually ship. The fix was bucketing by block of work instead of by which thread happened to grab it, so the merge order was always the same regardless of which thread finished when. Rebuilt the WASM, ran the lockstep suite again. `liquidfun`: zero of 921,600 pixels different. `lfstress`: zero of 921,600 pixels different. `Math.random()` got replaced with `rng()` across every demo the same night, so nothing else could quietly reintroduce the thing just fixed.

## Friday 11 September 2026 (afternoon) — Is the Engine Even Deterministic?

The idea, stated as a hypothesis and not a fact: run every worker at a fixed timestep, take a screenshot, run it again the exact same way, take another screenshot, and compare. If they ever came back all black, something broke the renderer in a way you couldn't miss. If they matched pixel for pixel, the engine was deterministic. "but that's a hypothesis i wanna confirm before writing these tests."

It did not go smoothly. A step got skipped without a report back, and got called out directly: "wait, is the engine deterministic? you didnt stop to tell me the report." Then a real moment of doubt about whether to keep going at all: "should we remove the extra code you introduced then? if we cannot make it work deterministically.. what do you think?" The answer was to try harder, not to walk away — a real test design, stated in plain terms: "scene init, make time not run. advance 16ms 100 times. take a screenshot." That is, almost word for word, the test that ended up shipping.

One more decision mattered as much as the test itself: Box2D running single-threaded is trivially deterministic, but that's not what ships. Production runs the multithreaded WASM, so the test had to run against that, threads and all — plus every shader-driven scene, LiquidFun and the water demo included. No shrinking the problem down to something easy to pass. Test the real configuration, or the test proves nothing.

## Thursday 10 September 2026 — Fire, and Both Hats at Once

A prototype sitting in a sibling folder, `box2d+fire_sim (lbm)`, showed a compute shader driving a fragment shader to make bodies actually burn. The want, stated with the project's whole ambition behind it: "i want to allow custom computeshaders in weedjs, no fallbacks, no backwards compatibility. we're building the best 2d web game engine on the planet."

And then the line that is this whole project's rule, said out loud in the moment it actually mattered: "i dont want WeedJS to have a built-in fire shader. I want to allow devs to put their own compute shaders. So we're wearing both hats now: change the engine AND create a new scene that uses compute shaders." The engine gets a real, generic compute-layer API — any dev's own WGSL, not a baked-in fire effect. The burning-boxes scene gets built on top of that API, as a demo proving the API is worth having, with `ignite()` as a method on a GameObject subclass that only exists in demo code. Neither hat worn instead of the other.

## Monday 31 August – Thursday 3 September 2026 — SIMD, Job Stealing, and a Number That Went the Wrong Way

A question that started the week, aimed straight at the part of LiquidFun still costing the most: "there's still a piece that isn't Structure-of-Arrays and isn't using SIMD — make a plan." That piece was the biggest remaining cost in the whole step.

A real architectural question followed it, about whether the machine was being asked to do too much at once: sixteen hardware threads, four already claimed by Box2D, more for LiquidFun, more still for collisions on top of whatever the browser's own workers needed — "I still don't want the CPU maxed out the whole time," just because it technically could be. That question led somewhere better than adding more threads: since Erin Catto's own Box2D already used job stealing to balance work across its pool, why not put LiquidFun's contact-finding into that same job system instead of giving it threads of its own. `liquidfun uses the job stealing system that box2d uses` shipped that week, one pool, shared, instead of two pools competing for the same cores.

Not everything that week landed clean. A SIMD pass on the SoA rewrite came back with a real, honest number moving the wrong way: "it runs, but it's worse — the stress scene went from 5 ms to 7 ms." The response wasn't to defend the work already done. "Revert all of it, then?" "Ok, go ahead." The wrong path was gone by the end of the session.

## Monday 24 August 2026 (evening) — Two Particle Systems, One Clean Line Between Them

The water shader experiment from the night before turns into a real property: texture scale on the emit call, controllable the same way every other sprite in this engine controls its texture. Then the split that had been overdue since the very first LiquidFun bug: `ParticleEmitter` stays exactly what it always was — WeedJS's own CPU particles. `LiquidFun` becomes its own class, its own surface — `LiquidFun.setGroupViscousScale`, and everything else that touches real physics-obeying particles, living apart from the system that never touched Box2D at all. Two particle systems. One clean line between where each one's API begins.

## Monday 24 August 2026 (afternoon) — The WASM Heap Was Already Shared Memory

While working out how to expose LiquidFun state to every worker, not just the main thread — the same comfort `Camera` and `Mouse` already had — a wrong assumption I'd been carrying finally got questioned: wait, is a WASM heap really not a `SharedArrayBuffer`? It is, when it's built with `shared: true`. There was never a reason to copy particle position and alpha out of it every frame. That one correction is the reason LiquidFun's pose today lives directly on the WASM heap instead of a second buffer somebody has to remember to keep in sync.

Before that: a real, curated decision about which of Google's original LiquidFun 1.1 features actually deserved a place here. Yes to `SplitParticleGroup`, `JoinParticleGroups`, contiguous group ranges, solid and rigid particle groups. No to color-mixing particles, repulsive and reactive particle flags, destroy-oldest-particle logic — features that exist in the original but didn't earn their keep in this engine. Not a port of everything Google ever shipped. A port of what this engine actually needed, checked line against line against the real source so nothing got left out by accident: "i feel you're not telling me things... what of google's architecture we're not respecting?"

## Monday 24 August 2026 (morning) — Dulce de Leche

`LiquidFunSystem.js` had a viscosity preset by then, and it wasn't behaving: "this dulce de leche thing, even tho i put a very very high strength is not acting viscous.. am i doing it right?" The want behind fixing it, in full: "i want the devs of my beloved weedjs to be able to have oil thin + thick dulce de leche, or even change the viscosity of a particle group as it melts. you dig? can we do that without fucking up liquid fun c that so far runs like a charm." Landed on per-group viscosity as the fast path, with per-particle melting kept as a real idea for later, not shipped yet because it wasn't clearly worth what it would cost.

Along the way: `getLiquidFunParticleGroups()` silently returning an empty array every time, a `RangeError` on a 256-length typed array that shouldn't have existed, and a real complaint about the API's own honesty — hiding viscosity behind a named material string instead of just exposing the number was, in so many words, "kinda stupid," because the people using this engine deserve full control with a clean surface, not a preset menu standing in the way.

## Sunday 23 – Monday 24 August 2026 — Real Interpolation, No C Changes Needed

A long fight with motion that never looked smooth no matter what got tried. Extrapolation felt wrong with gravity in the picture — it can't predict a collision that hasn't happened yet, so a falling particle would extrapolate straight through a floor it was about to hit. `fixedFPS` turned out to change the simulation's actual speed, not just how often it got sampled, which wasn't the intent at all. The fix, once found, didn't touch the C side at all: LiquidFun already tracked enough state that real interpolation was possible in JS, once the previous position was captured properly. Extrapolation got removed outright.

Lifespan for particles came right after — random-range lifetimes, `{min, max}` — and a real check against Google's own docs turned up something already built and simply unused: `SetParticleDestructionByAge`. The original engine had already solved this. The job was noticing that, not reinventing it a second time.

## Sunday 23 August 2026 (evening) — SIMD Must Work, or Fail Loud

Comparing this engine's LiquidFun port against Google's original for fidelity, then hunting every micro-optimization available. The real line on SIMD: "we should assume there is simd... i'm the only person who is gonna compile this code.. i dont wanna add extra complexity. Also, if it is not working, i wanna know it, and throw an error, and fix it. SIMD must work!" No silent scalar fallback pretending to be fine.

Built a real benchmark scene specifically so every optimization had a number attached to it — five thousand water particles, a thousand of something else, same scene, every time. Then the payoff, with the number still fresh: physics STEP_MS down to 2.860. Good enough to commit right there. And immediately after: the benchmark scene needed more particles, because 2.86 ms was already too fast to trust as a stress test. You don't get to celebrate a good number without making sure it's a number that will still mean something next week.

## Sunday 23 August 2026 (morning) — First Contact, and Catching Myself Reinventing the Wheel

The first real session with LiquidFun particles actually moving in WeedJS, and almost everything about it was wrong. Particles didn't collide with each other — spawn any number of them and they'd collapse into a single flat line the instant they touched the floor. They compressed far past where real water should — "i need thousands of particles to fill a little space." They climbed straight through walls while supposedly colliding with them. At three thousand particles, the physics step already blew past the 16.67 ms frame budget.

The moment that mattered most wasn't a bug, it was a question aimed at the process itself: "isn't this solved in the original liquid fun??? can't you take a look at the original repo? i feel you're trying to reinvent the wheel." Right alongside it, the architectural line that held for the rest of the project: WeedJS's own CPU particles (`ParticleComponent`, `particleWorker`) and these new LiquidFun particles are never the same system and must never get mixed — not the same gravity pass, not the same buffer, not the same anything, except where they're deliberately asked to touch.

## Tuesday 28 July 2026 (evening) — Gamepad, and Sleeping For Real

`GamePad` joins `Mouse` and `Keyboard` as a real input class, same shape, same comfort. Then back into Box2D's own C source to find the real sleep exports — `body_set_awake`, whether `b2World_EnableSleeping` exists — because sleeping had been broken since the migration and I wasn't going to fake it with a JS-side timer. A sequenced contact ring lands not long after, with joint revision tracking, so a stale contact from a body that already got despawned and reused can't wrongly fire a callback. By the time August 1st closes this stretch out: savegames work, `DecorationSpatial` replaces putting every blade of grass in the spatial hash, and the neighbor-reuse work from earlier in the year finally ships its real defaults.

## Tuesday 28 July 2026 (late afternoon) — Making It Small, and Breaking a Few More Things on the Way

Bundle size, for real this time: `wasm-opt` on the binary, gzip before the base64 encode, one debug build and one prod build, both landing in `dist/`. A real memory deep-dive, seeded by a small, sharp observation — entity IDs never go above 65,535, so why was anything using a wider type than `Uint16` to hold one. Found a jsDelivr URL that already worked for the published package and put it in the README, because apparently `import` from a CDN was already possible and nobody had written it down.

More crashes on the way: `Invalid typed array length: 100000` out of nowhere in the Pixi worker, a contact ring overrunning and clearing its own state mid-frame. Fixed both, then went hunting for dead code and backwards-compatibility shims with a very specific instruction to be ruthless about it — if it's not part of the real public API, and nothing uses it, delete it, don't preserve it out of politeness.

## Tuesday 28 July 2026 (afternoon) — Merged to Main, and a Real Fight About Attribution

Built the actual `dist` bundle with Box2D living inside it for the first time, fixed it so the shipped demo didn't quietly depend on files that only exist in the source tree. Then: "i wanna checkout to main, merge this branch into main, update the readme and all the docs, mentioning our awesome version of box2d 3.0 (better than the phaser one!)" That confidence was earned by that point, not posturing.

And a real, all-caps moment that afternoon, over Cursor stamping its own co-author line onto commits without asking: "I WANNA REMOVE CURSOR AGENT FROM THE COMMITS IN GITHUB! REMOVE IT FROM EVERYWHERE! SUCH A DISRESPECT." That anger is exactly why a rule exists in this repo, to this day, forbidding any tool from adding attribution to a commit that isn't mine.

## Tuesday 28 July 2026 (morning, continued) — Congrats, Man

Nine in the morning, after the crash gauntlet: Box2D 3.0 WASM, data-oriented, our own hooks and wrapper on top, SIMD, multithreaded. Actually integrated, actually running. Said it out loud to no one in particular and meant it. Then didn't just take that win at face value — ran a completely independent audit pass over the whole integration before calling it done, line by line, as if someone else had written it. Trust the work. Still double-check it before you ship it.

## Tuesday 28 July 2026 (early morning) — The Crash Gauntlet

`box2dWasm.js` failed to even load one of its own generated files. Fixed that, and hit `createDistanceJointLocal failed` — the WASM joint table, full. Fixed that, and hit the real wall: `Aborted(OOM)`, a genuine out-of-memory abort deep inside the WASM heap, with a native stack trace running through function indices instead of source lines. One demo had a pool of 50,000 `ConstraintBox` slots left over from before the fork — cut to 600, because nothing in that scene ever needed more than a few hundred at once, and the WASM heap doesn't forgive being asked for that much space by accident.

Fixed the heap properly after that: 512 MB, fixed, no growth allowed. And a question that mattered more than it looked like: if Box2D's own memory ever did grow, would WeedJS even notice — because growth means a new `ArrayBuffer` under the hood, and every existing typed-array view into the old one goes stale silently, still readable, just wrong. Locking the heap size sidestepped having to answer that for now. It's still an open question for later.

## Tuesday 28 July 2026 (before dawn) — No Backwards Compatibility, Change the Demo Files

Debug view stopped showing colliders and neighbors right after the migration — first thing to fix, because you can't trust what you can't see. Then a real decision, stated plainly: unify the whole engine to speak Box2D's own language. Box versus polygon stops being a real distinction, because Box2D already treats every box as a four-sided polygon. `drag` gets checked against Box2D's `frictionAir`. `Constraint` starts becoming `Joint` — `DistanceJoint`, `RevoluteJoint`, `WeldJoint` — matching Box2D's own vocabulary instead of a name WeedJS made up two years earlier. And the rule for all of it: "do not keep anything for backwards compatibility, change the demo files." No shim layer pretending the old names still worked.

## Tuesday 28 July 2026, 2:32 AM — Stop 0, Then I Test

Started from a plan and the WASM files already sitting in a sibling folder, copied in fresh that same night. The whole rollout ran one deliberate step at a time: "only do stop 0. then stop, i test, and i tell you when to continue." Position and velocity sync landed first, the most load-bearing piece — set a transform, set a velocity, watch it actually move. "it works fine!" Then: "go." The rest of the day built on that one working step.

## Monday 27 July 2026 — Should We Just Compile Box2D Into WASM?

Woke up still fighting yesterday's boxes and decided to stop guessing and copy the source. Box2D 3.0 doesn't use OBB the way I'd built it — it uses SAT against real polygons, capped at eight vertices per shape. Started rebuilding around that: a real polygon collider, matching Box2D's own limit, not my own invented shape.

It got worse before it got better. Boxes still vibrated and now dropped through the floor in `OrientedBoxScene`. Then a completely unrelated system broke as collateral damage — `BallsScene`, which had nothing to do with polygons at all, started letting balls crush into each other and fall through a floor that wasn't even rotating. Fixed that, and found the real cost of the day: the balls-scene physics worker was running at 18 FPS. It had been 50 the day before. Same scene, same entity count, just a slower solver underneath it now.

Kept pushing on the polygon rewrite anyway. Boxes stopped vibrating and started rotating in slow motion instead. Fixed that, and stacked boxes started drifting sideways until they spun off on their own. At every step, the same question kept coming back: why am I reinventing what Box2D 3.0 already solved.

So I asked straight out, no hedging: should we keep trying this? What if there were a real `PolygonCollider` component? Does any other engine even use Verlet the way I do? And the question underneath all of them — should we just compile Box2D 3.0 to WASM and make it write into our own SharedArrayBuffers instead of its own memory?

That question is the whole next chapter. I didn't know it yet, sitting there that evening, but I'd already half-decided.

## Saturday 25 – Sunday 26 July 2026 — Boxes That Would Not Stop Vibrating

Went digging through `phaser-box2d`'s own OBB and collision code, comparing it against mine, hoping to borrow enough to stop the shaking. It didn't go well. "boxes dont even stack now! and they vibrate all over." Tried again — the balls started vibrating too, and they'd been fine. "still very wrong!" Tried a third time and lost ground I'd already had: "now everything's broken and we're back to before, vibrating on the floor with no collisions." By the end of one session I was asking out loud whether the boxes' center of mass was even computed right, because nothing else explained what I was seeing.

In the middle of all that, a real fork in the road: given how complex OBB and friction were turning out to be, and given that the old circles-plus-constraints trick in `ConstraintBoxScene` was working _better_ than the real oriented boxes I was trying to build — what if I just kept not thinking about angular velocity at all? The problem with that answer was obvious too: circles don't stack. They're round. A box made of circles drifts until the curves find a compromise instead of sitting flat.

I asked which existing 2D engine would be easiest to bolt onto this architecture. The next evening, half-serious, I asked for a plan to bring in Rapier instead of fixing what I had.

## Friday 24 July 2026 — Oriented Boxes, and a Real Test of the Hypothesis

`OrientedBox` lands as a real collider shape. `Ray` gets extended to actually intersect one, `PhysicsDebugRenderer` can draw one. And right alongside it, in the same commit: `ConstraintBoxScene` — the old trick, circles held rigid by a distance constraint, the same approach the first car used back in February — built as a direct side-by-side against `OrientedBoxScene`. This was the actual test of the hypothesis: could constraints fake a rigid rectangle well enough that real oriented boxes were never necessary? Building both scenes at once was the only honest way to find out.

## Tuesday 9 June 2026 — Lock-Free, For Real This Time

The free list becomes a real Treiber stack — compare-and-swap push and pop, not just an atomic counter that could still race under the wrong conditions. The initial ordering gets an eight-way interleave, so when multiple cores start popping from it at once, they're not all fighting over the same handful of cache lines. `copyWithin` replaces manual array shifting for active-entity lists — same operation, no per-element loop.

Pixi stops re-walking the world every frame it doesn't need to — stale-frame gating, skip the pass entirely if nothing new arrived. The leftover sprite-animation code path gets removed outright, because the render queue already is the renderer; that second path was dead weight pretending to be a feature. Ray traversal, `PreRenderWorker`, `Grid`, `Mouse`, `Camera`, `Keyboard` all get touched the same evening — not one big idea, just a night of sanding down rough edges across the whole render and input path.

Then quiet. Six weeks pass before the next real push.

## Friday 15 May 2026 — Quiet

`jsconfig.json` lands, a small thing. Then nothing of real weight for months. Not every stretch of a project is a story. Some of it is just maintenance, breathing room, other things pulling focus. The next real push doesn't come until the physics rewrite in July.

## Sunday 3 May 2026 — A Platformer, Just to See

`PlatformerGameScene`, a real character controller, platforms you can stand on. Not because the engine needed a platformer — because if the public API can't hold up a genre this different from flocks and top-down shooters without fighting you, the API isn't actually general. First real type definitions land the same day, `weed.d.ts`, so an editor can tell you what a `GameObject` has before you guess and check the console.

## Friday 1 May 2026 — The Biggest Cleanup Day

One day, an enormous amount of ground covered. Visibility-polygon buffers get reworked in both Pixi and pre-render. Decorations get generation tracking and active-list locking so a decoration that's mid-despawn can't get reused out from under something still reading it. Query results get precomputed into real snapshots instead of recalculated live. `BulletPool` and `ParticleEmitter` warn you now instead of silently doing nothing when their pool runs dry — that used to just fail quiet, which is worse than crashing.

The first real unit tests show up in the repo today — `buildSceneMemoryUsageReport`, `preInitializeEntityTypeArrays`. Small, but it's the first time "does this function actually do what the comment says" gets checked by code instead of by eyeballing a demo.

And `Ray` grows up: `castWithInfo`, `castAll`, `linecast` all take an optional `out` parameter now. January's fix was an internal pool nobody outside `ray.js` could see. This is that same idea, made a real public contract — pass your own object in if you need a result to survive past the next Ray call, otherwise you're borrowing a shared one and you'd better use it immediately. Mass finally syncs properly between `Collider` and `RigidBody` instead of drifting apart. Version 0.5.2. A README that actually describes what's here now, not what was here in November.

## Friday 10 April 2026 — QuerySystem, Round Three

Third real pass on the query system this year. Precomputed queries get versioned, so active-entity tracking doesn't have to guess whether its cached answer is stale. `Keyboard` gets held-state and press counters, same idea `Mouse` got back in December. `BulletPool` and `BulletComponent` graduate into the public `WEED` namespace — they'd been living as demo code for months before that.

## Friday 3 April 2026 — Adobe Animate Joins the Engine

A whole new animation pipeline: characters authored in Adobe Animate, playable in the engine. Same day, immediately after landing it: a pass to eliminate per-frame allocations across the entire pipeline, with enough exclamation marks in the commit message that I clearly meant it. Ship the feature, then don't let it get away with being slow just because it's new.

## Wednesday 1 – Thursday 2 April 2026 — A Real Benchmark Harness, Decorations Get Parents

Playwright tracing and memory snapshots, wired into an actual benchmark script — thirty thousand lines of trace data from one run, because now there's a real record of what a frame costs instead of a feeling. Decorations become children of GameObjects, with real z-index, so a tree can move with whatever it's attached to instead of being stuck to world coordinates forever.

## Wednesday 25 – Saturday 28 March 2026 — Balls Were Escaping, and Headless Was Lying

A real bug — "balls were escaping!!" — chased down alongside manual loop-unrolling in the physics worker and real profiling on particle and physics timings. Then the bigger lesson, the one that changes how every benchmark gets run from here on: headless Chrome renders WebGL and WebGPU differently than a real window does. "we need to run it with headless:false, otherwise webgpu and webgl work differently." Ran the benchmarks headed after that. Called the headless results "headless torsos" in the commit right before, which in hindsight was a pretty good description of what they actually were — bodies with nothing real behind the numbers.

## Sunday 22 – Tuesday 24 March 2026 — Constraints Get Dense, Bodies Get Mass Properly

A dense array of active colliders, built once per frame, holding only the ones that actually have collision candidates — the comment I left on it says exactly why: "eliminating thousands of empty loop iterations in sub-stepping." Constraints get the same dense treatment. A distance-constraint stability fix. Mass initialization gets refactored so a dynamic body without a collider-derived mass defaults sanely instead of quietly being wrong. Sleeping comes back into the mix, clouds cast shadows, and the interleaved entity-position buffer that had come and gone before shows up again in the spatial worker — apparently that idea just keeps being worth revisiting.

## Sunday 15 – Monday 16 March 2026 — Layers Own Their Backgrounds, Collisions Get Layers and Masks

A real overhaul of how layers work: backgrounds belong to layers now, not scenes, and custom layers can route particles, decorations, bullets to themselves by `layerId`. `Collider` gets `collisionLayer` and `collisionMask`, and `Ray` takes the same mask, so you can finally ask "does this hit anything on this specific layer" instead of "does this hit anything, and I'll check the type myself after." `CameraInOutListener` so an entity can react to entering or leaving the viewport without polling `Camera` every tick. `Layer.alpha` synced across workers with atomics.

## Saturday 14 March 2026 — Visibility Polygons

The lighting system's fifth real form this year. Not a shader, not `LightEmitter`, not a projected blob — actual raycasted visibility polygons, `LightOccluder` as a component, so a light can be genuinely blocked by geometry instead of just fading with distance. "ok. we need another type of shadows," and this time it's the type that can hide behind a wall. Production builds start stubbing debug code out of the bundle entirely around the same time — the debug UI was never meant to ship.

## Friday 13 March 2026 (afternoon into evening) — One Debug-Draw API Instead of a Pile of Overlays

Raycast visualization used to be its own one-off thing. Replaced it with `DebugDraw` — lines, circles, text, real primitives, synced across threads so what you see matches what's actually happening on whichever worker owns the data, centralized on `Scene` instead of scattered wherever a raycast happened to need to show itself.

## Friday 13 March 2026 (morning) — Consolidating Debug, Hunting a NaN

`DebugUI` split into real submodules instead of one growing file. Browser hardening — no context menu on right-click, because a game shouldn't feel like a webpage. `Mouse` gets real press/release edge detection instead of just "is the button down right now." A NaN hunt in physics that took most of the morning. And max-acceleration properties stripped off of every entity that had one — `Ball`, `Boid`, `Box`, `Bug`, `CarPart`, all of them — because that cap had been fighting the physics more than helping it for a while.

## Wednesday 11 – Thursday 12 March 2026 — Layers With Shaders, and Waterrr

Custom layers can carry their own shader now, not just a look. `WaterAndBoxesScene` is the proof — `WaterBall` entities, a metaball fragment shader, collision-triggered particle bursts. This is a **look**, built entirely in demo code (`demos/gameObjects/waterBall.js`, a `.frag` file) — not LiquidFun, not real fluid physics. That's still months away. `RenderQueueLayout` lands the same window, so every custom layer computes its buffer size the same documented way instead of each one inventing its own math.

## Saturday 7 March 2026 — A Real Audio System

Audio queue, a scene-selection screen so you're not always booting straight into Predator, spatial sound, real metrics for audio in the debug UI. An FSM/tick-decimation bug caught and fixed. Canvas auto-resizes now instead of assuming a fixed size. And after a week of fighting the build pipeline across babel, webpack, and worker bundling: "bundle works fine!" — four words that took a lot longer to earn than they read.

## Tuesday 3 March 2026 — Self-Driving Cars on a Flowfield

A car can load an external, static flowfield and just follow it — no player, no input, the field does all the steering. First real README/philosophy pass on the project, and a new gif to go with it, because by now there's actually something worth showing someone in twenty seconds.

## Sunday 1 – Monday 2 March 2026 — Cars Get a Voice

AI-driven cars, tuned until they stop feeling like a boat. Sparks and smoke when they crash into something. And the first real sound effects on GameObjects — not a beep, actual audio tied to actual events.

## Wednesday 18 – Friday 27 February 2026 — Chasing a Flicker

Scene-unload memory leaks patched — `Grid`, `NavGrid`, `SpriteSheetRegistry` all get reset methods now, so switching scenes doesn't leave the last world's ghosts in memory. `Flash` loses its `Collider` entirely, so it stops paying spatial-hash rent it never needed to pay in the first place — it doesn't collide with anything, why was it in the grid. A `Car` class gets deleted outright, didn't survive contact with wherever the redesign was going. And the balls-scene flicker that had been bugging me finally gets traced down: a stale `visibleEntitiesData` buffer, one frame behind where it should be. Removed the buffer, went to direct visibility checks instead. Sometimes the fix for a flicker isn't a new system, it's deleting the one that was lying to you.

## Monday 16 February 2026 — Sun, and the First Car

`Sun` becomes a static class every worker can read from directly — one shared source of truth for shadow direction and the day/night cycle, instead of each worker guessing. `heightMultiplier` replaces `shadowRadius` for how tall a shadow gets cast.

And the first car. I didn't have oriented boxes yet — that's still five months away. So a car is two circles, `CarPart` front and back, joined by a `Constraint` distance-joint holding them a fixed distance apart. The sprite draws at their midpoint, rotated to the angle between the two circles. It looks like a rigid rectangle. It's actually two dots and a spring pretending to be rigid. Part of the hope was that this might just be enough — that constraints could fake rectangle physics well enough that I'd never need a real oriented box. Steering came right after: speed-sensitive, so it doesn't feel like a boat at any speed.

## Saturday 14 February 2026 — The Worker Born in January Gets Deleted

`nav_worker` — maybe a month old, built in January for pathfinding — removed outright. Its job folds into `particleWorker` and a brand new `preRenderWorker`, because it turns out pathfinding and shadow-queue building didn't need a whole dedicated thread to themselves. Real physics constraints land the same day — joints, cloth, something you can actually build a ragdoll or a rope out of. Render queues get double-buffered so `preRenderWorker` can write the next frame while `pixiWorker` is still reading the current one.

## Thursday 12 February 2026 — Any Worker Can Spawn Now

Atomic spawn and despawn through SAB-backed free lists. Before this, every spawn request had to route through worker 0 first, because that was the only one allowed to touch the free list safely. Now any worker can claim a slot atomically. One less thing that has to funnel through a single point.

## Wednesday 11 February 2026 — I Hate Synching Shit

Light glow sprites fold into the main particle container instead of needing their own separate one. Shadows stop disappearing the instant their caster walks offscreen. Job stealing ripped out of the spatial worker, in my own words: "i hate synching shit dedup in spatial worker." The dedup logic across workers cost more than the load balancing was worth. Flashes get fixed by removing flash logic from the particle worker entirely — it never belonged there, it belonged with `Flash` itself.

## Tuesday 10 February 2026 — 150 FPS Render, But Shadows Broke

`particleWorker` starts building the actual render queue that `pixiWorker` just consumes, instead of Pixi walking the whole entity list itself every frame. 150 FPS. Same commit: shadows broke. Spent the rest of the session rebuilding shadows on top of the new queue — entity type and index carried along with each item, a texture lookup added, the whole thing pre-sorted before it ever reaches Pixi. You don't get the speed for free. You get the speed, then you pay off what it broke.

## Monday 9 February 2026 — A Real Bundle

First real `dist` build. Then an ESM version alongside the UMD one. Then telling the minifier to stop mangling the names that other code needs to actually find at runtime.

## Friday 6 – Saturday 7 February 2026 — 130 to 150, Then 160 Without Touching Anything

The single densest GC day yet. `QuerySystem` caches subarray views instead of slicing fresh ones. Neighbor arrays become `Uint16Array`. `gameObjects` gets pre-allocated in `LogicWorker` so V8 never sees a sparse array. Collision keys get normalized so there's no pair cache to maintain at all — the inverse Cantor pairing function recovers both entity IDs straight from the key, no lookup, no cache. A texture-id typed array replaces a `Map` in the renderer. Visible lights get precomputed into two pools instead of walked fresh every frame.

The particle worker goes from 130 FPS to 150. Physics hits 160 on the exact same Predator demo, without touching anything, ten seconds after boot — sometimes the number moves because the JIT finally finished warming up, not because you did anything that day. Active-entity tracking goes from an O(N) full rebuild every frame to O(1) incremental updates on spawn/despawn, and the active list gets sorted, because it turns out the workers process a sorted list faster.

One optimization shipped and got reverted in this same window: skipping neighbor updates for sleeping entities. Looked free. Wasn't — stale `RigidBody` data on entities that had despawned and respawned was causing false positives. Left a note to come back to it once despawn actually clears component data instead of leaving it stale.

## Wednesday 4 February 2026 — Collision Candidates!!!

Neighbor search moves to a spiral pattern around each cell instead of a flat scan, with early returns once you've found enough. Then the real win: a collision-candidate list built once per frame and handed to the physics worker directly, instead of physics re-deriving who might be touching whom from scratch every substep. My own exclamation marks in the commit message, not mine to add.

## Wednesday 5 February 2026 — Flowfields That Know About Walls

Averaging a flowfield now actually accounts for unwalkable cells instead of blending straight through them like they weren't there. A nicer-looking tilemap the same evening, unrelated, just something that had been bothering me.

## Tuesday 3 February 2026 — STOP FUCKING AROUND WITH THE PHYSICS WORKER!

Earlier that day: `QuerySystem` gets real `SharedArrayBuffer` support, and the particle and physics workers start filtering to active entities only instead of walking the full list and checking a flag per entity. Small, real wins, the kind that don't need a story.

Then, that evening: spatial workers switched from interleaved row ownership (`row % totalWorkers`, so worker 0 gets rows 0, 4, 8, 12…) to block-based ownership — each worker owns a contiguous chunk of rows instead of scattered ones. The hypothesis: entities near each other in the world are more likely owned by the same worker, so fewer neighbor lookups have to cross worker boundaries. That one stuck.

Then, two hours later, this commit. The actual code change is nothing — one blank line in `physics_worker.js`. What really happened is in `todo.txt`: I deleted a whole paragraph I'd written to myself about Morton-code cell indexing for cache locality, turning `QuerySystem` into bitmasks instead of string keys, removing every division in favor of multiplication. No bug. No revert. I caught myself sketching next-level physics-worker research instead of shipping anything, and the commit message is me telling myself to stop.

## Sunday 1 February 2026 — Static Properties, After Decades

Neighbor search used to check a 3×3 box of grid cells around each entity — nine cells, including the far corners, even though the actual search area is a circle, not a square. Fixed it properly: `generateSymmetricalCirclePattern` precomputes a real circle-shaped list of cell offsets for every possible search radius, once, at startup, cached in a map. A second cache remembers which actual cell indices that shape points to for a given cell, so even the offset-to-index math only happens the first time.

A GC sweep across the particle, Pixi, logic, and nav workers — reusing sets and arrays instead of allocating fresh ones every frame. Separation force only kicks in when a soldier is idle, not constantly. And somewhere in the middle of all this, a small realization, exactly as written: "i think just now i understood why they are called static properties.. after decades of using them :P"

## Monday 2 February 2026 — Sleeping Bodies, Sleeping Cells

Bodies that stop simulating once they're not moving. Then, later the same day, cells themselves learn to sleep too — a whole region of the grid can stop doing work if nothing in it is active. A note to myself mid-session: "this is a commit to leave the physics worker alone for some time." Muzzle lines and a sway calculation land on the shooting side, unrelated, just because they were next on the list.

## Saturday 31 January 2026 — Mouse Stops Pretending to Be an Entity

Tick intervals staggered across entities so they don't all recompute the same thing on the same frame. `invertedMass` for collision response. Shooting. Punching. And Mouse, which became a GameObject back in December because that made the plumbing easier, stops being one — it wasn't the right fit, and the mapping-table lesson from a month ago made that obvious the moment I looked at it again. Month closes on a version bump.

## Tuesday 27 – Friday 30 January 2026 — Predator Becomes a Game

Loading entity layouts straight from JSON instead of hardcoding spawn points. Dropping and picking up items. Flowfield pathfinding that's actually nice to watch instead of just technically working. Decals stamped in multiply mode that can span more than one tile. People dying with a real death state, blood left behind where they fell. Soldiers running `FSM` behavior, checking line of sight with `Ray.cast` before they engage instead of just measuring distance. This is the week the demo stopped being a stress test and started being a thing you'd call a game, even a rough one.

## Sunday 18 – Friday 23 January 2026 — Giving Entities a Place to Navigate

`NavGrid`: A* and flowfield pathfinding, a smart cache, its own dedicated worker. My own commit message that day was three emoji long — `:O :D :(` — and honestly that's a more accurate changelog than most of what I write with actual words. DebugUI moves onto its own canvas so the Pixi worker isn't also running a UI on the side. A neighbor-count bug that had been wrong for even longer than the one two weeks ago finally, actually, gets fixed.

## Saturday 17 January 2026 — The Ancient Lockless Proverb

The payoff to that `Atomics.add` toy from back in November, in `sharedArrayBuffer_hack`. `Atomics.wait()` ripped out of the spatial workers, completely. Double-buffering instead — read from a stable buffer while the next one gets built in the background, one frame of latency traded for workers that never block on each other again. My commit message that day got a little theatrical about it, and I stand by every word.

Same day, smaller but it bugged me more: `Ray.castAll()` was building a fresh `{entityIndex, distance, hitX, hitY}` object per hit, every single call, and sorting a throwaway array on top of that. Fixed it the same way I fix everything now — a pool of hit objects that grows lazily and gets reused, `outHits[i]` written into instead of pushed, `.length` truncated to how many hits actually happened instead of the array being thrown away and rebuilt:

```js
let out = outHits[i];
if (!out) {
  out = { entityIndex: -1, distance: 0, hitX: 0, hitY: 0 };
  outHits[i] = out;
}
out.entityIndex = hit.entityIndex;
out.distance = hit.distance;
```

Same object, every call, after the first few grow the pool to size. `Ray.castAll` never has to ask the garbage collector for anything again.

## Thursday 15 – Friday 16 January 2026 — Shadows That Actually Look Right

Spatial worker stops resetting markers it doesn't need to reset every frame. Shaped shadows. Glows come back better than they were before I broke them in December. Fire and Rock show up as new entities, purely to give the shadow and lighting systems something harder to chew on. Ray gets new methods. Scattered helper functions finally start collecting into one `utils.js` instead of living wherever I happened to need them first.

## Tuesday 13 – Wednesday 14 January 2026 — Shipping It, Finally Fixing the Neighbor Bug

Flashes cast real shadows now, not just light. First real npm package — you can `npm install` this thing instead of cloning a repo and hoping. Light culling with a reusable pool so I stop allocating a lights array every frame just to throw it away. And a neighbor-count bug that had been quietly wrong for a while finally gets tracked down and fixed.

## Tuesday 13 January 2026 — Raycasts, and a Grid Class of Its Own

I didn't want a raycast worker. I wanted `Ray.cast()` to just be a static method any worker's entity tick could call directly, because the spatial grid already lives on a SharedArrayBuffer — no message, no round trip, just read the same memory `spatialWorker` already wrote:

```js
const hitEntityIndex = Ray.cast(fromX, fromY, toX, toY, maxDistance);
```

Underneath that one call: DDA — walk only the grid cells the ray line actually crosses, cell by cell, stepping toward whichever axis boundary is closer, instead of testing every entity in the world. `utils.js` picks up the real geometry underneath it, `rayCircleIntersect` and `rayBoxIntersect`. It wasn't cheap on allocation yet — every cell check that found something built a fresh `{entityIndex, distance}` object — but the traversal shape was right, and that's the part that's hard to get right. The allocation would get fixed later, once I actually felt it.

Same session: grid rebuilding moves onto the particle worker for load balancing, and neighbor lists get double-buffered — logic can read last frame's neighbors while spatial is still writing this frame's. Shadows still a little buggy. Less than before, in my own words that night.

## Monday 12 January 2026 — Ten Thousand Civilians, and Deleting December's Idea

I wanted a finite state machine that felt like writing a normal class, but stored its state the same way everything else in this engine stores state — flat, per-entity, in a typed array, not a JS object living somewhere on the heap.

The trick: `FSM` is itself a `Component`. That's it. That's the whole idea. It gets `state`, `time`, `nextState` as SoA arrays for free, the exact same machinery `Transform` and `RigidBody` already use — one entity, one row, no allocation per entity, no allocation per tick.

States themselves are classes, never instances — `onEnter` / `onUpdate` / `onExit` as static methods, looked up by a small integer index into an array of state classes, not by name, not through a map, every frame:

```js
class CivilianBehaviorFSM extends FSM {
  static states = { IDLE: IdleState, FLEEING: FleeingState };
  static initial = this.states.IDLE;
}
```

And transitions don't happen the instant you ask for them. `changeState(i, this.fsm.states.FLEEING)` just writes an index into `nextState[i]` — a request, not an action. The actual `onExit`/`onEnter` pair runs at the top of the _next_ tick, before that state's `onUpdate`. Queuing it that way means a state can never trigger its own exit mid-update by accident, and the write pattern stays exactly as boring and cache-friendly as every other array write in this engine.

Ten thousand civilians ran on it the same day, as the real test. Not ten. Ten thousand — because that's the number that tells you whether a state machine design actually holds at engine scale or just looks nice in a demo with five guys standing around.

And in the same session, almost as a coda: `MainThreadLogicHelper` — the whole "main thread as an extra logic worker" idea from December — deleted outright, nearly 500 lines gone. I never did solve the tab-focus throttling problem it ran into. Turns out I didn't need to. I just needed to stop needing it.

## Thursday 8 – Saturday 10 January 2026 — Decorations, Pools, and Never Showing 20,000 at Once

Decorations skip the spatial hash entirely — they don't move, they don't need neighbors, so why pay for it. Typed arrays for everything that still wasn't one. A real stats buffer instead of guessing. A `PIXI.Particle` pool, because the whole point is you're never rendering all 20,000 entities on screen at the same time, so stop pretending you need 20,000 live sprites. More GC reuse on collision result objects. `cantorPair` replaces inline pair-key math for neighbor lookups. Tilemap backgrounds land.

## Wednesday 7 January 2026 — Too Good to Be True

A spatial hash optimization that looked completely free — cut the visual range on lights, skip some neighbor work. It wasn't free. Something broke in a way that only showed up once you actually played with it, and I reverted the whole thing that same afternoon. My own words in the commit message still say it best.

## Monday 5 January 2026 — An API That's Easy to Write, and Expensive to Get Wrong

I wanted a query API that felt effortless to use in entity code and did real work underneath, without the person writing `tick()` ever having to think about it:

```js
const allPrey = query([RigidBody, PreyBehavior]);
```

That one line is pre-calculated at scene load and reads as an O(1) lookup at runtime — not a scan. `QuerySystem` is the whole reason that's true. Same day: Pixi starts interpolating poses whenever it's running faster than the physics worker, so a slow physics tick reads as smooth motion instead of stutter.

## Sunday 4 January 2026 — Tried a Shortcut, Walked It Back

Another GC pass through `GameObject` and the physics worker — fewer reads, less garbage, delta-time-scaled acceleration caps instead of hardcoded ones. Then, same evening, walking two of those changes straight back out: the time correction, the acceleration limit. Sometimes you ship the fix and the revert on the same day, and that's not failure, that's just how fast you can find out something was wrong.

## Friday 2 – Saturday 3 January 2026 — New Year, New Toys

Player and camera actually following each other, real friction, a proper `Camera` class. Boxes with colliders. The debug UI gets an eraser and a spawner — tools, not just readouts. Entities can spawn by class reference or by a plain string name, whichever's convenient at the call site. Small, useful things, the kind you only get around to once the big scary architecture work has a break in it.

## Monday 29 – Tuesday 30 December 2025 — A Real Flash, and a Real Scene

Two births the same night. `Flash.create()` — a real short-lived light, not a particle pretending to be one, and flashes that cast shadows too. Then, hours later: `Scene`. Well over a thousand lines that used to live loose inside `gameEngine.js`, wired by hand in an HTML file every time, moved into an actual class you load — `PredatorScene`, `BallsScene`. You stop copy-pasting boot sequences and start writing a scene. The next evening: folders reorganized, `loadScene` gets smarter, tile backgrounds get a scale knob.

## Thursday 18 December 2025 — Let the Particle Worker Carry Its Own Weight

One focused commit. Angle and linear speed move onto the particle worker, since it already owns everything else about how a thing looks and moves on screen. The physics worker gets lighter, and it's the right worker for that job anyway — physics should care about forces, not about which way a sprite is facing.

## Monday 15 December 2025 — Can the Main Thread Pull Its Own Weight?

Dense day. The shader does the whole look now — no more tint as a crutch underneath it. `MainThreadLogicHelper` shows up: the main thread becomes an extra logic worker too, four hundred lines of it, with one catch I had to account for immediately — if the tab isn't focused, the browser throttles `requestAnimationFrame` right down, so that "worker" just stops ticking while you're not looking at it. Visibility and screen-position math move onto the particle worker, because it had room to spare and physics didn't. Drawcalls get watched. Light glows show up by the end of the night.

## Friday 12 – Saturday 13 December 2025 — Shadows That Actually Follow the Light

Light formula refined, every component gets an `active` flag. Then I actually sat down with the profiler and went looking for garbage collection pauses, and found two real ones. `particleWorker` was building a brand-new camera-bounds object, every single frame, just to check what's on screen — so I gave it one scratch object, `_cameraBounds`, and started writing into the same one instead. `pixiWorker` was worse: every frame it built a fresh array and a fresh `{entityId, sprite, y}` object per visible sprite, just to sort them by depth — so that became `_ySortPool`, a pool of objects reused frame to frame, only truncated to the active count before sorting.

Then the big one: projected shadows, wired into the real rendering pipeline this time, not a test file. `ShadowCaster` as a component. The trick is a rotation, not a flip — point the shadow sprite away from the light with `atan2`, then stretch it, width from the caster's radius, length growing the farther the light is:

```js
const angle = Math.atan2(dy, dx);
shadowRotation[shadowIdx] = angle - Math.PI / 2; // FIXED: was + PI/2, now - PI/2
shadowScaleX[shadowIdx] = widthScale;
shadowScaleY[shadowIdx] = lengthScale; // 0.8 to 2.3, based on distance from light
```

Had that sign backwards once, shadows pointing the wrong way. Still a little slow. Still a little to go, in my own words that night.

## Thursday 11 December 2025 — Lights and Decals, Proven Alone Before Proven for Real

Decals that actually stick to the ground and don't look wrong when they do. And lights — but tested first in an isolated `tests/shader.html`, five hundred lines of nothing but the shader itself, before any of it touched the real pipeline. Only after that held up: a real `LightEmitter` component and a `tallLight` demo entity to hang it on.

## Monday 8 December 2025 — The Particle System Gets Its Own Worker

Quick warm-up first: `rng()` and seeded random tried out in the demos, Pixi upgraded to v8. Then the real event, same evening: `ParticleEmitter`, `ParticleComponent`, and a brand-new `particleWorker` — a whole separate system, but built from the start to Y-sort and render exactly like everything else, not bolted on as a second pipeline nobody trusts. First real use: blood particles on `Predator`.

## Friday 5 – Saturday 6 December 2025 — The Indices Don't Match. Why Am I Even Mapping Them?

Made Mouse a GameObject, and right after that, indices started mismatching. I could have patched around it. Instead I asked why there was a mapping layer between an entity and its data at all. There wasn't a good reason. Ripped the whole thing out — entity indices are just absolute now, no lookup table anywhere in the engine. That commit message has more exclamation marks than any other I've ever written, and I meant every one of them.

Same run: `entityType` moved into `Transform` where it belonged, the texture packer got loud about warnings instead of failing quietly, the first real bundle came out the other side, and boids and prey finally shared a scene without stepping on each other.

## Thursday 4 December 2025 — 15,000 Prey and a Debug UI Worth Looking At

Reworked the spatial worker and got back to 20 FPS with 15,000 prey on screen — a number I'd lost a few days earlier and wanted back. Classes resolve their own asset URLs automatically now, spawn configs got simpler, and the debug UI stopped being an afterthought. First one I actually wanted to leave open while I worked.

## Monday 1 December 2025 — Input as a Class, Finally

`Mouse` and `Keyboard` became real classes instead of scattered event listeners. Anchors on sprites so rotation doesn't happen around the wrong corner. Animations map by name now, not by index — the kind of thing that seems small until you've debugged an off-by-one in a spritesheet at 1 AM one too many times.

## Sunday 30 November 2025 — No Barriers, and Ten Thousand Balls Sorted Themselves

Busy night. Pixi's particle containers came in, Y-sorting became a real property instead of a hack, and 10,000 balls ran clean.

Then the bigger thing: multiple logic workers, splitting entities across them. And barely more than an hour later, ripping out the barriers between them — no waiting, no lockstep, each worker just runs. That's not a performance tweak, that's the actual philosophy this engine still runs on today, and it landed as real code this one night. A texture packer that keeps sprite names alive through the pipeline came out of the same session.

## Thursday 27 November 2025 — 3 FPS, Then 60

Got predator and prey running together for the first time, and the frame rate fell off a cliff. 3 FPS. Stripped fields nobody was reading, moved getters and setters onto actual component instances instead of poking raw arrays everywhere — and by the end of the night, 60 FPS, with `Flocking` as the first custom component I ever wrote for this engine.

## Wednesday 26 November 2025 — The Component Owns the Memory Now

This is the one that mattered more than I understood at the time. `Component`, and right alongside it: `Collider`, `RigidBody`, `SpriteRenderer`, `Transform`. Each one owns its own SharedArrayBuffer and its own properties instead of the entity holding everything. That split is still exactly how the engine is shaped now. Everything since has been built on top of this one commit.

## Sunday 23 November 2025 — The Container Was the Bottleneck

Every GameObject had been holding a Pixi container, because that felt like the natural place to put "the thing you render." Ripped them out. Same scene, same entity count: 38 FPS became 50. The abstraction that felt free wasn't.

## Friday 21 – Saturday 22 November 2025 — Verlet Should Be Simple. It Wasn't.

Built a whole new physics worker around Verlet integration — position and previous-position, velocity implicit, the same trick from `ropeball` years earlier, except now it had to live inside this engine's component system. First night, it didn't work, and I said so in the commit message and went to bed. Came back the next evening and pushed through it across the physics worker, the spatial worker, and both demo entities that depend on it. It worked.

## Thursday 20 – Friday 21 November 2025 — Let the Renderer Trust What Spatial Already Knows

The spatial worker already figures out which entities are near the camera every frame. Why was the renderer asking that question again on its own? Made spatial flag on-screen entities directly so the renderer just reads the flag. Auto-getters landed on every entity class for the logic worker. Squared distance got precalculated once instead of recomputed everywhere. Spawn and remove finally worked for real, and separation force moved into the physics worker where it belonged.

## Tuesday 18 November 2025 — Only One Loop

Animated sprites work tonight, `spriteConfig` gets standardized, and the moral of the whole session, in my own words at 4 AM: "only one loop!" If you're iterating the same entities twice for two different reasons, you already lost. Life mapped straight to tint after that, so you could watch the simulation dying in real time instead of just trusting a number.

## Monday 17 November 2025 — Predator, Prey, and the First Real Cleanup

Cleaned up the entity classes so adding a new one didn't feel like a chore, and `Predator` and `Prey` showed up as the first real tests of whether any of this actually worked as an engine, not just a flock. Later that same day: split things into a proper `lib/` folder, stopped registering classes nobody ever instantiates, and circle-vs-circle collision finally landed. Small day on paper. Everything after this assumed these pieces existed.

## Sunday 16 November 2025 — Six Threads to Light a Candle

I got greedy. Not just a light shader — a whole extra worker, `lighting_worker.js`, doing real physics: lumens over distance squared, the actual inverse-square falloff, like light works in real life. A `Candle` entity that flickers. A fragment shader in `pixiWorker` waiting for tints from all of it. I even wrote three design docs before I was done, because I could already see the shape of it in my head and wanted to get it down before I lost it.

And then it just did not work. I was standardizing buffers everywhere else in the engine that same night, and something in that broke it, in a way I never actually figured out. There's a commit that says "the lighting system doesnt work," and not long after, one that says "no more lights, for now" — and the whole thing is gone. The worker, the entity, all three docs. Deleted like it was never there.

That stung a little. But it taught me something real too: I can design a system before I understand the plumbing under it, and the plumbing will let me know when it's not ready. Lights would come back. Just not that night.

## Sunday 16 November 2025 — Back to Pixi, and a Skeleton Every Worker Can Share

Woke up, looked at the Three.js renderer from the night before, and went back to Pixi. Tried a shader-based Pixi worker on the way there too — built it, ran it, and knew immediately: don't want it. Left it in the repo anyway.

Then the real thing: `abstractWorker.js`. Init, pause, resume — one shape that every worker in this engine would extend from now on, instead of each one reinventing its own boot sequence. The Three.js renderer and the shader-Pixi experiment got moved out into their own folder instead of deleted. Wasn't ready to throw that work away, just ready to stop looking at it every day.

## Saturday 15 November 2025 — A Repo, a GameObject, and Fifty Thousand Boids

This repo already had leftover files in it from the SharedArrayBuffer hack — must have started it from that same scratch space. Cleaned that out, dropped in a `vercel.json`, and realized: wait, this one's actually wired to Vercel. So I pasted the whole `render_from_webworkers` prototype in — `GameFramework`, all four workers, the whole Pixi library file — just to see something alive on a real URL instead of `localhost`. That's the moment this stopped being a folder on my machine.

A few hours later, `gameFramework.js` became `gameEngine.js`, and inside it: a real `GameObject` class for the first time. Not much to it yet, but it was the first shape that said "this is an entity," not "this is an index into an array, good luck."

Then I just wanted to see something break. Kept raising the boid count until it didn't — fifty thousand of them, fleeing the mouse, and nothing gave. Tried rendering all of it with a Three.js `InstancedMesh` in its own worker, one draw call for the whole flock, just because I could. It worked. That feeling, that a browser tab can hold fifty thousand moving things and keep breathing, is the whole reason I kept going.

## Saturday 15 November 2025 — Can I Get SharedArrayBuffer Somewhere I Don't Control the Server?

A string of small commits, one right after another, all rewriting the same two files. GitHub Pages won't let you set response headers, so the trick has to happen client-side — a service worker that intercepts every fetch and stamps the isolation headers onto the response before the browser sees it, then forces one reload once it takes control.

The demo itself was a toy — a few workers hammering `Atomics.add` on a shared array, just to prove the isolation actually took.

That same afternoon, WeedJS got its own repo on Vercel. This was the last thing I checked before starting the real thing.

## Friday 14 November 2025 — Can I Stop Wiring Buffers by Hand Every Time?

Every prototype so far started the same way: create the workers, build the buffers, post the init message, wire the ports, by hand, again. `GameFramework` is the first time that setup itself became an API instead of a copy-pasted boot sequence — one class, config in, workers and shared buffers out.

## Thursday 13 November 2025 — No Boid Object, No Wall Around the World

`node server.js` learns to send the two isolation headers. That's the whole trick — and `SharedArrayBuffer` stops throwing. No more transferring a buffer back and forth between workers. One buffer. Both workers hold a view of it, at the same time, always.

Then `class Boid` is gone. Position, velocity, rotation — each one its own typed array, Structure of Arrays instead of a pile of objects. Same night: 35,000 boids. Then a camera you can pan and zoom, and culling right behind it, because the two only make sense together — once the world is bigger than the screen, you need a way to move the view and a way to stop drawing what it can't see.

## Wednesday 12 November 2025 — Is the Worker Architecture Actually Faster, or Does It Just Feel That Way?

Ten days of an experiment that didn't survive, gone in this one commit. What replaced it: `main_thread.js`, a real toggle. Same `Boid` code, same everything, just workers on or off, so the worker version finally had something honest to be measured against instead of a vibe.

And the sprites stopped snapping. Position used to just jump straight to the new value the instant it arrived. Now it blends toward it a little at a time. The logic worker ticks slower than Pixi renders; that blend is what hides the gap from the eye.

## Sunday 2 November 2025 — Can Two Workers Talk Without the Main Thread in the Middle?

New scratch folder, `render_from_webworkers_and_multithreading`. Twelve hundred boids, still plain objects with a naive neighbor loop — the win tonight isn't the algorithm, it's the wiring.

Built a `MessageChannel` on the main thread, then immediately gave both of its ports away — one into the logic worker, one into the Pixi worker. Now they talk to each other, directly. The main thread just handed out a canvas and got out of the way.

Double-buffered arrays for position, rotation, scale, transferred — not copied — straight from one worker to the other every frame, with a flag so logic never outruns the buffer Pixi is still drawing from.

The main thread renders nothing and touches no boid data. It's not "free" the way `_webworkers` was free. It's not even in the conversation.

## Thursday 28 April 2022 — Can Physics Run on Its Own Clock, Away from the Screen?

Before there was any engine, there was `ropeball`. Ten thousand circles, and a question: can the physics live somewhere the render loop can't touch it, and still look smooth?

`RopeBallEngine` runs on Verlet integration — no velocity field anywhere, just current position and previous position. Velocity is just the difference between the two, implicit, free. Collisions get resolved by nudging positions directly, not by pushing forces around.

Ten thousand balls means naive collision checking is out of the question, so the world becomes a grid of chunks, and each ball only checks the balls in its own chunk and the ones next door.

The physics worker runs its own interval, on its own schedule, completely separate from whatever the main thread's render loop is doing. The main thread keeps the last two frames of positions and interpolates between them, so the screen can paint faster than physics ticks. Physics at 60, paint at whatever the monitor wants.

That interpolation trick is one I'd carry into every worker architecture after this. Physics doesn't have to run at render rate. It just has to leave enough breadcrumbs for render to fake the rest.

## Saturday 8 April 2023 — Can Code Run Without Freezing the Page?

I had a scratch folder called `_webworkers`. No framework, no plan, just a question: if I run something heavy, does the page have to freeze while it runs?

Web Workers were the answer. `worker.js` is where I proved it — a pool of them, sitting idle until I hand one a job. Whichever worker is free gets marked busy and shipped a function, literally stringified and `eval`'d on the other side. Ugly, but it proved the point: the main thread asked a question, a second thread answered it, and the page never stopped painting.

That's the whole engine, in embryo. Years before there was any GameObject or SharedArrayBuffer, there was just: the CPU has more than one lane, and JavaScript can use more than one of them.

## Saturday 11 January 2025 — Can a Worker Keep Its Own Clock?

Almost two years later I came back to that same folder and asked a different question. So far every worker had been a function-in, result-out box — the main thread decided when it ran. What if the worker just kept its own time?

`interval_worker.js` runs its render loop inside the worker itself. Not triggered from outside, not polled — the worker has its own clock and posts a frame back on its own schedule. That's a different animal from a job queue. That's a thread that lives.

Still posting an array of plain objects every frame, one per boid-to-be. Hadn't learned yet that was expensive. That lesson was next.
