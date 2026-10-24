// Did a rebuild change any code? Compares two builds of a module function by function, up to
// renumbering: maps each old function to the new one with the same body once call targets are mapped
// (wasm-opt reorders functions, and an added export shifts indices). Prints the functions that only
// one side has. Code that maps 1:1 compiles to the same machine code, so no kernel can time it apart.
//
//   node tests/bench/wasmSameCode.mjs old.wasm src/box2d/box2dWasm.wasm
//
// Uses Binaryen's wasm-dis (WASM_DIS, or the sibling Box2D repository's emsdk). First used for the
// Box2D memory build (docs/internal/reports/DX-MEM-box2d-memory.md).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIS = process.env.WASM_DIS || 'D:/xampp/htdocs/Box2d_3.2_C_-_liquidfun/emsdk/upstream/bin/wasm-dis.exe';

/** Defined functions of a module, as wasm-dis prints them: { name, body } in index order. */
function functions(wasmPath) {
  const text = execFileSync(DIS, [wasmPath], { maxBuffer: 1 << 28 }).toString();
  return text
    .split(/\n \(func \$/)
    .slice(1)
    .map((part) => {
      const name = part.slice(0, part.search(/[\s(]/));
      const body = part.slice(name.length);
      return { name, body: body.slice(0, body.indexOf('\n )') + 3) };
    });
}

export function compareBuilds(oldPath, newPath) {
  const A = functions(oldPath);
  const B = functions(newPath);
  const callsMasked = (body) => body.replace(/\(call \$[\w$.]+/g, '(call $X');
  const candidates = new Map();
  B.forEach((f, i) => {
    const k = callsMasked(f.body);
    if (!candidates.has(k)) candidates.set(k, []);
    candidates.get(k).push(i);
  });
  // Bodies equal with calls masked are the candidates; an exact match wins, duplicates go in order.
  const map = new Map();
  const taken = new Set();
  for (const f of A) {
    const free = (candidates.get(callsMasked(f.body)) || []).filter((i) => !taken.has(i));
    const pick = free.find((i) => B[i].body === f.body) ?? free[0];
    if (pick !== undefined) {
      map.set(f.name, B[pick].name);
      taken.add(pick);
    }
  }
  const byName = new Map(B.map((f) => [f.name, f]));
  const differ = [];
  for (const f of A) {
    const g = byName.get(map.get(f.name));
    const mapped = f.body.replace(/\(call \$([\w$.]+)/g, (m, callee) => `(call $${map.get(callee) ?? callee}`);
    if (!g || mapped !== g.body) differ.push(f.name);
  }
  return {
    oldCount: A.length,
    newCount: B.length,
    differ,
    onlyNew: B.filter((f, i) => !taken.has(i)).map((f) => `${f.name} (${f.body.split('\n').length} lines)`),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error('usage: node tests/bench/wasmSameCode.mjs old.wasm new.wasm');
    process.exit(2);
  }
  const r = compareBuilds(oldPath, newPath);
  console.log(`functions: ${r.oldCount} old, ${r.newCount} new`);
  console.log(`old functions whose code changed: ${r.differ.length}${r.differ.length ? ` (${r.differ.slice(0, 20).join(', ')})` : ''}`);
  console.log(`functions only in the new build: ${r.onlyNew.length ? r.onlyNew.join(', ') : 'none'}`);
  process.exitCode = r.differ.length ? 1 : 0;
}
