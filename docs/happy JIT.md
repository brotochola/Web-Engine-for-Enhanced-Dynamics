Guide: JS that makes V8's JIT happy

Up front: there is no JavaScript that is "equivalent to assembler" everywhere. V8 can get close in well-typed numeric loops, and it almost never does in code with dynamic objects. This guide orders the rules by impact. The emergency exit (WebAssembly) is at the end, for when you actually want assembler.

0. How V8 thinks

V8 has four tiers: Ignition (interpreter) → Sparkplug (baseline) → Maglev (mid-tier JIT) → TurboFan (aggressive optimizer). The last two compile by speculating on what they saw at runtime (types, shapes, ranges). If the speculation fails there is a deopt: the optimized code is thrown away and execution drops to a lower tier.

The whole guide comes down to being predictable: the same types, the same shapes, and the same ranges, always.

1. Shapes (hidden classes) and inline caches
   Initialize every property in the constructor, always in the same order. Two objects with the same order share a shape.
   Do not add properties later, and do not add them behind an if. If a field is optional, initialize it to null or 0.
   Never use delete. It sends the object into dictionary mode (slow). Set obj.x = undefined, or better, null.
   Do not change the prototype (Object.setPrototypeOf, __proto__) and do not modify built-in prototypes on a hot path.
   A call site should see 1 shape (monomorphic). Two to four is polymorphic (slower). More than four is megamorphic (very slow; it falls back to a generic lookup).
   Do not use an object as a hashmap with dynamic keys in hot code: use Map. If the object is a fixed structure, leave it fixed.
   Avoid Proxy, with, eval, and new Function on the hot path, and avoid getters with side effects if you want the load to be hoisted or inlined.
2. Numeric types
   A Smi (small integer, ~31 bits with pointer compression) is the fastest. A double is one step slower, and a HeapNumber (boxed double) is the worst.
   Do not mix types in the same variable, argument, field, or array. A variable that goes from integer to double to string makes the JIT generalize or deopt.
   Force integers with x | 0, x >>> 0 (careful: a uint32 can leave the Smi range), and Math.imul(a, b) for a 32-bit multiply.
   int32 overflow: if the JIT speculated integers and a result overflows, there is a deopt. Keep the ranges bounded.
   Math.fround helps if you are working in float32.
   Avoid BigInt in hot loops, and avoid NaN or undefined flowing through numeric code.
   Double fields on objects live in heap boxes, so hot mutable numbers belong in a Float64Array.
3. Arrays and memory
   Elements kinds: PACKED_SMI → PACKED_DOUBLE → PACKED_ELEMENTS, and each has a HOLEY variant. The transitions go one way. They never go back.
   Do not create holes: new Array(n) is HOLEY forever, even if you fill it afterwards with .fill(). Use [] plus push, or typed arrays.
   Do not mix types in an array (one "a" inside an array of numbers degrades it to generic ELEMENTS).
   Never read out of range (a[-1], a[a.length]). That is a slow path or a deopt.
   Prefer typed arrays (Float64Array, Int32Array, Uint8Array, …) for numeric data: contiguous memory, a fixed type, no holes, no boxing.
   Struct of Arrays instead of Array of Structs: xs[i], ys[i] in typed arrays is much kinder to the cache and to the JIT than pts[i].x. You can build "structs" as views over the same ArrayBuffer.
   Preallocate sizes, and reuse buffers and objects (object pooling) instead of allocating garbage in the loop. The GC is the enemy in real time.
4. Functions and inlining
   Small hot functions get inlined (the limit is on the order of a few hundred bytes of bytecode). Giant functions are not inlined, and they are not optimized the same way.
   Arguments with stable types: a function that sometimes receives an int and sometimes a string becomes polymorphic.
   Always the same number of arguments. Use rest parameters instead of arguments.
   A shared helper that receives many different callbacks becomes megamorphic at the inner call site. If that is critical, duplicate it or specialize it.
   try/catch no longer stops TurboFan. Exceptions are slow when they are thrown, so do not use them for normal control flow.
   Closures created inside hot loops allocate garbage, so move them out.
5. Loops and control flow
   Hoisting: V8 often does LICM (loop-invariant code motion) on its own, but it cannot when there are getters, proxies, opaque calls, or possible aliasing. Hoisting by hand is free and it protects you.
   Use a classic for with an integer index on the hottest loops. for...of over arrays and an inlined forEach often do well, but check it with a benchmark.
   Avoid unpredictable branches and polymorphism inside the loop (dispatch on type with switch/if instead of changing virtual calls).
   Pull out of the loop whatever is invariant, and the allocations ([], {}, closures, arr.slice()).
   Large loops that start cold do OSR (on-stack replacement), which sometimes optimizes worse than a function called many times. For benchmarks, put the loop in its own function and call it several times.
6. Strings
   Concatenating with + builds ropes (cheap). They flatten when indexed, so do not mix concatenation and indexing in the same loop.
   Comparing internalized strings (constants and keys) is cheap. Prefer numeric enums or constants instead of dynamic strings as discriminators.
7. Things that throw the code away (typical deopts)
   Changing the type of a variable or a property on the hot path.
   A new shape at a call site that was already optimized.
   Overflow, or leaving the range of what was speculated as a Smi or int32.
   A read out of range, or a read of a hole.
   Modifying Array.prototype or Object.prototype (invalidates global protectors).
   A badly used arguments object (a leak) in old or sloppy code.
8. How to check it (do not guess)
   Chrome or Node: --js-flags="--trace-opt --trace-deopt", or node --trace-opt --trace-deopt.
   With --allow-natives-syntax: %GetOptimizationStatus(fn), %OptimizeFunctionOnNextCall(fn), %DebugPrint(obj) (it shows the shape and the elements kind).
   Node: --print-opt-code to see the assembler TurboFan emits.
   DevTools → Performance for the real profile, and Memory to see the GC.
   Tools such as Deoptigate and V8's system-analyzer for inline caches.
   Benchmarks: avoid dead code (use a sink), warm up, take several runs and the median, measure samples of at least 30–50 ms, and one function per case.

Golden rule

This is for hot paths a profiler has confirmed. Everywhere else, clear code wins. V8 also changes between versions (Maglev, for example, is fairly new), so a trick that pays today can be unnecessary tomorrow: always measure on your version of Chrome.
