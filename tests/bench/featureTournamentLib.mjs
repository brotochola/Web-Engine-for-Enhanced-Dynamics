/**
 * Small helpers shared by the bench runners. (Named for the feature
 * tournaments; their runners are gone.)
 */

import fs from 'node:fs';
import path from 'node:path';

export function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function pctDelta(hyp, base) {
  if (base == null || !(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

export function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}
