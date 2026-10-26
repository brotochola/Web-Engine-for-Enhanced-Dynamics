# ED-39: scene load phases

**2026-10-26.** How long a full scene load takes, phase by phase, so the fast swap (ED-35 in
`VISUAL_EDITOR_PLAN.md`) knows which phases it skips and what they cost. Measurement only: no
engine code changed.

## Protocol

- Script: `tests/bench/sceneLoadPhases.mjs`. One headless Chromium page (the integrated benchmark
  page, source tree, `?src=1`), one `GameEngine` with `debug: false`, the scene loaded six times in
  a row. The first load is the cold one a player sees on opening the game (modules and WASM
  compiled, assets fetched for the first time). The other five are scene changes inside a running
  game, which is what the fast swap replaces. Each load runs 2 s before the next, so every warm load
  also pays the previous scene's teardown.
- Phases come from `loadScene`'s `onProgress` stages, from the scene's own hooks wrapped on the
  page's copy of the scene module (`preload`, `create`, `createNewGame`, `_flushCreateSpawns`, the
  previous scene's `destroy`) and `Layer.applyConfiguredContent`, and from the renderer's first
  published frame (frame totals, slot `renderer`). The workers import their own copy of the module,
  so nothing they run changed, and `src/` has no marks.
- Each phase is the time from the event before it to its own end. The asset stages (`adobe` to
  `tilemaps`) run while the workers start, so they are slices of that interval, not extra time.
- The machine was otherwise idle (no other benchmark running). Headless timings; a headed page with
  the debug UI adds its own setup.

## Results

Milliseconds. Warm: median of five, [min..max].

| Phase | Predator cold | Predator warm | littleCity cold | littleCity warm | Fast swap |
| --- | ---: | ---: | ---: | ---: | --- |
| previous scene's `destroy` | – | 5.6 | – | 5.0 | replaced by the clear |
| audio worklet | 7.8 | 4.0 [2.3..9.6] | 3.7 | 1.1 [0.6..3.0] | skips |
| shared buffers | 425.0 | 537.4 [413.2..684.7] | 104.4 | 229.7 [213.5..289.7] | skips |
| assets (Adobe, flowfields, shaders, sounds, atlas, tilemaps) | 294.7 | 264.0 | 380.9 | 663.8 | skips |
| workers ready (rest of the interval) | 1585.5 | 1501.7 [1352.8..3363.1] | 2024.6 | 1816.8 [1750.5..1977.1] | skips |
| page instances, `Layer.applyConfiguredContent` | 78.7 | 58.7 | 40.5 | 21.5 | skips |
| `preload` | 0.0 | 0.0 | 100.1 | 21.9 [19.6..82.0] | runs |
| `create` | 27.9 | 34.2 [16.2..44.1] | 0.1 | 0.1 | runs |
| `createNewGame` | 32.6 | 20.2 [12.2..21.1] | 0.0 | 0.0 | runs |
| `_flushCreateSpawns` | 201.2 | 228.0 [179.8..264.2] | 91.6 | 108.6 [80.3..111.6] | runs |
| start, then `transitionCooldown` | 103.9 | 110.4 [103.9..112.0] | 101.4 | 101.9 [100.3..107.2] | runs (see below) |
| first rendered frame after `loadScene` returns | 0.4 | 0.1 [0.1..14.0] | 6.5 | 0.1 | – |
| **Total** | **2758** | **2824 [2535..4770]** | **2854** | **3001 [2799..3403]** | |

Rows that group several stages (the teardown, assets, page instances and layers) show the sum of their stages' medians, without a range.

## What the fast swap skips

- **Predator:** the skipped phases are about **2.37 s** of a 2.82 s warm load (audio, buffers,
  assets, workers, layers content). What stays is `create`, `createNewGame` and the spawn flush,
  about 0.28 s, plus the clear that replaces `destroy`.
- **littleCity:** about **2.73 s** of 3.00 s is skipped; what stays is `preload` and the spawn
  flush, about 0.13 s.
- **Workers ready** is the biggest phase in both scenes (1.5 to 1.8 s warm): worker start, module
  imports in each worker, and the WASM memories and `engine.wasm` instances made per memory. A fast
  swap keeps all of them. **Shared buffers** is next (0.2 to 0.5 s).
- **`transitionCooldown` (100 ms by default)** is a wait at the end of `loadScene`, after the scene
  is already running: the first frame is drawn during it. It is not load time a player sees; it
  stops a second `loadScene` from starting at once. The fast swap keeps it as a guard (or sets its
  own), and the ED-35 timing reads the first rendered frame, not the promise.

Expected fast swap, before ED-35 measures it: roughly 0.3 s for Predator and 0.15 s for littleCity
(the hooks and the spawn flush, plus the clear), against 2.8 and 3.0 s now. The author's 3 to 5 s
(up to 10 s on a busy machine) is the headed page with the debug UI on a loaded machine; one warm
Predator load here took 4.8 s, inside that range.

## Notes

- The cold load is not slower than a warm one here (2.76 against 2.82 s for Predator). Not
  investigated: a warm load releases the previous scene's memories and commits new ones, which may
  cost about what the cold load's first compiles do.
- `_flushCreateSpawns` is the largest phase the fast swap still pays in Predator (0.23 s). It is the
  same path the scene-file loader (ED-2) will use for placed entities, so ED-5's 1,764 trees are the
  size check for it.

## Fast swap (ED-35), 2026-10-26

The same script with `--swap` (d434f0a1): the cold load is full, and the five warm loads of the
same scene class are fast swaps, timed to the renderer's first frame after them. The page's copy of
the scene class also wraps the swap's own steps (`pauseAndSettle`, `_clearWorldForSwap`, the resets,
the tiny physics step). Platformer, littleCity and Predator headless; Predator again headed, which
draws with the machine's GPU.

Milliseconds, median of five swaps [min..max]:

| Step | Platformer | littleCity | Predator headless | Predator headed |
| --- | ---: | ---: | ---: | ---: |
| fetch the scene file, import the module | 7.0 | 1.7 | 1.7 | 1.1 |
| settle every worker (`pauseAndSettle`) | 42.4 [7.1..187.3] | 25.5 | 379.9 [333.5..463.2] | 0.8 [0.4..1.8] |
| the clear (logic0's `clearScene`, the effect pools) | 0.4 | 17.4 | 24.1 | 19.1 |
| the resets | 0.1 | 0.2 | 0.3 | 0.2 |
| the tiny physics step | 0.3 | 7.7 | 25.4 | 20.4 |
| `preload` | 0 | 14.5 | 0 | 0 |
| `create` + `createNewGame` | 0 | 0 | 24.0 | 21.5 |
| `_flushCreateSpawns` | 0.7 | 40.0 | 105.7 | 91.9 |
| start, then `transitionCooldown` | 110.4 | 104.0 | 104.5 | 101.7 |
| **Total** | **161.5 [123.6..306]** | **226.9 [192.1..323.3]** | **677.4 [646.5..745.1]** | **257.0 [247.6..285.6]** |
| the cold full load in the same run | 1368 | 2898 | 2294 | 1836 |

- **A fast swap is 4 to 13 times faster than a full load.** littleCity saves 2.77 s of its 3.00 s
  warm full load (ED-39's prediction was 2.73 s); Predator headed takes 0.26 s, as predicted (about
  0.3 s), against 2.82 s.
- **The settle depends on the renderer.** Every worker answers the barrier between two frames, so
  the swap waits for the longest frame in progress. Headless Chromium draws Predator in software:
  a scratch probe timed each worker's answer, and the Pixi worker took 503, 458 and 49 ms while every
  other worker answered within 12 ms. With the GPU (headed), the settle is under 2 ms.
- **What a swap pays is the level's own work and the cooldown.** Of Predator's 0.26 s, 0.13 s is
  its hooks and the spawn flush (the same as in a full load) and 0.1 s is `transitionCooldown`. The
  clear, the resets and the tiny physics step together take about 40 ms.
- Not measured here: a scene whose renderer frame is long on the author's machine would wait for it
  in the settle too; a swap cannot be shorter than the frame in progress.
