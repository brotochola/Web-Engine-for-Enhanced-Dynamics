// Q2 premise in Chrome (tests/bench/chromeKernel.mjs calls run): the module against Chrome's Math.*.
import { compareAll } from './core.mjs';

export async function run(args) {
  const bytes = new Uint8Array(await (await fetch(new URL('./trigQ2.wasm', import.meta.url))).arrayBuffer());
  return compareAll(bytes, args);
}
