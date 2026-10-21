/**
 * Small helpers shared by the bench runners. (Named for the feature
 * tournaments; their runners are gone.)
 */

import fs from 'node:fs';
import path from 'node:path';

export { median } from './benchMath.js';

export function pctDelta(hyp, base) {
  if (base == null || !(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

export function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}
