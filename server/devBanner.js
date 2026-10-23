/**
 * What `npm run dev` and `npm run dev:sw` print when the server starts: the WeedJS logo, then what
 * is running and how (headers or weed-sw.js, hot reload). In colour when the terminal has it: the
 * logo in a diagonal leaf-green to yellow gradient, as printLogo() paints it in the browser.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { WEED_LOGO_ART } from '../src/util/weedLogo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The gradient's stops, leaf green to yellow (the browser logo's #0f0 and #ff4, softened). */
const STOPS = [
  [40, 220, 70],
  [160, 240, 60],
  [255, 230, 70],
];
/** The same stops in the 256-colour palette. */
const STOPS_256 = [34, 76, 112, 148, 184, 220];

/**
 * Text styling for a terminal: ANSI codes when it shows colour, plain text when it does not (a
 * pipe, NO_COLOR, a dumb terminal), so logs and tests read the same words.
 * @param {{ isTTY?: boolean, hasColors?: (count?: number) => boolean }} [stream]
 */
export function terminalPaint(stream = process.stdout) {
  const depth = !stream.isTTY || typeof stream.hasColors !== 'function' ? 0
    : stream.hasColors(2 ** 24) ? 24
      : stream.hasColors(256) ? 8
        : stream.hasColors() ? 4 : 0;
  const wrap = (open) => (text) => (depth ? `\x1b[${open}m${text}\x1b[0m` : text);
  /** The ANSI colour for t in [0, 1] along the gradient. */
  const colourAt = (t) => {
    if (depth === 24) {
      const x = Math.min(Math.max(t, 0), 1) * (STOPS.length - 1);
      const i = Math.min(Math.floor(x), STOPS.length - 2);
      const f = x - i;
      const [r, g, b] = STOPS[i].map((c, k) => Math.round(c + (STOPS[i + 1][k] - c) * f));
      return `38;2;${r};${g};${b}`;
    }
    if (depth === 8) return `38;5;${STOPS_256[Math.min(Math.floor(t * STOPS_256.length), STOPS_256.length - 1)]}`;
    return t < 0.6 ? '32' : '33';
  };
  return {
    depth,
    bold: wrap('1'),
    dim: wrap('2'),
    cyan: wrap('36'),
    green: wrap('32'),
    /**
     * Lines in diagonal bands, green, yellow, green, yellow, green from top left to bottom right:
     * the browser logo's 135° gradient. Spaces stay plain.
     */
    gradient(lines) {
      if (!depth) return lines;
      const width = Math.max(...lines.map((l) => l.length), 1);
      const height = Math.max(lines.length - 1, 1);
      const band = (x, y) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (x / width + y / height));
      return lines.map((line, y) => {
        let out = '';
        let open = null;
        for (let x = 0; x < line.length; x++) {
          const ch = line[x];
          if (ch === ' ') {
            out += ch;
            continue;
          }
          const code = colourAt(band(x, y));
          if (code !== open) {
            out += `\x1b[${code}m`;
            open = code;
          }
          out += ch;
        }
        return open ? `${out}\x1b[0m` : out;
      });
    },
  };
}

/**
 * @param {{ port: number, swMode: boolean, hotReload: boolean, logRequests?: boolean, root: string,
 *   paint?: ReturnType<typeof terminalPaint> }} options
 * @returns {string}
 */
export function devBanner({ port, swMode, hotReload, logRequests = false, root, paint = terminalPaint() }) {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const url = `http://localhost:${port}/`;
  const out = [''];
  for (const line of paint.gradient(WEED_LOGO_ART.split('\n'))) out.push(line);
  out.push('');
  out.push(`  ${paint.bold(`WeedJS ${version}`)}  ${paint.dim('·')}  ${swMode ? 'dev server, service worker mode' : 'dev server'}`);
  out.push('');
  out.push(`  ${paint.green('➜')}  Server running at ${paint.cyan(url)}`);
  out.push(`  ${paint.green('➜')}  Demos: ${paint.cyan(`${url}demos/`)}`);
  out.push(`     ${paint.dim(`Serving ${root}`)}`);
  out.push('');
  const row = (label, ...text) => {
    text.forEach((t, i) => out.push(`  ${paint.dim((i ? '' : label).padEnd(12))}${t}`));
  };
  if (swMode) {
    row('Isolation',
      'no COOP/COEP headers, as GitHub Pages or a static host serves a game. /weed-sw.js adds them:',
      'the engine registers it and reloads once on the first visit, behind a black screen.');
    row('Start over', 'DevTools > Application > Storage > "Clear site data". Keep "Bypass for network" unticked.');
    row('Compare', 'npm run dev serves the same files with the headers (port 8000).');
  } else {
    row('Isolation', 'COOP/COEP headers on every response: SharedArrayBuffer on, no service worker.');
    row('Compare', 'npm run dev:sw serves without them, as GitHub Pages would (port 8090).');
  }
  if (hotReload) {
    row('Hot reload',
      'on, for pages that ask for it (hotReload: true, as the demos do): a changed scene script',
      'swaps into the running game; any other change reloads the page and restores the scene.');
  } else {
    row('Hot reload', 'off (WEED_HOT_RELOAD=0).');
  }
  row('Requests', logRequests ? 'every one is logged (WEED_LOG_REQUESTS=1).' : 'only failures are logged; WEED_LOG_REQUESTS=1 logs every one.');
  out.push('');
  out.push(`  ${paint.dim('Ctrl+C stops.')}`);
  out.push('');
  return out.join('\n');
}
