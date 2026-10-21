#!/usr/bin/env node
/**
 * types/weed.d.ts is written by hand, so it drifts from the code: methods ship
 * untyped, and declarations outlive what they describe. This compares the
 * public members the runtime really has with what the .d.ts declares.
 *
 *   node scripts/checkTypesDrift.mjs            # fails on a missing declaration
 *   node scripts/checkTypesDrift.mjs --all      # also list classes that only report
 *
 * Gated (exit 1 when the runtime has a public member the .d.ts lacks):
 * GameObject, Scene, GameEngine, and the keys of the WEED namespace. Public =
 * not starting with "_". Declared but not at runtime is reported as stale.
 * No TypeScript dependency: the class blocks are read with a brace counter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dts = fs.readFileSync(path.join(root, 'types/weed.d.ts'), 'utf8');
const showAll = process.argv.includes('--all');

/** Body text of `export declare class Name … { … }` or `export interface Name … { … }`. */
function blockOf(kind, name) {
  const re = new RegExp(`export (?:declare )?${kind} ${name}\\b[^{]*\\{`);
  const m = re.exec(dts);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < dts.length && depth > 0; i++) {
    const c = dts[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return dts.slice(start, i - 1);
}

/** Member names declared at the top level of a block (static ones separately; methods noted). */
function declaredMembers(body) {
  const inst = new Set();
  const stat = new Set();
  const methods = new Set();
  if (body === null) return { inst, stat, methods };
  let depth = 0;
  let line = '';
  const flush = () => {
    const m = /^\s*(static\s+)?(?:readonly\s+)?(get\s+|set\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*([?!]?)\s*([(:<])/.exec(line);
    if (m && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
      (m[1] ? stat : inst).add(m[3]);
      // A required method (not an optional field typed as a function) must exist at runtime.
      if (!m[2] && m[4] !== '?' && (m[5] === '(' || m[5] === '<')) methods.add(m[3]);
    }
    line = '';
  };
  for (const c of body) {
    if (depth === 0 && c === '\n') {
      flush();
      continue;
    }
    if (c === '{' || c === '(' || c === '<' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === '>' || c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 || line.length < 200) line += c;
  }
  flush();
  return { inst, stat, methods };
}

function runtimeMembers(Cls) {
  const inst = new Set();
  for (let p = Cls.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k !== 'constructor' && !k.startsWith('_')) inst.add(k);
    }
    if (Object.getPrototypeOf(p) === Object.prototype) break;
  }
  const stat = new Set();
  for (const k of Object.getOwnPropertyNames(Cls)) {
    if (!['length', 'name', 'prototype'].includes(k) && !k.startsWith('_')) stat.add(k);
  }
  return { inst, stat };
}

const idx = await import(pathToFileURL(path.join(root, 'src/index.js')).href);
const WEED = idx.default;

const GATED = ['GameObject', 'Scene', 'GameEngine'];
/** Public by name, engine plumbing in fact: not part of the game-facing types. */
const INTERNAL = new Set([
  'GameObject.bindToEntitySlot',
  'GameObject.ENTITY_TYPE_FORCE_PROCESS_FLAG_COUNT',
  'GameObject.activeEntitiesData',
  'GameObject.cameraData',
  'GameObject.globalEntityCount',
  'GameObject.initializeArrays',
  'GameObject.initializeFreeList',
  'GameObject.neighborData',
  'GameObject.nextTick',
  'Scene.ensureOptionalComponentPools',
  'Scene.killWorkers',
]);
const REPORTED = ['RigidBody', 'Collider', 'SpriteRenderer', 'Tween', 'Camera', 'Layer', 'Query', 'SoundManager'];

let missingCount = 0;
const lines = [];
for (const name of [...GATED, ...(showAll ? REPORTED : [])]) {
  const Cls = WEED[name];
  const body = blockOf('class', name);
  const decl = declaredMembers(body);
  const run = runtimeMembers(Cls);
  const isInternal = (k) => INTERNAL.has(`${name}.${k}`);
  const missing = [...run.inst].filter((k) => !decl.inst.has(k) && !decl.stat.has(k) && !isInternal(k));
  const missingStatic = [...run.stat].filter((k) => !decl.stat.has(k) && !decl.inst.has(k) && !isInternal(k));
  // Fields and component accessors are made at runtime, so only declared methods can be stale.
  const stale = [...decl.methods].filter((k) => k !== 'constructor' && !run.inst.has(k) && !run.stat.has(k));
  const gated = GATED.includes(name);
  if (gated) missingCount += missing.length + missingStatic.length;
  if (missing.length || missingStatic.length || stale.length) {
    lines.push(`${name}${gated ? '' : ' (report only)'}:`);
    if (missing.length) lines.push(`  missing in .d.ts: ${missing.sort().join(', ')}`);
    if (missingStatic.length) lines.push(`  missing static in .d.ts: ${missingStatic.sort().join(', ')}`);
    if (stale.length) lines.push(`  declared, not at runtime: ${stale.sort().join(', ')}`);
  }
}

const ns = declaredMembers(blockOf('interface', 'WeedNamespace'));
const enums = declaredMembers(blockOf('interface', 'WeedEnums'));
const nsMissing = Object.keys(WEED).filter((k) => !ns.inst.has(k) && !enums.inst.has(k) && !k.startsWith('_'));
if (nsMissing.length) {
  missingCount += nsMissing.length;
  lines.push(`WEED namespace:\n  missing in WeedNamespace: ${nsMissing.sort().join(', ')}`);
}

if (lines.length) console.log(lines.join('\n'));
if (missingCount > 0) {
  console.error(`\ntypes drift: ${missingCount} public runtime member(s) not declared in types/weed.d.ts`);
  process.exitCode = 1;
} else {
  console.log('types drift: GameObject, Scene, GameEngine and WEED are declared');
}
