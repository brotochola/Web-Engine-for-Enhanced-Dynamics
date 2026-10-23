#!/usr/bin/env node
/**
 * DX-SW. Serves this repository like GitHub Pages or `npx serve`: no COOP/COEP headers, so a game
 * page starts cross-origin isolated only through weed-sw.js. For trying the isolation service
 * worker by hand in a browser; isolationWorkerSmoke.mjs is the automated version.
 *
 *   node tests/bench/serveWithoutIsolation.mjs [--port 8090] [--headers]
 *
 * --headers sends COOP/COEP as a host set up per DEPLOY.md would (the engine then registers nothing).
 * /weed-sw.js serves src/workers/isolationServiceWorker.js (source mode needs it at the site root).
 * A second server on port + 1 is another origin, for embedding the game in an iframe. Ctrl+C stops.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 8090;
const headers = argv.includes('--headers');

const game = await createStaticBenchmarkServer(repoRoot, port, {
  isolationHeaders: headers,
  files: { '/weed-sw.js': 'src/workers/isolationServiceWorker.js' },
});
const other = await createStaticBenchmarkServer(repoRoot, port + 1, { isolationHeaders: false });

const base = `http://127.0.0.1:${game.port}`;
const smoke = `${base}/tests/bench/isolation/isolationSmoke.html`;
console.log(`Serving ${repoRoot} ${headers ? 'WITH' : 'without'} the isolation headers.\n`);
console.log(`  A small scene (source):  ${smoke}`);
console.log(`  Predator (source):       ${smoke}?scene=/demos/predatorScene/predatorScene.js`);
console.log(`  The bundles:             ${base}/dist/index.html   (run node scripts/buildBundle.js first)`);
console.log(`  Embedded by another site: http://127.0.0.1:${other.port}/tests/bench/isolation/frame.html?src=${encodeURIComponent(smoke)}`);
console.log('\nFirst visit: one reload, then the scene runs; DevTools console: crossOriginIsolated is true.');
console.log('Start over: DevTools, Application, Storage, "Clear site data" (removes the service worker).');
console.log('Ctrl+C stops.');

const stop = async () => {
  await game.close();
  await other.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
