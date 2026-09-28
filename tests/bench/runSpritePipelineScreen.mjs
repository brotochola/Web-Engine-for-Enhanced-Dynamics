#!/usr/bin/env node
/**
 * Headed sprite pipeline cribado: who packs GPU sprites, who runs the painter.
 * Keep the Chromium window visible.
 *
 *   node tests/bench/runSpritePipelineScreen.mjs
 *   node tests/bench/runSpritePipelineScreen.mjs --screen-only
 *   node tests/bench/runSpritePipelineScreen.mjs --confirm-only
 *   node tests/bench/runSpritePipelineScreen.mjs --scenes bunny
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');
const outDir = path.join(repoRoot, 'tests/results/sprite-pipeline');

const argv = process.argv.slice(2);
const screenOnly = argv.includes('--screen-only');
const confirmOnly = argv.includes('--confirm-only');
let sceneFilter = null;
const onlyCells = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--scenes' && argv[i + 1]) sceneFilter = String(argv[++i]).split(',').map((s) => s.trim());
  if (argv[i] === '--cells' && argv[i + 1]) onlyCells.push(...String(argv[++i]).split(','));
}

const SCENES = {
  bunny: {
    id: 'bunny',
    title: 'BunnyMark 250k',
    path: '/demos/bunnyMarkScene/bunnyMarkScene.js',
    exportName: 'BunnyMarkScene',
    loadKeys: ['MARK_ACTIVE', 'RENDER_QUEUE_SIZE'],
    current: { n: 2, pack: 'preRender', sort: 'none' },
    queryBase: '',
    cells: [
      { name: 'n1-packPR', n: 1, pack: 'preRender', sort: 'none' },
      { name: 'n1-packPixi', n: 1, pack: 'pixi', sort: 'none' },
      { name: 'n2-packPR', n: 2, pack: 'preRender', sort: 'none' },
      { name: 'n2-packPixi', n: 2, pack: 'pixi', sort: 'none' },
      { name: 'n4-packPR', n: 4, pack: 'preRender', sort: 'none' },
      { name: 'n4-packPixi', n: 4, pack: 'pixi', sort: 'none' },
    ],
  },
  predator: {
    id: 'predator',
    title: 'Predator lejos',
    path: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    loadKeys: ['BODY_COUNT'],
    current: { n: 1, pack: 'preRender', sort: 'preRender' },
    queryBase: 'hour=0&zoom=0.4',
    cells: ySortCells(),
  },
  littlecity: {
    id: 'littlecity',
    title: 'LittleCity lejos',
    path: '/demos/littleCity/littleCityScene.js',
    exportName: 'LittleCityScene',
    loadKeys: ['RENDER_QUEUE_SIZE', 'VISIBLE_ENTITIES'],
    current: { n: 1, pack: 'preRender', sort: 'preRender' },
    queryBase: 'zoom=0.4',
    cells: ySortCells(),
  },
};

function ySortCells() {
  return [
    { name: 'sortPR', n: 1, pack: 'preRender', sort: 'preRender' },
    { name: 'sortPixi', n: 1, pack: 'pixi', sort: 'pixi' },
  ];
}

function cellQuery(scene, cell) {
  const parts = [];
  if (scene.queryBase) parts.push(scene.queryBase);
  parts.push(`packGpuSprites=${cell.pack}`);
  if (cell.sort && cell.sort !== 'none') parts.push(`sortSprites=${cell.sort}`);
  return parts.join('&');
}

function sameConfig(a, b) {
  return a.n === b.n && a.pack === b.pack && a.sort === b.sort;
}

function avgOf(worker) {
  return (worker && worker.statsSamplesAverage) || {};
}

function pickMaxPreRender(j) {
  const list = (j.workers || []).filter((w) => w.type === 'preRender' || String(w.id || '').startsWith('preRender'));
  let step = 0;
  let queue = 0;
  let visible = 0;
  const steps = [];
  for (const w of list) {
    const a = avgOf(w);
    const ms = Number(a.STEP_MS) || 0;
    steps.push(ms);
    if (ms > step) step = ms;
    const q = Number(a.RENDER_QUEUE_SIZE) || 0;
    if (q > queue) queue = q;
    const v = Number(a.VISIBLE_ENTITIES) || 0;
    if (v > visible) visible = v;
  }
  return { step, queue, visible, steps };
}

function lineFromJson(name, cell, j) {
  const pre = pickMaxPreRender(j);
  const renderer = (j.workers || []).find((w) => w.id === 'renderer' || w.type === 'renderer');
  const physics = (j.workers || []).find((w) => w.id === 'physics' || w.type === 'physics');
  const logic0 = (j.workers || []).find((w) => w.id === 'logic0');
  const particle = (j.workers || []).find((w) => w.id === 'particle' || w.type === 'particle');
  const ra = avgOf(renderer);
  const pa = avgOf(physics);
  const la = avgOf(logic0);
  const pta = avgOf(particle);
  const pixi = Number(ra.STEP_MS) || 0;
  const bottleneck = Math.max(pre.step, pixi);
  return {
    name,
    n: cell.n,
    pack: cell.pack,
    sort: cell.sort,
    preRender: pre.step,
    preRenderSteps: pre.steps,
    pixi,
    bottleneck,
    MARK_ACTIVE: Number(la.MARK_ACTIVE) || 0,
    RENDER_QUEUE_SIZE: pre.queue,
    VISIBLE_ENTITIES: Number(ra.VISIBLE_ENTITIES) || pre.visible || 0,
    BODY_COUNT: Number(pa.BODY_COUNT) || 0,
    BODY_MOVED_COUNT: Number(pa.BODY_MOVED_COUNT) || 0,
    GPU_CASTERS: Number(ra.GPU_CASTERS) || 0,
    ACTIVE_PARTICLES: Number(pta.ACTIVE_PARTICLES) || 0,
  };
}

function loadDriftPct(base, cell, key) {
  const b = Number(base[key]) || 0;
  const c = Number(cell[key]) || 0;
  if (b <= 0 && c <= 0) return 0;
  if (b <= 0) return Infinity;
  return (Math.abs(c - b) / b) * 100;
}

function loadOk(scene, base, cell) {
  const notes = [];
  let ok = true;
  for (const key of scene.loadKeys) {
    const d = loadDriftPct(base, cell, key);
    if (!Number.isFinite(d) || d > 5) {
      ok = false;
      notes.push(`${key} ${base[key]} vs ${cell[key]} (${d === Infinity ? 'inf' : d.toFixed(1)}%)`);
    }
  }
  return { ok, notes };
}

function runCell(scene, cell, { warmupMs, durationMs, tag }) {
  const query = cellQuery(scene, cell);
  const out = path.join(outDir, `${tag}-${scene.id}-${cell.name}.json`);
  console.log(`\n======== ${scene.id} ${cell.name} query=${query} ========`);
  const args = [
    runner,
    '--headed',
    '--src',
    '--no-collect-detailed-stats',
    '--scene',
    scene.path,
    '--scene-export',
    scene.exportName,
    '--warmup-ms',
    String(warmupMs),
    '--duration-ms',
    String(durationMs),
    '--query',
    query,
    '--output',
    out,
  ];
  let r = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn(`Playwright fail; retry 1x (${scene.id} ${cell.name})`);
    r = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  }
  if (r.status !== 0) {
    return { name: cell.name, n: cell.n, pack: cell.pack, sort: cell.sort, error: r.status || 1, query };
  }
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { ...lineFromJson(cell.name, cell, j), query, output: out };
}

function median(arr) {
  const s = [...arr].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  const s = arr.filter((n) => Number.isFinite(n));
  if (!s.length) return 0;
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function stdevSample(arr) {
  const s = arr.filter((n) => Number.isFinite(n));
  if (s.length < 2) return 0;
  const m = mean(s);
  return Math.sqrt(s.reduce((acc, x) => acc + (x - m) ** 2, 0) / (s.length - 1));
}

function cvOf(arr) {
  const m = mean(arr);
  return m > 0 ? stdevSample(arr) / m : 0;
}

function pickWinner(scene, rows) {
  const base = rows.find((r) => !r.error);
  const ranked = [];
  for (const row of rows) {
    if (row.error) {
      ranked.push({ ...row, loadOk: false, rankSkip: true, reason: 'bench error' });
      continue;
    }
    const load = loadOk(scene, base, row);
    const castersEmpty = scene.id === 'predator' && !(row.GPU_CASTERS > 0);
    ranked.push({
      ...row,
      loadOk: load.ok,
      castersEmpty,
      loadNotes: load.notes,
      movedNoisy: scene.id === 'predator',
    });
  }
  const eligible = ranked.filter((r) => !r.error && r.loadOk && !r.castersEmpty);
  const pool = eligible.length ? eligible : ranked.filter((r) => !r.error);
  pool.sort((a, b) => a.bottleneck - b.bottleneck);
  return { base, ranked, winner: pool[0] || null };
}

function sceneList() {
  return Object.values(SCENES).filter((s) => !sceneFilter || sceneFilter.includes(s.id));
}

function cellsOf(scene) {
  if (!onlyCells.length) return scene.cells;
  return scene.cells.filter((c) => onlyCells.includes(c.name) || onlyCells.includes(`${scene.id}-${c.name}`));
}

fs.mkdirSync(outDir, { recursive: true });

const screenSummary = { when: new Date().toISOString(), warmupMs: 3000, durationMs: 7000, scenes: {} };
const confirmSummary = { when: new Date().toISOString(), warmupMs: 25000, durationMs: 18000, runs: 5, scenes: {} };

if (!confirmOnly) {
  for (const scene of sceneList()) {
    const rows = [];
    for (const cell of cellsOf(scene)) {
      rows.push(runCell(scene, cell, { warmupMs: 3000, durationMs: 7000, tag: 'screen' }));
    }
    const picked = pickWinner(scene, rows);
    screenSummary.scenes[scene.id] = {
      title: scene.title,
      current: scene.current,
      winner: picked.winner
        ? { n: picked.winner.n, pack: picked.winner.pack, sort: picked.winner.sort, name: picked.winner.name, bottleneck: picked.winner.bottleneck }
        : null,
      rows,
      ranked: picked.ranked,
    };
    console.log(`\n${scene.title} winner: ${picked.winner ? picked.winner.name : 'none'} bottleneck=${picked.winner ? picked.winner.bottleneck.toFixed(3) : '?'}`);
  }
  fs.writeFileSync(path.join(outDir, 'cribado-summary.json'), JSON.stringify(screenSummary, null, 2) + '\n');
} else {
  const existing = path.join(outDir, 'cribado-summary.json');
  if (fs.existsSync(existing)) {
    const prev = JSON.parse(fs.readFileSync(existing, 'utf8'));
    screenSummary.scenes = prev.scenes || {};
  }
}

function runConfirmSide(scene, cell, label) {
  const samples = [];
  for (let run = 0; run < 5; run++) {
    const tagged = { ...cell, name: `${cell.name || label}-r${run}` };
    const row = runCell(scene, tagged, { warmupMs: 25000, durationMs: 18000, tag: `confirm-${label}-r${run}` });
    samples.push(row);
  }
  const keys = ['preRender', 'pixi', 'bottleneck', 'MARK_ACTIVE', 'RENDER_QUEUE_SIZE', 'VISIBLE_ENTITIES', 'BODY_COUNT', 'BODY_MOVED_COUNT', 'GPU_CASTERS'];
  const med = {};
  const cv = {};
  for (const key of keys) {
    const arr = samples.map((s) => Number(s[key]) || 0);
    med[key] = median(arr);
    cv[key] = cvOf(arr);
  }
  return { cell, samples, median: med, cv };
}

if (!screenOnly) {
  for (const scene of sceneList()) {
    const screen = screenSummary.scenes[scene.id];
    const winnerCell = screen && screen.winner
      ? { name: screen.winner.name, n: screen.winner.n, pack: screen.winner.pack, sort: screen.winner.sort }
      : scene.current;
    const currentCell = { name: 'current', ...scene.current };
    const sides = {};
    sides.current = runConfirmSide(scene, currentCell, 'current');
    if (!sameConfig(winnerCell, currentCell)) {
      sides.winner = runConfirmSide(scene, winnerCell, 'winner');
    } else {
      sides.winner = sides.current;
    }
    confirmSummary.scenes[scene.id] = {
      title: scene.title,
      current: scene.current,
      winner: { n: winnerCell.n, pack: winnerCell.pack, sort: winnerCell.sort },
      sides,
    };
  }
  fs.writeFileSync(path.join(outDir, 'confirm-summary.json'), JSON.stringify(confirmSummary, null, 2) + '\n');
}

console.log(`\nWrote ${outDir}`);
