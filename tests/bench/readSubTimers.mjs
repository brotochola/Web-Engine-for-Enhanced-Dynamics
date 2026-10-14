// Read the sub-timers out of an ABBA sitting, per pair and per side.
//
// The gate compares preRender_STEP_MS, which is the right primary but is not the
// loop H-19 changed. STEP_MS on this vehicle turned out to be bimodal because
// EMIT_MS alternates between a full emit and a pose-only shortcut, so a STEP_MS
// win does not automatically mean the collect loop got faster.
//
// A = the baseline worktree (hoist reverted). B = the working tree (hoist applied).

import fs from 'node:fs';

const dir = process.argv[2] || 'tests/results/predator-abab/H19-collect-hoist';

function stat(file, key) {
  const p = `${dir}/${file}`;
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const a = (r.workers || []).find((w) => w.type === 'preRender')?.statsSamplesAverage || {};
  return a[key] ?? null;
}

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
}

const pct = (a, b) => `${a === 0 ? 'n/a' : (((b - a) / a) * 100).toFixed(1)}%`;

const rows = [];
console.log('  pair   COLLECT_MS A -> B            EMIT_MS A -> B           SPRITE_PACK A -> B');
for (let p = 0; p < 4; p++) {
  const a = `A-p${p}.json`;
  const b = `B-p${p}.json`;
  const c1 = stat(a, 'COLLECT_MS');
  const c2 = stat(b, 'COLLECT_MS');
  const e1 = stat(a, 'EMIT_MS');
  const e2 = stat(b, 'EMIT_MS');
  const s1 = stat(a, 'SPRITE_PACK_MS');
  const s2 = stat(b, 'SPRITE_PACK_MS');
  if (c1 == null || c2 == null) {
    console.log(`   ${p}     (missing)`);
    continue;
  }
  rows.push({ p, c: [c1, c2], e: [e1, e2], s: [s1, s2] });
  console.log(
    `   ${p}     ${c1.toFixed(3)} -> ${c2.toFixed(3)}  (${pct(c1, c2).padStart(7)})   ` +
      `${e1.toFixed(3)} -> ${e2.toFixed(3)}   ${s1.toFixed(3)} -> ${s2.toFixed(3)}`,
  );
}

if (!rows.length) process.exit(0);
const ca = rows.map((r) => r.c[0]);
const cb = rows.map((r) => r.c[1]);
const ea = rows.map((r) => r.e[0]);
const eb = rows.map((r) => r.e[1]);
const collectWorse = rows.filter((r) => r.c[1] > r.c[0]).length;

console.log('');
console.log(
  `  median COLLECT_MS   A ${median(ca).toFixed(3)} -> B ${median(cb).toFixed(3)}   ` +
    `(${pct(median(ca), median(cb))}), B worse in ${collectWorse}/${rows.length} pairs`,
);
console.log(
  `  median EMIT_MS      A ${median(ea).toFixed(3)} -> B ${median(eb).toFixed(3)}   ` +
    `(${pct(median(ea), median(eb))})`,
);
console.log('');
console.log('  EMIT_MS per side, in file order - the bimodality check:');
console.log(`    A: ${ea.map((x) => x.toFixed(3)).join('  ')}`);
console.log(`    B: ${eb.map((x) => x.toFixed(3)).join('  ')}`);