// SST-5: the page's side of the asset workers, short-lived module workers that take a scene's asset work off the page's
// main thread while it loads (src/workers/atlasWorker.js, …): start one, post it jobs, take its answers and its load
// marks. A job message is { id, job, ...args }; the answer { id, ok: true, result, marks,
// background } or { id, ok: false, error, marks }; a job that goes on after answering (background: true: a cache write)
// posts { id, backgroundDone: true, marks } when it is done. A page that cannot run one (no module workers, no
// OffscreenCanvas, a bundle built without it, a module that fails to load) gets null or an AssetWorkerUnavailable error,
// and does the job on its own thread: the same code, the same result.

/** One token a page load, as the scene's workers have (sceneWorkerBootstrap.js WORKER_CACHE_BUST). */
const CACHE_BUST = `?v=${Date.now()}`;

/** The worker could not run the job (it did not load): the page does it itself. */
export class AssetWorkerUnavailable extends Error {}

/**
 * A started asset worker: jobs by id, its marks kept until taken.
 */
export class AssetWorker {
  /** @param {Worker} worker */
  constructor(worker) {
    this.worker = worker;
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this.pending = new Map();
    this.nextId = 1;
    /** Why it stopped answering (it did not load), or null. */
    this.failed = null;
    /** Its SST-0 marks, flat [name, ms, …], until takeMarks. */
    this.marks = [];
    /** Jobs it still works for after answering (a cache write), by id. */
    this.background = new Set();
    /** release() was called: it stops once nothing is pending or in the background. */
    this.released = false;
    /** It was terminated. */
    this.closed = false;
    /** After release(): where marks that come later go (a background job's), or null. */
    this.lateMarks = null;
    worker.onmessage = (e) => this._answer(e.data);
    worker.onerror = (e) => {
      e?.preventDefault?.();
      this._fail(new AssetWorkerUnavailable(`asset worker: ${e?.message || 'it did not load'}`));
    };
    worker.onmessageerror = () => this._fail(new AssetWorkerUnavailable('asset worker: a message could not be read'));
  }

  _answer(data) {
    if (Array.isArray(data?.marks)) for (let i = 0; i < data.marks.length; i++) this.marks.push(data.marks[i]);
    if (this.released && this.lateMarks !== null && this.marks.length > 0) this.lateMarks(this.takeMarks());
    if (data?.backgroundDone) {
      this.background.delete(data.id);
      this._stopIfIdle();
      return;
    }
    if (data?.background) this.background.add(data.id);
    const job = this.pending.get(data?.id);
    if (!job) return;
    this.pending.delete(data.id);
    if (data.ok) job.resolve(data.result);
    else {
      const error = new Error(data.error?.message || 'asset worker: the job failed');
      if (data.error?.stack) error.stack = data.error.stack;
      job.reject(error);
    }
    this._stopIfIdle();
  }

  _fail(error) {
    if (this.failed) return;
    this.failed = error;
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
    this.background.clear();
  }

  _stopIfIdle() {
    if (this.released && this.pending.size === 0 && this.background.size === 0) this.close();
  }

  /**
   * Post a job. Rejects with AssetWorkerUnavailable when the worker does not run, with the job's own error when it fails.
   * @param {string} job
   * @param {object} args
   * @param {Transferable[]} [transfer]
   */
  run(job, args, transfer = []) {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...args, id, job }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(new AssetWorkerUnavailable(`asset worker: ${error?.message || error}`));
      }
    });
  }

  /** Its marks so far, flat [name, ms, …], forgotten here. */
  takeMarks() {
    const out = this.marks;
    this.marks = [];
    return out;
  }

  /**
   * The page needs nothing more from it: it stops when its jobs and their background work are done.
   * @param {(marks: Array<string | number>) => void} [lateMarks] gets the marks it posts from now on (a background job's)
   */
  release(lateMarks = null) {
    this.released = true;
    this.lateMarks = lateMarks;
    this._stopIfIdle();
  }

  /** Stop it now (pending jobs reject, background work is dropped). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this._fail(new AssetWorkerUnavailable('asset worker: closed'));
    this.worker.terminate();
  }
}

/**
 * Start an asset worker, or null where none can run: no Worker or OffscreenCanvas, or a bundle without its source
 * (WEED.WorkerSources[script], which scripts/buildBundle.js must embed like the scene's workers).
 * @param {string} script the worker's file in src/workers/, without .js ('atlasWorker')
 * @param {{ makeWorker?: () => Worker, name?: string }} [opts] makeWorker: tests give their own; name: the worker's name
 *   (default the script's without "Worker": 'atlas', 'tilemap'), which its load marks are filed under
 * @returns {Promise<AssetWorker | null>}
 */
export async function startAssetWorker(script, opts = {}) {
  try {
    if (typeof opts.makeWorker === 'function') return new AssetWorker(opts.makeWorker());
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    const weed = typeof window !== 'undefined' ? window.WEED : undefined;
    if (weed?.BUNDLE_MODE) {
      if (!weed.WorkerSources?.[script] || typeof weed.createWorker !== 'function') return null;
      if (typeof weed.ensureEmbeddedSources === 'function') await weed.ensureEmbeddedSources();
      return new AssetWorker(weed.createWorker(script));
    }
    const name = opts.name ?? script.replace(/Worker$/, '');
    return new AssetWorker(new Worker(`/src/workers/${script}.js${CACHE_BUST}`, { type: 'module', name }));
  } catch {
    return null;
  }
}

/**
 * Run a job on the worker when there is one and it runs, else `here()` on this thread.
 * @template T
 * @param {AssetWorker | null} worker
 * @param {string} job
 * @param {object} args
 * @param {Transferable[]} transfer
 * @param {() => Promise<T> | T} here the same job on this thread
 * @returns {Promise<T>}
 */
export async function runJobOrHere(worker, job, args, transfer, here) {
  if (worker) {
    try {
      return await worker.run(job, args, transfer);
    } catch (error) {
      if (!(error instanceof AssetWorkerUnavailable)) throw error;
    }
  }
  return here();
}
