#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  SPEED_PCT,
  measureSceneSide,
  parseMeasureArgs,
  pctDelta,
  repoRoot,
  workloadOk,
  writeJson,
} from './measureLib.mjs';

const FL_FILE = path.join(repoRoot, 'src/util/atomicFreeList.js');
const TOGGLE_RE = /export const U32_FREE_LIST_HEAD = '[^']+'/;

const BUNNY = {
  path: '/demos/bunnyMarkScene/bunnyMarkScene.js',
  exportName: 'BunnyMarkScene',
  headed: true,
  kind: 'gameplay',
};

function setHead(kind) {
  const src = fs.readFileSync(FL_FILE, 'utf8');
  if (!TOGGLE_RE.test(src)) throw new Error('U32_FREE_LIST_HEAD toggle missing');
  const next = src.replace(TOGGLE_RE, `export const U32_FREE_LIST_HEAD = '${kind}'`);
  if (next !== src) fs.writeFileSync(FL_FILE, next);
}

const args = parseMeasureArgs(process.argv.slice(2));
const outRoot = path.join(repoRoot, 'tests/results/entity-id-width-best');

setHead('bigint64');
const fl1 = measureSceneSide('fl1-bunny', BUNNY, args, path.join(outRoot, 'ab-fl1-bunny'));
if (!fl1.ok) throw new Error(`FL1 bunny failed: ${fl1.error}`);

setHead('i32-19-13');
const fl4 = measureSceneSide('fl4-bunny', BUNNY, args, path.join(outRoot, 'ab-fl4-bunny'));
if (!fl4.ok) {
  setHead('bigint64');
  throw new Error(`FL4 bunny failed: ${fl4.error}`);
}

const load = workloadOk(fl1.summary, fl4.summary, ['MARK_ACTIVE']);
const base = fl1.summary.preRender_STEP_MS.median;
const hyp = fl4.summary.preRender_STEP_MS.median;
const delta = pctDelta(hyp, base);
const worse = load.ok && delta != null && delta >= SPEED_PCT;
const win = load.ok && delta != null && delta <= -SPEED_PCT;

if (worse) setHead('bigint64');

const report = {
  feature: 'entity-id-width-best-bunny-headed',
  fl1: fl1.summary,
  fl4: fl4.summary,
  load,
  medianMs: { fl1: base, fl4: hyp },
  deltaPct: delta,
  samples: {
    fl1: fl1.rows.map((r) => r.preRender_STEP_MS),
    fl4: fl4.rows.map((r) => r.preRender_STEP_MS),
    mark: {
      fl1: fl1.rows.map((r) => r.MARK_ACTIVE),
      fl4: fl4.rows.map((r) => r.MARK_ACTIVE),
    },
  },
  verdict: !load.ok ? 'FAIL' : worse ? 'WORSE-FL4' : win ? 'KEPT-FL4' : 'TIE',
  headLeft: worse ? 'bigint64' : 'i32-19-13',
};
writeJson(path.join(outRoot, 'bunny-headed.json'), report);
console.log(JSON.stringify({
  verdict: report.verdict,
  fl1: base,
  fl4: hyp,
  deltaPct: delta,
  loadOk: load.ok,
  samples: report.samples,
}, null, 2));
