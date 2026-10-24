# Writing JavaScript that V8's JIT handles well

There is no JavaScript that is "equivalent to assembler" everywhere. V8 gets close in well-typed numeric
loops and almost never in code with dynamic objects. This guide orders the rules by impact; the last
section is the way out, WebAssembly, for when the work really wants machine code.

The rules this engine paid for, each with its measurement, are in `CLAUDE.md` (Engine code rules) and in
[`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). This page is the general background behind them.

## 0. How V8 thinks

V8 has four tiers: Ignition (the interpreter), Sparkplug (baseline), Maglev (a mid-tier JIT) and TurboFan
(the optimizing compiler). The last two compile by speculating on what they saw at run time: types, shapes,
ranges. When a speculation fails there is a deopt: the optimized code is thrown away and execution drops to
a lower tier.

The whole guide comes down to being predictable: the same types, the same shapes and the same ranges,
always.

## 1. Shapes (hidden classes) and inline caches

- Initialize every property in the constructor, always in the same order. Two objects built in the same
  order share a shape.
- Do not add properties later, and do not add them behind an `if`. An optional field starts as `null` or 0
  (a fraction as a double, a typed array as an empty one of its class).
- Never use `delete`: it sends the object into dictionary mode. Set the field to `null` instead.
- Do not change a prototype (`Object.setPrototypeOf`, `__proto__`), and do not modify built-in prototypes.
- A call site should see one shape (monomorphic). Two to four is polymorphic and slower; more than four is
  megamorphic and falls back to a generic lookup.
- Do not use an object as a hash map with dynamic keys in hot code: use a `Map`. A fixed structure stays fixed.
- Keep `Proxy`, `with`, `eval`, `new Function` and getters with side effects off the hot path.

## 2. Numbers

- A Smi (a small integer, about 31 bits with pointer compression) is the fastest; a double is a step slower;
  a HeapNumber (a boxed double) is the worst.
- Do not mix types in one variable, argument, field or array: a variable that goes from integer to double
  to string makes the JIT generalize or deopt.
- Force integers with `x | 0` or `x >>> 0` (a uint32 can leave the Smi range) and `Math.imul(a, b)` for a
  32-bit multiply. An int32 overflow after the JIT speculated integers is a deopt: keep ranges bounded.
- `Math.fround` helps when the work is in float32.
- Keep BigInt out of hot loops, and keep `NaN` or `undefined` from flowing through numeric code.
- Double fields on objects can live in heap boxes: hot mutable numbers belong in a `Float64Array`.

## 3. Arrays and memory

- Elements kinds go one way: `PACKED_SMI` → `PACKED_DOUBLE` → `PACKED_ELEMENTS`, each with a `HOLEY`
  variant, and never back.
- Do not create holes: `new Array(n)` is holey forever, even after `.fill()`. Use `[]` and `push`, or typed
  arrays.
- One string in an array of numbers degrades it to generic elements.
- Never read out of range (`a[-1]`, `a[a.length]`): that is a slow path or a deopt.
- Prefer typed arrays for numeric data: contiguous memory, one type, no holes, no boxing.
- Structure of arrays, not array of structures: `xs[i]`, `ys[i]` in typed arrays is far kinder to the cache
  and the JIT than `pts[i].x`. "Structs" can be views over one `ArrayBuffer`.
- Preallocate, and reuse buffers and objects instead of allocating in the loop: in real time the garbage
  collector is the enemy.

## 4. Functions and inlining

- Small hot functions are inlined (the limit is a few hundred bytes of bytecode); giant functions are not,
  and are not optimized the same way.
- Give arguments stable types: a function that sometimes gets an integer and sometimes a string is
  polymorphic.
- Always pass the same number of arguments; use rest parameters instead of `arguments`.
- A shared helper that receives many different callbacks becomes megamorphic at its inner call site: when it
  matters, duplicate or specialize it.
- `try`/`catch` no longer stops TurboFan, but a thrown exception is slow: not for normal control flow.
- Closures created inside hot loops allocate: move them out.

## 5. Loops and control flow

- V8 often hoists loop-invariant code on its own, but not past getters, proxies, opaque calls or possible
  aliasing. Hoisting by hand is free and protects you.
- Use a classic `for` with an integer index on the hottest loops; `for...of` and an inlined `forEach` often
  do well, but measure.
- Avoid unpredictable branches and polymorphism inside the loop: dispatch on type with `switch` or `if`
  before it.
- Pull invariants and allocations (`[]`, `{}`, closures, `arr.slice()`) out of the loop.
- A large loop that starts cold is compiled by OSR (on-stack replacement), which sometimes optimizes worse
  than a function called many times. In a benchmark, put the loop in its own function and call it several
  times before timing.

## 6. Strings

- Concatenating with `+` builds ropes (cheap); they flatten when indexed, so do not mix concatenation and
  indexing in the same loop.
- Comparing internalized strings (constants, keys) is cheap; prefer numeric enums or constants to dynamic
  strings as discriminators.

## 7. What throws optimized code away

- A variable or property changing type on the hot path.
- A new shape at a call site that was already optimized.
- An overflow, or a value leaving the range speculated as Smi or int32.
- A read out of range, or a read of a hole.
- Modifying `Array.prototype` or `Object.prototype` (it invalidates global protectors).
- A leaked `arguments` object in old or sloppy code.

## 8. How to check (do not guess)

- `--js-flags="--trace-opt --trace-deopt"` in Chrome, or `node --trace-opt --trace-deopt`.
- With `--allow-natives-syntax`: `%GetOptimizationStatus(fn)`, `%OptimizeFunctionOnNextCall(fn)`,
  `%DebugPrint(obj)` (it shows the shape and the elements kind).
- `node --print-opt-code` shows the machine code TurboFan emits.
- DevTools: Performance for the real profile, Memory for the garbage collector.
- Deoptigate and V8's system analyzer for inline caches.
- In this repository: `tests/bench/summarizeV8Deopt.mjs`, `heapSampleWorkers.mjs`, `kernelTierAudit.mjs`,
  `fieldTypeAudit.mjs` (see HOW_WE_MEASURE).
- Benchmarks: keep the result alive (a sink), warm up, take several runs and the median, time samples of at
  least 30 to 50 ms, and one function per case.

## 9. The way out: WebAssembly

When a hot loop is numeric, branch-light and runs over typed columns, a C kernel compiled to WebAssembly can
beat the best JavaScript: no deopts, real SIMD, float32 arithmetic, and code that does not depend on what the
JIT saw. This engine's kernels live in `wasm/`, follow the rules in HOW_WE_MEASURE (one call per batch, no
memory of their own, Chrome decides between variants), and are planned in
[`WASM_HYPOTHESES.md`](./WASM_HYPOTHESES.md).

## The golden rule

This is for hot paths a profiler has confirmed. Everywhere else, clear code wins. V8 also changes between
versions (Maglev is fairly new), so a trick that pays today can be unnecessary tomorrow: measure on the
Chrome you ship to.
