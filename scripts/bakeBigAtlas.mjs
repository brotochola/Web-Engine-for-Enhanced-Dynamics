/**
 * Bake a scene's textures/spritesheets into bigAtlas.png + bigAtlas.json
 * (proxySheets + individualTextures live in json.meta; each frame's base and footprint in its frame).
 * DX-MAPS: when a sheet has height or normal maps, the atlas's twin page goes beside it as bigAtlas_maps.png, its texels
 * as they are (an RGBA PNG written here, not through a canvas), and json.meta.mapsImage names it for the loader.
 *
 * Usage:
 *   node scripts/bakeBigAtlas.mjs \
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
/** The twin page's file, beside bigAtlas.png. */
const MAPS_FILE = 'bigAtlas_maps.png';

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
  const pageUrl = `http://127.0.0.1:${server.port}/scripts/bakeBigAtlas.html`;

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
          // DX-MAPS: the twin page's texels as they are; its canvas would premultiply them.
          keepMapsTexels: true,
        });

        if (!packed.json?.meta?.proxySheets) {
          throw new Error('createBigAtlas did not write meta.proxySheets');
        }

        /** Straight RGBA as a PNG data URL (8-bit RGBA, each row's filter the one that sums smallest), no canvas. */
        async function encodeRgbaPng(width, height, rgba) {
          const crcTable = new Uint32Array(256);
          for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
          }
          const crc32 = (bytes) => {
            let c = 0xffffffff;
            for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
            return (c ^ 0xffffffff) >>> 0;
          };
          const chunk = (type, data) => {
            const out = new Uint8Array(12 + data.length);
            const view = new DataView(out.buffer);
            view.setUint32(0, data.length);
            for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
            out.set(data, 8);
            view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
            return out;
          };
          const paeth = (a, b, c) => {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          };
          const stride = width * 4;
          const raw = new Uint8Array((stride + 1) * height);
          const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
          for (let y = 0; y < height; y++) {
            const row = y * stride;
            let best = 0;
            let bestSum = Infinity;
            for (let f = 0; f < 5; f++) {
              const out = cand[f];
              let sum = 0;
              for (let x = 0; x < stride; x++) {
                const v = rgba[row + x];
                const a = x >= 4 ? rgba[row + x - 4] : 0;
                const b = y > 0 ? rgba[row - stride + x] : 0;
                const c = x >= 4 && y > 0 ? rgba[row - stride + x - 4] : 0;
                const p = (f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)) & 0xff;
                out[x] = p;
                sum += p < 128 ? p : 256 - p;
              }
              if (sum < bestSum) {
                bestSum = sum;
                best = f;
              }
            }
            raw[y * (stride + 1)] = best;
            raw.set(cand[best], y * (stride + 1) + 1);
          }
          const idat = new Uint8Array(
            await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()
          );
          const ihdr = new Uint8Array(13);
          const head = new DataView(ihdr.buffer);
          head.setUint32(0, width);
          head.setUint32(4, height);
          ihdr[8] = 8; // bit depth
          ihdr[9] = 6; // RGBA
          const blob = new Blob(
            [
              new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              chunk('IHDR', ihdr),
              chunk('IDAT', idat),
              chunk('IEND', new Uint8Array(0)),
            ],
            { type: 'image/png' }
          );
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }

        const size = packed.json.meta.size;
        return {
          json: packed.json,
          pngDataUrl: packed.canvas.toDataURL('image/png'),
          mapsPngDataUrl: packed.mapsTexels ? await encodeRgbaPng(size.w, size.h, packed.mapsTexels) : null,
          size,
          proxyCount: Object.keys(packed.json.meta.proxySheets).length,
          frameCount: Object.keys(packed.json.frames).length,
        };
      },
      { sceneModule, sceneExport }
    );

    await fs.mkdir(outDir, { recursive: true });
    const jsonPath = path.join(outDir, 'bigAtlas.json');
    const pngPath = path.join(outDir, 'bigAtlas.png');
    const mapsPath = path.join(outDir, MAPS_FILE);
    const pngBytes = (dataUrl) => Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');

    // DX-MAPS: the loader finds the twin page by this name, beside bigAtlas.png (Scene._loadBakedMapsPage).
    if (result.mapsPngDataUrl) result.json.meta.mapsImage = MAPS_FILE;
    await fs.writeFile(jsonPath, JSON.stringify(result.json));
    await fs.writeFile(pngPath, pngBytes(result.pngDataUrl));
    if (result.mapsPngDataUrl) await fs.writeFile(mapsPath, pngBytes(result.mapsPngDataUrl));
    // A page left by an earlier bake of a scene that had maps then: no JSON names it now.
    else await fs.rm(mapsPath, { force: true });

    console.log(
      `Baked bigAtlas → ${outRel}\n` +
        `  ${result.size.w}x${result.size.h}, ${result.frameCount} frames, ` +
        `${result.proxyCount} proxy sheets` +
        (result.mapsPngDataUrl ? `, maps page ${MAPS_FILE}` : '')
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
