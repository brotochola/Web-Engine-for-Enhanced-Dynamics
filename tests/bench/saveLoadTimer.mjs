// N-314: how long a scene takes to save and to load back in the page, the way a player's save and a hot reload do
// (scene.saveGame into the SaveStore, then scene.loadGame from it: decode, the scene remounted with the restore
// payload, logic0's restore). The browser half runs in a page chromeKernel.mjs serves (COOP/COEP); `--root` serves
// another checkout, so the same rounds time two revisions. A fresh load of the scene is timed too, for the part of a
// load that is the scene's own boot.
//   node tests/bench/saveLoadTimer.mjs [--scene /demos/predatorScene/predatorScene.js] [--export PredatorScene]
//     [--seconds 20] [--rounds 3] [--query "k=v&…"] [--root <checkout>] [--output result.json]
// Set MSYS_NO_PATHCONV=1 from Git Bash. With --root, copy this file into that checkout's tests/bench first (the page
// imports it from the root it serves).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Browser side: chromeKernel.mjs calls run(args) in its page. */
export async function run({
  scene = '/demos/predatorScene/predatorScene.js',
  exportName = 'PredatorScene',
  seconds = 20,
  rounds = 3,
  query = '',
} = {}) {
  if (query) history.replaceState(null, '', `${location.pathname}?${query}`);
  const { default: WEED } = await import('/src/index.js');
  const game = new WEED.GameEngine({ autoResize: false, canvasWidth: 1280, canvasHeight: 720, injectStyles: false, debug: false });
  const t0 = performance.now();
  await game.loadScene(scene, { export: exportName });
  const freshLoadMs = performance.now() - t0;
  await sleep(seconds * 1000);
  const slot = 'n314-timer';
  const out = { scene: exportName, seconds, query, freshLoadMs, rounds: [] };
  for (let r = 0; r < rounds; r++) {
    const live = game.currentScene;
    const s0 = performance.now();
    const meta = await live.saveGame(slot);
    const saveMs = performance.now() - s0;
    const bytes = await WEED.SaveStore.get(slot);
    const l0 = performance.now();
    await live.loadGame(slot);
    const loadMs = performance.now() - l0;
    out.rounds.push({ saveMs, loadMs, bytes: bytes ? bytes.length : 0, entities: meta?.entityCount ?? null });
    // The loaded scene plays a little before the next save.
    await sleep(3000);
  }
  return out;
}

if (typeof process !== 'undefined' && process.versions?.node) {
  const { isCli, parseArgs } = await import('./microbenchHelpers.mjs');
  if (isCli(import.meta.url)) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const args = parseArgs();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const out = path.resolve(String(args.output || 'tests/results/saveLoadTimer.json'));
    const runArgs = {
      scene: args.scene || '/demos/predatorScene/predatorScene.js',
      exportName: args.export || 'PredatorScene',
      seconds: Number(args.seconds ?? 20),
      rounds: Number(args.rounds ?? 3),
      query: typeof args.query === 'string' ? args.query : '',
    };
    const kernelArgs = [path.join(here, 'chromeKernel.mjs'), '--module', '/tests/bench/saveLoadTimer.mjs', '--headed',
      '--args', JSON.stringify(runArgs), '--output', out];
    if (typeof args.root === 'string') kernelArgs.push('--root', args.root);
    const res = spawnSync(process.execPath, kernelArgs, { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (res.status !== 0) process.exit(res.status || 1);
    const report = JSON.parse(fs.readFileSync(out, 'utf8')).result;
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(0) : String(v));
    console.log(`${report.scene} ${report.query || ''}: fresh load ${fmt(report.freshLoadMs)} ms`);
    for (const [k, r] of report.rounds.entries()) {
      console.log(`  round ${k + 1}: save ${fmt(r.saveMs)} ms, load ${fmt(r.loadMs)} ms, ${r.bytes} bytes, ${r.entities} entities`);
    }
  }
}
