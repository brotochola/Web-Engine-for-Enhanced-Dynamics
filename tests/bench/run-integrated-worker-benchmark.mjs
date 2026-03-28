import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const defaultOutputPath = path.join(repoRoot, 'tests', 'results', 'integrated-worker-benchmark.json');

/** Match typical `demos/index.html` window size (autoResize), not scene world dimensions. */
const DEFAULT_DEMO_CANVAS_WIDTH = 1920;
const DEFAULT_DEMO_CANVAS_HEIGHT = 1080;

function parseArgs(argv) {
  const parsed = Object.create(null);
  parsed._ = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    i++;
  }

  return parsed;
}

function toPositiveInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? Math.round(normalized) : fallback;
}

function toOptionalPositiveInteger(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? Math.round(normalized) : undefined;
}

function buildBenchmarkOptions(cliArgs) {
  const positional = cliArgs._ || [];

  const canvasWidth = toOptionalPositiveInteger(cliArgs['canvas-width']);
  const canvasHeight = toOptionalPositiveInteger(cliArgs['canvas-height']);
  const warmupMs = toPositiveInteger(cliArgs['warmup-ms'] ?? positional[0], 8000);
  const durationMs = toPositiveInteger(cliArgs['duration-ms'] ?? positional[1], 8000);
  const sampleIntervalMs = toPositiveInteger(
    cliArgs['sample-interval-ms'] ?? positional[2],
    100
  );

  return {
    warmupMs,
    durationMs,
    sampleIntervalMs,
    ...(canvasWidth != null ? { canvasWidth } : {}),
    ...(canvasHeight != null ? { canvasHeight } : {}),
  };
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const benchmarkOptions = buildBenchmarkOptions(cliArgs);
  const positional = cliArgs._ || [];
  const outputPath = path.resolve(cliArgs.output || positional[3] || defaultOutputPath);

  const server = await createStaticBenchmarkServer(repoRoot);
  const benchmarkUrl = `http://127.0.0.1:${server.port}/tests/bench/integrated-worker-benchmark.html`;

  let browser;

  try {
    browser = await chromium.launch({ headless: false });
  } catch (error) {
    await server.close();
    throw new Error(
      `Unable to launch Playwright Chromium. Install the browser binary with "npx playwright install chromium". Original error: ${error.message}`
    );
  }

  try {
    const page = await browser.newPage();

    page.on('pageerror', (error) => {
      console.error('[benchmark page error]', error);
    });

    await page.goto(benchmarkUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, {
      timeout: 30000,
    });

    const sceneDims = await page.evaluate(async () => {
      const { BallsScene } = await import('/demos/scenes/BallsScene.js');
      return {
        width: BallsScene.config.worldWidth,
        height: BallsScene.config.worldHeight,
      };
    });

    const canvasWidth = benchmarkOptions.canvasWidth ?? DEFAULT_DEMO_CANVAS_WIDTH;
    const canvasHeight = benchmarkOptions.canvasHeight ?? DEFAULT_DEMO_CANVAS_HEIGHT;
    await page.setViewportSize({ width: canvasWidth, height: canvasHeight });

    const runOptions = {
      ...benchmarkOptions,
      canvasWidth,
      canvasHeight,
      worldWidth: sceneDims.width,
      worldHeight: sceneDims.height,
    };

    const result = await page.evaluate((options) => window.__WEED_BENCHMARK__.run(options), runOptions);

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

    console.log(`Benchmark report written to ${outputPath}`);
    console.log(`Main thread average FPS: ${result.mainThread.averageFPS.toFixed(2)}`);
    for (const worker of result.workers) {
      console.log(`${worker.id}: avg ${worker.averageFPS.toFixed(2)} FPS, current ${worker.instantaneousFPS.toFixed(2)} FPS`);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
