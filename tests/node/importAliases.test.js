import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hot modules re-declare some imports as module consts (`const Grid = GridImport;`):
// TurboFan folds a module const, and the typed arrays its class holds, but reads
// an import's cell at run time (HOW_WE_MEASURE, "Imports in hot code"). The alias
// runs when its module evaluates, so it is only safe when the exporter has already
// finished evaluating and never reassigns the binding. An alias of an import from
// the module's own import cycle throws at load; an alias of an `export let` keeps
// its first value.

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function listModules(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listModules(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const modules = listModules(srcRoot);
const sources = new Map(modules.map((f) => [f, fs.readFileSync(f, 'utf8')]));

/** Relative static imports and re-exports of a module: [{ dep, clause }]. */
function importsOf(file) {
  const out = [];
  const re = /^\s*(?:import|export)\s+([^'";]*?)\s*from\s*'(\.{1,2}\/[^']+)'/gm;
  for (const m of sources.get(file).matchAll(re)) {
    const dep = path.resolve(path.dirname(file), m[2]);
    if (sources.has(dep)) out.push({ dep, clause: m[1] });
  }
  return out;
}

/** Module -> the members of its strongly connected component (Tarjan). */
function importCycles() {
  const edges = new Map(modules.map((f) => [f, importsOf(f).map((i) => i.dep)]));
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const component = new Map();
  let next = 0;
  function visit(v) {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const members = new Set();
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        members.add(w);
      } while (w !== v);
      for (const m of members) component.set(m, members);
    }
  }
  for (const f of modules) if (!index.has(f)) visit(f);
  return component;
}

/** Every `const X = XImport;` alias, with the module its import comes from. */
function aliases() {
  const out = [];
  for (const file of modules) {
    for (const m of sources.get(file).matchAll(/^const ([A-Za-z_$][\w$]*) = \1Import;$/gm)) {
      const name = m[1];
      const from = importsOf(file).find((i) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')} as ${name.replace(/\$/g, '\\$')}Import\\b`).test(i.clause));
      out.push({ file, name, dep: from?.dep });
    }
  }
  return out;
}

const rel = (f) => path.relative(srcRoot, f).replace(/\\/g, '/');

test('the hot modules alias their imports (this test checks something)', () => {
  const files = new Set(aliases().map((a) => rel(a.file)));
  for (const f of ['workers/spatialWorker.js', 'workers/preRenderWorker.js', 'workers/particleWorker.js', 'util/colliderUtils.js']) {
    assert.ok(files.has(f), `${f} has no import aliases`);
  }
});

test('an aliased import comes from outside the importer\'s import cycle', () => {
  const cycles = importCycles();
  for (const { file, name, dep } of aliases()) {
    assert.ok(dep, `${rel(file)}: const ${name} = ${name}Import has no matching \`${name} as ${name}Import\` import`);
    const members = cycles.get(file);
    assert.ok(
      !(members.size > 1 && members.has(dep)),
      `${rel(file)} aliases ${name} from ${rel(dep)}, which is in its own import cycle: the alias would run before ${rel(dep)} has evaluated`,
    );
  }
});

test('an aliased import is never a binding its module reassigns', () => {
  for (const { file, name, dep } of aliases()) {
    const src = sources.get(dep);
    const escaped = name.replace(/\$/g, '\\$');
    assert.ok(
      !new RegExp(`^export\\s+(?:let|var)\\s+${escaped}\\b`, 'm').test(src),
      `${rel(file)} aliases ${name}, which ${rel(dep)} exports as a let: the alias would keep its first value`,
    );
    const declaredLet = new RegExp(`^(?:let|var)\\s+${escaped}\\b`, 'm').test(src);
    const exportedFromList = new RegExp(`^export\\s*\\{[^}]*(?<![\\w$])${escaped}(?![\\w$])`, 'm').test(src);
    assert.ok(!(declaredLet && exportedFromList), `${rel(file)} aliases ${name}, a let that ${rel(dep)} exports`);
  }
});
