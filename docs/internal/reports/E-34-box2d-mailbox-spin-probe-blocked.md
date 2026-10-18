# E-34 — the Box2D mailbox spin: probe blocked on an instrument that does not exist

**Date:** 2026-10-18. **Verdict: NOT started. Probe blocked — and the blocker is named.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-34.

## What is already settled

E-04b answered the configuration half, and its answer is why the configuration half is
dead:

- `physics.box2dWorkerCount` ∈ {1,2,3,4} → **`4` confirmed**. Step 10.7 / 7.5 / 6.4 /
  5.8 ms for 1→4 (1.86×), load spread 0.0 %.
- The 2026-10-01 mailbox-spin confound is resolved: bystanders move ≤0.12 ms when the
  worker count changes.
- A **smaller pool** costs the solver threads (+26.2 %, 2026-10-01); a **smaller worker
  count** costs the solver its parallelism (+86 %, E-04b). Neither lever reaches the spin.

So **~2.4 cores idle in the Emscripten mailbox is real, and no configuration reaches it.**

## The premise, confirmed

I verified the mechanism exists and is the wait primitive, rather than carrying it as an
assertion. In the sibling build (`weedjs/box2d_wasm.js`, the same artifact the engine
loads via `src/box2d/box2dWasm.js`):

- `:209` `__emscripten_thread_init(msgData.pthread_ptr, /*is_main=*/0, /*is_runtime=*/0, /*can_block=*/1, …)`
- **`:213` `__emscripten_thread_mailbox_await(msgData.pthread_ptr)`**

So a Box2D pthread with no work parks in `__emscripten_thread_mailbox_await`. That is the
thing burning 2.4 cores, and **the engine cannot see it**: it lives inside the Emscripten
pthread runtime, below any engine stat, which is why E-01's `IDLE_MS` (75–99 % idle on every
engine worker) and this 2.4-core figure coexist without contradicting each other. They are
measuring different populations — engine workers versus Box2D's internal pthreads.

## Why the probe is blocked, precisely

E-34 asks, per **E-30**, for a premise measurement before any edit: **how much of the 2.4
cores is the mailbox, and how much would a different wait primitive recover?** Two things
are needed and neither exists.

**1. The spin behaviour is in the compiled `.wasm`, not the glue.** Whether
`__emscripten_thread_mailbox_await` spins or blocks on a futex is decided by libcompiler-rt
C code compiled into the binary. The JS glue only calls it. So the premise "threads spin
whether or not they have work" **cannot be confirmed from source in this repository or the
sibling** — only from the runtime's behaviour.

**2. No engine stat records it, and it could not.** The plan already flags this as
proposal P-3: the declared secondary metric is **process CPU in core-seconds per frame**,
which is a property of the *process*, not of any worker. `runBox2dWorkerCountSweep.mjs`
does not capture it, and no `*_MS` stat can: the spin is not on the engine's call path, it
is threads the engine does not own. It would need one of:

- a **sampling CPU profiler** attached to the Chromium renderer process, or
- **OS-level per-thread CPU** (on Windows, per-thread times for the renderer's threads),
  correlated against `box2dWorkerCount`, or
- a build of the Emscripten runtime with `spin` counters exposed to JS.

All three are **projects**, and the third additionally requires rebuilding a vendor runtime
that sits adjacent to audio real-time behaviour — the "bar is high" the plan already names.

## What I am not doing, and why it is the right call

I did **not** build any of the three instruments this session. The reason is that E-34 has
already been paid for once: the 2026-10-01 experiment (pool 4→2) "cannot tell 'the solver
needs the cores' from 'the metric charged us for the spin it removed'". **Building an
unvalidated CPU instrument and then acting on it would repeat exactly that error** — this
campaign has twice now deleted a broken instrument rather than ship its output (E-13's
kernel, E-24's analyzer), and a third instance of it would be a pattern rather than an
accident.

So the deliverable here is the specification, not the number. That is a real result: the
next person to open E-34 now knows the instrument, knows it must be validated against the
known 4-vs-1 worker-count difference first, and knows the premise cannot be checked from
source.

## Verdict

**NOT started. Probe blocked on a named instrument.**

- Confirmed: the wait primitive is `__emscripten_thread_mailbox_await`, and it is invisible
  to every engine stat by construction.
- Not confirmed, and not confirmable from source: whether it spins.
- Not measured: how many core-seconds, and what a different wait primitive recovers.
- **Prerequisite before any build:** validate the CPU instrument against the
  `box2dWorkerCount` 4→1 difference, which is a ~2× step with an expected direction. An
  instrument that does not show it is not an instrument.