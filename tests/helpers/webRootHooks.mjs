// Node resolve hook for the web root. The demos import the engine and each
// other the way the browser serves them ('/src/index.js', '/demos/...'); this
// maps those specifiers to files in this repo so demo modules load in Node
// tests (review M8). Register it with tests/helpers/registerWebRoot.mjs.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIXES = ['/src/', '/demos/', '/tests/'];

export async function resolve(specifier, context, nextResolve) {
  if (PREFIXES.some((p) => specifier.startsWith(p))) {
    return nextResolve(pathToFileURL(path.join(ROOT, specifier)).href, context);
  }
  return nextResolve(specifier, context);
}
