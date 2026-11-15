/**
 * What DX-LIGHT3D's checks against a formula share (plan §8.2; the pattern of faceLightCheck.mjs): a windowed Chrome on
 * the real GPU, the repo served with COOP/COEP, a still scene opened in the bench page and captured, the canvas decoded
 * here (no 3.7 million numbers through page.evaluate), the Sun's state read from the page, and the geometry the checks
 * compare against (the sun's and a lamp's projection, polygons, distances).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng } from '../../helpers/visualPngCompare.mjs';
import { ensureCheckArt } from './makeCheckArt.mjs';

export const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const VIEWPORT = { width: 1280, height: 720 };

/**
 * The flags every check takes: --backend webgl|webgpu|both (both), --tolerance N, --headless, --wait-ms N (3000),
 * --save dir (the captures), --query k=v (the scene's knobs, repeatable). `flags` adds a check's own: name → default
 * (a boolean flag when the default is false, else it takes a value of the default's type).
 */
export function parseCheckCli(argv, { tolerance = 3, flags = {}, usage = '' } = {}) {
  const opts = { backends: ['webgl', 'webgpu'], tolerance, headless: false, waitMs: 3000, save: null, query: [], ...flags };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--backend') {
      const b = next();
      opts.backends = b === 'both' ? ['webgl', 'webgpu'] : [b];
    } else if (a === '--tolerance') opts.tolerance = Number(next());
    else if (a === '--headless') opts.headless = true;
    else if (a === '--wait-ms') opts.waitMs = Number(next());
    else if (a === '--save') opts.save = next();
    else if (a === '--query') opts.query.push(next());
    else if (a === '--help' || a === '-h') {
      console.log(usage);
      process.exit(0);
    } else if (a.startsWith('--') && Object.hasOwn(flags, camel(a.slice(2)))) {
      const key = camel(a.slice(2));
      if (flags[key] === false) opts[key] = true;
      else opts[key] = typeof flags[key] === 'number' ? Number(next()) : next();
    } else throw new Error(`unknown argument ${a}${usage ? `\n${usage}` : ''}`);
  }
  for (const b of opts.backends) if (b !== 'webgl' && b !== 'webgpu') throw new Error(`--backend webgl|webgpu|both, not ${b}`);
  return opts;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** The checks' art made if missing, a server and a windowed Chrome for `fn`, everything closed after. */
export async function withCheckBrowser(opts, fn) {
  const written = ensureCheckArt();
  if (written.length) console.log(`made the checks' art: ${written.join(', ')}`);
  const server = await createStaticBenchmarkServer(repoRoot);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: opts.headless,
    args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  try {
    return await fn({ browser, server });
  } finally {
    await browser.close();
    await server.close();
  }
}

/** A PNG's pixels (8-bit grey, RGB or RGBA, not interlaced: what Chrome's screenshots are) as RGBA. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const name = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('decodePng reads 8-bit, non-interlaced PNGs');
      type = data[9];
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`decodePng: colour type ${type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (channels >= 3) {
        out[o] = row[s];
        out[o + 1] = row[s + 1];
        out[o + 2] = row[s + 2];
        out[o + 3] = channels === 4 ? row[s + 3] : 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = row[s];
        out[o + 3] = channels === 2 ? row[s + 1] : 255;
      }
    }
    [prev, row] = [row, prev];
  }
  return { width, height, data: out };
}

/**
 * Opens a still scene in the bench page with its knobs, waits, captures the canvas: its pixels, the Sun's state and the
 * page's errors.
 * @param {{ browser: object, server: object }} ctx
 * @param {{ scene: string, sceneExport: string, query: Record<string, string|number>, waitMs: number, save?: string|null }} o
 */
export async function captureStill({ browser, server }, { scene, sceneExport, query, waitMs, save = null }) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    const params = new URLSearchParams('src=1');
    for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      ({ scene, sceneExport, waitMs, size }) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: waitMs,
          durationMs: 1000,
          sampleIntervalMs: 100,
          sceneModule: scene,
          sceneExport,
          canvasWidth: size.width,
          canvasHeight: size.height,
        }),
      { scene, sceneExport, waitMs, size: VIEWPORT },
    );
    await page.waitForTimeout(waitMs);
    const sun = await page.evaluate(async () => {
      const { default: WEED } = await import('/src/index.js');
      const S = WEED.Sun;
      const night = [0, 0, 0];
      if (typeof S.nightLightRGB === 'function') S.nightLightRGB(night);
      return {
        enabled: S.enabled,
        intensity: S.intensity,
        elevation: S.elevation,
        dirX: S.shadowDirX,
        dirY: S.shadowDirY,
        color: S.color,
        shadowAlpha: S.shadowAlpha,
        maxLength: S.shadowMaxLengthRatio,
        night: Array.from(night),
      };
    });
    const png = await captureCanvasPng(page);
    if (save) {
      fs.mkdirSync(path.dirname(path.resolve(save)), { recursive: true });
      fs.writeFileSync(save, png);
    }
    return { pixels: decodePng(png), sun, errors };
  } finally {
    await page.close();
  }
}

/** The knobs of --query as an object, over `base`. */
export function queryOf(opts, base = {}) {
  const out = { ...base };
  for (const pair of opts.query) {
    const at = pair.indexOf('=');
    out[at < 0 ? pair : pair.slice(0, at)] = at < 0 ? '' : pair.slice(at + 1);
  }
  return out;
}

/** A pixel's channels 0..255. */
export function rgbAt(pixels, x, y) {
  const o = (Math.round(y) * pixels.width + Math.round(x)) * 4;
  return [pixels.data[o], pixels.data[o + 1], pixels.data[o + 2]];
}

/** The sun's colour as 0..1 channels. */
export function sunRgb(sun) {
  return [((sun.color >> 16) & 255) / 255, ((sun.color >> 8) & 255) / 255, (sun.color & 255) / 255];
}

/**
 * The sun as the design puts it in the floor's space (plan §6.6, §17.1): the unit direction towards it (Sun's shadow
 * direction is on the screen; on the floor its y is over floorScaleY), the landing shift a px of height takes along the
 * floor (k: away from the sun, |k| = 1 / tan(elevation), capped at Sun.shadowMaxLengthRatio), and the floor direction a
 * card's columns run along (perp: across the sun, to the right of someone at the sun looking at the caster).
 */
export function sunGeometry(sun, floorScaleY) {
  const a = (sun.elevation * Math.PI) / 180;
  const dx = sun.dirX;
  const dy = sun.dirY / floorScaleY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const towards = [(-dx / len) * Math.cos(a), (-dy / len) * Math.cos(a), Math.sin(a)];
  const h = Math.sqrt(towards[0] * towards[0] + towards[1] * towards[1]);
  const z = Math.max(towards[2], 0.05);
  const scale = h > sun.maxLength * z ? sun.maxLength / h : 1 / z;
  return {
    towards,
    k: [towards[0] * scale, towards[1] * scale],
    perp: h > 1e-9 ? [towards[1] / h, -towards[0] / h] : [1, 0],
    toSun: h > 1e-9 ? [towards[0] / h, towards[1] / h] : [0, 0],
    // Over the floor's light: how much of the sun reaches a pixel facing straight up, as faceLight's w.
    w: 1 / Math.max(towards[2], 0.25),
  };
}

/** Where a point (x, y on the floor, z up) lands on the floor along a lamp's ray (plan §F7: L + (p - L)·E / (E - z)). */
export function lampLandingPoint(p, lamp, maxStretch = 8) {
  const room = lamp.elevation - p[2];
  const k = room > lamp.elevation / maxStretch ? lamp.elevation / room : maxStretch;
  return [lamp.x + (p[0] - lamp.x) * k, lamp.y + (p[1] - lamp.y) * k];
}

/** The convex hull of 2D points (monotone chain), counter-clockwise. */
export function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Whether (x, y) is inside a polygon (even-odd). */
export function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The distance from (x, y) to a polygon's outline. */
export function distanceToOutline(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    const qx = ax + t * ex - x;
    const qy = ay + t * ey - y;
    const d = Math.sqrt(qx * qx + qy * qy);
    if (d < best) best = d;
  }
  return best;
}

/** Points every `step` px along a polygon's outline. */
export function outlinePoints(poly, step = 1) {
  const out = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Percentile of numbers (0..1). */
export function percentile(values, q) {
  if (!values.length) return NaN;
  const v = values.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)))];
}

/** The line every check prints at its end, and its exit code. */
export function verdict(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
