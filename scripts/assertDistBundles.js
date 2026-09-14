import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_ARTIFACTS } from './buildBundle.js';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const missing = BUNDLE_ARTIFACTS.filter((name) => !fs.existsSync(path.join(distDir, name)));

if (missing.length) {
  console.error(
    `Missing dist bundles (run npm run make_bundle):\n  ${missing.join('\n  ')}`,
  );
  process.exit(1);
}
