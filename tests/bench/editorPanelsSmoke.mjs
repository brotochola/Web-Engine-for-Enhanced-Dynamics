#!/usr/bin/env node
/**
 * The editor's Stage 4 panels in Chromium (VISUAL_EDITOR_PLAN.md ED-24, ED-26, ED-45): tests/fixtures/editorPanels/
 * (crates on the entities layer, walkers on a props layer, a Tiled tilemap on a ground layer) in the editor page.
 * Each check prints PASS or FAIL with what it read; the exit code is the number of failures. Nothing is saved: the
 * level file is not touched, and the tilemap's file is a scratch this script writes and removes.
 *
 *   assets   the Assets dock lists the scene's layers (hide on each, lock where entities go) and its tilemap (file,
 *            size, the layer that shows it)
 *   lock     (ED-24) with props locked a click on a walker selects nothing, the scene list marks the walkers, the
 *            list still selects one, and the arrow keys do not move it; unlocked, a click selects it again
 *   hide     (ED-24) entities hidden: the layer is not drawn while editing and a click on a crate selects nothing;
 *            Play shows it again, Edit hides it again, unchecked it shows
 *   tilemap  (ED-26) with an unsaved edit and a selection, the tilemap's file changes (a hole in the sand) and hot
 *            reload puts it in place: the same game page, the tiles in memory, the pixels at the hole changed, and
 *            the editor still editing with its document, undo and selection
 *   shape    (ED-26) the file changes size: hot reload reloads the game page with the scene's state, and the editor
 *            page hands the editor's state over (D9): the new size loaded, the document still unsaved with its undo,
 *            edit mode and the selection
 *   picker   (ED-45) a crate's sprite param is a field whose list (taken when it gets the focus, ED-76) holds the
 *            scene's textures, sheet animations and the
 *            engine's own, with a thumbnail drawn from the atlas; a name the scene lacks is marked; a typed name
 *            changes the crate's record and its frame; a walker's animation param lists the civil1 animations, and a
 *            pick from the list (as Chrome sends it) changes the record and the walker's animation at once
 *   grid     (ED-76) a crate's sprite thumbnail opens the picture grid on its value (every sprite: barrel has no number),
 *            the search field focused and the value under the cursor; typed "bun" and Enter pick bunny and close it
 *
 * Every wait's predicate returns a boolean (a handle to the game's objects would keep a reloaded page alive).
 *
 *   node tests/bench/editorPanelsSmoke.mjs [--headed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE = '/tests/fixtures/editorPanels';
const GAME = `${FIXTURE}/index.html`;
const TILEMAP_FILE = '__ground.tilemap.json';
const tilemapPath = path.join(repoRoot, 'tests/fixtures/editorPanels', TILEMAP_FILE);

// The tilemap: 64 × 40 tiles of 24 px (the world's 1536 × 960), every one sand (tile 1 of demos/img/tilemap/2.png).
const COLS = 64;
const ROWS = 40;
const SAND = 1;
/** Tiles 28..36 × 16..24: a block about the view's center (the level centers the camera on 768, 480). */
const HOLE = { x0: 28, x1: 37, y0: 16, y1: 25 };

function writeTilemap({ rows = ROWS, hole = false } = {}) {
  const data = new Array(COLS * rows).fill(SAND);
  if (hole) {
    for (let y = HOLE.y0; y < HOLE.y1; y++) for (let x = HOLE.x0; x < HOLE.x1; x++) data[y * COLS + x] = 0;
  }
  const map = {
    type: 'map',
    version: '1.10',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    width: COLS,
    height: rows,
    tilewidth: 24,
    tileheight: 24,
    layers: [{ id: 1, name: 'sand', type: 'tilelayer', x: 0, y: 0, width: COLS, height: rows, visible: true, opacity: 1, data }],
    tilesets: [{ firstgid: 1, columns: 24, tilewidth: 24, tileheight: 24, tilecount: 288, image: 'spritesheet.png' }],
  };
  fs.writeFileSync(tilemapPath, JSON.stringify(map));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** The game page's frame (the editor page's iframe). */
const gameFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame());

async function gameReady(page) {
  await page.waitForFunction(() => window.__weedEditorHost?.connected === true, undefined, { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const game = document.getElementById('game').contentWindow.game;
      return !!(game && game.state === 1 && game.currentScene && game.currentScene.sceneFile);
    },
    undefined,
    { timeout: 30000 },
  );
}

/** The editor's state, read through the iframe. */
const readEditor = (page) =>
  page.evaluate(() => {
    const win = document.getElementById('game').contentWindow;
    const editMode = win.game.debugUI.editMode;
    const crate = win.game.currentScene.sceneFile.entities.find((e) => e.name === 'Crate1');
    win.__smokePage ??= Math.random().toString(36).slice(2);
    return {
      page: win.__smokePage,
      active: editMode.active,
      selection: editMode.selection.name,
      dirty: editMode.dirty,
      canUndo: editMode.history.canUndo,
      crateX: crate ? crate.x : null,
      status: editMode.status,
    };
  });

/** Where a world point is on the page (the editor page's coordinates). */
async function screenOf(page, wx, wy) {
  const frameBox = await page.evaluate(() => {
    const r = document.getElementById('game').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  const inGame = await gameFrame(page).evaluate(
    async ({ wx, wy }) => {
      const { default: WEED } = await import('/src/index.js');
      const r = window.game.canvas.getBoundingClientRect();
      const s = WEED.Camera.worldToScreen(wx, wy);
      const k = r.width / WEED.Camera.canvasWidth;
      return { x: r.left + s.x * k, y: r.top + s.y * k };
    },
    { wx, wy },
  );
  return { x: frameBox.x + inGame.x, y: frameBox.y + inGame.y };
}

/** The live position of a placed entity (its name in the file). */
const worldOf = (page, name) =>
  gameFrame(page).evaluate(async (name) => {
    const { default: WEED } = await import('/src/index.js');
    const entity = window.game.currentScene.getByName(name);
    return entity ? { x: WEED.Transform.x[entity.index], y: WEED.Transform.y[entity.index] } : null;
  }, name);

/** The RGB of the page at a point, from a screenshot. */
async function pixelAt(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, png.toString('base64'));
}

/**
 * The toolbar's Edit, then the view on the level's middle. Entering edit mode takes the camera's follow target as the
 * view's, and this level never sets one (it only centers the camera): the view would go to the world's corner.
 */
async function enterEdit(page) {
  await page.click('[data-slot=toolbar] button:has-text("Edit")');
  await gameFrame(page).evaluate(async () => {
    const { default: WEED } = await import('/src/index.js');
    WEED.Camera.setFreeTarget(768, 480);
    return true;
  });
  await page.waitForTimeout(400);
}

const layerRow = (page, name) => page.locator(`[data-slot=assets] [data-layer="${name}"]`);
const layerSwitch = (page, name, kind) => layerRow(page, name).locator(`input[data-switch=${kind}]`);
const layerVisible = (page, name) =>
  gameFrame(page).evaluate(async (name) => {
    const { default: WEED } = await import('/src/index.js');
    return WEED.Layer.get(name).visible;
  }, name);

async function main() {
  const args = parseArgs();
  writeTilemap();
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers),
  });
  const browser = await chromium.launch({ headless: !args.headed });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      // The test server has no hot reload route: the game page's EventSource gets a 404, as on any static server.
      if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${server.port}/src/core/debug/editor/shell/?game=${encodeURIComponent(GAME)}`);
    await gameReady(page);
    await page.waitForTimeout(1500);

    // ---- assets ----
    const assets = await page.evaluate(() => {
      const dock = document.querySelector('[data-slot=assets]');
      const rows = [...dock.querySelectorAll('[data-layer]')].map((row) => ({
        name: row.dataset.layer,
        switches: [...row.querySelectorAll('input[data-switch]')].map((el) => el.dataset.switch).join('+'),
      }));
      const tilemap = dock.querySelector('[data-tilemap]');
      return { rows, tilemap: tilemap ? tilemap.innerText.replace(/\s*\n\s*/g, ' | ') : null };
    });
    const layerText = assets.rows.map((r) => `${r.name}(${r.switches})`).join(' ');
    check(
      'assets',
      layerText === 'props(hide+lock) entities(hide+lock) ground(hide)' &&
        assets.tilemap !== null &&
        assets.tilemap.includes(`ground · ${TILEMAP_FILE}`) &&
        assets.tilemap.includes('64×40 tiles of 24 px, 1 layer; on ground'),
      `layers ${layerText}; tilemap "${assets.tilemap}"`,
    );

    // ---- lock (ED-24) ----
    await enterEdit(page);
    // A sprite's anchor is at its feet: aim a little above the entity's point.
    const walkerAt = await screenOf(page, ...Object.values(await worldOf(page, 'Walker1')));
    const walker = { x: walkerAt.x, y: walkerAt.y - 12 };
    await page.mouse.click(walker.x, walker.y);
    await page.waitForTimeout(200);
    const pickedBefore = (await readEditor(page)).selection;
    await page.keyboard.press('Escape');
    await layerSwitch(page, 'props', 'lock').check();
    await page.mouse.click(walker.x, walker.y);
    await page.waitForTimeout(200);
    const pickedLocked = (await readEditor(page)).selection;
    const rows = page.locator('[data-slot=tree] [data-row]');
    // The click before opened the walkers' group (a selection shows its row); else open it.
    if ((await rows.filter({ hasText: /^Walker1\s/ }).count()) === 0) await rows.filter({ hasText: /^▸ Walker\s+·/ }).click();
    const walkerRow = (await rows.filter({ hasText: /^Walker1\s/ }).innerText()).trim();
    await rows.filter({ hasText: /^Walker1\s/ }).click();
    await page.waitForTimeout(200);
    const listed = await readEditor(page);
    const before = await worldOf(page, 'Walker1');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const after = await worldOf(page, 'Walker1');
    const nudged = await readEditor(page);
    await page.keyboard.press('Escape');
    await layerSwitch(page, 'props', 'lock').uncheck();
    await page.mouse.click(walker.x, walker.y);
    await page.waitForTimeout(200);
    const pickedUnlocked = (await readEditor(page)).selection;
    check(
      'lock',
      pickedBefore === 'Walker1' &&
        pickedLocked === null &&
        walkerRow.includes('🔒 locked') &&
        listed.selection === 'Walker1' &&
        after.x === before.x &&
        /locked layer \(props\)/.test(nudged.status) &&
        pickedUnlocked === 'Walker1',
      `click ${pickedBefore}; locked: click ${pickedLocked}, row "${walkerRow}", list selects ${listed.selection}, ` +
        `arrow ${before.x} → ${after.x} ("${nudged.status}"); unlocked: click ${pickedUnlocked}`,
    );
    await page.keyboard.press('Escape');

    // ---- hide (ED-24) ----
    const crateAt = await screenOf(page, ...Object.values(await worldOf(page, 'Crate1')));
    const crate = { x: crateAt.x, y: crateAt.y - 12 };
    await layerSwitch(page, 'entities', 'hide').check();
    const hiddenEditing = await layerVisible(page, 'entities');
    await page.mouse.click(crate.x, crate.y);
    await page.waitForTimeout(200);
    const pickedHidden = (await readEditor(page)).selection;
    await page.click('[data-slot=toolbar] button:has-text("Play")');
    await page.waitForTimeout(300);
    const shownPlaying = await layerVisible(page, 'entities');
    await enterEdit(page); // the same view: the crate is where it was on screen
    const hiddenAgain = await layerVisible(page, 'entities');
    await layerSwitch(page, 'entities', 'hide').uncheck();
    const shownUnchecked = await layerVisible(page, 'entities');
    check(
      'hide',
      hiddenEditing === false && pickedHidden === null && shownPlaying === true && hiddenAgain === false && shownUnchecked === true,
      `editing ${hiddenEditing ? 'shown' : 'hidden'}, a click on the crate selects ${pickedHidden}; ` +
        `Play ${shownPlaying ? 'shown' : 'hidden'}, Edit ${hiddenAgain ? 'shown' : 'hidden'}, unchecked ${shownUnchecked ? 'shown' : 'hidden'}`,
    );

    // ---- tilemap in place (ED-26) ----
    await page.mouse.click(crate.x, crate.y);
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const edited = await readEditor(page);
    const center = await screenOf(page, ((HOLE.x0 + HOLE.x1) / 2) * 24, ((HOLE.y0 + HOLE.y1) / 2) * 24);
    const sand = await pixelAt(page, center.x, center.y);
    writeTilemap({ hole: true });
    const reload = await gameFrame(page).evaluate(async (file) => {
      const { HotReload } = await import('/src/core/debug/hotReload.js');
      return HotReload.onFileChanged(window.game, JSON.stringify({ file }));
    }, `tests/fixtures/editorPanels/${TILEMAP_FILE}`);
    await page.waitForTimeout(500);
    const hole = await pixelAt(page, center.x, center.y);
    const tile = await gameFrame(page).evaluate(async ({ x, y }) => {
      const { default: WEED } = await import('/src/index.js');
      return WEED.TileMap.get('ground').getLayer('sand').getTileIdAt(x, y);
    }, { x: HOLE.x0 + 4, y: HOLE.y0 + 4 });
    const kept = await readEditor(page);
    const changed = Math.abs(hole[0] - sand[0]) + Math.abs(hole[1] - sand[1]) + Math.abs(hole[2] - sand[2]);
    check(
      'tilemap',
      reload === 'tilemap' &&
        tile === 0 &&
        changed > 60 &&
        kept.page === edited.page &&
        kept.active &&
        kept.dirty &&
        kept.canUndo &&
        kept.selection === 'Crate1' &&
        kept.crateX === edited.crateX &&
        edited.crateX === 401,
      `hot reload "${reload}", tile ${tile}, pixel ${sand} → ${hole}; same page ${kept.page === edited.page}, ` +
        `editing ${kept.active}, unsaved ${kept.dirty}, undo ${kept.canUndo}, selected ${kept.selection}, Crate1.x ${kept.crateX}`,
    );

    // ---- another shape: the page reload that keeps the state (ED-26, D9's handover) ----
    writeTilemap({ rows: ROWS + 1, hole: true });
    await gameFrame(page).evaluate((file) => {
      import('/src/core/debug/hotReload.js').then(({ HotReload }) => HotReload.onFileChanged(window.game, JSON.stringify({ file })));
      return true;
    }, `tests/fixtures/editorPanels/${TILEMAP_FILE}`);
    await page.waitForFunction((old) => document.getElementById('game').contentWindow.__smokePage !== old, kept.page, {
      timeout: 30000,
    });
    await gameReady(page);
    await page.waitForTimeout(2500); // the resume: a fast swap to the unsaved document
    const reloaded = await readEditor(page);
    const rows41 = await gameFrame(page).evaluate(async () => {
      const { default: WEED } = await import('/src/index.js');
      return WEED.TileMap.get('ground').mapHeight;
    });
    check(
      'shape',
      reloaded.page !== kept.page &&
        rows41 === ROWS + 1 &&
        reloaded.active &&
        reloaded.dirty &&
        reloaded.canUndo &&
        reloaded.crateX === 401 &&
        reloaded.selection === 'Crate1',
      `new page ${reloaded.page !== kept.page}, tilemap ${rows41} rows; editing ${reloaded.active}, unsaved ${reloaded.dirty}, ` +
        `undo ${reloaded.canUndo}, Crate1.x ${reloaded.crateX}, selected ${reloaded.selection}`,
    );

    // ---- picker (ED-45) ----
    const select = (name) =>
      gameFrame(page).evaluate((name) => {
        window.game.debugUI.editMode.selectFromList(window.game.currentScene.getByName(name).index, false);
        return true;
      }, name);
    const placed = (name, key) =>
      gameFrame(page).evaluate(
        async ({ name, key }) => {
          const { default: WEED } = await import('/src/index.js');
          const scene = window.game.currentScene;
          const record = scene.sceneFile.entities.find((e) => e.name === name);
          const i = scene.getByName(name).index;
          return {
            value: record.config?.[key] ?? null,
            width: WEED.SpriteRenderer.getOriginalWidth(i),
            animation: WEED.SpriteRenderer.animationState[i],
            civilWidth: WEED.SpriteSheetRegistry.getFrameDimensions('bigAtlas', 'civil1_walk_down').w,
            walkUp: WEED.SpriteSheetRegistry.getAnimationIndex('civil1', 'walk_up'),
          };
        },
        { name, key },
      );
    const pickerOf = (row) =>
      row.evaluate((row) => {
        // The field takes its suggestions when it gets the focus (none in the page before: ED-76).
        const input = row.querySelector('input');
        const before = row.querySelector('datalist');
        input.focus();
        const list = row.querySelector('datalist');
        const thumb = row.querySelector('canvas');
        const pixels = thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data;
        let drawn = 0;
        for (let k = 3; k < pixels.length; k += 4) if (pixels[k] > 0) drawn++;
        return {
          value: input.value,
          linked: before === null && input.getAttribute('list') === list.id,
          options: [...list.options].map((o) => (o.textContent ? `${o.value}:${o.textContent}` : o.value)),
          drawn,
        };
      });
    await select('Crate2');
    await page.waitForTimeout(300);
    const spriteRow = page.locator('[data-slot=inspector] [data-key=sprite]');
    const sprite = await pickerOf(spriteRow);
    await spriteRow.locator('input').fill('nope');
    const marked = await spriteRow.locator('input').evaluate((el) => el.style.borderColor);
    await spriteRow.locator('input').fill('civil1_walk_down');
    await spriteRow.locator('input').press('Tab');
    await page.waitForTimeout(400);
    const crate2 = await placed('Crate2', 'sprite');
    await select('Walker2');
    await page.waitForTimeout(300);
    const animRow = page.locator('[data-slot=inspector] [data-key=anim]');
    const anim = await pickerOf(animRow);
    // A pick from the list as Chrome sends it (its native popup is not scriptable): the text replaced in one go.
    await animRow.locator('input').evaluate((input) => {
      input.focus();
      input.value = 'walk_up';
      input.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', bubbles: true }));
    });
    await page.waitForTimeout(400);
    const walker2 = await placed('Walker2', 'anim');
    check(
      'picker',
      sprite.value === 'bunny' &&
        sprite.linked &&
        ['barrel', 'bunny', 'civil1_walk_down', '_white'].every((name) => sprite.options.includes(name)) &&
        sprite.drawn > 50 &&
        /248, 113, 113|f87171/.test(marked) &&
        crate2.value === 'civil1_walk_down' &&
        crate2.width === crate2.civilWidth &&
        anim.options.includes('walk_left:civil1') &&
        anim.options.includes('walk_up:civil1') &&
        anim.drawn > 50 &&
        walker2.value === 'walk_up' &&
        walker2.animation === walker2.walkUp,
      `sprite field "${sprite.value}" with ${sprite.options.length} choices, thumbnail ${sprite.drawn} px drawn; ` +
        `"nope" marked ${marked}; typed civil1_walk_down: record ${crate2.value}, frame ${crate2.width} px wide; ` +
        `animation choices ${anim.options.slice(0, 3).join(', ')}…, thumbnail ${anim.drawn} px; a pick of walk_up: ` +
        `record ${walker2.value}, animation ${walker2.animation} (walk_up is ${walker2.walkUp})`,
    );

    // ---- grid (ED-76) ----
    await select('Crate1');
    await page.waitForTimeout(300);
    await spriteRow.locator('[data-pictures]').click();
    await page.waitForSelector('[data-picture-grid]');
    const grid = await page.evaluate(() => {
      const g = document.querySelector('[data-picture-grid]');
      const cells = [...g.querySelectorAll('[data-cell]')].filter((c) => c.style.display !== 'none');
      return {
        search: g.querySelector('input').value,
        focused: document.activeElement === g.querySelector('input'),
        names: cells.map((c) => c.title),
        cursor: cells.find((c) => c.getAttribute('aria-selected') === 'true')?.title ?? null,
        drawn: cells.filter((c) => {
          const canvas = c.querySelector('canvas');
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          for (let k = 3; k < pixels.length; k += 4) if (pixels[k] > 0) return true;
          return false;
        }).length,
      };
    });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('bun');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const crate1 = await placed('Crate1', 'sprite');
    const closed = await page.evaluate(() => document.querySelector('[data-picture-grid]') === null);
    check(
      'grid',
      grid.search === '' &&
        grid.focused &&
        grid.cursor === 'barrel' &&
        ['barrel', 'bunny', 'civil1_walk_down'].every((name) => grid.names.includes(name)) &&
        grid.drawn >= 3 &&
        crate1.value === 'bunny' &&
        closed,
      `opened on "${grid.search}" (barrel has no number: every sprite), the field focused ${grid.focused}, ` +
        `${grid.names.length} cells (${grid.drawn} drawn), cursor ${grid.cursor}; typed "bun" and Enter: ` +
        `record ${crate1.value}, closed ${closed}`,
    );

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(tilemapPath, { force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed;
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(tilemapPath, { force: true });
  process.exitCode = 1;
});
