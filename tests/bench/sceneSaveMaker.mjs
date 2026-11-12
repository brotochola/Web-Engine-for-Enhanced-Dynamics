// E-210: a save of a scene in mid-play, for sittings that start both sides from it (the bench page's ?restore=<url>,
// runPredatorAbab's --restore <file>). The browser half runs in a page chromeKernel.mjs serves (COOP/COEP): it loads
// the scene from /src, lets it play, saves the game (scene.saveGame) and hands back the save's bytes as base64. The
// Node half writes them to a file.
//   node tests/bench/sceneSaveMaker.mjs [--scene /demos/predatorScene/predatorScene.js] [--export PredatorScene]
//     [--seconds 20] [--query "k=v&…"] [--output tests/results/restore/predatorBattle.weedsave]
// Set MSYS_NO_PATHCONV=1 from Git Bash.

/** Browser side: chromeKernel.mjs calls run(args) in its page. */
export async function run({ scene = '/demos/predatorScene/predatorScene.js', exportName = 'PredatorScene', seconds = 20, query = '' } = {}) {
  if (query) history.replaceState(null, '', `${location.pathname}?${query}`);
  const { default: WEED } = await import('/src/index.js');
  const game = new WEED.GameEngine({ autoResize: false, canvasWidth: 1280, canvasHeight: 720, injectStyles: false, debug: false });
  await game.loadScene(scene, { export: exportName });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const live = game.currentScene;
  const slot = 'e210-bench';
  const meta = await live.saveGame(slot);
  const bytes = await WEED.SaveStore.get(slot);
  if (!bytes) throw new Error('the save was not stored');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { scene: exportName, seconds, entities: meta?.entityCount ?? null, bytes: bytes.length, base64: btoa(binary) };
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
    const out = path.resolve(String(args.output || 'tests/results/restore/predatorBattle.weedsave'));
    const json = `${out}.json`;
    const runArgs = {
      scene: args.scene || '/demos/predatorScene/predatorScene.js',
      exportName: args.export || 'PredatorScene',
      seconds: Number(args.seconds ?? 20),
      query: typeof args.query === 'string' ? args.query : '',
    };
    const res = spawnSync(process.execPath, [path.join(here, 'chromeKernel.mjs'), '--module', '/tests/bench/sceneSaveMaker.mjs', '--headed',
      '--args', JSON.stringify(runArgs), '--output', json], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (res.status !== 0) process.exit(res.status || 1);
    const report = JSON.parse(fs.readFileSync(json, 'utf8')).result;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(report.base64, 'base64'));
    fs.unlinkSync(json);
    console.log(`${out}: ${report.bytes} bytes, ${report.entities} entities, ${report.scene} after ${report.seconds} s`);
  }
}
