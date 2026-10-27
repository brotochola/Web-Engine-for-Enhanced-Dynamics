#!/usr/bin/env node
/**
 * A scene file's joints and decorations in Chromium (VISUAL_EDITOR_PLAN.md ED-21, ED-25), on the fixture
 * tests/fixtures/editorFormatScene.js and a scratch copy of tests/fixtures/levels/editorFormat.scene.json
 * (levels/__format-check.scene.json, removed after). Each check prints PASS or FAIL with what it read; the exit code
 * is the number of failures.
 *
 *   load      the file's joint is in the joint pool between the entities it names, with its anchors, and holds
 *             them (a push swings the block around the pivot at its distance); its decorations are live where the
 *             file puts them
 *   joints    in edit mode, the inspector of a placed entity adds a joint (the type and the other entity from its
 *             lists) and removes the file's one; each is one undo
 *   handles   Alt+drag on the joint's handle (on the entity's center) moves its anchor, not the entity
 *   brush     the palette's Paint takes up the brush; a drag paints decorations into the file and the pool
 *   undo      Ctrl+Z takes the stroke back out of the file and the pool; Ctrl+Y puts it back
 *   saved     Ctrl+S writes the file through the dev server's route: the new joint, the painted decorations
 *   reload    a fresh page that loads the file has the joint between the right entities and every decoration
 *
 * The page is the bench page with ?src=1 (the source tree), served with the editor's routes (server/devRoutes.js).
 * Every wait's predicate returns a boolean.
 *
 *   node tests/bench/editorFormatSmoke.mjs [--headed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LEVELS = '/tests/fixtures/levels';
const SCRATCH = '__format-check.scene.json';
const scratchPath = path.join(repoRoot, 'tests/fixtures/levels', SCRATCH);
const W = 1280;
const H = 720;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function enginePage(browser, port, log) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (error) => log.errors.push(String(error)));
  page.on('console', (message) => log.console.push(message.text()));
  await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });
  await page.evaluate(
    async ({ W, H, url }) => {
      const { default: WEED } = await import('/src/index.js');
      if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
      const game = new WEED.GameEngine({ autoResize: false, canvasWidth: W, canvasHeight: H, injectStyles: false, debug: true });
      globalThis.__fmt = { WEED, game, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
      await game.loadScene(url);
      return true;
    },
    { W, H, url: `${LEVELS}/${SCRATCH}` },
  );
  await page.waitForTimeout(800);
  return page;
}

/** The live joints (type, the names of their entities, anchors, length) and decorations (x, y), read in the page. */
const readWorld = (page) =>
  page.evaluate(() => {
    const { WEED, game } = globalThis.__fmt;
    const { Joint, DecorationComponent } = WEED;
    const scene = game.currentScene;
    const nameOf = new Map();
    for (const record of scene.sceneFile.entities) {
      const entity = scene.getByName(record.name);
      if (entity) nameOf.set(entity.index, record.name);
    }
    const types = ['', 'distance', 'revolute', 'weld', 'prismatic'];
    const joints = [];
    for (let slot = 0; slot < Joint.getDenseActiveCount(); slot++) {
      const i = Joint.activeIndices[slot];
      joints.push({
        type: Object.keys(Joint.TYPE).find((k) => Joint.TYPE[k] === Joint.type[i])?.toLowerCase() ?? types[Joint.type[i]],
        a: nameOf.get(Joint.getEntityA(i)) ?? `#${Joint.getEntityA(i)}`,
        b: nameOf.get(Joint.getEntityB(i)) ?? `#${Joint.getEntityB(i)}`,
        anchors: [Joint.localAnchorAX[i], Joint.localAnchorAY[i], Joint.localAnchorBX[i], Joint.localAnchorBY[i]],
        length: Joint.length[i],
      });
    }
    const decorations = [];
    const active = DecorationComponent.active;
    for (let i = 0; i < active.length; i++) if (active[i]) decorations.push([DecorationComponent.x[i], DecorationComponent.y[i]]);
    decorations.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const pebbles = scene.sceneFile.decorations?.find((r) => r.class === 'Pebble') ?? null;
    return {
      joints,
      decorations,
      fileJoints: structuredClone(scene.sceneFile.joints ?? null),
      filePebbles: pebbles === null ? null : pebbles.x.map((x, k) => [x, pebbles.y[k]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]),
    };
  });

/**
 * The screen point the engine reads as the world point (wx, wy): Camera.worldToScreen first, then corrected by what
 * Mouse reads there (the view may still be on its way to a free target set just before).
 */
async function screenPointOf(page, wx, wy) {
  let point = await page.evaluate(
    ([x, y]) => {
      const p = globalThis.__fmt.WEED.Camera.worldToScreen(x, y);
      return { x: p.x, y: p.y };
    },
    [wx, wy],
  );
  let zoom = 1;
  for (let k = 0; k < 6; k++) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(60);
    const read = await page.evaluate(() => {
      const { Mouse, Camera } = globalThis.__fmt.WEED;
      return { x: Mouse.x, y: Mouse.y, zoom: Camera.zoom || 1 };
    });
    zoom = read.zoom;
    const dx = (wx - read.x) * zoom;
    const dy = (wy - read.y) * zoom;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
    point = { x: point.x + dx, y: point.y + dy };
  }
  return { x: point.x, y: point.y, zoom };
}

const samePoints = (a, b) => a.length === b.length && a.every((p, k) => Math.abs(p[0] - b[k][0]) < 1e-3 && Math.abs(p[1] - b[k][1]) < 1e-3);

async function checkLoad(page) {
  const world = await readWorld(page);
  const joint = world.joints[0];
  check(
    'load: the file’s joint joins the entities it names, at its anchors',
    world.joints.length === 1 && joint.type === 'revolute' && joint.a === 'Anchor' && joint.b === 'Swing' && joint.anchors.join() === '80,0,-80,0',
    JSON.stringify(world.joints),
  );
  check(
    'load: its decorations are live where the file puts them',
    samePoints(world.decorations, [[300, 800], [340, 810], [380, 805]]),
    JSON.stringify(world.decorations),
  );
  // The hinge holds: pushed, the block swings around the pivot (680, 400) at 80 px from it.
  const swing = await page.evaluate(async () => {
    const { WEED, game, sleep } = globalThis.__fmt;
    const block = game.currentScene.getByName('Swing');
    block.setVelocity(0, 400);
    await sleep(600);
    const x = WEED.Transform.x[block.index];
    const y = WEED.Transform.y[block.index];
    const dx = x - 680;
    const dy = y - 400;
    return { x, y, fromPivot: Math.sqrt(dx * dx + dy * dy) };
  });
  check(
    'load: the joint holds in physics (the pushed block keeps its distance from the pivot)',
    Math.abs(swing.fromPivot - 80) < 4 && Math.abs(swing.y - 400) > 20,
    `block at ${swing.x.toFixed(1)}, ${swing.y.toFixed(1)}: ${swing.fromPivot.toFixed(2)} px from the pivot`,
  );
}

async function checkJoints(page) {
  // Back to the level as the file has it (the push moved the block), then edit mode with Anchor selected.
  await page.evaluate(async (url) => {
    const { game } = globalThis.__fmt;
    await game.loadScene(url);
    return true;
  }, `${LEVELS}/${SCRATCH}`);
  await page.waitForTimeout(500);
  await page.keyboard.press('Shift+E');
  await page.waitForFunction(() => globalThis.__fmt.game.debugUI.editing === true, undefined, { timeout: 5000 });
  await page.evaluate(() => {
    const { game } = globalThis.__fmt;
    game.debugUI.editMode.selectFromList(game.currentScene.getByName('Anchor').index, false);
    return true;
  });
  await page.waitForTimeout(200);
  // The Joints section starts folded for an entity without joints (ED-54), and builds its rows only when open (ED-75).
  if ((await page.locator('[data-joint-add-type]').count()) === 0) await page.click('[data-section=joints] > div');
  await page.selectOption('[data-joint-add-type]', 'distance');
  await page.selectOption('[data-joint-add-other]', 'Crate');
  await page.click('[data-joint-add]');
  await page.waitForTimeout(300);
  const added = await readWorld(page);
  await page.click('[data-joint="0"] [data-joint-remove]');
  await page.waitForTimeout(300);
  const removed = await readWorld(page);
  const undo = await page.evaluate(() => globalThis.__fmt.game.debugUI.editMode.history._done.map((c) => c.kind));
  check(
    'joints: the inspector adds a joint and removes the file’s one, one undo each',
    added.joints.length === 2 &&
      removed.joints.length === 1 &&
      removed.joints[0].type === 'distance' &&
      removed.joints[0].a === 'Anchor' &&
      removed.joints[0].b === 'Crate' &&
      removed.fileJoints?.length === 1 &&
      undo.join() === 'joints,joints',
    `after add ${added.joints.length} live, after remove ${JSON.stringify(removed.fileJoints)}; undo ${undo.join()}`,
  );

  // Alt+drag the new joint's handle on Anchor (its center) 30 px right and 20 px up, Anchor in the middle of the view
  // (away from the panels).
  await page.evaluate(() => {
    globalThis.__fmt.WEED.Camera.setFreeTarget(600, 400);
    return true;
  });
  await page.waitForTimeout(300);
  const from = await screenPointOf(page, 600, 400);
  const ends = { from, to: { x: from.x + 30 * from.zoom, y: from.y - 20 * from.zoom } };
  await page.keyboard.down('Alt');
  await page.mouse.move(ends.from.x, ends.from.y);
  await page.mouse.down();
  await page.mouse.move(ends.to.x, ends.to.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(300);
  const dragged = await readWorld(page);
  const anchor = dragged.fileJoints?.[0]?.anchorA ?? [NaN, NaN];
  const kept = await page.evaluate(() => {
    const scene = globalThis.__fmt.game.currentScene;
    const record = scene.sceneFile.entities.find((e) => e.name === 'Anchor');
    return { x: record.x, y: record.y, selected: globalThis.__fmt.game.debugUI.editMode.selection.name };
  });
  check(
    'handles: Alt+drag on a joint’s handle moves its anchor (one undo), not the entity',
    Math.abs(anchor[0] - 30) < 1.5 &&
      Math.abs(anchor[1] + 20) < 1.5 &&
      Math.abs(dragged.joints[0]?.anchors[0] - anchor[0]) < 1e-3 &&
      kept.x === 600 &&
      kept.y === 400 &&
      kept.selected === 'Anchor',
    `dragged from screen ${ends.from.x.toFixed(0)}, ${ends.from.y.toFixed(0)}: anchorA ${JSON.stringify(anchor)}, ` +
      `live ${JSON.stringify(dragged.joints[0]?.anchors)}; Anchor at ${kept.x}, ${kept.y}, selected ${kept.selected}`,
  );
}

async function checkBrush(page) {
  const before = await readWorld(page);
  // The view on an empty spot, the brush up, a drag across the middle of the view.
  await page.evaluate(() => {
    const { WEED } = globalThis.__fmt;
    WEED.Camera.setFreeTarget(1100, 900);
    return true;
  });
  await page.waitForTimeout(300);
  await page.click('[data-decoration-class="Pebble"] button');
  await page.waitForTimeout(100);
  const up = await page.evaluate(() => globalThis.__fmt.game.debugUI.editMode.brush.className);
  const start = await page.evaluate(() => {
    const p = globalThis.__fmt.WEED.Camera.worldToScreen(1100, 900);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 160, start.y + 20, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const painted = await readWorld(page);
  const added = (painted.filePebbles?.length ?? 0) - before.filePebbles.length;
  check(
    'brush: Paint takes up the brush; a drag paints decorations into the file and the pool',
    up === 'Pebble' && added > 10 && samePoints(painted.decorations, painted.filePebbles),
    `brush ${up}; ${added} painted, ${painted.decorations.length} live, ${painted.filePebbles?.length} in the file`,
  );

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const undone = await readWorld(page);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(300);
  const redone = await readWorld(page);
  check(
    'undo: Ctrl+Z takes the stroke out of the file and the pool, Ctrl+Y puts it back',
    samePoints(undone.filePebbles, before.filePebbles) &&
      samePoints(undone.decorations, before.decorations) &&
      samePoints(redone.filePebbles, painted.filePebbles) &&
      samePoints(redone.decorations, painted.decorations),
    `${undone.filePebbles.length} after undo (${undone.decorations.length} live), ${redone.filePebbles.length} after redo (${redone.decorations.length} live)`,
  );
  return redone;
}

async function checkSaveAndReload(browser, port, log, page, edited) {
  await page.keyboard.press('Control+s');
  const deadline = Date.now() + 5000;
  let saved = null;
  while (Date.now() < deadline) {
    const doc = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
    const pebbles = doc.decorations?.find((r) => r.class === 'Pebble');
    if (doc.joints?.length === 1 && pebbles && pebbles.x.length === edited.filePebbles.length) {
      saved = doc;
      break;
    }
    await page.waitForTimeout(100);
  }
  const text = fs.readFileSync(scratchPath, 'utf8');
  check(
    'saved: Ctrl+S writes the joint and the decorations, in the file’s layout',
    saved !== null &&
      /\n {4}\{ "type": "distance", "a": "Anchor", "b": "Crate", "anchorA": \[[-\d.]+, [-\d.]+\], "anchorB": \[0, 0\] \}\n/.test(text) &&
      /\n {6}"x": \[/.test(text),
    saved ? `${saved.joints.length} joint, ${saved.decorations[0].x.length} pebbles` : 'file unchanged',
  );
  await page.close();
  const fresh = await enginePage(browser, port, log);
  const world = await readWorld(fresh);
  // The distance joint without a length holds its anchors as placed: Anchor (600, 400) and its anchor, Crate (400, 600).
  const [ax, ay] = saved?.joints[0].anchorA ?? [0, 0];
  const want = Math.sqrt((600 + ax - 400) ** 2 + (400 + ay - 600) ** 2);
  check(
    'reload: a fresh page has the joint between the right entities and every decoration',
    world.joints.length === 1 &&
      world.joints[0].a === 'Anchor' &&
      world.joints[0].b === 'Crate' &&
      Math.abs(world.joints[0].length - want) < 0.01 &&
      samePoints(world.decorations, edited.filePebbles),
    `${JSON.stringify(world.joints)}; ${world.decorations.length} decorations live`,
  );
  await fresh.close();
}

async function main() {
  const headed = process.argv.includes('--headed');
  fs.copyFileSync(path.join(repoRoot, 'tests/fixtures/levels/editorFormat.scene.json'), scratchPath);
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers),
  });
  const browser = await chromium.launch({ headless: !headed });
  const log = { errors: [], console: [] };
  try {
    const page = await enginePage(browser, server.port, log);
    await checkLoad(page);
    await checkJoints(page);
    const edited = await checkBrush(page);
    await checkSaveAndReload(browser, server.port, log, page, edited);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(scratchPath, { force: true });
  }
  const warned = log.console.filter((line) => line.startsWith('WeedJS:'));
  check('no page errors, no WeedJS warnings', log.errors.length === 0 && warned.length === 0, [...log.errors, ...warned].slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed;
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(scratchPath, { force: true });
  process.exitCode = 1;
});
