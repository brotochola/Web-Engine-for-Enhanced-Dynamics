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
times mean nothing on them.

## Tasks

| Task | Script | What it answers |
|---|---|---|
| `tests` | Node's test runner | does the suite (and the demos') pass on that machine |
| `race` | [`raceStress.mjs`](../../tests/bench/ci/raceStress.mjs) | does a cross-thread protocol tear on a weakly ordered CPU |
| `repeatTests` | [`repeatTests.mjs`](../../tests/bench/ci/repeatTests.mjs) | how often do the threaded tests fail there |
| `kernelAb` | [`kernelAb.mjs`](../../tests/bench/ci/kernelAb.mjs) | a kernel, revision A against B; `a` and `b` equal is an A/A |
| `kernelSmoke` | [`kernelSmoke.mjs`](../../tests/bench/ci/kernelSmoke.mjs) | which of the Node kernels still run |
| `d8` | [`runD8.mjs`](../../tests/bench/d8/runD8.mjs) | V8's machine code for a kernel (ARM's on `mac`), or its time in d8 |
| `scenes` | [`sceneSmoke.mjs`](../../tests/bench/ci/sceneSmoke.mjs) | does every demo boot, draw and stay quiet in a browser |
| `bench` | `runIntegratedWorkerBenchmark.mjs` | one scene run, where the machine has a GPU |

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
