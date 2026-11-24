/** What this machine is: every CI result carries it, so a number is never read without the CPU it came from. */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** One `Name:   value` line of lscpu's output. */
function lscpuField(text, name) {
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0 && line.slice(0, at).trim() === name) return line.slice(at + 1).trim();
  }
  return null;
}

export function describeMachine() {
  const cpus = os.cpus();
  const out = {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpu: cpus[0]?.model?.trim() || null,
    threads: cpus.length,
    memoryGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    v8: process.versions.v8,
    image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ''}`.trim() : null,
    sha: process.env.GITHUB_SHA || tryRun('git', ['rev-parse', 'HEAD']),
  };
  if (out.platform === 'linux') {
    const lscpu = tryRun('lscpu', []);
    if (lscpu) {
      out.cpu = lscpuField(lscpu, 'Model name') || out.cpu;
      out.threadsPerCore = Number(lscpuField(lscpu, 'Thread(s) per core')) || null;
      out.caches = ['L1d', 'L2', 'L3'].map((k) => `${k} ${lscpuField(lscpu, `${k} cache`) || lscpuField(lscpu, k) || '?'}`).join(', ');
    }
  } else if (out.platform === 'darwin') {
    out.cpu = tryRun('sysctl', ['-n', 'machdep.cpu.brand_string']) || out.cpu;
    out.cacheLineBytes = Number(tryRun('sysctl', ['-n', 'hw.cachelinesize'])) || null;
    out.perfCores = Number(tryRun('sysctl', ['-n', 'hw.perflevel0.physicalcpu'])) || null;
    out.efficiencyCores = Number(tryRun('sysctl', ['-n', 'hw.perflevel1.physicalcpu'])) || null;
  }
  return out;
}
