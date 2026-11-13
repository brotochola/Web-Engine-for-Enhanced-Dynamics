import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { calleeAt, parseBytecode, parseCodeName, parseInlining, summarizeCodeLogs, unescapeV8 } from '../bench/summarizeV8Code.mjs';

// The lines below have the shape of Chrome 151's logs with --log-code --log-code-disassemble (2026-11-13).

/** V8's log escapes, the inverse of unescapeV8. */
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/,/g, '\\x2C').replace(/\n/g, '\\n');

test('log text: escapes come back', () => {
  assert.equal(unescapeV8('a\\x2Cb\\nc\\\\d\\u00e9'), 'a,b\nc\\dé');
});

test('code names: function, normalized url, line and column', () => {
  assert.deepEqual(parseCodeName('_findFlowfieldSlot http://127.0.0.1:49972/src/core/navGrid.js:868:28'), {
    name: '_findFlowfieldSlot', url: '/src/core/navGrid.js', line: 868, col: 28,
  });
  assert.equal(parseCodeName('get params http://h:1/src/index.js?v=17:337:13').name, 'get params');
  assert.equal(parseCodeName('get params http://h:1/src/index.js?v=17:337:13').url, '/src/index.js');
  assert.equal(parseCodeName(' http://h:1/src/a.js:1:1').name, '(anonymous)');
});

test('inlining table: entries name their function, call position and parent', () => {
  const { sfis, entries } = parseInlining('F0O70299F1O719I0F4O21230I3', 'S0x34c0219eac8S0x34c0197fed8');
  assert.deepEqual(sfis, ['0x34c0219eac8', '0x34c0197fed8']);
  assert.deepEqual(entries, [
    { fn: 0, pos: 70299, parent: -1 },
    { fn: 1, pos: 719, parent: 0 },
    { fn: 4, pos: 21230, parent: 3 },
  ]);
});

test('bytecode: header counts, instructions, positions and length', () => {
  const bc = parseBytecode([
    'Parameter count 2',
    'Register count 10',
    'Frame size 80',
    '30771 S> 0x7d75015600b4 @    0 : 34 02 00 00       GetNamedProperty <this>, [0:"_flowfieldSlotSize"], FBV[0]',
    '         0x7d75015600b8 @    4 : d7                Star0',
    '31675 S> 0x7d750156012b @  119 : bb                Return',
  ].join('\n'));
  assert.equal(bc.params, 2);
  assert.equal(bc.registers, 10);
  assert.equal(bc.length, 120);
  assert.deepEqual(bc.ops.map((o) => [o.pos, o.offset, o.op]), [[30771, 0, 'GetNamedProperty'], [-1, 4, 'Star0'], [31675, 119, 'Return']]);
});

test('callee at a call position: identifier, property, new, and the receiver', () => {
  const src = 'x = Atomics.load(u, i); y = foo(1); z = new A.B(2); w = this.bar(3); v = o[k](4);';
  assert.deepEqual(calleeAt(src, src.indexOf('load')), { name: 'load', receiver: 'Atomics' });
  assert.deepEqual(calleeAt(src, src.indexOf('foo')), { name: 'foo', receiver: null });
  assert.deepEqual(calleeAt(src, src.indexOf('new')), { name: 'B', receiver: 'A' });
  assert.deepEqual(calleeAt(src, src.indexOf('bar')), { name: 'bar', receiver: 'this' });
  // A computed callee puts the position on the parenthesis, with no name before it.
  assert.equal(calleeAt(src, src.indexOf('(4)')), null);
  assert.deepEqual(calleeAt('f (1)', 2), { name: 'f', receiver: null });
});

test('an optimized function: inlined and left-out calls, the reason, OSR and recompiles', async () => {
  const src = 'function outer(a){\n  return inner(a) + other(a);\n}\nfunction inner(a){ return a; }\nfunction other(a){ return a; }\n';
  const pInner = src.indexOf('inner(a) +');
  const pOther = src.indexOf('other(a);');
  const url = 'http://127.0.0.1:1/src/core/a.js';
  const outerBc = [
    'Parameter count 2', 'Register count 2', 'Frame size 16',
    `${pInner} E> 0x1 @    0 : 1a 02 03 00       CallUndefinedReceiver1 r0, a0, FBV[0]`,
    `${pOther} E> 0x2 @    4 : 1a 02 03 02       CallUndefinedReceiver1 r1, a0, FBV[2]`,
    '         0x3 @    8 : bb                Return',
  ].join('\n');
  const leafBc = 'Parameter count 2\nRegister count 0\nFrame size 0\n         0x4 @    0 : bb                Return';
  const log = [
    `script-source,7,${url},${esc(src)}`,
    `code-creation,JS,10,100,0x10,9,outer ${url}:1:1,0xa1,~`,
    'code-source-info,0x10,7,0,40,C0O1,,',
    `code-disassemble,0x10,INTERPRETED_FUNCTION,${esc(outerBc)}`,
    `code-creation,JS,10,101,0x20,500,inner ${url}:4:1,0xa2,~`,
    'code-source-info,0x20,7,41,70,C0O1,,',
    `code-disassemble,0x20,INTERPRETED_FUNCTION,${esc(leafBc)}`,
    `code-creation,JS,10,102,0x30,12,other ${url}:5:1,0xa3,~`,
    'code-source-info,0x30,7,72,100,C0O1,,',
    `code-disassemble,0x30,INTERPRETED_FUNCTION,${esc(leafBc)}`,
    `code-creation,JS,13,150,0x50,700,outer ${url}:1:1,0xa1,o*`,
    'code-source-info,0x50,7,0,40,C0O1,,',
    `code-creation,JS,13,2000000,0x40,800,outer ${url}:1:1,0xa1,*`,
    `code-source-info,0x40,7,0,40,C0O1,F0O${pOther},S0xa3`,
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8code-'));
  try {
    fs.writeFileSync(path.join(dir, 'isolate-0x1-1-v8.log'), log + '\n');
    const cpu = { kinds: { main: { self: [{ key: 'outer /src/core/a.js:1', ms: 50 }, { key: 'inner /src/core/a.js:4', ms: 30 }] } } };
    const cpuFile = path.join(dir, 'cpu.json');
    fs.writeFileSync(cpuFile, JSON.stringify(cpu));
    const [main] = await summarizeCodeLogs(dir, { cpu: cpuFile, minPct: 1 });
    assert.equal(main.kind, 'main');
    const outer = main.functions.find((f) => f.key === 'outer /src/core/a.js:1');
    assert.equal(outer.top, 'turbofan');
    assert.equal(outer.turbofanCompiles, 2, 'the OSR compile and the full one');
    assert.equal(outer.machineBytes, 800, 'the full compile, not the OSR one');
    assert.equal(outer.inlined, 1);
    assert.equal(outer.sitesMatched, 1);
    assert.equal(main.calls.length, 1);
    assert.equal(main.calls[0].callee, 'inner');
    assert.equal(main.calls[0].line, 2);
    assert.match(main.calls[0].reason, /^too big \(500 > 460\)/);
    assert.equal(main.calls[0].calleeMs, 30);
    assert.deepEqual(main.reopt.map((r) => [r.key, r.compiles]), [['outer /src/core/a.js:1', 2]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
