# WeedJS — notes for coding sessions

WeedJS is a multithreaded 2D web game engine: logic, spatial, physics (Box2D 3 WASM + LiquidFun),
particle, pre-render and Pixi render workers sharing SharedArrayBuffers. `src/` is the product;
`demos/` exist to exercise, show and measure it. This file holds the rules most tasks need; the rest
is in the files it points to (`docs/internal/README.md` indexes them all).

## Before you change code

- **Engine or demo?** If a request could mean either ("fix the camera", "make it faster"), ask, unless
  the user named a path, a worker, an API or a demo. Engine work stays generic: no special case for one
  demo inside `src/`. Demo work uses public APIs; when a demo needs something the engine lacks, ask:
  add it to the engine, or fake it in the scene.
- **Judgment over procedure.** Decide from a change's size and risk how much it needs; skip a step that
  cannot change the verdict (say so in a line). A speed claim is still measured in the scene that runs it.
- **Speed claims:** read what was already tried (`node scripts/hypotheses.mjs find <words>`), then follow
  `docs/internal/HOW_WE_MEASURE.md`. A record is evidence about one sitting, not a ban.
- **The register** (`docs/internal/hypotheses.json`) holds every hypothesis and every record of the work
  on it. After a sitting, the same day: `node scripts/hypotheses.mjs record --hyp <id> --title "…"
  --verdict <word> [--status <word>] --text-file <note.md>` (numbers, verdict, why in one sentence);
  commit once per session or batch. Links into the docs name a row by key (`EXECUTION_PLAN.md#E-82b`),
  never by line. The page, the merge driver and the rest: `docs/internal/README.md`, "The register".
- **Naming items to the owner:** every backlog item or hypothesis id you mention gets its title or a short
  description in parentheses ("E-502 (the opaque pass off on Intel's integrated GPUs)") (owner, 2026-11-18).
  Messages between agents may use bare ids.
- **Plans and open items:** `docs/internal/EXECUTION_PLAN.md` (speed, E-xx), `WASM_HYPOTHESES.md`,
  `REVIEW_PLAN.md` (review items B/M/D/R/G/V/N/DOC). New findings go there; finished campaigns are in
  `docs/internal/reports/`. A row's status and the order of the open work (`rank`) are the register's: a
  plan's heading can be behind.

## Commands

- Node suite: `npm run test:node` (about 3 650 tests, 2 minutes). Commit only when it is green. Demo code
  has its own: `npm run test:demos`.
- Kernels: `node tests/bench/<name>Microbench.mjs [--output path]` (Node, no browser).
- Scene runs: `node tests/bench/runIntegratedWorkerBenchmark.mjs --src --scene /path/scene.js
  --scene-export ClassName [--query k=v] [--warmup-ms N --duration-ms N]` (headless Chromium).
  From Git Bash set `MSYS_NO_PATHCONV=1`, or `/demos/...` becomes `C:/Program Files/Git/demos/...`.
- Predator gate: `tests/bench/runPredatorAbab.mjs`; engine-wide: `npm run bench:scoreboard`.
- V8's deopt and inlining evidence: `docs/internal/ENGINE_CODE_RULES.md`; every bench command:
  HOW_WE_MEASURE's "Commands".

## Commits

- One change per commit; the title says what code changed. Measurement tools (new kernel cases,
  scene knobs) go in their own commit before the change they measure.
- **No AI attribution trailers** (no `Co-authored-by`, no "Made with"). Commits belong to the human
  author configured in git; the commit-msg hook strips Cursor's old trailers.
- The pre-commit hook bumps the patch version on every commit. `npm run release -- patch|minor` builds
  and checks the bundles, tags, publishes to npm and pushes. `npm run check:dist` says whether `dist/`
  was built from the working tree.
- Preserve line endings: some files are CRLF (`git ls-files --eol <file>`). Edit those with a script
  that writes `\r\n`.
- Do not push unless asked.

## Engine code rules (one line each; the measurements behind them: `docs/internal/ENGINE_CODE_RULES.md`)

- No `Math.hypot`: `Math.sqrt(dx * dx + dy * dy)`.
- Declare every field in the constructor of worker classes and per-frame objects, with its final type: a
  double as a double (`NaN` if it must be falsy), a typed array as an empty one of its class, never `null`
  (`tests/node/workerShape.test.js` enforces it for pre-render and Pixi).
- Hot loops: no shared helper or loop-invariant branch merged in (it cost 10–30 %); send the rare case to
  its own copied loop. Keep hot callees that take or return doubles under TurboFan's 460-byte inline limit.
- Doubles on hot paths live in typed arrays (per-entity data, results, arguments across a call TurboFan may
  not inline), not in object fields or returned values. Use a module `const INF = Infinity`; seed a loop
  variable from a parameter with `+param`.
- Waits between workers (Windows): never wait in sub-ms slices; bound a short wait under 1 ms; sleep long
  waits on a word every party notifies.
- Correctness-sensitive reorders keep the output bit-identical, with a golden or parity test.
- Prefer behavioural tests on real code (`tests/bench/workerHarness.mjs`) over assertions on source text.

## Measuring (the full rules: `docs/internal/HOW_WE_MEASURE.md`)

- Premise first: a number that shows the cost (a trace share, a counter), a production caller and the gain
  expected, in the row before any code.
- Effort by size: a big plain change runs `--early` on its owner scene; one near the bar (3–10 %) runs
  the whole protocol; a fix off the hot path needs only the suites.
- Lowest layer that can see the change: kernel → stress scene → gameplay scene (Predator).
- Scene pairs: ABAB, both sides from worktrees (`runPredatorAbab.mjs --vs <base> --hyp-rev <rev>`), `--src`.
  Primary = the owning worker's `STEP_MS − WAIT_MS`, baseline ≥ 6 ms. Keep: ≥ 3 % and ≥ 75 % of pairs,
  load keys within 5 %, and clear (past the session's A/A limit, 7 pairs of 8 or better; 6 of 8 is more pairs
  or a tie); a hygiene change stays unless a primary worker is ≥ 3 % worse. Predator is a
  regression guard, not the ruler for a 3 % claim.
- GPU work: no `STEP_MS` sees it. `glFrameRecorder.mjs --gpu-draws` (WebGL), `webgpuFrameRecorder.mjs`,
  `gpuPassAbab.mjs`; every number names its GPU (the installed Chrome draws on the GTX 1650, Playwright's
  Chromium on the Radeon) and its backend; the pictures are compared on both (`compareCaptures.mjs`).
- After measuring, write the record with the numbers that decided it. Raw results under `tests/results/`
  are not kept: never link them.

## Where things are

- Workers: `src/workers/` (`preRenderWorker.js`, `pixiWorker.js`, `logicWorker.js`, …).
- Physics: `src/box2d/` (`physicsHostImpl.js` mirrors some SAB layouts by hand: append, don't move).
- Lighting/visibility: `src/render/visibility/angularSweep.js`; splats in `src/render/*Splat.js`.
- User guide: `docs/guide/` (examples there are user-facing: they must run).
- Public API: `src/index.js` (named exports and the default `WEED` object, both) and
  `types/weed.d.ts`.
