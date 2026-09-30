Guía: JS que hace felices al JIT de V8

Aclaración previa: no existe un JS "equivalente a assembler" en todos lados. V8 puede acercarse mucho en loops numéricos bien tipados, pero casi nunca en código con objetos dinámicos. La guía ordena las reglas por impacto, y al final está la salida de emergencia (WebAssembly) para cuando querés assembler de verdad.

0. Cómo piensa V8

V8 tiene cuatro tiers: Ignition (intérprete) → Sparkplug (baseline) → Maglev (JIT medio) → TurboFan (optimizador agresivo). Los dos últimos compilan especulando con lo que vieron en ejecución (tipos, shapes, rangos). Si la especulación falla hay deopt: se tira el código optimizado y se vuelve a un tier bajo.

Toda la guía se resume en ser predecible: mismos tipos, mismas shapes y mismos rangos, siempre.

1. Shapes (hidden classes) e inline caches
   Inicializá todas las propiedades en el constructor, siempre en el mismo orden. Dos objetos con el mismo orden comparten shape.
   No agregues propiedades después ni las condiciones con un if. Si hay un campo opcional, inicializalo en null o 0.
   Nunca uses delete, porque manda al objeto a modo diccionario (lento). Poné obj.x = undefined, o mejor null.
   No cambies el prototipo (Object.setPrototypeOf, **proto**) ni modifiques prototipos built-in en caliente.
   Un call site debería ver 1 shape (monomórfico). Con 2 a 4 es polimórfico (más lento) y con más de 4 es megamórfico (muy lento, cae en lookup genérico).
   No uses un objeto como hashmap con claves dinámicas en código caliente: usá Map. Y si el objeto es una estructura fija, dejalo fijo.
   Evitá Proxy, with, eval, new Function en el camino caliente, y getters con efectos si querés que se hoisteen o se inlineen.
2. Tipos numéricos
   Smi (entero chico, ~31 bits con pointer compression) es lo más rápido. Double es un escalón más lento, y HeapNumber (double boxeado) es lo peor.
   No mezcles tipos en una misma variable, argumento, campo o array. Una variable que pasa de entero a double a string hace que el JIT generalice o haga deopt.
   Forzá enteros con x | 0, x >>> 0 (ojo: uint32 puede salirse del rango Smi), y Math.imul(a, b) para multiplicar de 32 bits.
   Overflow de int32: si el JIT especuló enteros y un resultado se pasa, hay deopt. Mantené los rangos acotados.
   Math.fround ayuda si trabajás en float32.
   Evitá BigInt en loops calientes, y evitá NaN/undefined circulando por código numérico.
   Los campos double de objetos viven en cajas de heap, así que los números mutables en caliente van mejor en un Float64Array.
3. Arrays y memoria
   Elements kinds: PACKED_SMI → PACKED_DOUBLE → PACKED_ELEMENTS, y cada uno tiene su variante HOLEY. Las transiciones son de un solo sentido, nunca vuelven atrás.
   No crees agujeros: new Array(n) es HOLEY para siempre, aunque después lo rellenes con .fill(). Usá [] + push, o typed arrays.
   No mezcles tipos en un array (un "a" dentro de un array de números lo degrada a ELEMENTS genérico).
   Nunca leas fuera de rango (a[-1], a[a.length]). Eso es un camino lento o un deopt.
   Preferí typed arrays (Float64Array, Int32Array, Uint8Array…) para datos numéricos: memoria contigua, tipo fijo, sin holes, sin boxing.
   Struct of Arrays en vez de Array of Structs: xs[i], ys[i] en typed arrays es mucho más amigable al caché y al JIT que pts[i].x. Podés armar "structs" con vistas sobre un mismo ArrayBuffer.
   Preasigná tamaños, y reusá buffers y objetos (object pooling) en vez de crear basura en el loop. El GC es tu enemigo en tiempo real.
4. Funciones e inlining
   Funciones chicas y calientes se inlinean (el límite es del orden de centenares de bytes de bytecode). Las funciones gigantes no se inlinean ni se optimizan igual.
   Argumentos con tipos estables: una función que a veces recibe int y a veces string se vuelve polimórfica.
   Mismo número de argumentos siempre. Usá parámetros rest en vez de arguments.
   Un helper compartido que recibe muchos callbacks distintos se vuelve megamórfico en el call site interno. Si es crítico, duplicalo o especializalo.
   try/catch ya no frena a TurboFan. Las excepciones sí son lentas cuando se lanzan, así que no las uses para flujo normal.
   Las closures que se crean dentro de loops calientes generan basura, así que sacalas afuera.
5. Loops y flujo
   Hoisting: V8 suele hacer LICM (loop-invariant code motion) solo, pero no puede cuando hay getters, proxies, llamadas opacas o posible aliasing. Hoistear a mano es gratis y te protege.
   Usá for clásico con índice entero en lo más caliente. for...of sobre arrays y forEach inlineado suelen rendir bien, pero verificalo con un benchmark.
   Evitá ramas impredecibles y polimorfismo dentro del loop (despachar por tipo con switch/if en vez de llamadas virtuales cambiantes).
   Sacá del loop lo que sea invariante y las allocations ([], {}, closures, arr.slice()).
   Los loops grandes que arrancan fríos hacen OSR (on-stack replacement), que a veces optimiza peor que una función llamada muchas veces. Para benchmarks, separá el loop en una función y llamala varias veces.
6. Strings
   Concatenar con + crea ropes (baratas). Se aplanan al indexar, así que no mezcles concatenación e indexado en el mismo loop.
   Comparar strings internalizados (constantes/claves) es barato. Preferí enums numéricos o constantes en vez de strings dinámicos como discriminadores.
7. Cosas que tiran el código a la basura (deopts típicos)
   Cambiar el tipo de una variable o propiedad en caliente.
   Shape nueva en un call site ya optimizado.
   Overflow o salida de rango de lo que se especuló como Smi/int32.
   Lectura fuera de rango o sobre un hole.
   Modificar Array.prototype/Object.prototype (invalida protectores globales).
   Un arguments mal usado (leaks) en código viejo o sloppy.
8. Cómo verificarlo (no adivines)
   Chrome/Node: --js-flags="--trace-opt --trace-deopt" o node --trace-opt --trace-deopt.
   Con --allow-natives-syntax: %GetOptimizationStatus(fn), %OptimizeFunctionOnNextCall(fn), %DebugPrint(obj) (te muestra shape y elements kind).
   Node: --print-opt-code para ver el assembler que genera TurboFan.
   DevTools → Performance para el perfil real, y Memory para ver el GC.
   Herramientas como Deoptigate y el system-analyzer de V8 para inline caches.
   Benchmarks: evitá dead code (usá un sink), hacé warmup, varias corridas con mediana, mediciones ≥ 30-50 ms, y una función por caso.

Regla de oro

Esto es para hot paths confirmados por un profiler. Fuera de ahí, el código claro gana. Además, V8 cambia entre versiones (Maglev, por ejemplo, es bastante nuevo), así que lo que hoy es un truco mañana puede ser innecesario: medí siempre en tu versión de Chrome.
