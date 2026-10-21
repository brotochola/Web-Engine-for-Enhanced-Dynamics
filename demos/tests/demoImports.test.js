import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Demos are games built on the engine: they take engine names from WEED
// (/src/index.js), as a game built on a bundle must (N-41). The tests here
// may import src internals; the demos may not.
const demos = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(demos, { recursive: true })
  .filter((name) => typeof name === 'string' && name.endsWith('.js'))
  .filter((name) => !name.replace(/\\/g, '/').startsWith('tests/'));

test('no demo imports an engine module other than /src/index.js', () => {
  assert.ok(files.length > 50, `only ${files.length} demo files found`);
  const deep = [];
  for (const name of files) {
    const src = readFileSync(join(demos, name), 'utf8');
    for (const m of src.matchAll(/from\s*['"](\/src\/[^'"]+)['"]|import\(\s*['"](\/src\/[^'"]+)['"]/g)) {
      const target = m[1] || m[2];
      if (target !== '/src/index.js') deep.push(`${name}: ${target}`);
    }
  }
  assert.deepEqual(deep, []);
});
