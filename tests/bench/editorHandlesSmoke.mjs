#!/usr/bin/env node
/**
 * The editor's handles and entity pick in Chromium (VISUAL_EDITOR_PLAN.md Stage 4: ED-20, ED-22, ED-27, ED-45), on
 * tests/fixtures/editorHandles.scene.json (editorHandlesScene.js) in the bench page with ?src=1. Each check prints PASS
 * or FAIL with what it read; the exit code is the number of failures. Nothing is saved: the fixture file is not touched.
 *
 *   drawn    a selected Block's handles are on the overlay canvas: white squares at its edges
 *   box      (ED-20) its right edge dragged 60 px: the record's width grows 60 and its x 30 (the left edge stays), the
 *            respawned collider has the width, and it is one undo
 *   circle   (ED-20) a Ball's ring handle dragged 40 px out: radius 30 → 70, in the record and the collider
 *   polygon  (ED-20, ED-27) a Rock's top vertex dragged 30 px up: its points param, in its frame, and its collider's
 *            vertex; Alt+click on its bottom edge adds a fourth vertex there
 *   light    (ED-22) a Lamp's reach ring dragged from 300 to 200 px: lightIntensity 900 → 400, in the record and the light
 *   dimmed   a Door's collider is set in code: a press on its corner says so, and nothing changes
 *   route    (ED-27) a Guard's route point dragged, a point added by Alt+click on its line and taken out with Del over
 *            it, one more from the inspector's +
 *   pick     (ED-45) the door row's pick button, a click on a Ball (wrong class: said, still picking), a click on Door2:
 *            the door param names Door2, the Guard stays selected; then the button and Esc stop a pick
 *
 *   node tests/bench/editorHandlesSmoke.mjs [--headed]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FILE = '/tests/fixtures/editorHandles.scene.json';
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
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) log.errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });
  await page.evaluate(
    async ({ W, H, FILE }) => {
      const { default: WEED } = await import('/src/index.js');
      if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
      const game = new WEED.GameEngine({ autoResize: false, canvasWidth: W, canvasHeight: H, injectStyles: false, debug: true });
      globalThis.__h = { WEED, game };
      await game.loadScene(FILE);
      return true;
    },
    { W, H, FILE },
  );
  await page.waitForTimeout(1500);
  return page;
}

/** The view centered on a world point at a zoom; then the screen point of each world point asked for. */
async function look(page, x, y, zoom) {
  await page.evaluate(
    ({ x, y, zoom }) => {
      const { Camera } = globalThis.__h.WEED;
      Camera.setZoom(zoom);
      Camera.setFreeTarget(x, y);
      return true;
    },
    { x, y, zoom },
  );
  await page.waitForTimeout(250);
}

const toScreen = (page, points) =>
  page.evaluate((points) => {
    const { Camera } = globalThis.__h.WEED;
    return points.map(([x, y]) => {
      const s = Camera.worldToScreen(x, y);
      return [s.x, s.y];
    });
  }, points);

/** The editor's state and a record of the running file, as plain data. */
const read = (page, name) =>
  page.evaluate((name) => {
    const { WEED, game } = globalThis.__h;
    const scene = game.currentScene;
    const editMode = game.debugUI.editMode;
    const record = scene.sceneFile.entities.find((e) => e.name === name) ?? null;
    const entity = scene.getByName(name);
    const i = entity ? entity.index : -1;
    const { Collider, LightEmitter } = WEED;
    const base = i * 8;
    return {
      record: record === null ? null : JSON.parse(JSON.stringify(record)),
      live:
        i < 0
          ? null
          : {
              width: Collider.width[i],
              radius: Collider.radius[i],
              polyCount: Collider.polyCount[i],
              vertex0: [Collider.polyVertexX[base], Collider.polyVertexY[base]],
              lightIntensity: LightEmitter.active?.[i] ? LightEmitter.lightIntensity[i] : null,
            },
      selected: editMode.selection.name,
      status: editMode.status,
      statusIsError: editMode.statusIsError,
      picking: editMode.picker.picking,
      undo: editMode.history._done.map((c) => c.label),
    };
  }, name);

async function dragScreen(page, from, to, { alt = false } = {}) {
  await page.mouse.move(from[0], from[1]);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
  await page.waitForTimeout(350);
}

async function altClick(page, at) {
  await page.mouse.move(at[0], at[1]);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(350);
}

async function selectAt(page, at, name) {
  await page.mouse.click(at[0], at[1]);
  await page.waitForTimeout(200);
  const selected = await page.evaluate(() => globalThis.__h.game.debugUI.editMode.selection.name);
  if (selected !== name) throw new Error(`a click at ${at} selected ${selected}, not ${name}`);
}

/** The overlay canvas's pixel at a screen point: [r, g, b, a]. */
const overlayPixel = (page, at) =>
  page.evaluate(([x, y]) => {
    const canvas = document.getElementById('debug-visualization-canvas');
    if (!canvas) return null;
    return [...canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data];
  }, at);

async function checkBox(page) {
  await look(page, 400, 300, 1);
  const [center, rightEdge] = await toScreen(page, [[400, 300], [500, 300]]);
  await selectAt(page, center, 'Block1');
  await page.waitForTimeout(150);
  const pixel = await overlayPixel(page, rightEdge);
  check('drawn', pixel !== null && pixel[3] > 200 && pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200, `the overlay at the right edge's handle: rgba ${pixel}`);

  await dragScreen(page, rightEdge, [rightEdge[0] + 60, rightEdge[1] + 2]);
  const after = await read(page, 'Block1');
  check(
    'box',
    after.record.config?.width === 260 && after.record.x === 430 && after.record.y === 300 && after.live?.width === 260 &&
      after.undo.length === 1 && after.undo[0] === 'resize Block1' && after.selected === 'Block1',
    `record ${JSON.stringify(after.record)}, collider width ${after.live?.width}, undo ${JSON.stringify(after.undo)}`,
  );
}

async function checkCircle(page) {
  await look(page, 800, 300, 1);
  const [center, right] = await toScreen(page, [[800, 300], [830, 300]]);
  await selectAt(page, center, 'Ball1');
  await dragScreen(page, right, [right[0] + 40, right[1]]);
  const after = await read(page, 'Ball1');
  check('circle', after.record.config?.radius === 70 && after.live?.radius === 70, `record ${JSON.stringify(after.record.config)}, collider radius ${after.live?.radius}`);
}

async function checkPolygon(page) {
  await look(page, 1200, 300, 1);
  const [inside, top, bottom] = await toScreen(page, [[1200, 310], [1200, 260], [1200, 330]]);
  await selectAt(page, inside, 'Rock1');
  await dragScreen(page, top, [top[0], top[1] - 30]);
  const moved = await read(page, 'Rock1');
  await altClick(page, bottom);
  const added = await read(page, 'Rock1');
  const want = [0, -70, 40, 30, -40, 30];
  const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, k) => v === b[k]);
  check(
    'polygon',
    same(moved.record.config?.points, want) && moved.live?.vertex0[1] === -70 &&
      same(added.record.config?.points, [0, -70, 40, 30, 0, 30, -40, 30]) && added.live?.polyCount === 4,
    `dragged: ${JSON.stringify(moved.record.config?.points)} (vertex 0 ${moved.live?.vertex0}); ` +
      `Alt+click: ${JSON.stringify(added.record.config?.points)} (${added.live?.polyCount} vertices)`,
  );
}

async function checkLight(page) {
  await look(page, 700, 1000, 1);
  const d = 300 * Math.SQRT1_2;
  const e = 200 * Math.SQRT1_2;
  const [center, handle, target] = await toScreen(page, [[700, 1000], [700 + d, 1000 + d], [700 + e, 1000 + e]]);
  await selectAt(page, center, 'Lamp1');
  await dragScreen(page, handle, target);
  const after = await read(page, 'Lamp1');
  const value = after.record.config?.lightIntensity;
  const reach = Math.sqrt(value) * 10;
  check('light', Math.abs(reach - 200) <= 2 && Number.isInteger(reach) && after.live?.lightIntensity === value,
    `lightIntensity 900 → ${value} (reach 300 → ${reach} px), the light has ${after.live?.lightIntensity}`);
}

async function checkDimmed(page) {
  await look(page, 1000, 800, 1);
  const [center, corner] = await toScreen(page, [[1000, 800], [980, 760]]);
  await selectAt(page, center, 'Door1');
  const before = await read(page, 'Door1');
  await dragScreen(page, corner, [corner[0] - 40, corner[1] - 40]);
  const after = await read(page, 'Door1');
  check(
    'dimmed',
    after.status === 'Door has no width or height param: its collider is set in code' && after.statusIsError &&
      JSON.stringify(after.record) === JSON.stringify(before.record) && after.undo.length === before.undo.length && after.selected === 'Door1',
    `status "${after.status}", record kept ${JSON.stringify(after.record) === JSON.stringify(before.record)}`,
  );
}

async function checkRoute(page) {
  await look(page, 800, 800, 1);
  const [body, second] = await toScreen(page, [[800, 790], [900, 860]]);
  await selectAt(page, body, 'Guard1');
  await dragScreen(page, second, [second[0] + 20, second[1] + 20]);
  const dragged = (await read(page, 'Guard1')).record.config.route;
  const [middle] = await toScreen(page, [[840, 870]]);
  await altClick(page, middle);
  const added = (await read(page, 'Guard1')).record.config.route;
  await page.mouse.move(middle[0] + 1, middle[1]);
  await page.waitForTimeout(100);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(350);
  const removed = await read(page, 'Guard1');
  await page.click('button[data-add-point="route"]');
  await page.waitForTimeout(350);
  const plus = await read(page, 'Guard1');
  check(
    'route',
    JSON.stringify(dragged) === '[760,860,920,880]' && JSON.stringify(added) === '[760,860,840,870,920,880]' &&
      JSON.stringify(removed.record.config.route) === '[760,860,920,880]' && removed.selected === 'Guard1' &&
      JSON.stringify(plus.record.config.route) === '[760,860,920,880,1080,900]',
    `dragged ${JSON.stringify(dragged)}; Alt+click ${JSON.stringify(added)}; Del ${JSON.stringify(removed.record.config.route)}; ` +
      `+ ${JSON.stringify(plus.record.config.route)}`,
  );
}

async function checkPick(page) {
  // Zoomed out until the world's width fills the view (its least zoom): the Ball, the Guard and Door2 clear of the panels.
  await look(page, 800, 650, 0.64);
  const [guard, ball, door2] = await toScreen(page, [[800, 790], [800, 300], [1300, 800]]);
  await selectAt(page, guard, 'Guard1');
  await page.click('button[data-pick="door"]');
  await page.waitForTimeout(150);
  const started = await read(page, 'Guard1');
  await page.mouse.click(ball[0], ball[1]);
  await page.waitForTimeout(200);
  const wrong = await read(page, 'Guard1');
  await page.mouse.click(door2[0], door2[1]);
  await page.waitForTimeout(400);
  const picked = await read(page, 'Guard1');
  // The button and Esc stop a pick.
  await page.click('button[data-pick="door"]');
  await page.waitForTimeout(100);
  const again = await read(page, 'Guard1');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const escaped = await read(page, 'Guard1');
  check(
    'pick',
    started.picking && started.status.startsWith('Click a Door in the view') &&
      wrong.picking && wrong.status === 'Ball1 is a Ball: Guard1.door takes a Door. Esc cancels' && wrong.record.config.door === 'Door1' &&
      !picked.picking && picked.record.config.door === 'Door2' && picked.selected === 'Guard1' && picked.undo.at(-1) === 'Guard1.door' &&
      again.picking && !escaped.picking && escaped.selected === 'Guard1',
    `started "${started.status}"; on the Ball "${wrong.status}"; on Door2: door ${picked.record.config.door}, selected ${picked.selected}; ` +
      `Esc: picking ${escaped.picking}, selected ${escaped.selected}`,
  );
}

async function main() {
  const headed = process.argv.includes('--headed');
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers),
  });
  const browser = await chromium.launch({ headless: !headed });
  const log = { errors: [] };
  try {
    const page = await enginePage(browser, server.port, log);
    await page.mouse.click(5, H - 5); // the page has the focus
    await page.keyboard.press('Shift+E');
    await page.waitForTimeout(300);
    const editing = await page.evaluate(() => globalThis.__h.game.debugUI.editing);
    if (!editing) throw new Error('Shift+E did not enter edit mode');
    for (const step of [checkBox, checkCircle, checkPolygon, checkLight, checkDimmed, checkRoute, checkPick]) {
      try {
        await step(page);
      } catch (error) {
        check(step.name, false, error.message);
      }
    }
    await page.close();
  } finally {
    await browser.close();
    await server.close();
  }
  check('no page errors', log.errors.length === 0, log.errors.slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
