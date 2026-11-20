/**
 * N-254: a scene that fails while booting never reports ready, so loadScene waits forever, and the integrated runner
 * waited out its watchdog (warm-up + window + 5 min) before it gave up; measureLib then ran it again. The page races
 * loadScene with this watch, which fails the boot:
 *   - at once when the engine shows its fatal overlay (a worker that reported its error: the text it shows);
 *   - GRACE_MS after the page's first uncaught error or unhandled rejection, when the scene has still not booted. A
 *     worker that dies outside every handler of the engine's reaches the page that way and nowhere else; a scene that
 *     boots despite a stray error is not failed by it.
 * The runner exits with BOOT_FAILURE_EXIT on such a failure, and measureLib does not run it again.
 */

/** The runner's exit code when the scene failed while booting. */
export const BOOT_FAILURE_EXIT = 4;
/** How long the boot may go on after an uncaught error before it counts as failed. */
export const BOOT_ERROR_GRACE_MS = 10000;
/** The text every boot failure's message holds (box2dMemorySurvey.mjs reads the fatal overlay's line by it too). */
export const BOOT_FAILURE_PATTERN = /while the scene booted: /;

function describe(event) {
  const reason = event?.reason ?? event?.error;
  const text = reason?.message ?? (reason != null ? String(reason) : event?.message);
  return String(text ?? event).replace(/\s+/g, ' ').trim();
}

/**
 * Watch a scene's boot on `target` (the page's window).
 * @param {EventTarget} target
 * @param {() => string | null} fatalText the engine's fatal overlay as one line, or null when there is none
 * @param {{ graceMs?: number, pollMs?: number, now?: () => number }} [opts]
 * @returns {{ failed: Promise<never>, stop: () => void }} `failed` rejects with the boot's failure; stop() ends the watch
 */
export function watchBoot(target, fatalText, { graceMs = BOOT_ERROR_GRACE_MS, pollMs = 100, now = () => Date.now() } = {}) {
  let firstError = null;
  let firstAt = 0;
  let reject = null;
  const failed = new Promise((_, r) => {
    reject = r;
  });
  const onError = (event) => {
    if (firstError !== null) return;
    firstError = describe(event);
    firstAt = now();
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onError);
  const timer = setInterval(() => {
    const text = fatalText();
    if (text) {
      reject(new Error(`Fatal engine error while the scene booted: ${text}`));
    } else if (firstError !== null && now() - firstAt >= graceMs) {
      reject(new Error(`Uncaught error while the scene booted: ${firstError} (not ready ${graceMs} ms after it)`));
    }
  }, pollMs);
  return {
    failed,
    stop() {
      clearInterval(timer);
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onError);
    },
  };
}
