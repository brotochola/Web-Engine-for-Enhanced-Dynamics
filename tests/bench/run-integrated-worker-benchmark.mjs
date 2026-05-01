import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_WARMUP_MS,
} from './benchmarkDefaults.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const defaultOutputPath = path.join(repoRoot, 'tests', 'results', 'integrated-worker-benchmark.json');

/** Match typical `demos/index.html` window size (autoResize), not scene world dimensions. */
const DEFAULT_DEMO_CANVAS_WIDTH = 1920;
const DEFAULT_DEMO_CANVAS_HEIGHT = 1080;
const DEFAULT_SCENE_MODULE = '/demos/scenes/BallsScene.js';
const DEFAULT_SCENE_EXPORT = 'BallsScene';

/**
 * Reduce Chromium throttling when the window loses focus, is minimized, or is fully
 * covered by other windows (still not a 100% guarantee — the OS can always deprioritize).
 * Opt out with `--allow-throttle` to approximate normal user behavior.
 */
function buildChromiumLaunchArgs({ allowThrottle }) {
  if (allowThrottle) {
    return [];
  }
  const args = [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (os.platform() === 'win32') {
    args.push('--disable-features=CalculateNativeWinOcclusion');
  }
  return args;
}

function parseArgs(argv) {
  const parsed = Object.create(null);
  parsed._ = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
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
  const warmupMs = toPositiveInteger(cliArgs['warmup-ms'] ?? positional[0], DEFAULT_WARMUP_MS);
  const durationMs = toPositiveInteger(cliArgs['duration-ms'] ?? positional[1], DEFAULT_DURATION_MS);
  const sampleIntervalMs = toPositiveInteger(
    cliArgs['sample-interval-ms'] ?? positional[2],
    DEFAULT_SAMPLE_INTERVAL_MS
  );

  return {
    warmupMs,
    durationMs,
    sampleIntervalMs,
    sceneModule: cliArgs.scene || DEFAULT_SCENE_MODULE,
    sceneExport: cliArgs['scene-export'] || DEFAULT_SCENE_EXPORT,
    ...(canvasWidth != null ? { canvasWidth } : {}),
    ...(canvasHeight != null ? { canvasHeight } : {}),
  };
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const benchmarkOptions = buildBenchmarkOptions(cliArgs);
  const headed = Boolean(cliArgs.headed);
  const trace = Boolean(cliArgs.trace);
  const allowThrottle = Boolean(cliArgs['allow-throttle']);
  const positional = cliArgs._ || [];
  const outputPath = path.resolve(cliArgs.output || positional[3] || defaultOutputPath);

  const server = await createStaticBenchmarkServer(repoRoot);
  const benchmarkUrl = `http://127.0.0.1:${server.port}/tests/bench/integrated-worker-benchmark.html`;

  if (headed) {
    console.log(
      'Benchmark: headed Chromium (window should appear). Use pnpm test:bench for faster headless CI-style runs.\n'
    );
  } else {
    console.warn(
      'Benchmark: headless Chromium (no window). For a visible browser and demo-parity FPS, run:\n' +
        '  pnpm test:bench:headed\n' +
        '  or: node tests/bench/run-integrated-worker-benchmark.mjs --headed\n'
    );
  }

  const launchArgs = buildChromiumLaunchArgs({ allowThrottle });
  let browser;

  try {
    browser = await chromium.launch({
      headless: !headed,
      ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
    });
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

    if (trace) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await browser.startTracing(page, {
        path: path.join(path.dirname(outputPath), 'engine_trace.json'),
        screenshots: false,
        categories: [
          '-*', 'devtools.timeline', 'v8.execute',
          'disabled-by-default-devtools.timeline',
          'disabled-by-default-devtools.timeline.frame',
          'toplevel', 'blink.console', 'blink.user_timing',
          'latencyInfo', 'disabled-by-default-devtools.timeline.stack',
          'disabled-by-default-v8.cpu_profiler',
          'disabled-by-default-v8.cpu_profiler.hires', 'v8.gc'
        ]
      });
    }

    await page.goto(benchmarkUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, {
      timeout: 30000,
    });

    const sceneDims = await page.evaluate(async ({ sceneModule, sceneExport }) => {
      const sceneModuleExports = await import(sceneModule);
      const SceneClass = sceneModuleExports[sceneExport];
      if (!SceneClass) {
        throw new Error(`Benchmark scene export "${sceneExport}" not found in ${sceneModule}`);
      }
      return {
        name: SceneClass.name || sceneExport,
        width: SceneClass.config.worldWidth,
        height: SceneClass.config.worldHeight,
      };
    }, benchmarkOptions);

    const canvasWidth = benchmarkOptions.canvasWidth ?? DEFAULT_DEMO_CANVAS_WIDTH;
    const canvasHeight = benchmarkOptions.canvasHeight ?? DEFAULT_DEMO_CANVAS_HEIGHT;
    await page.setViewportSize({ width: canvasWidth, height: canvasHeight });
    // Reduce accidental occlusion (another window on top); does not stop user minimizing afterward.
    await page.bringToFront();

    const runOptions = {
      ...benchmarkOptions,
      canvasWidth,
      canvasHeight,
      worldWidth: sceneDims.width,
      worldHeight: sceneDims.height,
      sceneModule: benchmarkOptions.sceneModule,
      sceneExport: benchmarkOptions.sceneExport,
    };

    const result = await page.evaluate((options) => window.__WEED_BENCHMARK__.run(options), runOptions);

    if (trace) {
      const memoryUsage = await page.evaluate(() => {
        if (performance.memory) {
            return {
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                usedJSHeapSize: performance.memory.usedJSHeapSize
            };
        }
        return null;
      });
      await fs.writeFile(path.join(path.dirname(outputPath), 'memory_snapshot.json'), JSON.stringify(memoryUsage, null, 2), 'utf8');
      await browser.stopTracing();
      console.log(`Trace saved to ${path.join(path.dirname(outputPath), 'engine_trace.json')}`);
      console.log(`Memory snapshot saved to ${path.join(path.dirname(outputPath), 'memory_snapshot.json')}`);
    }

    result.metadata = {
      ...result.metadata,
      playwrightHeadless: !headed,
      chromiumBackgroundThrottleMitigation: !allowThrottle,
      chromiumExtraArgs: launchArgs,
      benchmarkNote:
        'Headed runs: keep the Chromium window visible and not minimized for comparable FPS; hidden/occluded windows can still throttle despite launch flags.',
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

    const throttleNote = allowThrottle
      ? 'Chromium background-throttle mitigation off (--allow-throttle)'
      : 'Chromium background-throttle mitigation on (minimize/occlude less punishing)';
    console.log(
      `Benchmark report written to ${outputPath} (${headed ? 'headed' : 'headless'} Chromium; ${throttleNote})`
    );
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
