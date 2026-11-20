import test from 'node:test';
import assert from 'node:assert/strict';

import { watchBoot, BOOT_FAILURE_PATTERN } from '../bench/bootWatch.mjs';

// N-254: a scene that failed while booting made runIntegratedWorkerBenchmark wait out its watchdog (warm-up + window +
// 5 min), and measureLib ran it again: a worker that dies outside the engine's handlers shows no fatal overlay, only the
// page's uncaught error. The page's boot watch (bootWatch.mjs, raced with loadScene) fails the boot on either.

/** A stand-in window, an overlay to set, and a clock the test moves with node:test's mocked timers. */
function setup(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  let overlay = null;
  let outcome = null;
  const target = new EventTarget();
  const watch = watchBoot(target, () => overlay, { graceMs: 10000, pollMs: 100, now: () => clock });
  watch.failed.catch((e) => {
    outcome = e;
  });
  return {
    target,
    watch,
    outcome: () => outcome,
    setOverlay: (text) => {
      overlay = text;
    },
    async advance(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
      await new Promise((r) => setImmediate(r));
    },
    uncaught(message) {
      const event = new Event('error');
      event.error = new Error(message);
      target.dispatchEvent(event);
    },
  };
}

test("a worker's uncaught error fails a boot that is not ready 10 s after it", async (t) => {
  const s = setup(t);
  await s.advance(2000);
  s.uncaught('this worker died while booting');
  await s.advance(9900);
  assert.equal(s.outcome(), null, 'within the grace the boot may still finish');
  await s.advance(200);
  assert.match(String(s.outcome()?.message), /Uncaught error while the scene booted: this worker died while booting/);
  assert.match(String(s.outcome()?.message), BOOT_FAILURE_PATTERN, 'the runner knows it for a boot failure');
  s.watch.stop();
});

test('the fatal overlay fails the boot at once, with its text', async (t) => {
  const s = setup(t);
  s.setOverlay('logic0: Worker message handling failed');
  await s.advance(100);
  assert.equal(String(s.outcome()?.message), 'Fatal engine error while the scene booted: logic0: Worker message handling failed');
  s.watch.stop();
});

test('an unhandled rejection counts as an uncaught error', async (t) => {
  const s = setup(t);
  const rejection = new Event('unhandledrejection');
  rejection.reason = new RangeError('Array buffer allocation failed');
  s.target.dispatchEvent(rejection);
  await s.advance(10100);
  assert.match(String(s.outcome()?.message), /Uncaught error while the scene booted: Array buffer allocation failed/);
  s.watch.stop();
});

test('a boot that finishes is never failed: stop() ends the watch, errors after it included', async (t) => {
  const s = setup(t);
  s.uncaught('a stray error the scene boots through');
  await s.advance(3000);
  s.watch.stop();
  s.setOverlay('later');
  s.uncaught('later');
  await s.advance(60000);
  assert.equal(s.outcome(), null);
});
