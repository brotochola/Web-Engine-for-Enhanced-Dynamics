#!/usr/bin/env node
/**
 * E-528: the entity hooks' declarations in types/weed.d.ts (GameObject's methods and their static forms) and the
 * guide's hook table (docs/guide/bible_of_weed_js.md) are written from the one hook table, src/core/entityHooks.js,
 * between their BEGIN and END markers. Edit the table, then run this; tests/node/entityHooksSync.test.js fails while
 * either region is stale.
 *
 *   node scripts/syncEntityHooks.mjs           # write both regions
 *   node scripts/syncEntityHooks.mjs --check   # exit 1 when a region differs from the table
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TYPES_FILE = path.join(root, 'types/weed.d.ts');
export const GUIDE_FILE = path.join(root, 'docs/guide/bible_of_weed_js.md');

const TYPES_BEGIN = '  // BEGIN entity hooks: scripts/syncEntityHooks.mjs writes them from src/core/entityHooks.js (edit the table).';
const TYPES_END = '  // END entity hooks';
const GUIDE_BEGIN = '<!-- BEGIN entity hooks: scripts/syncEntityHooks.mjs writes this table from src/core/entityHooks.js -->';
const GUIDE_END = '<!-- END entity hooks -->';
const WIDTH = 120;

/** A JSDoc comment at `indent`, on one line when it fits in WIDTH columns, else wrapped. */
function docComment(indent, text) {
  const one = `${indent}/** ${text} */`;
  if (one.length <= WIDTH) return [one];
  const lines = [`${indent}/**`];
  let line = `${indent} *`;
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > WIDTH && line !== `${indent} *`) {
      lines.push(line);
      line = `${indent} *`;
    }
    line += ` ${word}`;
  }
  lines.push(line, `${indent} */`);
  return lines;
}

const typedParams = (params) => params.map(([name, type]) => `${name}: ${type}`).join(', ');

/** A method declaration at two spaces, its parameters one a line when it does not fit in WIDTH columns. */
function declaration(head, params) {
  const one = `  ${head}(${typedParams(params)}): void;`;
  if (one.length <= WIDTH) return [one];
  return [`  ${head}(`, ...params.map(([name, type]) => `    ${name}: ${type},`), '  ): void;'];
}
const plainParams = (params) => params.map(([name]) => name).join(', ');

/** The d.ts region: each hook as a method, then its static form. */
export function renderTypesRegion(hooks) {
  const out = [
    TYPES_BEGIN,
    '  // Each entity hook as a method and in its static form (E-528): the static one takes the entity\'s index first, runs',
    '  // with the class as `this` and no instance, wins over the method of the same name and is inherited like one.',
  ];
  for (const hook of hooks) {
    const needs = hook.gate !== null ? `Needs ${hook.gate}. ` : '';
    out.push(...docComment('  ', `${needs}${hook.summary} Runs ${hook.runs}.`));
    out.push(...declaration(hook.name, hook.params));
    out.push(...declaration(`static ${hook.name}?`, [['entityIndex', 'number'], ...hook.params]));
  }
  out.push(TYPES_END);
  return out.join('\n');
}

const cell = (text) => text.replace(/\|/g, '\\|');

/** The guide's region: one row a hook. */
export function renderGuideRegion(hooks) {
  const out = [
    GUIDE_BEGIN,
    '| Method | Static form (no instance) | Needs | When |',
    '|---|---|---|---|',
  ];
  for (const hook of hooks) {
    const method = `\`${hook.name}(${plainParams(hook.params)})\``;
    const statik = `\`static ${hook.name}(${plainParams([['entityIndex'], ...hook.params])})\``;
    const needs = hook.gate !== null ? `\`${hook.gate}\`` : '';
    out.push(`| ${method} | ${statik} | ${needs} | ${cell(hook.summary)} Runs ${cell(hook.runs)}. |`);
  }
  out.push(GUIDE_END);
  return out.join('\n');
}

/** `text` with the region between `begin` and `end` (their lines included) replaced by `region`. */
export function replaceRegion(text, begin, end, region, file) {
  const from = text.indexOf(begin);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`${file}: no "${begin.trim()}" ... "${end.trim()}" region`);
  if (text.indexOf(begin, from + 1) >= 0) throw new Error(`${file}: two entity hook regions`);
  return text.slice(0, from) + region + text.slice(to + end.length);
}

/** Both files as the table writes them: { file, current, wanted }. */
export async function expectedFiles() {
  const { ENTITY_HOOKS } = await import(pathToFileURL(path.join(root, 'src/core/entityHooks.js')).href);
  const types = fs.readFileSync(TYPES_FILE, 'utf8');
  const guide = fs.readFileSync(GUIDE_FILE, 'utf8');
  return [
    { file: TYPES_FILE, current: types, wanted: replaceRegion(types, TYPES_BEGIN, TYPES_END, renderTypesRegion(ENTITY_HOOKS), TYPES_FILE) },
    { file: GUIDE_FILE, current: guide, wanted: replaceRegion(guide, GUIDE_BEGIN, GUIDE_END, renderGuideRegion(ENTITY_HOOKS), GUIDE_FILE) },
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { file, current, wanted } of await expectedFiles()) {
    if (current === wanted) continue;
    stale++;
    if (check) console.error(`${path.relative(root, file)}: its entity hooks differ from src/core/entityHooks.js`);
    else {
      fs.writeFileSync(file, wanted);
      console.log(`wrote ${path.relative(root, file)}`);
    }
  }
  if (check && stale > 0) {
    console.error('run node scripts/syncEntityHooks.mjs');
    process.exitCode = 1;
  } else if (stale === 0) {
    console.log('entity hooks: types/weed.d.ts and the guide match the table');
  }
}
