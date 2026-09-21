#!/usr/bin/env node
import {
  runFlKernel,
  runPairKernel,
  runSpatialKernel,
  runListKernel,
  runSignedKernel,
  runNbrStrideKernel,
  PLAY_N,
} from './entityIdWidthKernels.mjs';

const out = 'tests/results/entity-id-width-best';

const fl = await runFlKernel({ output: `${out}/kernel-fl.json` });
const signed = runSignedKernel({ output: `${out}/kernel-signed.json` });
const pair = runPairKernel({ output: `${out}/kernel-pair.json` });
const nbr = runNbrStrideKernel({ output: `${out}/kernel-nbr-stride.json` });
const spatial = runSpatialKernel({
  n64: PLAY_N,
  n300: 65536,
  output: `${out}/kernel-spatial.json`,
});
const list = runListKernel({ output: `${out}/kernel-list.json` });

console.log('FL play FL1 ops', fl.play30k?.FL1?.opsPerSec, 'FL4', fl.play30k?.FL4?.opsPerSec);
console.log('FL4 contention doubles', fl.contention?.FL4_64k?.doubles, fl.contention?.FL4_300k?.doubles);
console.log('FL5 verdict', fl.contention?.FL5_verdict);
console.log('signed LIST 30k U32', signed.play30k.LIST_U32.opsPerSec, 'I32', signed.play30k.LIST_I32.opsPerSec);
console.log('nbr stride 30k homo', nbr.play30k.homo.opsPerSec, 'mixed', nbr.play30k.mixed.opsPerSec);
console.log('spatial/list wrote', spatial.feature, list.feature, pair.feature);
