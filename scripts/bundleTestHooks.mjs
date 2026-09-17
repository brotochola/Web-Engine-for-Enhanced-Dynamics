/**
 * Node module hooks: remap every src/ URL to the loaded bundle namespace.
 * Never falls through to src/. Requires WEED_TEST_BUNDLE.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadUmdBundle } from './bundleTestLoad.mjs';

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function repoSrcRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'src');
}

function isUnderSrc(fileUrl) {
  try {
    const abs = fileURLToPath(fileUrl);
    const rel = path.relative(repoSrcRoot(), abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function bundleHref() {
  const bundlePath = process.env.WEED_TEST_BUNDLE;
  if (!bundlePath) {
    throw new Error('WEED_TEST_BUNDLE is required when bundle test hooks are registered');
  }
  return pathToFileURL(path.resolve(bundlePath)).href;
}

function umdSource(bundlePath) {
  const WEED = loadUmdBundle(bundlePath);
  const keys = Object.keys(WEED).filter((k) => IDENT_RE.test(k));
  const loaderHref = pathToFileURL(fileURLToPath(new URL('./bundleTestLoad.mjs', import.meta.url))).href;
  const lines = [
    `import { loadUmdBundle } from ${JSON.stringify(loaderHref)};`,
    `const WEED = loadUmdBundle(${JSON.stringify(bundlePath)});`,
    ...keys.map((k) => `export const ${k} = WEED[${JSON.stringify(k)}];`),
    `export default WEED;`,
    '',
  ];
  return lines.join('\n');
}

function esmSource(href) {
  return `export * from ${JSON.stringify(href)};\nexport { default } from ${JSON.stringify(href)};\n`;
}

let cachedSource;

function virtualSource() {
  if (cachedSource) return cachedSource;
  const bundlePath = path.resolve(process.env.WEED_TEST_BUNDLE);
  const isEsm = process.env.WEED_TEST_BUNDLE_FORMAT === 'esm';
  cachedSource = isEsm ? esmSource(bundleHref()) : umdSource(bundlePath);
  return cachedSource;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'weed-bundle:ns') {
    return { url: 'weed-bundle:ns', shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (resolved.url && isUnderSrc(resolved.url)) {
    return { url: 'weed-bundle:ns', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'weed-bundle:ns') {
    return {
      format: 'module',
      shortCircuit: true,
      source: virtualSource(),
    };
  }
  return nextLoad(url, context);
}
