# WeedJS — notes for coding sessions

WeedJS is a multithreaded 2D web game engine: logic, spatial, physics (Box2D 3 WASM + LiquidFun),
particle, pre-render and Pixi render workers sharing SharedArrayBuffers. `src/` is the product;
`demos/` exist to exercise, show and measure it. This file is a digest of the rules spread over
`.cursor/rules/` and `docs/internal/` (≈13k lines); follow the linked documents for detail.

## Before you change code

- **Engine or demo?** If a request could mean either ("fix the camera", "make it faster"), ask.
  Engine work stays generic: no special case for one demo inside `src/`. Demo work uses public
  APIs. (`.cursor/rules/engine-vs-demo.mdc`)
- **Speed claims:** read `docs/internal/HYPOTHESIS_LOG.md` first, then follow
  `docs/internal/HOW_WE_MEASURE.md`. A row is evidence about one sitting, not a ban.
- **Plans and open items:** `docs/internal/EXECUTION_PLAN.md` (speed hypotheses E-xx),
  `docs/internal/REVIEW_PLAN.md` (review items B/M/D/R/G/V/N/DOC). New findings go there.
- **Index of every hypothesis:** `docs/internal/hypotheses.json`, one short entry each (status, result,
  rank when pending, links to the evidence), read as `docs/internal/hypotheses.html`. After a sitting,
  update its entry and run `node scripts/buildHypothesesPage.mjs` (a node test fails when they differ).

## Commands

- Node suite: `npm run test:node` (≈1360 tests, ~15 s). Commit only when it is green. It tests
  the engine only; tests of demo code live in `demos/tests` (`npm run test:demos`).
- Kernels: `node tests/bench/<name>Microbench.mjs [--output path]` (Node, no browser).
- Scene runs: `node tests/bench/runIntegratedWorkerBenchmark.mjs --src --scene /path/scene.js
  --scene-export ClassName [--query k=v] [--warmup-ms N --duration-ms N]` (headless Chromium).
  From Git Bash set `MSYS_NO_PATHCONV=1`, or `/demos/...` becomes `C:/Program Files/Git/demos/...`.
- V8 evidence: add `--js-flags="--log-deopt --log-ic" --v8-log-dir <dir>`, then
  `node tests/bench/summarizeV8Deopt.mjs <dir>` (deopts, IC states, steady vs warm-up). A CPU
  profile names inlined code by its source function, so a helper listed there may well be inlined:
  ask `--trace-turbo-inlining`, and compare inclusive times when work moves into a callee (E-64).
- Predator gate: `tests/bench/runPredatorAbab.mjs`; engine-wide: `npm run bench:scoreboard`.

## Commits

- One change per commit; the title says what code changed. Measurement tools (new kernel cases,
  scene knobs) go in their own commit before the change they measure.
- **No AI or Cursor attribution trailers.** Commits belong to the human author
  (`.cursor/rules/no-cursor-attribution.mdc`; the commit-msg hook strips Cursor trailers).
- The pre-commit hook bumps the patch version and stages `package.json` and `src/version.js`.
  Commit other `package.json` edits on their own.
- Preserve line endings: some files are CRLF (`git ls-files --eol <file>`). Edit those with a
  script that writes `\r\n`, not a tool that writes `\n`.
- Do not push unless asked.

## Engine code rules

- **No `Math.hypot`**: `Math.sqrt(dx * dx + dy * dy)` (`.cursor/rules/no-hypot.mdc`).
- **Declare every field in the constructor** of worker classes and per-frame objects. A field
  first written after the frame loop starts reshapes the object and deoptimizes every method
  that saw the old shape (review N-32: one warning flag cost pre-render ~8 s of per-frame
  deopts). `tests/node/workerShape.test.js` enforces it for pre-render and Pixi. A field that
  holds fractions must start as a double (`NaN` if it must also be falsy): a Smi-to-double write
  also moves the object to a new map. A field that will hold a typed array starts as an empty one
  of the same class, not `null`: from `null` V8 types it Any. That costs where per-entity code tests
  the array's truthiness (`if (arr) arr[i] = …`): 15 % of the emit kernel (E-71). Loops that only
  index a hoisted local tied (E-73). `tests/bench/fieldTypeAudit.mjs` lists the candidates.
- **Hot loops:** don't merge copies through a shared helper or add a loop-invariant branch inside
  them; that cost 10–30 % (review R8). Send the rare case to its own copied loop instead
  (E-41, E-51, E-52 do this). Keep hot callees under TurboFan's 460-byte inline limit when they
  take or return doubles (a non-inlined call boxes them: E-59).
- **No doubles across a call TurboFan may leave out.** Inlining is transitive and has a budget
  (920 bytecode bytes per function), so splitting a callee into small integer-argument functions
  only moves the boxed call deeper. On a hot path, write the doubles into a module `Float64Array`
  and pass integers; results come back the same way (E-85: the ray path made 279 MB/s of heap
  numbers). The global `Infinity` in a branch that never ran is a load without feedback, and
  TurboFan then boxed the double the other branch stored in the same variable: use a module
  `const INF = Infinity`. `tests/bench/heapSampleNode.mjs` shows both in Node.
- **Per-entity doubles in typed arrays, not object fields.** In Chrome, x and y stored into a
  scratch object allocated a heap number each (shared map transitions make such fields tagged),
  and a double returned from a callee that a big caller did not inline was boxed: pre-render made
  30 MB/s of garbage that way (E-66). Write results into a Float64Array or the destination array.
  Sort comparators return a sign, not `a - b`. Check with `tests/bench/heapSampleWorkers.mjs`
  (Chrome); Node's V8 does not show it.
- Correctness-sensitive reorders keep the output bit-identical, with a golden or parity test
  (E-41, E-42, E-50 examples in `tests/node/`).
- Prefer behavioural tests on real code (`tests/bench/workerHarness.mjs` loads a real worker in
  Node) over assertions on source text.

## Measuring (digest of HOW_WE_MEASURE)

- Lowest layer that can see the change: kernel → stress scene → gameplay scene (Predator).
- Kernel: calls the shipped function, never writes `src/`, reports ops/s with a checksum, warms up
  through short calls so the timed code is a normal compile, not OSR (say which tier it timed;
  `warmNormalCompile` in `microbenchHelpers.mjs`, and `tests/bench/kernelTierAudit.mjs` checks).
- Scene pair: ABAB against a worktree of the base rev, headless, `--src`, detailed stats off.
  Primary = the owning worker's `STEP_MS − WAIT_MS`; baseline ≥ 3 ms or the row fails (raise the
  scene's own load knob). Speed keep: ≥ 3 % and ≥ 75 % of pairs, load keys within 5 %.
  A kernel claim needs the kernel win and the scene must not get 3 % worse.
- Hygiene keep (bug fix, dead code): stays unless a primary worker is ≥ 3 % worse.
- A worker the change cannot reach "regresses": run an A/A, and in emergent scenes fit its time
  against its own load key before calling it (review E-50: physics vs `BODY_MOVED_COUNT`). When every
  unreachable worker moved the same way, that is drift: read the owner against it.
- Spend the machine's time: pairs start at 4 and grow by 4 (`--append`) only when they do not
  decide; Predator gates only changes on its hot path or shared infrastructure, and one gate can
  cover a batch of kept changes; one A/A per session is the noise reference; quiet machine, and no
  edits to the working tree while a sitting reads it.
- WASM kernels: Node screens, Chrome decides between variants; time TurboFan, not Liftoff; one
  boundary call per batch; every kernel gets the flags/SIMD/float32 pass (HOW_WE_MEASURE).
- After measuring, update `HYPOTHESIS_LOG.md` / `EXECUTION_PLAN.md`; reports in full prose.

## Where things are

- Workers: `src/workers/` (`preRenderWorker.js`, `pixiWorker.js`, `logicWorker.js`, …).
- Physics: `src/box2d/` (`physicsHostImpl.js` mirrors some SAB layouts by hand: append, don't move).
- Lighting/visibility: `src/render/visibility/angularSweep.js`; splats in `src/render/*Splat.js`.
- User guide: `docs/guide/` (examples there are user-facing: they must run).
- Public API: `src/index.js` (named exports and the default `WEED` object, both) and
  `types/weed.d.ts`.
