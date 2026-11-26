# Engine code rules

The rules for code in `src/`, each with the measurement behind it. CLAUDE.md keeps one line of each.

- **No `Math.hypot`** (slower): `Math.sqrt(dx * dx + dy * dy)`.
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
  `const INF = Infinity`. A loop variable seeded from a parameter that was never used as a number
  (`let min = maxRadius`) is typed any value, and each double assigned to it is boxed: seed it
  with `+maxRadius` (E-95). `tests/bench/heapSampleNode.mjs` shows these in Node; run the kernel
  long enough that warm-up (which boxes everything) does not dominate.
- **Waits between workers (Windows):** V8's `Atomics.wait` under 1 ms spins a whole core until it ends, and one of
  1 ms or more sleeps to the timer period (about 15 ms) when nobody notifies. Never wait in sub-ms slices (N-146:
  physics burned a core); bound a wait that must stay short under 1 ms (E-219: 0.95 ms); sleep long waits on a word
  every party notifies (the frame chain's bell). Node tests that publish from another thread time it by a wall-clock
  deadline given ahead: a thread released from a wait took 1.5 ms to run here.
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

## Evidence from V8

- V8 evidence: add `--js-flags="--log-deopt --log-ic" --v8-log-dir <dir>`, then
  `node tests/bench/summarizeV8Deopt.mjs <dir>` (deopts, IC states, steady vs warm-up). A CPU
  profile names inlined code by its source function, so a helper listed there may well be inlined:
  ask `--trace-turbo-inlining`, and compare inclusive times when work moves into a callee (E-64).
