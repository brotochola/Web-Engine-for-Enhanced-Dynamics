/**
 * The harness's self-check: tests/asan/canary.c reads, then writes, one element past a malloc'd array. The group passes
 * when ASan reports each access, past that array, at the line canary.c marks for it; else the harness is blind (a
 * build without the sanitizer, a report it no longer parses) and every PASS after it would mean nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { symbolize } from '../asanSession.mjs';

/** The line of canary.c that carries `mark`. */
function markedLine(root, mark) {
  const lines = fs.readFileSync(path.join(root, 'tests', 'asan', 'canary.c'), 'utf8').split('\n');
  return lines.findIndex((l) => l.includes(mark)) + 1;
}

function check(ctx, op, mark) {
  const reports = ctx.session.takeReports() || [];
  const line = markedLine(ctx.harnessRoot, mark);
  const hit = reports.find((r) => {
    if (r.access?.op !== op || r.location?.name !== 'canary' || r.location.offset !== 0) return false;
    const top = symbolize(ctx.session.build, r.frames.slice(0, 1))[0]?.[0];
    return top && top.file.endsWith('canary.c') && top.line === line;
  });
  if (hit) return null;
  return reports.length
    ? `ASan reported ${reports.map((r) => `${r.kind} ${r.access?.op ?? '?'}`).join(', ')}, not the ${op} past 'canary' at canary.c:${line}`
    : `ASan reported nothing for the ${op} one element past the array (canary.c:${line})`;
}

export default {
  name: 'canary',
  sources: ['tests/asan/canary.c'],
  exports: ['canary_read', 'canary_write'],
  workingTree: true,

  async groups() {
    const one = (op, mark, fn) => ({
      label: `${op} one element past a 16-element array`,
      run: async (ctx) => {
        const p = ctx.session.malloc(16 * 4, 'canary');
        new Uint32Array(ctx.session.buffer, p, 16).fill(1);
        ctx.session.fn(fn)(p, 16);
        return { calls: 1, mismatch: check(ctx, op, mark) };
      },
    });
    return [{
      label: 'ASan sees an off-by-one read and write',
      cases: [one('READ', 'CANARY_READ', 'canary_read'), one('WRITE', 'CANARY_WRITE', 'canary_write')],
      // The write went into the redzone: the runner starts a fresh module after the group.
      resetAfter: true,
    }];
  },
};
