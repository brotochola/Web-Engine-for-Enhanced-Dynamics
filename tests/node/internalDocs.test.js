import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The internal docs stay navigable: every relative link in docs/ leads to a file of this repository, none
// points into tests/results/ (local results, not kept) or at a path on one machine (file:///…), and
// docs/internal/README.md lists every internal document and report.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docsDir = path.join(root, 'docs');
const internal = path.join(docsDir, 'internal');

function markdownFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const LINK = /\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;

test('every relative link in docs/ leads to a file of the repository', () => {
  const broken = [];
  for (const file of markdownFiles(docsDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(LINK)) {
      const target = m[1];
      if (/^(https?:|mailto:|vscode:|#)/i.test(target)) continue;
      const rel = path.relative(root, file);
      if (/^file:/i.test(target)) { broken.push(`${rel}: ${target} is a path on one machine`); continue; }
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target.split('#')[0]));
      const inRepo = path.relative(root, resolved);
      if (inRepo.split(path.sep)[0] === 'tests' && inRepo.split(path.sep)[1] === 'results') broken.push(`${rel}: ${target} is a local result (tests/results is not kept)`);
      else if (inRepo.startsWith('..')) broken.push(`${rel}: ${target} leaves the repository`);
      else if (!fs.existsSync(resolved)) broken.push(`${rel}: ${target} does not exist`);
    }
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

test('docs/internal/README.md lists every internal document and report', () => {
  const readme = fs.readFileSync(path.join(internal, 'README.md'), 'utf8');
  const listed = new Set([...readme.matchAll(LINK)].map((m) => path.resolve(internal, decodeURIComponent(m[1].split('#')[0]))));
  const missing = markdownFiles(internal)
    .filter((f) => path.basename(f) !== 'README.md' && !listed.has(f))
    .map((f) => path.relative(internal, f));
  assert.deepEqual(missing, [], `not in docs/internal/README.md: ${missing.join(', ')}`);
});
