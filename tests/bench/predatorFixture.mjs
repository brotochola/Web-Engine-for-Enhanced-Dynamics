/**
 * Predator frame fixture: one frame of the live scene, captured read-only from
 * the main thread by capturePredatorFixture.mjs. Kernels use its distribution
 * (positions, collider sizes, casters, lights, audio occupancy) instead of a
 * made-up layout.
 *
 * File layout: u32 header byte length, UTF-8 JSON header, then each array's
 * bytes in header order (4-byte aligned).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePredatorFixture } from './predatorFixtureParse.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const PREDATOR_FIXTURE_PATH = path.join(repoRoot, 'tests/fixtures/predator-frame.bin');

export function writeFixture(file, meta, arrays) {
  const entries = Object.entries(arrays);
  const layout = [];
  let offset = 0;
  for (const [name, arr] of entries) {
    layout.push({ name, type: arr.constructor.name, length: arr.length, offset });
    offset += Math.ceil(arr.byteLength / 4) * 4;
  }
  const header = Buffer.from(JSON.stringify({ ...meta, arrays: layout }), 'utf8');
  const headerPad = Math.ceil(header.length / 4) * 4;
  const out = Buffer.alloc(4 + headerPad + offset);
  out.writeUInt32LE(headerPad, 0);
  header.copy(out, 4);
  for (let i = 0; i < entries.length; i++) {
    const arr = entries[i][1];
    Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(out, 4 + headerPad + layout[i].offset);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return file;
}

/** @returns {null | { meta: object, arrays: Record<string, ArrayBufferView> }} */
export function loadPredatorFixture(file = PREDATOR_FIXTURE_PATH) {
  if (!fs.existsSync(file)) return null;
  return parsePredatorFixture(fs.readFileSync(file));
}
