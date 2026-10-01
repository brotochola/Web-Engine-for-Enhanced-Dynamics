import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { workerLoadPct } from '../../src/util/workersUtils.js';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_WARMUP_MS,
} from './benchmarkDefaults.mjs';

function formatLoadPct(stepMs) {
  return `${workerLoadPct(stepMs).toFixed(0)}%`;
}

/** Console line: STEP_MS + Load% primary; FPS secondary. */
function formatWorkerConsoleLine(worker) {
  const avg = worker.statsSamplesAverage || {};
  const step = avg.STEP_MS || 0;
  let line =
    `${worker.id}: STEP_MS ${step.toFixed(3)} | Load ${formatLoadPct(step)}` +
    ` | FPS ${worker.averageFPS.toFixed(2)} (inst ${worker.instantaneousFPS.toFixed(2)})`;
  if (worker.type === 'preRender' || worker.id === 'preRender' || String(worker.id || '').startsWith('preRender')) {
    if (avg.COLLECT_MS != null) line += ` | COLLECT_MS ${Number(avg.COLLECT_MS).toFixed(3)}`;
    if (avg.EMIT_MS != null) line += ` | EMIT_MS ${Number(avg.EMIT_MS).toFixed(3)}`;
    if (avg.SORT_MS != null) line += ` | SORT_MS ${Number(avg.SORT_MS).toFixed(3)}`;
    if (avg.SPRITE_PACK_MS != null) line += ` | SPRITE_PACK_MS ${Number(avg.SPRITE_PACK_MS).toFixed(3)}`;
    if (avg.SHADOW_Q_MS != null) line += ` | SHADOW_Q_MS ${Number(avg.SHADOW_Q_MS).toFixed(3)}`;
    if (avg.WAIT_MS != null) line += ` | WAIT_MS ${Number(avg.WAIT_MS).toFixed(3)}`;
    if (avg.RENDER_QUEUE_SIZE != null) line += ` | QUEUE ${Number(avg.RENDER_QUEUE_SIZE).toFixed(0)}`;
  }
  if (worker.type === 'physics' || worker.id === 'physics') {
    if (avg.BOX2D_MS != null) line += ` | BOX2D_MS ${Number(avg.BOX2D_MS).toFixed(3)}`;
    if (avg.LIQUIDFUN_MS != null) line += ` | LIQUIDFUN_MS ${Number(avg.LIQUIDFUN_MS).toFixed(3)}`;
    const passKeys = [
      ['grid', avg.LF_PASS_GRID_MS],
      ['find', avg.LF_PASS_FIND_CONTACTS_MS],
      ['body', avg.LF_PASS_BODY_MS],
      ['wt', avg.LF_PASS_WEIGHT_MS],
      ['statP', avg.LF_PASS_STATIC_PRESSURE_MS],
      ['P', avg.LF_PASS_PRESSURE_MS],
      ['solv', avg.LF_PASS_CONTACT_SOLVERS_MS],
      ['rest', avg.LF_PASS_REST_MS],
    ];
    if (passKeys.some(([, v]) => v != null && Number(v) > 0)) {
      line +=
        ' | LF ' +
        passKeys.map(([k, v]) => `${k} ${Number(v || 0).toFixed(2)}`).join(' ');
    }
    if (avg.BODY_MOVED_COUNT != null) line += ` | Moved ${Number(avg.BODY_MOVED_COUNT).toFixed(0)}`;
    if (avg.AWAKE_COUNT != null) line += ` | Awake ${Number(avg.AWAKE_COUNT).toFixed(0)}`;
    if (avg.BODY_COUNT != null) line += ` | BODY_COUNT ${Number(avg.BODY_COUNT).toFixed(0)}`;
  }
  if (worker.type === 'renderer' || worker.id === 'renderer') {
    if (avg.SHADOWS_MS != null) line += ` | SHADOWS_MS ${Number(avg.SHADOWS_MS).toFixed(3)}`;
    if (avg.GPU_STEP_MS != null) {
      line +=
        ` | GPU_STEP_MS ${Number(avg.GPU_STEP_MS).toFixed(3)}` +
        ` | GPU_SORT_MS ${Number(avg.GPU_SORT_MS || 0).toFixed(3)}` +
        ` | GPU_SHADOWS_MS ${Number(avg.GPU_SHADOWS_MS || 0).toFixed(3)}` +
        ` | GPU_LIGHTS_MS ${Number(avg.GPU_LIGHTS_MS || 0).toFixed(3)}` +
        ` | GPU_PRESENT_MS ${Number(avg.GPU_PRESENT_MS || 0).toFixed(3)}` +
        ` | GPU_PASSES ${Number(avg.GPU_PASSES || 0).toFixed(1)}` +
        ` | GPU_CASTERS ${Number(avg.GPU_CASTERS || 0).toFixed(0)}` +
        ` | GPU_SHADOW_LIGHTS ${Number(avg.GPU_SHADOW_LIGHTS || 0).toFixed(1)}`;
    }
    if (avg.VISIBLE_ENTITIES != null) line += ` | VISIBLE_ENTITIES ${Number(avg.VISIBLE_ENTITIES).toFixed(0)}`;
  }
  return line;
}

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const defaultOutputPath = path.join(repoRoot, 'tests', 'results', 'integrated-worker-benchmark.json');

/** Match typical `demos/index.html` window size (autoResize), not scene world dimensions. */
const DEFAULT_DEMO_CANVAS_WIDTH = 1920;
const DEFAULT_DEMO_CANVAS_HEIGHT = 1080;
const DEFAULT_SCENE_MODULE = '/demos/ballsScene/ballsScene.js';
const DEFAULT_SCENE_EXPORT = 'BallsScene';

/**
 * Reduce Chromium throttling when the window loses focus, is minimized, or is fully
 * covered by other windows (still not a 100% guarantee — the OS can always deprioritize).
 * Opt out with `--allow-throttle` to approximate normal user behavior.
 */
function buildChromiumLaunchArgs({
  allowThrottle,
  collectGpuStats,
  jsFlags,
  userDataDir,
  enableLogging,
}) {
  const args = [];
  if (!allowThrottle) {
    args.push(
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    );
    if (os.platform() === 'win32') {
      args.push('--disable-features=CalculateNativeWinOcclusion');
    }
  }
  if (collectGpuStats) {
    args.push('--enable-webgpu-developer-features');
    args.push('--enable-dawn-features=allow_unsafe_apis');
  }
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  if (jsFlags) {
    args.push(`--js-flags=${jsFlags}`);
  }
  if (enableLogging) {
    args.push('--enable-logging');
    args.push('--v=1');
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

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    const flagsThatTakeDashValues = key === 'js-flags' || key === 'channel' || key === 'v8-log-dir';

    if (!next || (next.startsWith('--') && !flagsThatTakeDashValues)) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    i++;
  }

  return parsed;
}

function resolveJsFlags(cliArgs, v8LogDir) {
  let jsFlags = typeof cliArgs['js-flags'] === 'string' ? cliArgs['js-flags'].trim() : '';
  if (!jsFlags) return '';
  if (v8LogDir && !/(^|\s)--logfile=/.test(jsFlags)) {
    const logPath = path.join(v8LogDir, 'v8.log').replace(/\\/g, '/');
    jsFlags = `--logfile=${logPath} ${jsFlags}`;
  }
  return jsFlags;
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

  // Benches default collectDetailedStats on; --no-collect-detailed-stats for lean A/B.
  const collectDetailedStats = !cliArgs['no-collect-detailed-stats'];
  // GPU timestamps are extra submits. Off unless this campaign asks.
  const collectGpuStats = !!cliArgs['collect-gpu-stats'];

  return {
    warmupMs,
    durationMs,
    sampleIntervalMs,
    sceneModule: cliArgs.scene || DEFAULT_SCENE_MODULE,
    sceneExport: cliArgs['scene-export'] || DEFAULT_SCENE_EXPORT,
    debug: Boolean(cliArgs.debug),
    collectDetailedStats,
    collectGpuStats,
    ...(canvasWidth != null ? { canvasWidth } : {}),
    ...(canvasHeight != null ? { canvasHeight } : {}),
  };
}

/** Resolve screenshot output dir from --screenshots [dir] and --output. */
function resolveScreenshotDir(cliArgs, outputPath) {
  if (!cliArgs.screenshots) return null;
  if (typeof cliArgs.screenshots === 'string') {
    return path.resolve(cliArgs.screenshots);
  }
  const stem = path.basename(outputPath, path.extname(outputPath));
  return path.join(path.dirname(outputPath), stem);
}

async function captureCanvasScreenshot(page, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const canvas = page.locator('canvas').first();
  // WebGPU OffscreenCanvas often leaves the element bitmap empty (tiny black
  // PNG). Clip the page compositor instead — that is what the user sees.
  const box = await canvas.boundingBox();
  if (box && box.width > 0 && box.height > 0) {
    await page.screenshot({ path: filePath, type: 'png', clip: box });
  } else {
    await canvas.screenshot({ path: filePath, type: 'png' });
  }
  return filePath;
}

async function collectV8LogFiles({ v8LogDir, userDataDir, repoRoot }) {
  const names = await fs.readdir(repoRoot).catch(() => []);
  for (const name of names) {
    if (!/^v8.*\.log/i.test(name) && name !== 'v8.log') continue;
    const src = path.join(repoRoot, name);
    const dest = path.join(v8LogDir, name);
    try {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    } catch {
      /* ignore */
    }
  }
  if (userDataDir) {
    const debugLog = path.join(userDataDir, 'chrome_debug.log');
    try {
      await fs.copyFile(debugLog, path.join(v8LogDir, 'chrome_debug.log'));
    } catch {
      /* ignore */
    }
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const benchmarkOptions = buildBenchmarkOptions(cliArgs);
  const headed = Boolean(cliArgs.headed);
  // --trace-cpu: CPU profiler + thread names only. The timeline categories
  // (.stack especially) add cost to every task and make a 190 MB file.
  const traceCpuOnly = Boolean(cliArgs['trace-cpu']);
  const trace = Boolean(cliArgs.trace) || traceCpuOnly;
  const allowThrottle = Boolean(cliArgs['allow-throttle']);
  const positional = cliArgs._ || [];
  const outputPath = path.resolve(cliArgs.output || positional[3] || defaultOutputPath);
  const screenshotDir = resolveScreenshotDir(cliArgs, outputPath);
  const usePhasedScreenshots = Boolean(screenshotDir);

  const server = await createStaticBenchmarkServer(repoRoot);
  const srcModules = Boolean(cliArgs.src);
  const extraQuery = typeof cliArgs.query === 'string' ? cliArgs.query.replace(/^\?/, '') : '';
  const qs = [];
  if (srcModules) qs.push('src=1');
  if (extraQuery) qs.push(extraQuery);
  const benchmarkUrl =
    `http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html` +
    (qs.length ? `?${qs.join('&')}` : '');
  if (srcModules) {
    console.log('Benchmark: live /src modules (not dist bundle).');
  }

  if (headed) {
    console.log(
      'Benchmark: headed Chromium (window should appear). Use pnpm test:bench for faster headless CI-style runs.\n'
    );
  } else {
    console.warn(
      'Benchmark: headless Chromium (no window). For a visible browser and demo-parity FPS, run:\n' +
        '  pnpm test:bench:headed\n' +
        '  or: node tests/bench/runIntegratedWorkerBenchmark.mjs --headed\n'
    );
  }

  const v8LogDir =
    typeof cliArgs['v8-log-dir'] === 'string' ? path.resolve(cliArgs['v8-log-dir']) : null;
  if (v8LogDir) {
    await fs.mkdir(v8LogDir, { recursive: true });
  }
  const jsFlags = resolveJsFlags(cliArgs, v8LogDir);
  if (cliArgs['js-flags'] === true) {
    console.warn(
      'Warning: --js-flags had no value (the next token started with --). Use --js-flags="--log-deopt --log-ic".'
    );
  }
  const dumpio = Boolean(cliArgs.dumpio) || Boolean(jsFlags);
  const userDataDir = null;
  if (jsFlags) {
    console.log(`V8 --js-flags: ${jsFlags}`);
    console.log('JIT flags change STEP_MS. Do not use this run as a speed verdict.');
  }

  const launchArgs = buildChromiumLaunchArgs({
    allowThrottle,
    collectGpuStats: benchmarkOptions.collectGpuStats,
    jsFlags,
    userDataDir,
    enableLogging: Boolean(jsFlags) || dumpio,
  });
  const launchOptions = {
    headless: !headed,
    ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
    ...(dumpio ? { dumpio: true } : {}),
  };
  const requestedChannel =
    typeof cliArgs.channel === 'string' ? cliArgs.channel : jsFlags ? null : 'chrome';
  let browser;
  let browserChannel = requestedChannel || 'chrome';

  try {
    if (requestedChannel === 'chromium') {
      browserChannel = 'chromium';
      browser = await chromium.launch(launchOptions);
    } else {
      browser = await chromium.launch({
        ...launchOptions,
        channel: requestedChannel || 'chrome',
      });
      browserChannel = requestedChannel || 'chrome';
    }
  } catch (chromeError) {
    try {
      browserChannel = 'chromium';
      browser = await chromium.launch(launchOptions);
    } catch (error) {
      await server.close();
      throw new Error(
        `Unable to launch Chrome or Playwright Chromium.\n` +
          `Install Google Chrome, or run: pnpm exec playwright install chromium\n` +
          `Chrome error: ${chromeError.message}\n` +
          `Chromium error: ${error.message}`
      );
    }
  }
  console.log(`Browser binary: ${browserChannel}`);

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);

    page.on('pageerror', (error) => {
      console.error('[benchmark page error]', error);
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      const status = failure?.errorText || 'failed';
      console.error(`[page requestfailed] ${request.method()} ${request.url()} ${status}`);
    });
    page.on('console', (msg) => {
      const text = msg.text();
      if (
        msg.type() === 'error' ||
        text.includes('WebGPU') ||
        text.includes('PIXI WORKER') ||
        text.includes('uncaptured') ||
        text.includes('ComputeLayer')
      ) {
        console.log(`[page ${msg.type()}] ${text}`);
      }
    });

    if (trace) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await browser.startTracing(page, {
        path: path.join(path.dirname(outputPath), 'engine_trace.json'),
        screenshots: false,
        categories: traceCpuOnly
          ? ['-*', '__metadata', 'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires']
          : [
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

    let result;
    let screenshotPaths = [];

    if (usePhasedScreenshots) {
      await fs.mkdir(screenshotDir, { recursive: true });
      const prepared = await page.evaluate(
        (options) => window.__WEED_BENCHMARK__.prepare(options),
        runOptions
      );

      const warmupMs = prepared.warmupMs;
      const zoomScene = runOptions.sceneExport === 'BurningBoxesScene';
      if (zoomScene) {
        await sleep(Math.max(400, Math.floor(warmupMs * 0.45)));
        await page.evaluate(() => {
          const Cam = window.WEED?.Camera;
          if (!Cam || typeof Cam.setZoom !== 'function') return;
          Cam.setZoom((Cam.zoom || 1) * 1.8);
        });
        await sleep(Math.max(400, Math.floor(warmupMs * 0.2)));
        await page.evaluate(() => {
          const Cam = window.WEED?.Camera;
          if (!Cam || typeof Cam.setZoom !== 'function') return;
          Cam.setZoom(Math.max(0.35, (Cam.zoom || 1) / 1.8));
        });
        await sleep(Math.max(200, warmupMs - Math.floor(warmupMs * 0.45) - Math.floor(warmupMs * 0.2)));
      } else {
        await sleep(warmupMs);
      }
      screenshotPaths.push(
        await captureCanvasScreenshot(page, path.join(screenshotDir, '01-post-warmup.png'))
      );

      await page.evaluate(() => window.__WEED_BENCHMARK__.beginMeasure());

      const halfMs = Math.floor(prepared.durationMs / 2);
      await sleep(halfMs);
      screenshotPaths.push(
        await captureCanvasScreenshot(page, path.join(screenshotDir, '02-mid-measure.png'))
      );

      await sleep(prepared.durationMs - halfMs);
      screenshotPaths.push(
        await captureCanvasScreenshot(page, path.join(screenshotDir, '03-end-measure.png'))
      );

      result = await page.evaluate(() => window.__WEED_BENCHMARK__.collect());
    } else {
      result = await page.evaluate((options) => window.__WEED_BENCHMARK__.run(options), runOptions);
    }

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
      browserChannel,
      jsFlags: jsFlags || undefined,
      v8LogDir: v8LogDir || undefined,
      gameEngineDebug: Boolean(benchmarkOptions.debug),
      collectDetailedStats: Boolean(benchmarkOptions.collectDetailedStats),
      collectGpuStats: Boolean(benchmarkOptions.collectGpuStats),
      benchmarkNote:
        'Headed runs: keep the Chromium window visible and not minimized for comparable FPS; hidden/occluded windows can still throttle despite launch flags.',
      ...(screenshotPaths.length > 0
        ? {
            screenshots: screenshotPaths,
            screenshotDir,
          }
        : {}),
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

    const throttleNote = allowThrottle
      ? 'Chromium background-throttle mitigation off (--allow-throttle)'
      : 'Chromium background-throttle mitigation on (minimize/occlude less punishing)';
    console.log(
      `Benchmark report written to ${outputPath} (${headed ? 'headed' : 'headless'} Chromium; ${throttleNote})`
    );
    if (screenshotPaths.length > 0) {
      console.log(`Screenshots (${screenshotPaths.length}): ${screenshotDir}`);
      for (const p of screenshotPaths) {
        console.log(`  ${p}`);
      }
    }
    console.log(`Main thread average FPS: ${result.mainThread.averageFPS.toFixed(2)}`);
    for (const worker of result.workers) {
      console.log(formatWorkerConsoleLine(worker));
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.close();
    if (v8LogDir) {
      await collectV8LogFiles({ v8LogDir, userDataDir, repoRoot });
      console.log(`V8 log dir: ${v8LogDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
