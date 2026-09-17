import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Package is "type": "module", so require() of dist/*.js is ESM and the UMD
 * wrapper never writes module.exports. Eval as a CJS function in this realm
 * so Gamepad/etc see the same globalThis the tests stub.
 */
export function loadUmdBundle(bundlePath) {
  const abs = path.resolve(bundlePath);
  const href = pathToFileURL(abs).href;
  const code = fs.readFileSync(abs, 'utf8');
  const module = { exports: {} };
  const prevDoc = globalThis.document;
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (!globalThis.location) globalThis.location = { href, protocol: 'file:' };
  globalThis.document = {
    currentScript: { src: href, tagName: 'SCRIPT' },
    getElementsByTagName(tag) {
      return tag === 'script' ? [this.currentScript] : [];
    },
  };
  try {
    const fn = new Function('module', 'exports', code);
    fn.call(globalThis, module, module.exports);
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
  const exported = module.exports;
  if (exported && (typeof exported === 'function' || Object.keys(exported).length)) {
    return exported;
  }
  if (globalThis.WEED) return globalThis.WEED;
  throw new Error(`UMD bundle did not export WEED: ${path.basename(abs)}`);
}

export async function loadBundleNamespace(artifactPath, isEsm) {
  if (isEsm) {
    const ns = await import(pathToFileURL(path.resolve(artifactPath)).href);
    const ensure = ns.ensureEmbeddedSources || ns.default?.ensureEmbeddedSources;
    if (typeof ensure === 'function') await ensure();
    return ns;
  }
  const WEED = loadUmdBundle(artifactPath);
  if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
  return WEED;
}

export function exportNameSet(ns) {
  return new Set(Object.keys(ns));
}
