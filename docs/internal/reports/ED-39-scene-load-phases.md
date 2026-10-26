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

## Next

Run the script again after ED-35, with a fast-swap section: the same scenes swapping to a scene
file with the same setup, timed to the first rendered frame.
