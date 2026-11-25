# Measuring and testing on GitHub's machines

GitHub Actions runs our tests and kernels on machines we do not have: Linux, Windows and macOS, x64 and ARM. The
repository is public, so GitHub's standard runners cost nothing. This document says how a request runs, where its results
are, and what those numbers may decide. The protocol for speed claims stays [HOW_WE_MEASURE.md](./HOW_WE_MEASURE.md).

## How a request runs

1. A request is a JSON file: a name, and a list of tasks with their machines and how many VMs of each.
2. `node scripts/ciMeasure.mjs submit <request.json> [--base <rev>]` pushes the branch `ci/<name>`: the revision plus one
   commit that adds the request as `ci-request.json`. It needs git's access to the repository and no token.
3. The push starts [`.github/workflows/ci-measure.yml`](../../.github/workflows/ci-measure.yml), which runs one job a VM.
   The workflow runs on `ci/**` branches and nowhere else.
4. Its last job gathers what every job left, also when some failed, and pushes it as the branch `ci-results/<name>`.
5. `node scripts/ciMeasure.mjs wait <name>` waits for that branch and unpacks it to `tests/results/ci/<name>/`
   (git-ignored). `summary.md` is the page to read.
6. Records go to the register by hand, with the machines named. `node scripts/ciMeasure.mjs clean <name>` then deletes
   both branches. GitHub keeps each job's raw files for 90 days; downloading those needs a login.

`status <name>` lists the jobs (the public API, no login). A push to `ci/*` is public while the branch exists.

## Machines

| Key | Runner | What it is for |
|---|---|---|
| `linux` | ubuntu-24.04 | 4 threads of a server CPU; the model changes from VM to VM |
| `linuxArm` | ubuntu-24.04-arm | 4 ARM cores (Neoverse); weak memory order |
| `win` | windows-2025 | the timers and waits of Windows, on a server CPU |
| `winArm` | windows-11-arm | ARM with Windows' waits |
| `mac` | macos-15 | Apple M1, 3 cores, a virtual Metal GPU; five jobs at a time |
| `macIntel` | macos-15-intel | 4 threads of an old Intel CPU |

Linux and Windows VMs have no GPU: a scene there draws in software on the same threads the workers run on, so a scene's
times mean nothing on them, unless it draws nothing (`--no-draw`, what `sceneAb` runs).

## Tasks

| Task | Script | What it answers |
|---|---|---|
| `tests` | Node's test runner | does the suite (and the demos') pass on that machine |
| `race` | [`raceStress.mjs`](../../tests/bench/ci/raceStress.mjs) | does a cross-thread protocol tear on a weakly ordered CPU |
| `repeatTests` | [`repeatTests.mjs`](../../tests/bench/ci/repeatTests.mjs) | how often do the threaded tests fail there |
| `kernelAb` | [`kernelAb.mjs`](../../tests/bench/ci/kernelAb.mjs) | a kernel, revision A against B; `a` and `b` equal is an A/A |
| `sweep` | [`sweep.mjs`](../../tests/bench/ci/sweep.mjs) | old verdicts again: a commit against its parent, or a kernel's variants; every rate each kernel reports |
| `kernelSmoke` | [`kernelSmoke.mjs`](../../tests/bench/ci/kernelSmoke.mjs) | which of the Node kernels still run |
| `d8` | [`runD8.mjs`](../../tests/bench/d8/runD8.mjs) | V8's machine code for a kernel (ARM's on `mac`), or its time in d8 |
| `scenes` | [`sceneSmoke.mjs`](../../tests/bench/ci/sceneSmoke.mjs) | does every demo boot, draw and stay quiet in a browser |
| `sceneAb` | [`sceneAb.mjs`](../../tests/bench/ci/sceneAb.mjs) | scenes of two revisions, each worker's own time, without drawing; `--set all`: every scene both have |
| `frameProbe` | [`frameProbe.mjs`](../../tests/bench/ci/frameProbe.mjs) | how many frames each worker runs on that machine, by the way Chromium is started |
| `bench` | `runIntegratedWorkerBenchmark.mjs` | one scene run, where the machine has a GPU |

## measure:all, two revisions in one page

`npm run measure:all -- --a v0.14.0 --b v0.15.0` compares two revisions (two releases, or a release and `HEAD`) and writes one
page, `tests/results/measure-all/<name>/page.md` (git-ignored), and its numbers beside it:

- **Exact**, from git: the bundles' and the WASM modules' bytes, the lines of code, the test cases.
- **Kernels**: every Node kernel that reaches the engine, with the variant the engine ships
  ([`shipped.mjs`](../../tests/bench/ci/shipped.mjs)), src/ of one against src/ of the other in the same VM (a sweep of
  `{ "revs": { a, b } }`). A kernel written for the second that does not run on the first is tried as it was then; one that
  runs neither way is listed, not left out. A kernel moved when it did by 3 % or more, past its machine's limit.
- **Scenes**: eight scenes, each revision with its own, in Chromium with draw calls that do nothing
  ([`noDrawSource.mjs`](../../tests/bench/noDrawSource.mjs)): each worker's own time a frame, Pixi's uploads and state calls
  among it, on machines without a GPU ([`sceneAb.mjs`](../../tests/bench/ci/sceneAb.mjs)). What the GPU takes is not in them,
  nor the frames on the screen. Until 2026-11-25 they ran with `--disable-gl-drawing-for-tests`, under which SwiftShader still
  drew on Linux: the renderer and pre-render ran 2 to 30 frames in 8 s (300 to 478 now), and their times were of cold frames.
  A row says the frames behind it when they are few or not alike, and a scene that is not the same on both sides has a `*`.
- **Health**, when the second is the commit checked out: the suites, the races and the demos.

A kernel that computes something else on each side (its checksums differ) is marked: its speed is read with that. A kernel's line has its worst
and best case beside the mean, and the parts of the engine are read by their median. Kernels are pieces of a frame, not
frames: what a game gets is the scenes' (`npm run bench:scoreboard`), on a GPU.

## The measures kept (DX-MEASURES)

Every measure:all of a release or of a merged performance commit is kept as it came, against nothing:
`node scripts/measures.mjs save <name>` writes `docs/internal/measures/<date>-<name>.json` (both sides' rounds by VM, the
frames behind each scene, each VM's CPU, the exact numbers), `list` names them and `compare <measure>:a <measure>:b` takes
any two sides. Two sides of one measure ran in the same VMs. Of two measures, a case is compared on the CPU models both saw:
the same code (v0.15.0) in three measures of two days reads 0.5 to 0.7 % apart in the median case, nine in ten within 5.5 %
(Neoverse N2 and Xeon 6975P within about 2 %, EPYC within 3 to 11). Three loops that never change, timed at the start and the
end of every job to correct for the VM, were tried and dropped (2026-11-25): two VMs of one CPU model read the same code 0.56 %
apart as they came and 5.5 % apart over them, for the loops' own rates move more than the kernels' (7 to 12 % from a job's
start to its end).

## What the numbers may decide

1. **A and B run in the same VM, alternating.** VMs of one kind differ by 40 % and more; a difference between two VMs is
   never evidence. A VM is one observation: 8 of them or more a machine kind.
2. **The A/A gives the limit.** A kernel's detection limit on a machine is 2.5 x the spread of its VMs / √VMs, as in
   HOW_WE_MEASURE; a kernel whose limit is over the bar there is not read there.
3. **A dropped idea reopens** when it wins 3 % or more, over the limit, on two CPU families. Its scene sitting on the
   reference machine decides.
4. **A kept change is questioned** when it loses as much on two families. One that wins on x86 and loses on ARM goes to
   the owner with both numbers.
5. **No engine change is kept on GitHub's numbers alone.** A bug (a torn read, a failing test) is a bug on one machine.
6. Apple's chips and Zen 4/5 weigh more than server ARM: players have them.
7. No hardware counters: VMs do not expose them reliably. GPU times on Linux and Windows do not exist.

## Calibration (2026-11-24)

An A/A of the catalog's kernels, 5 rounds, one VM an observation (R-1982). The limit is what a difference must pass there.

| Machine | VMs | Limit, median | Limit, 9 of 10 kernels | Kernels at 3 % or less | Minutes a VM |
|---|---|---|---|---|---|
| `linux` | 8 | 0.5 % | 1.4 % | 39 of 41 | 10 to 14 |
| `linuxArm` | 8 | 0.4 % | 2.4 % | 39 of 41 | 12 |
| `win` | 6 | 1.0 % | 6.3 % | 33 of 41 | 9 to 16 |
| `winArm` | 4 | 0.7 % | 2.3 % | 39 of 41 | 32 |
| `mac` | 1, 9 rounds | not a limit: the one VM's A/A differed 2.3 % (median), 5.7 % (9 of 10) | | | 20 |

`audioSlots` and `queryPublish` cannot be read on x64, nor `gpuQueuePack` on ARM. The M1 is for bugs, its GPU and machine
code, not for times. GitHub may not find a Mac for a job (one was dropped after 15 minutes): Mac jobs go in a request of
their own.
