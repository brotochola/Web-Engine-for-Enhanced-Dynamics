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

**16:00** — Starting **B1** (audio voices leaking across buses): reading the SoundManager
bus-list code end to end before writing the failing test.

## Log

### 2026-10-20 15:59 — Started

- Node suite baseline at `80464dc1`: **1169 / 1169 pass**, 10.3 s.
- Wrote [`REVIEW_PLAN.md`](./REVIEW_PLAN.md) from the review (bugs B1–B29, measurement
  M1–M12, dead code D1–D11, duplication R1–R12, GC G1–G7, deopt V1–V6, speed E-41…E-50,
  docs DOC1–DOC7).
- Order: B1–B9 → M1–M6 → B10–B29 → hygiene phases → speed, one hypothesis at a time →
  docs alongside each fix.
