#!/usr/bin/env node
/**
 * Q2 premise in Node: trigQ2.wasm against this Node's Math.atan2/atan/sin/cos/asin, bit for bit.
 *   node tests/bench/trigPremise/node.mjs [scale=1] [atan2,atan,sin,cos,asin]
 * The same comparison in Chrome:
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/trigPremise/chrome.mjs --args '{"scale":1}'
 */
import fs from 'node:fs';

import { compareAll } from './core.mjs';

const r = await compareAll(fs.readFileSync(new URL('./trigQ2.wasm', import.meta.url)), {
  scale: Number(process.argv[2] || 1),
  which: process.argv[3] || undefined,
});
for (const [k, v] of Object.entries(r)) console.log(k, JSON.stringify(v));
console.log(`node ${process.version} v8 ${process.versions.v8}`);
