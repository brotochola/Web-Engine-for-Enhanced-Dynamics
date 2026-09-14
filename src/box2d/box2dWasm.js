// include: shell.js
// include: minimum_runtime_check.js
// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module != "undefined" ? Module : {};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).
// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() running directly in a worker. (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)
// The way we signal to a worker that it is hosting a pthread is to construct
// it with a specific name.
var ENVIRONMENT_IS_PTHREAD = ENVIRONMENT_IS_WORKER && globalThis.name == "em-pthread";

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
var programArgs = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
  throw toThrow;
};

// In MODULARIZE mode _scriptName needs to be captured already at the very top of the page immediately when the page is parsed, so it is generated there
// before the page load. In non-MODULARIZE modes generate it here.
var _scriptName = globalThis.document?.currentScript?.src;

if (ENVIRONMENT_IS_WORKER) {
  _scriptName = self.location.href;
}

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

// Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL(".", _scriptName).href;
  } catch {}
  {
    // include: web_or_worker_shell_read.js
    if (ENVIRONMENT_IS_WORKER) {
      readBinary = url => {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
      };
    }
    readAsync = async url => {
      var response = await fetch(url, {
        credentials: "same-origin"
      });
      if (response.ok) {
        return response.arrayBuffer();
      }
      throw new Error(response.status + " : " + response.url);
    };
  }
} else {}

var out = console.log.bind(console);

var err = console.error.bind(console);

// end include: shell.js
// include: preamble.js
// === Preamble library stuff ===
// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
var wasmBinary;

// Wasm globals
// For sending to workers.
var wasmModule;

//========================================
// Runtime essentials
//========================================
// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// include: runtime_common.js
// include: runtime_exceptions.js
// Base Emscripten EH error class
class EmscriptenEH {}

class EmscriptenSjLj extends EmscriptenEH {}

// end include: runtime_exceptions.js
// include: runtime_debug.js
// end include: runtime_debug.js
// include: runtime_pthread.js
// Pthread Web Worker handling code.
// This code runs only on pthread web workers and handles pthread setup
// and communication with the main thread via postMessage.
var startWorker;

if (ENVIRONMENT_IS_PTHREAD) {
  // Thread-local guard variable for one-time init of the JS state
  var initializedJS = false;
  // Turn unhandled rejected promises into errors so that the main thread will be
  // notified about them.
  self.onunhandledrejection = e => {
    throw e.reason || e;
  };
  function handleMessage(e) {
    try {
      var msgData = e.data;
      //dbg('msgData: ' + Object.keys(msgData));
      var cmd = msgData.cmd;
      if (cmd == 1) {
        // Preload command that is called once per worker to parse and load the Emscripten code.
        // Until we initialize the runtime, queue up any further incoming messages.
        let messageQueue = [];
        self.onmessage = e => messageQueue.push(e);
        // And add a callback for when the runtime is initialized.
        startWorker = () => {
          // Notify the main thread that this thread has loaded.
          postMessage({
            cmd: 3
          });
          // Process any messages that were queued before the thread was ready.
          for (let msg of messageQueue) {
            handleMessage(msg);
          }
          // Restore the real message handler.
          self.onmessage = handleMessage;
        };
        // Use `const` here to ensure that the variable is scoped only to
        // that iteration, allowing safe reference from a closure.
        for (const handler of msgData.handlers) {
          // If the main module has a handler for a certain event, but no
          // handler exists on the pthread worker, then proxy that handler
          // back to the main thread.
          if (!Module[handler] || Module[handler].proxy) {
            Module[handler] = (...args) => {
              postMessage({
                cmd: 9,
                handler,
                args
              });
            };
            // Rebind the out / err handlers if needed
            if (handler == "print") out = Module[handler];
            if (handler == "printErr") err = Module[handler];
          }
        }
        wasmMemory = msgData.wasmMemory;
        updateMemoryViews();
        wasmModule = msgData.wasmModule;
        createWasm();
        run();
        startWorker();
      } else if (cmd == 2) {
        // Call inside JS module to set up the stack frame for this pthread in JS module scope.
        // This needs to be the first thing that we do, as we cannot call to any C/C++ functions
        // until the thread stack is initialized.
        establishStackSpace(msgData.pthread_ptr);
        // Pass the thread address to wasm to store it for fast access.
        __emscripten_thread_init(msgData.pthread_ptr, /*is_main=*/ 0, /*is_runtime=*/ 0, /*can_block=*/ 1, 0, 0);
        PThread.threadInitTLS();
        // Await mailbox notifications with `Atomics.waitAsync` so we can start
        // using the fast `Atomics.notify` notification path.
        __emscripten_thread_mailbox_await(msgData.pthread_ptr);
        if (!initializedJS) {
          initializedJS = true;
        }
        try {
          invokeEntryPoint(msgData.start_routine, msgData.arg);
        } catch (ex) {
          if (ex != "unwind") {
            // The pthread "crashed".  Do not call `_emscripten_thread_exit` (which
            // would make this thread joinable).  Instead, re-throw the exception
            // and let the top level handler propagate it back to the main thread.
            throw ex;
          }
        }
      } else if (cmd == 4) {
        if (initializedJS) {
          checkMailbox();
        }
      } else if (cmd) {
        // The received message looks like something that should be handled by this message
        // handler, (since there is a cmd field present), but is not one of the
        // recognized commands:
        err(`worker: received unknown command ${cmd}`);
        err(msgData);
      }
    } catch (ex) {
      if (runtimeInitialized) __emscripten_thread_crashed();
      throw ex;
    }
  }
  self.onmessage = handleMessage;
}

// ENVIRONMENT_IS_PTHREAD
// end include: runtime_pthread.js
// Memory management
var runtimeInitialized = false;

function updateMemoryViews() {
  var b = wasmMemory.buffer;
  HEAP8 = new Int8Array(b);
  HEAPU8 = new Uint8Array(b);
  Module["HEAP32"] = HEAP32 = new Int32Array(b);
  HEAPU32 = new Uint32Array(b);
  Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
}

// In non-standalone/normal mode, we create the memory here.
// include: runtime_init_memory.js
// Create the wasm memory. (Note: this only applies if IMPORTED_MEMORY is defined)
// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
function initMemory() {
  if ((ENVIRONMENT_IS_PTHREAD)) {
    return;
  }
  {
    var INITIAL_MEMORY = 268435456;
    /** @suppress {checkTypes} */ wasmMemory = new WebAssembly.Memory({
      "initial": INITIAL_MEMORY / 65536,
      "maximum": INITIAL_MEMORY / 65536,
      "shared": true
    });
  }
  updateMemoryViews();
}

// end include: runtime_init_memory.js
// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
function preRun() {
  var preRun = Module["preRun"];
  if (preRun) {
    if (typeof preRun == "function") preRun = [ preRun ];
    onPreRuns.push(...preRun);
  }
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
  runtimeInitialized = true;
  if (ENVIRONMENT_IS_PTHREAD) return;
  // No ATINITS hooks
  wasmExports["t"]();
}

function postRun() {
  var postRun = Module["postRun"];
  if (postRun) {
    if (typeof postRun == "function") postRun = [ postRun ];
    onPostRuns.push(...postRun);
  }
  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
}

/**
 * @param {string|number=} what
 */ function abort(what) {
  Module["onAbort"]?.(what);
  what = `Aborted(${what})`;
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  what += ". Build with -sASSERTIONS for more info.";
  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.
  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

var wasmBinaryFile;

function findWasmBinary() {
  return locateFile("box2d_wasm.wasm");
}

function getBinarySync(file) {
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally advisable since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      var response = await readAsync(binaryFile);
      return new Uint8Array(response);
    } catch {}
  }
  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);
    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary) {
    try {
      var response = fetch(binaryFile, {
        credentials: "same-origin"
      });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err("falling back to ArrayBuffer instantiation");
    }
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  assignWasmImports();
  // prepare imports
  var imports = {
    "a": wasmImports
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    registerTLSInit(wasmExports["tc"]);
    assignWasmExports(wasmExports);
    // We now have the Wasm module loaded up, keep a reference to the compiled module so we can post it to the workers.
    wasmModule = module;
    return wasmExports;
  }
  // Prefer streaming instantiation if available.
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    return receiveInstance(result["instance"], result["module"]);
  }
  var info = getWasmImports();
  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  var instantiateWasm = Module["instantiateWasm"];
  if (instantiateWasm) {
    return new Promise(resolve => {
      instantiateWasm(info, (inst, mod) => resolve(receiveInstance(inst, mod)));
    });
  }
  if ((ENVIRONMENT_IS_PTHREAD)) {
    // Instantiate from the module that was received via postMessage from
    // the main thread. We can just use sync instantiation in the worker.
    var instance = new WebAssembly.Instance(wasmModule, getWasmImports());
    return receiveInstance(instance, wasmModule);
  }
  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js
// Begin JS library code
class ExitStatus {
  name="ExitStatus";
  constructor(status) {
    this.message = `Program terminated with exit(${status})`;
    this.status = status;
  }
}

var terminateWorker = worker => {
  worker.terminate();
  // terminate() can be asynchronous, so in theory the worker can continue
  // to run for some amount of time after termination.  However from our POV
  // the worker is now dead and we don't want to hear from it again, so we stub
  // out its message handler here.  This avoids having to check in each of
  // the onmessage handlers if the message was coming from a valid worker.
  worker.onmessage = e => {};
};

var cleanupThread = pthread_ptr => {
  var worker = PThread.pthreads[pthread_ptr];
  PThread.returnWorkerToPool(worker);
};

var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var dependenciesPromise = null;

var resolveRunDependencies = async () => dependenciesPromise;

var runDependencies = 0;

var dependenciesPromiseResolve = null;

var removeRunDependency = id => {
  runDependencies--;
  Module["monitorRunDependencies"]?.(runDependencies);
  if (!runDependencies) {
    dependenciesPromiseResolve();
  }
};

var addRunDependency = id => {
  if (!runDependencies) {
    dependenciesPromise = new Promise(resolve => dependenciesPromiseResolve = resolve);
  }
  runDependencies++;
  Module["monitorRunDependencies"]?.(runDependencies);
};

var spawnThread = threadParams => {
  var worker = PThread.getNewWorker();
  if (!worker) {
    // No available workers in the PThread pool.
    return 6;
  }
  // Add to pthreads map
  PThread.pthreads[threadParams.pthread_ptr] = worker;
  worker.pthread_ptr = threadParams.pthread_ptr;
  var msg = {
    cmd: 2,
    start_routine: threadParams.startRoutine,
    arg: threadParams.arg,
    pthread_ptr: threadParams.pthread_ptr
  };
  // Ask the worker to start executing its pthread entry point function.
  worker.postMessage(msg, threadParams.transferList);
  return 0;
};

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

var stackSave = () => _emscripten_stack_get_current();

var stackRestore = val => __emscripten_stack_restore(val);

var stackAlloc = sz => __emscripten_stack_alloc(sz);

/** @type {!Float64Array} */ var HEAPF64;

/** not-@type {!BigInt64Array} */ var HEAP64;

/** @type{function(number, (number|boolean), ...number)} */ var proxyToMainThread = (funcIndex, emAsmAddr, proxyMode, ...callArgs) => {
  // EM_ASM proxying is done by passing a pointer to the address of the EM_ASM
  // content as `emAsmAddr`.  JS library proxying is done by passing an index
  // into `proxiedJSCallArgs` as `funcIndex`. If `emAsmAddr` is non-zero then
  // `funcIndex` will be ignored.
  // Additional arguments are passed after the first three are the actual
  // function arguments.
  // The serialization buffer contains the number of call params, and then
  // all the args here.
  // We also pass 'proxyMode' to C separately, since C needs to look at it.
  // Allocate a buffer (on the stack), which will be copied if necessary by
  // the C code.
  // First passed parameter specifies the number of arguments to the function.
  // When BigInt support is enabled, we must handle types in a more complex
  // way, detecting at runtime if a value is a BigInt or not (as we have no
  // type info here). To do that, add a "prefix" before each value that
  // indicates if it is a BigInt, which effectively doubles the number of
  // values we serialize for proxying. TODO: pack this?
  var bufSize = 8 * callArgs.length * 2;
  var sp = stackSave();
  var args = stackAlloc(bufSize);
  var b = ((args) >> 3);
  for (var arg of callArgs) {
    if (typeof arg == "bigint") {
      // The prefix is non-zero to indicate a bigint.
      HEAP64[b++] = 1n;
      HEAP64[b++] = arg;
    } else {
      // The prefix is zero to indicate a JS Number.
      HEAP64[b++] = 0n;
      HEAPF64[b++] = arg;
    }
  }
  var rtn = __emscripten_run_js_on_main_thread(funcIndex, emAsmAddr, bufSize, args, proxyMode);
  stackRestore(sp);
  return rtn;
};

function _proc_exit(code) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(0, 0, 1, code);
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    PThread.terminateAllThreads();
    Module["onExit"]?.(code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
}

function exitOnMainThread(returnCode) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(1, 0, 0, returnCode);
  _exit(returnCode);
}

/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
  EXITSTATUS = status;
  if (ENVIRONMENT_IS_PTHREAD) {
    // implicit exit can never happen on a pthread
    // When running in a pthread we propagate the exit back to the main thread
    // where it can decide if the whole process should be shut down or not.
    // The pthread may have decided not to exit its own runtime, for example
    // because it runs a main loop, but that doesn't affect the main thread.
    exitOnMainThread(status);
    throw "unwind";
  }
  _proc_exit(status);
};

var _exit = exitJS;

var waitAsyncPolyfilled = (!Atomics.waitAsync || (globalThis.navigator?.userAgent && Number((navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./) || [])[2]) < 91));

/** @type {!Int32Array} */ var HEAP32;

var PThread = {
  unusedWorkers: [],
  tlsInitFunctions: [],
  pthreads: {},
  init() {
    if ((!(ENVIRONMENT_IS_PTHREAD))) {
      PThread.initMainThread();
    }
  },
  initMainThread() {
    var pthreadPoolSize = 4;
    // Start loading up the Worker pool, if requested.
    while (pthreadPoolSize--) {
      PThread.allocateUnusedWorker();
    }
    // MINIMAL_RUNTIME takes care of calling loadWasmModuleToAllWorkers
    // in postamble_minimal.js
    addOnPreRun(async () => {
      var pthreadPoolReady = PThread.loadWasmModuleToAllWorkers();
      addRunDependency("loading-workers");
      await pthreadPoolReady;
      removeRunDependency("loading-workers");
    });
  },
  terminateAllThreads: () => {
    // Attempt to kill all workers.  Sadly (at least on the web) there is no
    // way to terminate a worker synchronously, or to be notified when a
    // worker is actually terminated.  This means there is some risk that
    // pthreads will continue to be executing after `worker.terminate` has
    // returned.  For this reason, we don't call `returnWorkerToPool` here or
    // free the underlying pthread data structures.
    for (var worker of Object.values(PThread.pthreads)) {
      terminateWorker(worker);
    }
    for (var worker of PThread.unusedWorkers) {
      terminateWorker(worker);
    }
    PThread.unusedWorkers = [];
    PThread.pthreads = {};
  },
  terminateRuntime: () => {
    PThread.terminateAllThreads();
    var pthread_ptr = _pthread_self();
    ___set_thread_state(0, 0, 0, 1);
    if (!waitAsyncPolyfilled) {
      // Break the waitAsync loop.  Note that checkMailbox will not
      // re-register since the `___set_thread_state` above causes _pthread_self
      // to return 0.
      Atomics.notify(HEAP32, ((pthread_ptr) >> 2));
    }
  },
  returnWorkerToPool: worker => {
    // We don't want to run main thread queued calls here, since we are doing
    // some operations that leave the worker queue in an invalid state until
    // we are completely done (it would be bad if free() ends up calling a
    // queued pthread_create which looks at the global data structures we are
    // modifying). To achieve that, defer the free() until the very end, when
    // we are all done.
    var pthread_ptr = worker.pthread_ptr;
    delete PThread.pthreads[pthread_ptr];
    // Note: worker is intentionally not terminated so the pool can
    // dynamically grow.
    PThread.unusedWorkers.push(worker);
    // Not a running Worker anymore
    // Detach the worker from the pthread object, and return it to the
    // worker pool as an unused worker.
    worker.pthread_ptr = 0;
    // Finally, free the underlying (and now-unused) pthread structure in
    // linear memory.
    __emscripten_thread_free_data(pthread_ptr);
  },
  threadInitTLS() {
    // Call thread init functions (these are the _emscripten_tls_init for each
    // module loaded.
    PThread.tlsInitFunctions.forEach(f => f());
  },
  loadWasmModuleToWorker: worker => new Promise(onFinishedLoading => {
    worker.onmessage = e => {
      var d = e.data;
      var cmd = d.cmd;
      // If this message is intended to a recipient that is not the main
      // thread, forward it to the target thread. This is currently only
      // used by `CMD_CHECK_MAILBOX`.
      if (d.targetThread && d.targetThread != _pthread_self()) {
        var targetWorker = PThread.pthreads[d.targetThread];
        targetWorker?.postMessage(d);
        return;
      }
      if (d === "setimmediate" || d === "_si") {
        // Worker wants to postMessage() to itself to implement setImmediate()
        // emulation.
        worker.postMessage(d);
        return;
      }
      switch (cmd) {
       case 4:
        checkMailbox();
        break;

       case 5:
        spawnThread(d);
        break;

       case 6:
        // cleanupThread needs to be run via callUserCallback since it calls
        // back into user code to free thread data. Without this it's possible
        // the unwind or ExitStatus exception could escape here.
        callUserCallback(() => cleanupThread(d.thread));
        break;

       case 3:
        onFinishedLoading(worker);
        break;

       case 9:
        Module[d.handler](...d.args);
        break;

       default:
        // The received message looks like something that should be handled by this message
        // handler, (since there is a e.data.cmd field present), but is not one of the
        // recognized commands:
        if (cmd) err(`worker sent an unknown command ${cmd}`);
      }
    };
    worker.onerror = e => {
      var message = "worker sent an error!";
      err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);
      throw e;
    };
    // When running on a pthread, none of the incoming parameters on the module
    // object are present. Proxy known handlers back to the main thread if specified.
    var handlers = [];
    var knownHandlers = [ "onExit", "onAbort", "print", "printErr" ];
    for (var handler of knownHandlers) {
      if (Module.propertyIsEnumerable(handler)) {
        handlers.push(handler);
      }
    }
    // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
    worker.postMessage({
      cmd: 1,
      handlers,
      wasmMemory,
      wasmModule
    });
  }),
  async loadWasmModuleToAllWorkers() {
    // Instantiation is synchronous in pthreads.
    if (ENVIRONMENT_IS_PTHREAD) {
      return;
    }
    let pthreadPoolReady = Promise.all(PThread.unusedWorkers.map(PThread.loadWasmModuleToWorker));
    return pthreadPoolReady;
  },
  allocateUnusedWorker() {
    var worker;
    var pthreadMainJs = _scriptName;
    worker = new Worker(pthreadMainJs, {
      // This is the way that we signal to the Web Worker that it is hosting
      // a pthread.
      "name": "em-pthread"
    });
    PThread.unusedWorkers.push(worker);
    return worker;
  },
  getNewWorker() {
    if (PThread.unusedWorkers.length == 0) {
      // PTHREAD_POOL_SIZE_STRICT should show a warning and, if set to level `2`, return from the function.
      var newWorker = PThread.allocateUnusedWorker();
      PThread.loadWasmModuleToWorker(newWorker);
    }
    return PThread.unusedWorkers.pop();
  }
};

var onPostRuns = [];

/** @type {!Uint32Array} */ var HEAPU32;

function establishStackSpace(pthread_ptr) {
  var stackHigh = HEAPU32[(((pthread_ptr) + (48)) >> 2)];
  var stackSize = HEAPU32[(((pthread_ptr) + (52)) >> 2)];
  var stackLow = stackHigh - stackSize;
  // Set stack limits used by `emscripten/stack.h` function.  These limits are
  // cached in wasm-side globals to make checks as fast as possible.
  _emscripten_stack_set_limits(stackHigh, stackLow);
  // Call inside wasm module to set up the stack frame for this pthread in wasm module scope
  stackRestore(stackHigh);
}

var wasmTableMirror = [];

var getWasmTableEntry = funcPtr => {
  var func = wasmTableMirror[funcPtr];
  if (!func) {
    /** @suppress {checkTypes} */ wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
  }
  return func;
};

var invokeEntryPoint = (ptr, arg) => {
  // An old thread on this worker may have been canceled without returning the
  // `runtimeKeepaliveCounter` to zero. Reset it now so the new thread won't
  // be affected.
  runtimeKeepaliveCounter = 0;
  // Same for noExitRuntime.  The default for pthreads should always be false
  // otherwise pthreads would never complete and attempts to pthread_join to
  // them would block forever.
  // pthreads can still choose to set `noExitRuntime` explicitly, or
  // call emscripten_unwind_to_js_event_loop to extend their lifetime beyond
  // their main function.  See comment in src/runtime_pthread.js for more.
  noExitRuntime = 0;
  // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
  // Native codebases sometimes spawn threads with other thread entry point
  // signatures, such as void ThreadMain(void *arg), void *ThreadMain(), or
  // void ThreadMain().  That is not acceptable per C/C++ specification, but
  // x86 compiler ABI extensions enable that to work. If you find the
  // following line to crash, either change the signature to "proper" void
  // *ThreadMain(void *arg) form, or try linking with the Emscripten linker
  // flag -sEMULATE_FUNCTION_POINTER_CASTS to add in emulation for this x86
  // ABI extension.
  var result = getWasmTableEntry(ptr)(arg);
  function finish(result) {
    // In MINIMAL_RUNTIME the noExitRuntime concept does not apply to
    // pthreads. To exit a pthread with live runtime, use the function
    // emscripten_unwind_to_js_event_loop() in the pthread body.
    if (keepRuntimeAlive()) {
      EXITSTATUS = result;
      return;
    }
    __emscripten_thread_exit(result);
  }
  finish(result);
};

var noExitRuntime = true;

var registerTLSInit = tlsInitFunc => PThread.tlsInitFunctions.push(tlsInitFunc);

var wasmMemory;

function pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(2, 0, 1, pthread_ptr, attr, startRoutine, arg);
  return ___pthread_create_js(pthread_ptr, attr, startRoutine, arg);
}

var _emscripten_has_threading_support = () => !!globalThis.SharedArrayBuffer;

var ___pthread_create_js = (pthread_ptr, attr, startRoutine, arg) => {
  if (!_emscripten_has_threading_support()) {
    return 6;
  }
  // List of JS objects that will transfer ownership to the Worker hosting the thread
  var transferList = [];
  var error = 0;
  // Synchronously proxy the thread creation to main thread if possible. If we
  // need to transfer ownership of objects, then proxy asynchronously via
  // postMessage.
  if (ENVIRONMENT_IS_PTHREAD && (transferList.length === 0 || error)) {
    return pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg);
  }
  // If on the main thread, and accessing Canvas/OffscreenCanvas failed, abort
  // with the detected error.
  if (error) return error;
  var threadParams = {
    startRoutine,
    pthread_ptr,
    arg,
    transferList
  };
  if (ENVIRONMENT_IS_PTHREAD) {
    // The prepopulated pool of web workers that can host pthreads is stored
    // in the main JS thread. Therefore if a pthread is attempting to spawn a
    // new thread, the thread creation must be deferred to the main JS thread.
    threadParams.cmd = 5;
    postMessage(threadParams, transferList);
    // When we defer thread creation this way, we have no way to detect thread
    // creation synchronously today, so we have to assume success and return 0.
    return 0;
  }
  // We are the main thread, so we have the pthread warmup pool in this
  // thread and can fire off JS thread creation directly ourselves.
  return spawnThread(threadParams);
};

var __abort_js = () => abort("");

var __emscripten_init_main_thread_js = tb => {
  var can_block = !ENVIRONMENT_IS_WEB;
  // Feature detect whether the main thread can block.
  try {
    Atomics.wait(HEAP32, 0, 0, 0);
    can_block = true;
  } catch (e) {}
  // Pass the thread address to the native code where they are stored in wasm
  // globals which act as a form of TLS. Global constructors trying
  // to access this value will read the wrong value, but that is UB anyway.
  __emscripten_thread_init(tb, /*is_main=*/ !ENVIRONMENT_IS_WORKER, /*is_runtime=*/ 1, can_block, /*default_stacksize=*/ 65536, /*start_profiling=*/ false);
  PThread.threadInitTLS();
};

var handleException = e => {
  // Certain exception types we do not treat as errors since they are used for
  // internal control flow.
  // 1. ExitStatus, which is thrown by exit()
  // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
  //    that wish to return to JS event loop.
  if (e instanceof ExitStatus || e == "unwind") {
    return EXITSTATUS;
  }
  quit_(1, e);
};

var maybeExit = () => {
  if (!keepRuntimeAlive()) {
    try {
      if (ENVIRONMENT_IS_PTHREAD) {
        // exit the current thread, but only if there is one active.
        // TODO(https://github.com/emscripten-core/emscripten/issues/25076):
        // Unify this check with the runtimeExited check above
        if (_pthread_self()) __emscripten_thread_exit(EXITSTATUS);
        return;
      }
      _exit(EXITSTATUS);
    } catch (e) {
      handleException(e);
    }
  }
};

var callUserCallback = func => {
  if (ABORT) {
    return;
  }
  try {
    return func();
  } catch (e) {
    handleException(e);
  } finally {
    maybeExit();
  }
};

var __emscripten_thread_mailbox_await = pthread_ptr => {
  if (!waitAsyncPolyfilled) {
    // Wait on the pthread's initial self-pointer field because it is easy and
    // safe to access from sending threads that need to notify the waiting
    // thread.
    // Note: Under wasm64 only the low 32-bit of the pthread_ptr are
    // read/compared here, but we don't actually care about the exact values
    // here as long as they match.
    var wait = Atomics.waitAsync(HEAP32, ((pthread_ptr) >> 2), pthread_ptr);
    wait.value.then(checkMailbox);
    var waitingAsync = pthread_ptr + 112;
    Atomics.store(HEAP32, ((waitingAsync) >> 2), 1);
  }
};

var checkMailbox = () => {
  // checkMailbox can be called after the pthread has shut down. See
  // Pthread.terminateRuntime().
  // In this case we return silently without re-registering using waitAsync.
  // Perhaps there is a more universal way we can detect runtime has exited.
  // TODO(https://github.com/emscripten-core/emscripten/issues/25076)
  var pthread_ptr = _pthread_self();
  if (!pthread_ptr) return;
  callUserCallback(() => {
    // If we are using Atomics.waitAsync as our notification mechanism, wait
    // for a notification before processing the mailbox to avoid missing any
    // work that could otherwise arrive after we've finished processing the
    // mailbox and before we're ready for the next notification.
    __emscripten_thread_mailbox_await(pthread_ptr);
    __emscripten_check_mailbox();
  });
};

var __emscripten_notify_mailbox_postmessage = (targetThread, currThreadId) => {
  if (targetThread == currThreadId) {
    setTimeout(checkMailbox);
  } else if (ENVIRONMENT_IS_PTHREAD) {
    postMessage({
      targetThread,
      cmd: 4
    });
  } else {
    var worker = PThread.pthreads[targetThread];
    if (!worker) {
      return;
    }
    worker.postMessage({
      cmd: 4
    });
  }
};

var proxiedJSCallArgs = [];

var __emscripten_receive_on_main_thread_js = (funcIndex, emAsmAddr, callingThread, bufSize, args, ctx, ctxArgs) => {
  // Sometimes we need to backproxy events to the calling thread (e.g.
  // HTML5 DOM events handlers such as
  // emscripten_set_mousemove_callback()), so keep track in a globally
  // accessible variable about the thread that initiated the proxying.
  proxiedJSCallArgs.length = 0;
  var b = ((args) >> 3);
  var end = ((args + bufSize) >> 3);
  while (b < end) {
    var arg;
    if (HEAP64[b++]) {
      // It's a BigInt.
      arg = HEAP64[b++];
    } else {
      // It's a Number.
      arg = HEAPF64[b++];
    }
    proxiedJSCallArgs.push(arg);
  }
  // Proxied JS library funcs use funcIndex and EM_ASM functions use emAsmAddr
  var func = proxiedFunctionTable[funcIndex];
  PThread.currentProxiedOperationCallerThread = callingThread;
  var rtn = func(...proxiedJSCallArgs);
  PThread.currentProxiedOperationCallerThread = 0;
  if (ctx) {
    rtn.then(rtn => __emscripten_run_js_on_main_thread_done(ctx, ctxArgs, rtn));
    return;
  }
  return rtn;
};

var __emscripten_runtime_keepalive_clear = () => {
  noExitRuntime = false;
  runtimeKeepaliveCounter = 0;
};

var __emscripten_thread_cleanup = thread => {
  // Called when a thread needs to be cleaned up so it can be reused.
  // A thread is considered reusable when it either returns from its
  // entry point, calls pthread_exit, or acts upon a cancellation.
  // Detached threads are responsible for calling this themselves,
  // otherwise pthread_join is responsible for calling this.
  if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread); else postMessage({
    cmd: 6,
    thread
  });
};

var __emscripten_thread_set_strongref = thread => {};

var timers = {};

var _emscripten_get_now = () => performance.timeOrigin + performance.now();

function __setitimer_js(which, timeout_ms) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(3, 0, 1, which, timeout_ms);
  // First, clear any existing timer.
  if (timers[which]) {
    clearTimeout(timers[which].id);
    delete timers[which];
  }
  // A timeout of zero simply cancels the current timeout so we have nothing
  // more to do.
  if (!timeout_ms) return 0;
  var id = setTimeout(() => {
    delete timers[which];
    callUserCallback(() => __emscripten_timeout(which, _emscripten_get_now()));
  }, timeout_ms);
  timers[which] = {
    id,
    timeout_ms
  };
  return 0;
}

var _emscripten_date_now = () => Date.now();

var nowIsMonotonic = 1;

var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;

var INT53_MAX = 9007199254740992;

var INT53_MIN = -9007199254740992;

var bigintToI53Checked = num => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);

function _clock_time_get(clk_id, ignored_precision, ptime) {
  ignored_precision = bigintToI53Checked(ignored_precision);
  if (!checkWasiClock(clk_id)) {
    return 28;
  }
  var now;
  // all wasi clocks but realtime are monotonic
  if (clk_id === 0) {
    now = _emscripten_date_now();
  } else if (nowIsMonotonic) {
    now = _emscripten_get_now();
  } else {
    return 52;
  }
  // "now" is in ms, and wasi times are in ns.
  var nsec = Math.round(now * 1e3 * 1e3);
  HEAP64[((ptime) >> 3)] = BigInt(nsec);
  return 0;
}

var _emscripten_check_blocking_allowed = () => {};

var runtimeKeepalivePush = () => {
  runtimeKeepaliveCounter += 1;
};

var _emscripten_exit_with_live_runtime = () => {
  runtimeKeepalivePush();
  throw "unwind";
};

var abortOnCannotGrowMemory = requestedSize => {
  abort("OOM");
};

/** @type {!Uint8Array} */ var HEAPU8;

var _emscripten_resize_heap = requestedSize => {
  var oldSize = HEAPU8.length;
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  requestedSize >>>= 0;
  abortOnCannotGrowMemory(requestedSize);
};

var printCharBuffers = [ null, [], [] ];

var UTF8Decoder = globalThis.TextDecoder && new TextDecoder;

/**
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul
   * @return {number}
   */ var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
  var maxIdx = idx + maxBytesToRead;
  if (ignoreNul) return maxIdx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on
  // null terminator by itself.
  // As a tiny code save trick, compare idx against maxIdx using a negation,
  // so that maxBytesToRead=undefined/NaN means Infinity.
  while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
  return idx;
};

/**
   * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
   * array that contains uint8 values, returns a copy of that string as a
   * Javascript String object.
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number=} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
  var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
  // When using conditional TextDecoder, skip it for short strings as the overhead of the native call is not worth it.
  if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
    return UTF8Decoder.decode(heapOrArray.buffer instanceof ArrayBuffer ? heapOrArray.subarray(idx, endPtr) : heapOrArray.slice(idx, endPtr));
  }
  var str = "";
  while (idx < endPtr) {
    // For UTF8 byte structure, see:
    // http://en.wikipedia.org/wiki/UTF-8#Description
    // https://www.ietf.org/rfc/rfc2279.txt
    // https://tools.ietf.org/html/rfc3629
    var u0 = heapOrArray[idx++];
    if (!(u0 & 128)) {
      str += String.fromCharCode(u0);
      continue;
    }
    var u1 = heapOrArray[idx++] & 63;
    if ((u0 & 224) == 192) {
      str += String.fromCharCode(((u0 & 31) << 6) | u1);
      continue;
    }
    var u2 = heapOrArray[idx++] & 63;
    if ((u0 & 240) == 224) {
      u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
    } else {
      u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
    }
    if (u0 < 65536) {
      str += String.fromCharCode(u0);
    } else {
      var ch = u0 - 65536;
      str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
    }
  }
  return str;
};

var printChar = (stream, curr) => {
  var buffer = printCharBuffers[stream];
  if (curr === 0 || curr === 10) {
    (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
    buffer.length = 0;
  } else {
    buffer.push(curr);
  }
};

/**
   * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
   * emscripten HEAP, returns a copy of that string as a Javascript String object.
   *
   * @param {number} ptr
   * @param {number=} maxBytesToRead - An optional length that specifies the
   *   maximum number of bytes to read. You can omit this parameter to scan the
   *   string until the first 0 byte. If maxBytesToRead is passed, and the string
   *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
   *   string will cut short at that byte index.
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : "";

function _fd_write(fd, iov, iovcnt, pnum) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(4, 0, 1, fd, iov, iovcnt, pnum);
  // hack to support printf in SYSCALLS_REQUIRE_FILESYSTEM=0
  var num = 0;
  for (var i = 0; i < iovcnt; i++) {
    var ptr = HEAPU32[((iov) >> 2)];
    var len = HEAPU32[(((iov) + (4)) >> 2)];
    iov += 8;
    for (var j = 0; j < len; j++) {
      printChar(fd, HEAPU8[ptr + j]);
    }
    num += len;
  }
  HEAPU32[((pnum) >> 2)] = num;
  return 0;
}

var getCFunc = ident => {
  var func = Module["_" + ident];
  // closure exported function
  return func;
};

/** @type {!Int8Array} */ var HEAP8;

var writeArrayToMemory = (array, buffer) => {
  HEAP8.set(array, buffer);
};

var lengthBytesUTF8 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
    // unit, not a Unicode code point of the character! So decode
    // UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var c = str.charCodeAt(i);
    // possibly a lead surrogate
    if (c <= 127) {
      len++;
    } else if (c <= 2047) {
      len += 2;
    } else if (c >= 55296 && c <= 57343) {
      len += 4;
      ++i;
    } else {
      len += 3;
    }
  }
  return len;
};

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
  // undefined and false each don't write out any bytes.
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1;
  // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
    // and https://www.ietf.org/rfc/rfc2279.txt
    // and https://tools.ietf.org/html/rfc3629
    var u = str.codePointAt(i);
    if (u <= 127) {
      if (outIdx >= endIdx) break;
      heap[outIdx++] = u;
    } else if (u <= 2047) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++] = 192 | (u >> 6);
      heap[outIdx++] = 128 | (u & 63);
    } else if (u <= 65535) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++] = 224 | (u >> 12);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      heap[outIdx++] = 240 | (u >> 18);
      heap[outIdx++] = 128 | ((u >> 12) & 63);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
      // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
      // We need to manually skip over the second code unit for correct iteration.
      i++;
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx] = 0;
  return outIdx - startIdx;
};

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);

var stringToUTF8OnStack = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8(str, ret, size);
  return ret;
};

/**
   * @param {string|null=} returnType
   * @param {Array=} argTypes
   * @param {Array=} args
   * @param {Object=} opts
   */ var ccall = (ident, returnType, argTypes, args, opts) => {
  // For fast lookup of conversion functions
  var toC = {
    "string": str => {
      var ret = 0;
      if (str !== null && str !== undefined && str !== 0) {
        // null string
        ret = stringToUTF8OnStack(str);
      }
      return ret;
    },
    "array": arr => {
      var ret = stackAlloc(arr.length);
      writeArrayToMemory(arr, ret);
      return ret;
    }
  };
  function convertReturnValue(ret) {
    if (returnType === "string") {
      return UTF8ToString(ret);
    }
    if (returnType === "boolean") return Boolean(ret);
    return ret;
  }
  var func = getCFunc(ident);
  var cArgs = [];
  var stack = 0;
  if (args) {
    for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]];
      if (converter) {
        if (stack === 0) stack = stackSave();
        cArgs[i] = converter(args[i]);
      } else {
        cArgs[i] = args[i];
      }
    }
  }
  var ret = func(...cArgs);
  function onDone(ret) {
    if (stack !== 0) stackRestore(stack);
    return convertReturnValue(ret);
  }
  ret = onDone(ret);
  return ret;
};

/**
   * @param {string=} returnType
   * @param {Array=} argTypes
   * @param {Object=} opts
   */ var cwrap = (ident, returnType, argTypes, opts) => {
  // When the function takes numbers and returns a number, we can just return
  // the original function
  var numericArgs = !argTypes || argTypes.every(type => type === "number" || type === "boolean");
  var numericRet = returnType !== "string";
  if (numericRet && numericArgs && !opts) {
    return getCFunc(ident);
  }
  return (...args) => ccall(ident, returnType, argTypes, args, opts);
};

/** @type {!Float32Array} */ var HEAPF32;

PThread.init();

// End JS library code
// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.
{
  // With WASM_ESM_INTEGRATION this has to happen at the top level and not
  // delayed until processModuleArgs.
  initMemory();
  // Begin ATMODULES hooks
  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
  if (Module["print"]) out = Module["print"];
  if (Module["printErr"]) err = Module["printErr"];
  // End ATMODULES hooks
  if (Module["arguments"]) programArgs = Module["arguments"];
  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
  var preInit = Module["preInit"];
  if (preInit) {
    if (typeof preInit == "function") Module["preInit"] = preInit = [ preInit ];
    // Written as a loop so that preInit functions that themselves add more
    // preInit functions.  Is this actually needed?
    while (preInit.length > 0) {
      preInit.shift()();
    }
  }
}

// Begin runtime exports
Module["ccall"] = ccall;

Module["cwrap"] = cwrap;

// End runtime exports
// Begin JS library exports
// End JS library exports
// end include: postlibrary.js
// proxiedFunctionTable specifies the list of functions that can be called
// either synchronously or asynchronously from other threads in postMessage()d
// or internally queued events. This way a pthread in a Worker can synchronously
// access e.g. the DOM on the main thread.
var proxiedFunctionTable = [ _proc_exit, exitOnMainThread, pthreadCreateProxied, __setitimer_js, _fd_write ];

// Imports from the Wasm binary.
var _create_world, _world_enable_sleeping, _bind_game_buffers, _free, _malloc, _create_body_box, _create_body_circle, _create_body, _create_body_polygon, _destroy_body, _body_set_transform, _body_set_linear_velocity, _body_set_angular_velocity, _body_set_fixed_rotation, _body_set_type, _body_apply_force, _body_apply_force_center, _body_set_linear_damping, _body_set_angular_damping, _body_set_gravity_scale, _body_apply_linear_impulse, _body_apply_linear_impulse_center, _body_apply_angular_impulse, _body_apply_torque, _body_set_awake, _body_set_filter, _body_set_friction, _body_set_restitution, _body_set_sleep_threshold, _world_set_hit_event_threshold, _world_explode, _joint_configure, _body_set_density, _body_add_shape_box, _body_set_shape_box, _body_add_shape_circle, _body_set_shape_circle, _body_add_shape_polygon, _body_set_shape_polygon, _body_clear_shapes, _overlap_aabb_into, _overlap_aabb, _overlap_circle, _overlap_box, _cast_ray_closest, _cast_ray_all, _cast_mover, _collide_mover, _create_revolute_joint, _create_distance_joint, _create_prismatic_joint, _create_weld_joint, _create_distance_joint_local, _create_revolute_joint_local, _create_weld_joint_local, _destroy_joint, _get_joint_count, _step_world, _get_state_byte_offset, _get_sleeping_byte_offset, _get_meta_byte_offset, _get_body_capacity, _get_max_body_slots, _get_slot_count, _get_state_channel_offset, _get_meta_float_stride, _get_state_region_bytes, _get_meta_region_bytes, _get_joint_byte_offset, _get_joint_float_stride, _get_joint_region_bytes, _get_joint_capacity, _get_query_slots_byte_offset, _get_query_hits_byte_offset, _get_event_header_byte_offset, _get_contact_begin_byte_offset, _get_contact_end_byte_offset, _get_contact_hit_byte_offset, _get_sensor_begin_byte_offset, _get_sensor_end_byte_offset, _get_joint_events_byte_offset, _get_joint_event_capacity, _get_mover_planes_byte_offset, _get_query_capacity, _get_ray_hit_capacity, _get_query_hit_float_stride, _get_contact_event_capacity, _get_sensor_event_capacity, _get_contact_hit_capacity, _get_mover_plane_capacity, _get_mover_plane_float_stride, _get_event_header_int_count, _get_contact_pair_int_stride, _get_body_move_count, _get_body_move_byte_offset, _get_body_fell_asleep_byte_offset, _get_body_move_capacity, _get_awake_body_count, _get_profile_byte_offset, _get_profile_float_count, _get_counters_byte_offset, _get_counters_int_count, _create_particle_system, _destroy_particle_system, _create_particle_box, _create_particle_group_box, _create_particle_group_circle, _destroy_particle_group, _set_particle_sub_steps, _set_particle_tuning, _set_group_viscous_scale, _get_particle_group_slot_count, _get_particle_group_alive, _get_particle_group_particle_count, _get_particle_group_center_x, _get_particle_group_center_y, _get_particle_group_vx, _get_particle_group_vy, _get_particle_group_angular_velocity, _get_particle_group_angle, _get_particle_group_viscous_scale, _get_particle_group_first_index, _get_particle_group_last_index, _get_particle_group_flags, _join_particle_groups, _split_particle_group, _particle_apply_force, _particle_apply_linear_impulse, _particle_group_apply_force, _particle_group_apply_linear_impulse, _particle_query_aabb, _particle_ray_cast, _get_particle_query_hit, _get_particle_query_hits_byte_offset, _get_sync_particle_groups_max, _get_sync_particle_groups_byte_offset, _sync_active_particle_groups, _cull_particles_outside_bounds, _get_particle_weight_byte_offset, _restore_particles, _get_particle_group_index_byte_offset, _get_particle_rest_offset_byte_offset, _get_particle_pair_count, _copy_particle_group_slots, _copy_particle_pairs, _restore_particle_groups_and_pairs, _get_particle_count, _get_liquidfun_step_ms, _get_lf_worker_count, _get_particle_capacity, _get_particle_radius, _get_particle_count_byte_offset, _get_particle_pos_byte_offset, _get_particle_vel_byte_offset, _get_particle_flags_byte_offset, _get_particle_x_byte_offset, _get_particle_alpha_byte_offset, _get_particle_y_byte_offset, _get_particle_vx_byte_offset, _get_particle_vy_byte_offset, _weedjs_heap_bytes_used, __emscripten_tls_init, _pthread_self, __emscripten_thread_init, ___set_thread_state, __emscripten_thread_crashed, __emscripten_run_js_on_main_thread_done, __emscripten_run_js_on_main_thread, __emscripten_thread_free_data, __emscripten_thread_exit, __emscripten_timeout, __emscripten_check_mailbox, _emscripten_stack_set_limits, __emscripten_stack_restore, __emscripten_stack_alloc, _emscripten_stack_get_current, __indirect_function_table, wasmTable;

function assignWasmExports(wasmExports) {
  _create_world = Module["_create_world"] = wasmExports["u"];
  _world_enable_sleeping = Module["_world_enable_sleeping"] = wasmExports["v"];
  _bind_game_buffers = Module["_bind_game_buffers"] = wasmExports["w"];
  _free = Module["_free"] = wasmExports["x"];
  _malloc = Module["_malloc"] = wasmExports["y"];
  _create_body_box = Module["_create_body_box"] = wasmExports["z"];
  _create_body_circle = Module["_create_body_circle"] = wasmExports["A"];
  _create_body = Module["_create_body"] = wasmExports["B"];
  _create_body_polygon = Module["_create_body_polygon"] = wasmExports["C"];
  _destroy_body = Module["_destroy_body"] = wasmExports["D"];
  _body_set_transform = Module["_body_set_transform"] = wasmExports["E"];
  _body_set_linear_velocity = Module["_body_set_linear_velocity"] = wasmExports["F"];
  _body_set_angular_velocity = Module["_body_set_angular_velocity"] = wasmExports["G"];
  _body_set_fixed_rotation = Module["_body_set_fixed_rotation"] = wasmExports["H"];
  _body_set_type = Module["_body_set_type"] = wasmExports["I"];
  _body_apply_force = Module["_body_apply_force"] = wasmExports["J"];
  _body_apply_force_center = Module["_body_apply_force_center"] = wasmExports["K"];
  _body_set_linear_damping = Module["_body_set_linear_damping"] = wasmExports["L"];
  _body_set_angular_damping = Module["_body_set_angular_damping"] = wasmExports["M"];
  _body_set_gravity_scale = Module["_body_set_gravity_scale"] = wasmExports["N"];
  _body_apply_linear_impulse = Module["_body_apply_linear_impulse"] = wasmExports["O"];
  _body_apply_linear_impulse_center = Module["_body_apply_linear_impulse_center"] = wasmExports["P"];
  _body_apply_angular_impulse = Module["_body_apply_angular_impulse"] = wasmExports["Q"];
  _body_apply_torque = Module["_body_apply_torque"] = wasmExports["R"];
  _body_set_awake = Module["_body_set_awake"] = wasmExports["S"];
  _body_set_filter = Module["_body_set_filter"] = wasmExports["T"];
  _body_set_friction = Module["_body_set_friction"] = wasmExports["U"];
  _body_set_restitution = Module["_body_set_restitution"] = wasmExports["V"];
  _body_set_sleep_threshold = Module["_body_set_sleep_threshold"] = wasmExports["W"];
  _world_set_hit_event_threshold = Module["_world_set_hit_event_threshold"] = wasmExports["X"];
  _world_explode = Module["_world_explode"] = wasmExports["Y"];
  _joint_configure = Module["_joint_configure"] = wasmExports["Z"];
  _body_set_density = Module["_body_set_density"] = wasmExports["_"];
  _body_add_shape_box = Module["_body_add_shape_box"] = wasmExports["$"];
  _body_set_shape_box = Module["_body_set_shape_box"] = wasmExports["aa"];
  _body_add_shape_circle = Module["_body_add_shape_circle"] = wasmExports["ba"];
  _body_set_shape_circle = Module["_body_set_shape_circle"] = wasmExports["ca"];
  _body_add_shape_polygon = Module["_body_add_shape_polygon"] = wasmExports["da"];
  _body_set_shape_polygon = Module["_body_set_shape_polygon"] = wasmExports["ea"];
  _body_clear_shapes = Module["_body_clear_shapes"] = wasmExports["fa"];
  _overlap_aabb_into = Module["_overlap_aabb_into"] = wasmExports["ga"];
  _overlap_aabb = Module["_overlap_aabb"] = wasmExports["ha"];
  _overlap_circle = Module["_overlap_circle"] = wasmExports["ia"];
  _overlap_box = Module["_overlap_box"] = wasmExports["ja"];
  _cast_ray_closest = Module["_cast_ray_closest"] = wasmExports["ka"];
  _cast_ray_all = Module["_cast_ray_all"] = wasmExports["la"];
  _cast_mover = Module["_cast_mover"] = wasmExports["ma"];
  _collide_mover = Module["_collide_mover"] = wasmExports["na"];
  _create_revolute_joint = Module["_create_revolute_joint"] = wasmExports["oa"];
  _create_distance_joint = Module["_create_distance_joint"] = wasmExports["pa"];
  _create_prismatic_joint = Module["_create_prismatic_joint"] = wasmExports["qa"];
  _create_weld_joint = Module["_create_weld_joint"] = wasmExports["ra"];
  _create_distance_joint_local = Module["_create_distance_joint_local"] = wasmExports["sa"];
  _create_revolute_joint_local = Module["_create_revolute_joint_local"] = wasmExports["ta"];
  _create_weld_joint_local = Module["_create_weld_joint_local"] = wasmExports["ua"];
  _destroy_joint = Module["_destroy_joint"] = wasmExports["va"];
  _get_joint_count = Module["_get_joint_count"] = wasmExports["wa"];
  _step_world = Module["_step_world"] = wasmExports["xa"];
  _get_state_byte_offset = Module["_get_state_byte_offset"] = wasmExports["ya"];
  _get_sleeping_byte_offset = Module["_get_sleeping_byte_offset"] = wasmExports["za"];
  _get_meta_byte_offset = Module["_get_meta_byte_offset"] = wasmExports["Aa"];
  _get_body_capacity = Module["_get_body_capacity"] = wasmExports["Ba"];
  _get_max_body_slots = Module["_get_max_body_slots"] = wasmExports["Ca"];
  _get_slot_count = Module["_get_slot_count"] = wasmExports["Da"];
  _get_state_channel_offset = Module["_get_state_channel_offset"] = wasmExports["Ea"];
  _get_meta_float_stride = Module["_get_meta_float_stride"] = wasmExports["Fa"];
  _get_state_region_bytes = Module["_get_state_region_bytes"] = wasmExports["Ga"];
  _get_meta_region_bytes = Module["_get_meta_region_bytes"] = wasmExports["Ha"];
  _get_joint_byte_offset = Module["_get_joint_byte_offset"] = wasmExports["Ia"];
  _get_joint_float_stride = Module["_get_joint_float_stride"] = wasmExports["Ja"];
  _get_joint_region_bytes = Module["_get_joint_region_bytes"] = wasmExports["Ka"];
  _get_joint_capacity = Module["_get_joint_capacity"] = wasmExports["La"];
  _get_query_slots_byte_offset = Module["_get_query_slots_byte_offset"] = wasmExports["Ma"];
  _get_query_hits_byte_offset = Module["_get_query_hits_byte_offset"] = wasmExports["Na"];
  _get_event_header_byte_offset = Module["_get_event_header_byte_offset"] = wasmExports["Oa"];
  _get_contact_begin_byte_offset = Module["_get_contact_begin_byte_offset"] = wasmExports["Pa"];
  _get_contact_end_byte_offset = Module["_get_contact_end_byte_offset"] = wasmExports["Qa"];
  _get_contact_hit_byte_offset = Module["_get_contact_hit_byte_offset"] = wasmExports["Ra"];
  _get_sensor_begin_byte_offset = Module["_get_sensor_begin_byte_offset"] = wasmExports["Sa"];
  _get_sensor_end_byte_offset = Module["_get_sensor_end_byte_offset"] = wasmExports["Ta"];
  _get_joint_events_byte_offset = Module["_get_joint_events_byte_offset"] = wasmExports["Ua"];
  _get_joint_event_capacity = Module["_get_joint_event_capacity"] = wasmExports["Va"];
  _get_mover_planes_byte_offset = Module["_get_mover_planes_byte_offset"] = wasmExports["Wa"];
  _get_query_capacity = Module["_get_query_capacity"] = wasmExports["Xa"];
  _get_ray_hit_capacity = Module["_get_ray_hit_capacity"] = wasmExports["Ya"];
  _get_query_hit_float_stride = Module["_get_query_hit_float_stride"] = wasmExports["Za"];
  _get_contact_event_capacity = Module["_get_contact_event_capacity"] = wasmExports["_a"];
  _get_sensor_event_capacity = Module["_get_sensor_event_capacity"] = wasmExports["$a"];
  _get_contact_hit_capacity = Module["_get_contact_hit_capacity"] = wasmExports["ab"];
  _get_mover_plane_capacity = Module["_get_mover_plane_capacity"] = wasmExports["bb"];
  _get_mover_plane_float_stride = Module["_get_mover_plane_float_stride"] = wasmExports["cb"];
  _get_event_header_int_count = Module["_get_event_header_int_count"] = wasmExports["db"];
  _get_contact_pair_int_stride = Module["_get_contact_pair_int_stride"] = wasmExports["eb"];
  _get_body_move_count = Module["_get_body_move_count"] = wasmExports["fb"];
  _get_body_move_byte_offset = Module["_get_body_move_byte_offset"] = wasmExports["gb"];
  _get_body_fell_asleep_byte_offset = Module["_get_body_fell_asleep_byte_offset"] = wasmExports["hb"];
  _get_body_move_capacity = Module["_get_body_move_capacity"] = wasmExports["ib"];
  _get_awake_body_count = Module["_get_awake_body_count"] = wasmExports["jb"];
  _get_profile_byte_offset = Module["_get_profile_byte_offset"] = wasmExports["kb"];
  _get_profile_float_count = Module["_get_profile_float_count"] = wasmExports["lb"];
  _get_counters_byte_offset = Module["_get_counters_byte_offset"] = wasmExports["mb"];
  _get_counters_int_count = Module["_get_counters_int_count"] = wasmExports["nb"];
  _create_particle_system = Module["_create_particle_system"] = wasmExports["ob"];
  _destroy_particle_system = Module["_destroy_particle_system"] = wasmExports["pb"];
  _create_particle_box = Module["_create_particle_box"] = wasmExports["qb"];
  _create_particle_group_box = Module["_create_particle_group_box"] = wasmExports["rb"];
  _create_particle_group_circle = Module["_create_particle_group_circle"] = wasmExports["sb"];
  _destroy_particle_group = Module["_destroy_particle_group"] = wasmExports["tb"];
  _set_particle_sub_steps = Module["_set_particle_sub_steps"] = wasmExports["ub"];
  _set_particle_tuning = Module["_set_particle_tuning"] = wasmExports["vb"];
  _set_group_viscous_scale = Module["_set_group_viscous_scale"] = wasmExports["wb"];
  _get_particle_group_slot_count = Module["_get_particle_group_slot_count"] = wasmExports["xb"];
  _get_particle_group_alive = Module["_get_particle_group_alive"] = wasmExports["yb"];
  _get_particle_group_particle_count = Module["_get_particle_group_particle_count"] = wasmExports["zb"];
  _get_particle_group_center_x = Module["_get_particle_group_center_x"] = wasmExports["Ab"];
  _get_particle_group_center_y = Module["_get_particle_group_center_y"] = wasmExports["Bb"];
  _get_particle_group_vx = Module["_get_particle_group_vx"] = wasmExports["Cb"];
  _get_particle_group_vy = Module["_get_particle_group_vy"] = wasmExports["Db"];
  _get_particle_group_angular_velocity = Module["_get_particle_group_angular_velocity"] = wasmExports["Eb"];
  _get_particle_group_angle = Module["_get_particle_group_angle"] = wasmExports["Fb"];
  _get_particle_group_viscous_scale = Module["_get_particle_group_viscous_scale"] = wasmExports["Gb"];
  _get_particle_group_first_index = Module["_get_particle_group_first_index"] = wasmExports["Hb"];
  _get_particle_group_last_index = Module["_get_particle_group_last_index"] = wasmExports["Ib"];
  _get_particle_group_flags = Module["_get_particle_group_flags"] = wasmExports["Jb"];
  _join_particle_groups = Module["_join_particle_groups"] = wasmExports["Kb"];
  _split_particle_group = Module["_split_particle_group"] = wasmExports["Lb"];
  _particle_apply_force = Module["_particle_apply_force"] = wasmExports["Mb"];
  _particle_apply_linear_impulse = Module["_particle_apply_linear_impulse"] = wasmExports["Nb"];
  _particle_group_apply_force = Module["_particle_group_apply_force"] = wasmExports["Ob"];
  _particle_group_apply_linear_impulse = Module["_particle_group_apply_linear_impulse"] = wasmExports["Pb"];
  _particle_query_aabb = Module["_particle_query_aabb"] = wasmExports["Qb"];
  _particle_ray_cast = Module["_particle_ray_cast"] = wasmExports["Rb"];
  _get_particle_query_hit = Module["_get_particle_query_hit"] = wasmExports["Sb"];
  _get_particle_query_hits_byte_offset = Module["_get_particle_query_hits_byte_offset"] = wasmExports["Tb"];
  _get_sync_particle_groups_max = Module["_get_sync_particle_groups_max"] = wasmExports["Ub"];
  _get_sync_particle_groups_byte_offset = Module["_get_sync_particle_groups_byte_offset"] = wasmExports["Vb"];
  _sync_active_particle_groups = Module["_sync_active_particle_groups"] = wasmExports["Wb"];
  _cull_particles_outside_bounds = Module["_cull_particles_outside_bounds"] = wasmExports["Xb"];
  _get_particle_weight_byte_offset = Module["_get_particle_weight_byte_offset"] = wasmExports["Yb"];
  _restore_particles = Module["_restore_particles"] = wasmExports["Zb"];
  _get_particle_group_index_byte_offset = Module["_get_particle_group_index_byte_offset"] = wasmExports["_b"];
  _get_particle_rest_offset_byte_offset = Module["_get_particle_rest_offset_byte_offset"] = wasmExports["$b"];
  _get_particle_pair_count = Module["_get_particle_pair_count"] = wasmExports["ac"];
  _copy_particle_group_slots = Module["_copy_particle_group_slots"] = wasmExports["bc"];
  _copy_particle_pairs = Module["_copy_particle_pairs"] = wasmExports["cc"];
  _restore_particle_groups_and_pairs = Module["_restore_particle_groups_and_pairs"] = wasmExports["dc"];
  _get_particle_count = Module["_get_particle_count"] = wasmExports["ec"];
  _get_liquidfun_step_ms = Module["_get_liquidfun_step_ms"] = wasmExports["fc"];
  _get_lf_worker_count = Module["_get_lf_worker_count"] = wasmExports["gc"];
  _get_particle_capacity = Module["_get_particle_capacity"] = wasmExports["hc"];
  _get_particle_radius = Module["_get_particle_radius"] = wasmExports["ic"];
  _get_particle_count_byte_offset = Module["_get_particle_count_byte_offset"] = wasmExports["jc"];
  _get_particle_pos_byte_offset = Module["_get_particle_pos_byte_offset"] = wasmExports["kc"];
  _get_particle_vel_byte_offset = Module["_get_particle_vel_byte_offset"] = wasmExports["lc"];
  _get_particle_flags_byte_offset = Module["_get_particle_flags_byte_offset"] = wasmExports["mc"];
  _get_particle_x_byte_offset = Module["_get_particle_x_byte_offset"] = wasmExports["nc"];
  _get_particle_alpha_byte_offset = Module["_get_particle_alpha_byte_offset"] = wasmExports["oc"];
  _get_particle_y_byte_offset = Module["_get_particle_y_byte_offset"] = wasmExports["pc"];
  _get_particle_vx_byte_offset = Module["_get_particle_vx_byte_offset"] = wasmExports["qc"];
  _get_particle_vy_byte_offset = Module["_get_particle_vy_byte_offset"] = wasmExports["rc"];
  _weedjs_heap_bytes_used = Module["_weedjs_heap_bytes_used"] = wasmExports["sc"];
  __emscripten_tls_init = wasmExports["tc"];
  _pthread_self = wasmExports["uc"];
  __emscripten_thread_init = wasmExports["wc"];
  ___set_thread_state = wasmExports["xc"];
  __emscripten_thread_crashed = wasmExports["yc"];
  __emscripten_run_js_on_main_thread_done = wasmExports["zc"];
  __emscripten_run_js_on_main_thread = wasmExports["Ac"];
  __emscripten_thread_free_data = wasmExports["Bc"];
  __emscripten_thread_exit = wasmExports["Cc"];
  __emscripten_timeout = wasmExports["Dc"];
  __emscripten_check_mailbox = wasmExports["Ec"];
  _emscripten_stack_set_limits = wasmExports["Fc"];
  __emscripten_stack_restore = wasmExports["Gc"];
  __emscripten_stack_alloc = wasmExports["Hc"];
  _emscripten_stack_get_current = wasmExports["Ic"];
  __indirect_function_table = wasmTable = wasmExports["vc"];
}

var wasmImports;

function assignWasmImports() {
  wasmImports = {
    /** @export */ d: ___pthread_create_js,
    /** @export */ n: __abort_js,
    /** @export */ g: __emscripten_init_main_thread_js,
    /** @export */ p: __emscripten_notify_mailbox_postmessage,
    /** @export */ c: __emscripten_receive_on_main_thread_js,
    /** @export */ l: __emscripten_runtime_keepalive_clear,
    /** @export */ q: __emscripten_thread_cleanup,
    /** @export */ f: __emscripten_thread_mailbox_await,
    /** @export */ j: __emscripten_thread_set_strongref,
    /** @export */ m: __setitimer_js,
    /** @export */ s: _clock_time_get,
    /** @export */ e: _emscripten_check_blocking_allowed,
    /** @export */ i: _emscripten_exit_with_live_runtime,
    /** @export */ b: _emscripten_get_now,
    /** @export */ o: _emscripten_resize_heap,
    /** @export */ r: _exit,
    /** @export */ h: _fd_write,
    /** @export */ a: wasmMemory,
    /** @export */ k: _proc_exit
  };
}

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===
async function run() {
  if ((ENVIRONMENT_IS_PTHREAD)) {
    initRuntime();
    return;
  }
  preRun();
  if (runDependencies) {
    await resolveRunDependencies();
  }
  var setStatus = Module["setStatus"];
  if (setStatus) {
    setStatus("Running...");
    // Yield to the event loop to allow the browser to paint "Running..."
    await new Promise(resolve => setTimeout(resolve, 1));
    // Then we want to clear the status text, but only after the rest of this function runs.
    setTimeout(setStatus, 1, "");
  }
  if (ABORT) return;
  initRuntime();
  Module["onRuntimeInitialized"]?.();
  postRun();
}

var wasmExports;

if ((!(ENVIRONMENT_IS_PTHREAD))) {
  // Call createWasm on startup if we are the main thread.
  // Worker threads call this once they receive the module via postMessage
  // With async instantation wasmExports is assigned asynchronously when the
  // instance is received.
  createWasm().then(() => run());
}

// end include: postamble.js
// include: D:/xampp/htdocs/Box2d_3.2_C_-_liquidfun/wasm/../weedjs/weed_post.js
// Appended to box2d_wasm.js via --post-js when building for WeedJS.
// Worker entry must be box2d_wasm.js so Emscripten pthread pool spawns this file.
// Pthread pool workers (name "em-pthread") must NOT run app glue.
// Weed loads weedjs_post.js then physics_host.impl.js from the same directory
// (engine src/box2d/). Host speaks Weed init/start and calls weedjsDoStep in-process.
(function() {
  if (self.name === "em-pthread") {
    console.log("[physics] pthread worker — skip app glue");
    return;
  }
  importScripts("weedjs_post.js");
  importScripts("physics_host.impl.js");
})();
