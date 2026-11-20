/**
 * N-215, E-459: no per-frame setter passes its double to a call TurboFan may leave out. A setter TurboFan did not
 * inline boxed the value it was given: a stress scene's walkers, moved through this.x and this.y, allocated 2.1 MB/s
 * in the logic worker at 3 000 of them.
 *
 * V8 inlines a callee whatever its caller's budget in two cases. Its own bytecode plus the bytecode its own optimized
 * code inlined is 30 bytes or less (27 in Node 22's V8). Or the call passes a heap number (a double from arithmetic, a
 * Float64 field, a non-Smi constant) and the callee's own bytecode is 75 bytes or less
 * (--max-inlined-bytecode-size-small-with-heapnum-in-out, in Chrome 157's V8 15.7 and V8 16; not in Node 22). Ticks
 * call a setter from the interpreter first, so V8 optimizes it on its own early, and once that code inlined the setter's
 * work the first rule no longer held (N-215's 26-byte set x counted 26 + 181 in Node 22): the second rule is the one
 * that keeps setters inlined. Elsewhere (a value from a phi, a load or a call) a setter is an ordinary candidate,
 * inlined while the caller's budget lasts, whatever its form.
 *
 * set x and set y, the setters every moving entity calls, compare and store inline, in 75 bytes or less
 * (setterBytecodeSize.test.js), and call poseMoved, which takes no double. The other setters, as an entity's methods or
 * as their components' statics (E-533: SpriteRenderer.setAlpha(i, a)), store their value here (two for setPosition,
 * setVelocity and setScale) and call a function that takes the entity's index and no double. A compare-inline form
 * would not keep them under 75 bytes in a bundle: a module's functions and imports past its 255th slot take 4 bytes
 * more each (set vx: 69 bytes from source, 77 after esbuild and terser). Float32, so the functions read the value as
 * its column will hold it (N-170's compare); each reads it first, before it calls anything.
 *
 * E-473: on a SharedArrayBuffer, whose backing store is off V8's heap and can never be detached, so TurboFan gives its
 * two floats an immediate address; an on-heap Float32Array(2) had its length, base and external pointer loaded,
 * decoded and bounds-checked at each access. A plain ArrayBuffer on a page without SharedArrayBuffer (not cross-origin
 * isolated), where the engine does not start and no setter runs a frame.
 */
export const SETTER_ARGS = new Float32Array(
  new (typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : ArrayBuffer)(8),
);
