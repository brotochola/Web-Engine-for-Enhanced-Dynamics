/**
 * Bake a scene's textures/spritesheets into bigAtlas.png + bigAtlas.json
 * (proxySheets + individualTextures live in json.meta).
 *
 * Usage:
 *   node scripts/bake-big-atlas.mjs \
 *     --scene /demos/predatorScene/predatorScene.js \
 *     --export PredatorScene \
 *     --out demos/img/baked/PredatorScene
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../tests/helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const parsed = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sceneModule = args.scene || '/demos/predatorScene/predatorScene.js';
  const sceneExport = args.export || args['scene-export'] || 'PredatorScene';
  const outRel = args.out || 'demos/img/baked/PredatorScene';
  const outDir = path.resolve(repoRoot, outRel);
  const headed = Boolean(args.headed);

  const server = await createStaticBenchmarkServer(repoRoot);
  const pageUrl = `http://127.0.0.1:${server.port}/scripts/bake-big-atlas.html`;

  const browser = await chromium.launch({
    headless: !headed,
    channel: 'chrome',
  }).catch(async () =>
    chromium.launch({
      headless: !headed,
    })
  );

  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[bake pageerror]', error));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[bake console]', msg.text());
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.dataset.bakeReady === 'true', undefined, {
      timeout: 30000,
    });

    const result = await page.evaluate(
      async ({ sceneModule, sceneExport }) => {
        const [{ SpriteSheetRegistry }, sceneExports] = await Promise.all([
          import('/src/index.js'),
          import(sceneModule),
        ]);
        const SceneClass = sceneExports[sceneExport];
        if (!SceneClass) {
          throw new Error(`Scene export "${sceneExport}" not found in ${sceneModule}`);
        }

        const assets = { ...(SceneClass.assets || {}) };
        // Always bake from source textures/spritesheets, never from a prior bake.
        delete assets.bigAtlas;

        const textures = assets.textures || {};
        const sceneSpritesheets = assets.spritesheets || {};
        const adobeConfigs = assets.AdobeAnimateAnimations || {};

        const fakeGame = { canvas: document.createElement('canvas') };
        const scene = new SceneClass(fakeGame);
        const assetsConfig = scene.config.assets || {};

        const preparedAdobe = await scene.prepareAdobeAnimateAssets(adobeConfigs);
        const spritesheets = {
          ...sceneSpritesheets,
          ...preparedAdobe.spritesheetConfigs,
        };
        const assetsToLoad = {
          ...textures,
          spritesheets,
        };

        const packed = await SpriteSheetRegistry.createBigAtlas(assetsToLoad, {
          maxAtlasWidth: assetsConfig.maxAtlasWidth ?? 4096,
          maxAtlasHeight: assetsConfig.maxAtlasHeight ?? 4096,
          atlasPadding: assetsConfig.atlasPadding ?? 2,
          trimImages: assetsConfig.trimImages ?? true,
          trimAlphaThreshold: assetsConfig.trimAlphaThreshold ?? 0,
          heuristic: 'best-short-side',
        });

        if (!packed.json?.meta?.proxySheets) {
          throw new Error('createBigAtlas did not write meta.proxySheets');
        }

        return {
          json: packed.json,
          pngDataUrl: packed.canvas.toDataURL('image/png'),
          size: packed.json.meta.size,
          proxyCount: Object.keys(packed.json.meta.proxySheets).length,
          frameCount: Object.keys(packed.json.frames).length,
        };
      },
      { sceneModule, sceneExport }
    );

    await fs.mkdir(outDir, { recursive: true });
    const jsonPath = path.join(outDir, 'bigAtlas.json');
    const pngPath = path.join(outDir, 'bigAtlas.png');

    await fs.writeFile(jsonPath, JSON.stringify(result.json));
    const base64 = result.pngDataUrl.replace(/^data:image\/png;base64,/, '');
    await fs.writeFile(pngPath, Buffer.from(base64, 'base64'));

    console.log(
      `Baked bigAtlas → ${outRel}\n` +
        `  ${result.size.w}x${result.size.h}, ${result.frameCount} frames, ` +
        `${result.proxyCount} proxy sheets`
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
