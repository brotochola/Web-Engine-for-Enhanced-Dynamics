// N-303 CR-0: scripts/codeSize.mjs's line classes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { countLines } from '../../scripts/codeSize.mjs';

test('countLines: code, comment and blank lines, a trailing comment counts as code', () => {
  const text = [
    '// a line comment',
    'const a = 1; // code with a comment after it',
    '',
    '   ',
    '/* a block',
    '   comment over',
    '   three lines */',
    'const b = /* inline */ 2;',
    '/* closed */ const c = 3;',
    '/** doc */',
    '  return a;',
  ].join('\n');
  assert.deepEqual(countLines(text), { code: 4, comment: 5, blank: 2 });
});

test('countLines: CRLF line ends count the same', () => {
  assert.deepEqual(countLines('a();\r\n\r\n// c\r\n'), { code: 1, comment: 1, blank: 2 });
});
