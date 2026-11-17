// Served in place of /src/workers/pixiWorker.js by tests/bench/programLinkProbe.mjs: the probe first, then the worker,
// whose file is served beside as /src/workers/pixiWorkerReal.js so its relative imports resolve as they always do.
import '/tests/bench/programLinkProbeGl.js';
import './pixiWorkerReal.js';
