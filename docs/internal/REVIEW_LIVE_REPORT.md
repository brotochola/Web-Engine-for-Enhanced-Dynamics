# Live report — implementing the 2026-10-20 review

Newest entry first. I update this file as I work, so you can keep it open in VS Code
(Markdown preview refreshes on its own). The plan with every item and its status is
[`REVIEW_PLAN.md`](./REVIEW_PLAN.md); speed hypotheses go to
[`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) as E-41 onward.

**Rules I am working under**
- One commit per fix, title says what code changed plus the item id. Nothing is pushed.
  No AI co-author trailer, per `.cursor/rules/no-cursor-attribution.mdc`.
- A bug gets a failing test first whenever Node can show it, then the fix, then the
  whole node suite.
- Hot-path changes get the protocol's hygiene check (kept unless a primary worker is
  3 % worse). **Before any headed Chromium run I write a "HEADED RUN" line here** — please
  keep the machine quiet while one is running.
- Baseline rev for every A/B is `8af92002^`, never `main`.

## Now

**17:05** — **B4**: raycasted lights touched by a compound occluder draw a quarter circle
at the engine default `maxPolygonVertices` (128).

## Log

### 17:00 — B3 fixed: chain raycasts used a negated denominator (`a14c0c31`)

The ray/segment solve divided by `dir × e` instead of `e × dir`, so the hit distance and the
edge parameter came out negated. I worked every expectation out from the world geometry
before running anything: the old test expected a hit at 3 for a ray along y = 195 against
a square that spans y 203–213 — it was pinning the bug. The rewritten test (rotated and
unrotated loops, an open chain, front and back side, start inside, pointing away) failed on
the old code and passes now. This changes what `Ray.cast`, `castAll` and line of sight
return against chain colliders: real hits now register, phantom hits are gone.

### 16:55 — B1 follow-up: the 12.5 % storm cost is gone (`27751001`)

The cheap fix worked. The cost was the per-entry helper call inside the walk, not the
check: with the check inlined as one compare (word 7 must equal `bus | (i << 8)`), the
`storm` case re-measured against pre-B1 at **41.6 k → 43.0 k plays/s** (5 rounds each;
one 31 k outlier round on the B1 side), so no regression. Catalog key `occ100x3`
164 668 → 169 057 (+2.7 %, TIE). B1 is a hygiene keep at the kernel layer. The AudioStorm
scene check is folded into E-46, which measures that scene anyway.

**Lesson worth keeping:** the catalog key for a row can miss the case a change touches.
For hot-path fixes I now read every case of the kernel, not only the scored one.

### 16:42 — B1 hygiene kernel: catalog keys tie, but the multi-bus `storm` case is ~12 % slower

`runKernelsVsRev --vs HEAD~1 --only audioSlots,audioStorm`, 5 alternating rounds per side:

| Row (catalog key) | Before B1 | After B1 | Verdict |
| --- | ---: | ---: | --- |
| `audioStorm` (`scan2048`, the mixer) | 10 483 ops/s | 10 675 ops/s | TIE (+1.8 %, 68 % rounds) |
| `audioSlots` (`occ100x3`, 3 threads, one bus) | 162 747 | 170 450 | TIE (+4.7 %, 76 % rounds) |

The catalog key does not run the code B1 changed most. The same kernel's **`storm` case**
(three buses at their caps — the AudioStorm regime) does, and it was slower in **every**
round: before B1 42.9 / 42.6 / 41.4 / 41.8 / 42.9 k plays/s, after B1 37.6 / 23.3 / 37.0 /
37.6 / 37.3 k (median 42.6 k → 37.3 k, −12.5 %). That is ~3 µs more per `play()`.

**Why:** since `8af92002`, every `play()` walks the whole bus list (that is E-46); B1 made
each step of that walk check ownership. **What I am doing:** first the cheap fix (inline the
check, hoist the loads) and re-measure `storm`. If it stays above 3 %, I fix the walk itself
(the worklet bumps a per-bus "freed" counter, and `play()` walks only when it moved), which
is E-46's fix and makes the common case O(1) again. A hygiene keep must not cost 3 %.

### 16:35 — B2 fixed: chorded mouse buttons no longer stick (`e29e7684`)

Six new tests drive `Mouse.pointerDown/Move/Up` with the event order the Pointer Events
spec defines for chords. Three failed on the old code (both chord orders left a button
held; a chorded middle press made no edge). Now down, move and up reconcile with the
`buttons` mask. Two guards I added on purpose, each with a test: a drag that started on a
DOM panel (the terrain sliders) does **not** start a press when it crosses the canvas, and
events without a `buttons` mask keep the old path. ToolManager stops painting when the
primary is released inside a chord. ToolManager has no Node test (it needs a DOM); the
change is three lines. Node suite **1179 / 1179**.

### 16:20 — B1 fixed: a bus list only counts voices it still owns (`85b74217`)

**The bug, reproduced first.** Two new tests failed on the old code exactly as the review
predicted: with buses `ui` (1 voice) and `sfx`, a `ui` click ends on the audio thread, an
`sfx` boom takes the freed slot 0, and then a quiet `ui` click was **dropped** (the `ui`
bus still counted slot 0 as its own) and a louder `ui` click **stole the boom**.

**The fix.** A bus-list entry now counts as live only while the slot is PLAYING *and* its
word 7 still names this bus and this list position. Stealing the cached quietest voice
checks the same thing, and checks word 7 again right after its CAS: if the audio thread
freed the slot and another bus re-claimed it in between (it reads PLAYING again — the
classic ABA), the slot is handed back untouched. Word 7 is now written before PLAYING is
published, not after. One more gap I found in my own change: when a failed steal shows the
bus actually has room, the play now takes a free slot instead of dropping.

**Proof the race test is real.** I disabled the post-CAS re-check in a temporary copy: the
ABA test failed. Copies deleted. Node suite **1173 / 1173**.

**Note for E-46.** `play()` still builds a `claim` closure on every call (1200 per tick in
AudioStorm). I left it for E-46 so B1's hygiene check measures only the fix.

### 2026-10-20 15:59 — Started

- Node suite baseline at `80464dc1`: **1169 / 1169 pass**, 10.3 s.
- Wrote [`REVIEW_PLAN.md`](./REVIEW_PLAN.md) from the review (bugs B1–B29, measurement
  M1–M12, dead code D1–D11, duplication R1–R12, GC G1–G7, deopt V1–V6, speed E-41…E-50,
  docs DOC1–DOC7).
- Order: B1–B9 → M1–M6 → B10–B29 → hygiene phases → speed, one hypothesis at a time →
  docs alongside each fix.
