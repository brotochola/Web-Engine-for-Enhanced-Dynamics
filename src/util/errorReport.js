/**
 * Game code that throws in a worker: say once which entity and which phase, then
 * count. A tick that throws every frame would otherwise print 60 times a second
 * per entity, or (before this) stop the worker's loop for good.
 *
 * One report per distinct (class, phase, message) per worker: the worker prints
 * the real Error (DevTools links the stack) and posts `entityError` to the scene;
 * repeats only bump a count, re-posted as `entityErrorCount` at most once a
 * second. Distinct keys are capped so a message with a changing number in it
 * cannot grow the map without bound. Only the throw path runs any of this.
 */

export const ERROR_REPORT_MAX_KEYS = 64;
const RECOUNT_MS = 1000;
const OVERFLOW_KEY = '(more distinct errors)';

export class ErrorReporter {
  /**
   * @param {(msg: object) => void} post - postMessage to the scene
   * @param {string} workerName
   * @param {() => number} [now]
   */
  constructor(post, workerName, now = () => performance.now()) {
    this._post = post;
    this._workerName = workerName;
    this._now = now;
    /** key → { count, postedAt } */
    this._seen = new Map();
  }

  /**
   * @param {unknown} error
   * @param {string} phase - 'tick', 'collision callbacks', 'onSpawned', 'frame', …
   * @param {string} [className] - entity class, '' when not tied to one entity
   * @param {number} [entityIndex] - -1 when not tied to one entity
   */
  report(error, phase, className = '', entityIndex = -1) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    let key = `${className}|${phase}|${message}`;
    let rec = this._seen.get(key);
    if (!rec && this._seen.size >= ERROR_REPORT_MAX_KEYS) {
      key = OVERFLOW_KEY;
      rec = this._seen.get(key);
    }
    const t = this._now();
    if (rec) {
      rec.count++;
      if (t - rec.postedAt >= RECOUNT_MS) {
        rec.postedAt = t;
        this._post({ msg: 'entityErrorCount', key, count: rec.count, workerName: this._workerName });
      }
      return;
    }
    this._seen.set(key, { count: 1, postedAt: t });
    const where = className
      ? `${className}${entityIndex >= 0 ? ` #${entityIndex}` : ''} · ${phase}`
      : phase;
    console.error(`WeedJS: ${where} threw (${this._workerName}). Later repeats are counted, not logged.`, error);
    this._post({
      msg: 'entityError',
      key,
      phase,
      className,
      entityIndex,
      message: key === OVERFLOW_KEY ? OVERFLOW_KEY : message,
      stack: error && typeof error.stack === 'string' ? error.stack : '',
      count: 1,
      workerName: this._workerName,
    });
  }
}

/**
 * This worker's reporter. Module-level on purpose: an extra field on the worker
 * classes reshapes them (one instance each, so V8 never trims their in-object
 * slack); a first Predator sitting with a field here had pre-render +3.8 % (9/10 pairs).
 */
let workerReporter = null;

/**
 * @param {unknown} error
 * @param {string} phase
 * @param {string} [className]
 * @param {number} [entityIndex]
 */
export function reportWorkerError(error, phase, className = '', entityIndex = -1) {
  if (workerReporter === null) {
    const scope = globalThis.self || globalThis;
    workerReporter = new ErrorReporter(
      (m) => scope.postMessage(m),
      scope.name || (scope.logicWorker ? 'logic' : 'worker')
    );
  }
  workerReporter.report(error, phase, className, entityIndex);
}
