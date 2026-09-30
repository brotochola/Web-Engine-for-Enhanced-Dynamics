#!/usr/bin/env node
/**
 * Summarize a Chrome/Playwright CPU trace (engine_trace.json) per thread, in ms.
 *
 *   node tests/bench/summarizeChromeCpuTrace.mjs tests/results/v8-deopt/after-h9/engine_trace.json
 *   node tests/bench/summarizeChromeCpuTrace.mjs <trace> --from-ms 10000 --duration-ms 10000
 *   node tests/bench/summarizeChromeCpuTrace.mjs <trace> --vs tests/results/v8-deopt/after/cpu-summary.json
 *
 * Writes cpu-summary.json and hot-lines.md next to the trace (or --out dir).
 * CPU samples are not STEP_MS: this says where a worker spends its busy time,
 * the worker's STEP_MS says whether a change paid.
 */
import fs from 'node:fs';
import path from 'node:path';

import { diffSummaries, readCpuTrace, summarizeCpuTrace } from './cpuTraceLib.mjs';

function parseArgs(argv) {
  const out = { file: null, limit: 30, fromMs: undefined, durationMs: undefined, vs: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Math.max(1, parseInt(argv[++i], 10) || 30);
    else if (a === '--from-ms' && argv[i + 1]) out.fromMs = Number(argv[++i]);
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = Number(argv[++i]);
    else if (a === '--vs' && argv[i + 1]) out.vs = path.resolve(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (!a.startsWith('--') && !out.file) out.file = path.resolve(a);
  }
  return out;
}

const fmtMs = (v) => v.toFixed(1).padStart(9);
const fmtPct = (v) => `${v.toFixed(1)}%`.padStart(7);

function hotLinesMarkdown(summary) {
  const lines = [
    '# Líneas calientes por hilo',
    '',
    `Trace: \`${summary.file}\`. Ventana desde ${summary.window.fromMs} ms${summary.window.durationMs ? `, ${summary.window.durationMs} ms` : ''}. Intervalo mediano entre muestras: ${summary.medianDeltaUs.toFixed(0)} µs.`,
    '',
    'Tiempo propio (self). El porcentaje de cada línea es sobre el tiempo propio de su función.',
    '',
  ];
  for (const t of summary.threads) {
    if (t.kind === 'other' || !t.hotLines.length) continue;
    lines.push(`## ${t.label} (${t.threadName})`);
    lines.push('');
    lines.push(`Ocupado ${t.busyMsPerS.toFixed(0)} ms/s, GC ${t.gcMs.toFixed(0)} ms en la ventana.`);
    lines.push('');
    for (const h of t.hotLines) {
      lines.push(`### ${h.fn} (${h.fnMs.toFixed(1)} ms)`);
      lines.push('');
      const callers = t.callers[h.fn];
      if (callers?.length) {
        lines.push(`Callers: ${callers.map((c) => `${c.key} ${c.pct.toFixed(0)}%`).join('; ')}`);
        lines.push('');
      }
      if (!h.lines.length) {
        lines.push('(sin muestras con línea)');
        lines.push('');
        continue;
      }
      lines.push('```text');
      for (const l of h.lines) {
        lines.push(`${String(l.line).padStart(5)} ${l.pctOfFn.toFixed(0).padStart(3)}%  ${l.text ?? ''}`);
      }
      lines.push('```');
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file || path.resolve('tests/results/v8-deopt/engine_trace.json');
  if (!fs.existsSync(file)) {
    console.error(`missing ${file}`);
    process.exitCode = 1;
    return;
  }
  const trace = await readCpuTrace(file, { fromMs: args.fromMs, durationMs: args.durationMs });
  const summary = summarizeCpuTrace(trace, { limit: args.limit });
  if (args.vs) {
    summary.vs = { file: args.vs, kinds: diffSummaries(JSON.parse(fs.readFileSync(args.vs, 'utf8')), summary) };
  }

  const outDir = args.out || path.dirname(file);
  fs.mkdirSync(outDir, { recursive: true });
  const outJson = path.join(outDir, 'cpu-summary.json');
  const outMd = path.join(outDir, 'hot-lines.md');
  fs.writeFileSync(outJson, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.writeFileSync(outMd, hotLinesMarkdown(summary), 'utf8');

  console.log(
    `Events ${summary.events} | window from ${summary.window.fromMs} ms | median sample interval ${summary.medianDeltaUs.toFixed(0)} µs`
  );
  console.log('\n## Threads (busy ms per second of window)');
  for (const t of summary.threads) {
    console.log(
      `${t.label.padEnd(22)} busy ${t.busyMsPerS.toFixed(0).padStart(4)} ms/s  gc ${t.gcMs.toFixed(0).padStart(4)} ms  samples ${t.samples}  (${t.threadName})`
    );
  }
  for (const [kind, k] of Object.entries(summary.kinds)) {
    if (kind === 'other') continue;
    console.log(`\n## ${kind} (${k.threads.length} thread${k.threads.length > 1 ? 's' : ''}, max ${k.maxThreadBusyMsPerS.toFixed(0)} ms/s busy)`);
    console.log('   self ms   %busy   function');
    for (const r of k.self.slice(0, 12)) console.log(`${fmtMs(r.ms)} ${fmtPct(r.pct)}   ${r.key}`);
  }
  if (summary.vs) {
    console.log(`\n## vs ${summary.vs.file} (percentage points of busy time)`);
    for (const [kind, d] of Object.entries(summary.vs.kinds)) {
      if (kind === 'other') continue;
      console.log(`\n${kind}: max busy ${d.busyMsPerSBase.toFixed(0)} → ${d.busyMsPerSCur.toFixed(0)} ms/s`);
      for (const r of d.rows.slice(0, 8)) {
        console.log(`  ${(r.deltaPts >= 0 ? '+' : '') + r.deltaPts.toFixed(1)} pts  ${r.basePct.toFixed(1)} → ${r.curPct.toFixed(1)}  ${r.key}`);
      }
    }
  }
  console.log(`\nWrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
