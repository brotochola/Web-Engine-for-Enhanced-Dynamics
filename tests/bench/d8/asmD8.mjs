// Summarize a d8 --print-opt-code --code-comments dump, per optimized code object (V8 16 format):
// size, inlined functions, deopt points, and on the hot path (blocks not marked deferred) the builtins it calls,
// the register calls (JS calls not inlined) with the nearest name above, the inline megamorphic map-cache checks
// (V8 16 inlines them: `(map >> 2) & 7` into a table) with the property they guard, and overflow checks; each split
// into inside a loop or not.
//   node asmD8.mjs <dump.txt> [--min 300] [--filter regex] [--json out.json]
import fs from 'node:fs';

const argv = process.argv.slice(2);
const file = argv[0];
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 ? argv[i + 1] : d;
};
const min = Number(opt('min', 300));
const filter = opt('filter') ? new RegExp(opt('filter')) : null;
const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const NAMED = /<String\[\d+\]: #([^>]+)>|<SharedFunctionInfo ([^>]+)>|<JSFunction ([^ >(]+)/;

const out = [];
for (const chunk of text.split('--- Optimized code ---').slice(1)) {
  const body = chunk.split('--- End code ---')[0];
  const name = (/^name = (.*)$/m.exec(body) || [])[1] || '?';
  const kind = (/^kind = (.*)$/m.exec(body) || [])[1] || '?';
  const size = Number((/Instructions \(size = (\d+)\)/.exec(body) || [])[1] || 0);
  const osr = /^osr_offset = \d+/m.test(body);
  if (size < min || (filter && !filter.test(name))) continue;
  const inl = /Inlined functions \(count = (\d+)\)\n([\s\S]*?)\n\n/.exec(body);
  const inlined = inl ? [...new Set([...inl[2].matchAll(/<SharedFunctionInfo ([^>]*)>/g)].map((m) => m[1]))] : [];
  const deoptPoints = Number((/deopt points = (\d+)/.exec(body) || [])[1] || 0);
  const code = body.split(/\nInlined functions|\nDeoptimization Input Data/)[0].split('\n');
  let deferred = false;
  let inLoop = false;
  const r = { name, kind, osr, size, deoptPoints, inlined, builtins: {}, calls: {}, mega: {}, overflow: { loop: 0, other: 0 }, allocs: 0 };
  const where = () => (inLoop ? 'loop' : 'straight');
  const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
  const nameAbove = (k, span = 10) => {
    for (let q = k - 1; q >= Math.max(0, k - span); q--) {
      const m = NAMED.exec(code[q]);
      if (m) return m[1] || m[2] || m[3];
    }
    return '';
  };
  const nameBelow = (k, span = 40) => {
    for (let q = k + 1; q < Math.min(code.length, k + span); q++) {
      const m = /<String\[\d+\]: #([^>]+)>/.exec(code[q]);
      if (m) return m[1];
    }
    return '?';
  };
  for (let k = 0; k < code.length; k++) {
    const line = code[k];
    const b = /-- B\d+ start(.*)--/.exec(line);
    if (b) {
      deferred = /deferred/.test(b[1]);
      inLoop = /in loop|loop up to/.test(b[1]);
      continue;
    }
    if (deferred) continue;
    // x64: `call <addr>  (Name)`; arm64: `bl #… (addr …)` with the builtin's name after `;; code:` or in brackets.
    let m = /call [0-9A-Fa-f]+\s+\(([A-Za-z_]\w*)\)/.exec(line) ||
      /\bbl #.*?(?:Builtin::|code: |\()([A-Z][A-Za-z_]\w*)/.exec(line);
    if (m && !/Deoptimiz|CompileLazy|RecordWrite/.test(m[1])) {
      bump(r.builtins, `${m[1]} [${where()}]`);
      if (/Allocate/.test(m[1])) r.allocs++;
      continue;
    }
    if (/\bcall r[a-z0-9]+\b|\bcall \[r|\bblr x\d+\b/.test(line)) {
      bump(r.calls, `${nameAbove(k) || '?'} [${where()}]`);
      continue;
    }
    // The inline megamorphic cache: an index of 8 from the map, then the property's name a few lines below.
    if (/andl r\w+,0x7$/.test(line.trim()) && /shrq r\w+,2/.test(code[k - 1] || '')) {
      bump(r.mega, `${nameBelow(k)} [${where()}]`);
      continue;
    }
    if (/\bjo\b|\bb\.vs\b/.test(line)) r.overflow[inLoop ? 'loop' : 'other']++;
  }
  out.push(r);
}

const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ');
for (const r of out) {
  console.log(`## ${r.name} (${r.kind}${r.osr ? ', OSR' : ''}) ${r.size} B, ${r.deoptPoints} deopt points, ${r.inlined.length} inlined`);
  if (r.inlined.length) console.log(`   inlined: ${r.inlined.join(', ')}`);
  if (Object.keys(r.mega).length) console.log(`   megamorphic checks: ${fmt(r.mega)}`);
  if (Object.keys(r.calls).length) console.log(`   JS calls: ${fmt(r.calls)}`);
  if (Object.keys(r.builtins).length) console.log(`   builtins: ${fmt(r.builtins)}`);
  console.log(`   overflow checks: loop ${r.overflow.loop}, other ${r.overflow.other}`);
}
const j = opt('json');
if (j) fs.writeFileSync(j, JSON.stringify(out, null, 2));
