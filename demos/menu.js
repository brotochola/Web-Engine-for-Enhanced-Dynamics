// The scene picker of demos/index.html. '/src/index.js' is the engine's source, or on GitHub Pages the debug bundle
// (index.html's import map).
import WEED from '/src/index.js';

const { GameEngine } = WEED;
const params = new URLSearchParams(location.search);
const SCENE_BTN_GAP = 8;

const game = new GameEngine({
  autoResize: true,
  debug: params.get('debug') !== '0',
  hotReload: !WEED.BUNDLE_MODE, // npm run dev: a file change reloads the scene with its state
  // The site root's: it covers both pages, and on GitHub Pages it also serves the demos' /demos/… paths.
  isolationServiceWorker: new URL('../weed-sw.js', import.meta.url).href,
});
window.game = game;

const scenes = [
  { name: '🦴 Adobe Animate', url: '/demos/adobeAnimateScene/adobeAnimateScene.js' },
  { name: '🐜 Ants', url: '/demos/bichosScene/bichosScene.js' },
  { name: '🐷 Bad Piggies', url: '/demos/badPiggiesScene/badPiggiesScene.js' },
  { name: '⚽ Balls', url: '/demos/ballsScene/ballsScene.js' },
  { name: '💥 Blastforge', url: '/demos/blastforgeScene/blastforgeScene.js', export: 'BlastforgeScene' },
  { name: '🐦 Boids', url: '/demos/boidsScene/boidsScene.js' },
  { name: 'Box2D QueryAABB', url: '/demos/box2dQueryAabbScene/box2dQueryAabbScene.js' },
  { name: 'Bunny Mark', url: '/demos/bunnyMarkScene/bunnyMarkScene.js' },
  { name: '🔥 Burning Boxes', url: '/demos/burningBoxesScene/burningBoxesScene.js', export: 'BurningBoxesScene' },
  { name: '🚗 Car', url: '/demos/carScene/carScene.js' },
  { name: 'Constraint Boxes', url: '/demos/constraintBoxScene/constraintBoxScene.js' },
  { name: '🔗 Constraints', url: '/demos/constraintsTestScene/constraintsTestScene.js' },
  { name: '⛰️ Destructible Terrain', url: '/demos/destructibleTerrainScene/destructibleTerrainScene.js' },
  { name: '⚙️ Gear Chain', url: '/demos/gearChainScene/gearChainScene.js' },
  { name: '🌌 GPU Galaxy', url: '/demos/gpuGalaxyScene/gpuGalaxyScene.js', export: 'GpuGalaxyScene' },
  { name: '🌊 LiquidFun Fluid', url: '/demos/liquidFunDemoScene/liquidFunDemoScene.js' },
  { name: '🧪 LiquidFun Stress (bench)', url: '/tests/bench/stressScenes/liquidFunStressScene.js' },
  { name: '🏙️ Little City', url: '/demos/littleCity/littleCityScene.js' },
  { name: '🧱 Mamushka Dig', url: '/demos/mamushkaDigScene/mamushkaDigScene.js' },
  { name: '🔷 Mesh Gallery', url: '/demos/meshGalleryScene/meshGalleryScene.js' },
  { name: 'Oriented Boxes', url: '/demos/orientedBoxScene/orientedBoxScene.js' },
  { name: '✨ Particle Lab', url: '/demos/particleLabScene/particleLabScene.js' },
  { name: '🪐 Planet', url: '/demos/planetScene/planetScene.js' },
  { name: '🪐 Planet Box2D', url: '/demos/planetPhysicsScene/planetPhysicsScene.js' },
  { name: 'platformer game', url: '/demos/platformerGameScene/platformerGameScene.js' },
  { name: '🐺 Predators', url: '/demos/predatorScene/predatorScene.js' },
  { name: '🌳 Tree', url: '/demos/proceduralTreeScene/proceduralTreeScene.js' },
  { name: '🐍 U Chain', url: '/demos/uChainScene/uChainScene.js' },
  { name: '💧 Water & Boxes', url: '/demos/waterAndBoxesScene/waterAndBoxesScene.js' },
  { name: 'Weld Break', url: '/demos/weldBreakScene/weldBreakScene.js' },
  { name: 'Y-sort overlay (cpu / Z / bitonic)', url: '/tests/bench/stressScenes/ySortOverlayScene.js', export: 'YSortOverlayScene' },
  { name: '🔬 Zenithal Particles', url: '/demos/zenithalParticleTestScene/zenithalParticleTestScene.js' },
];
// Alphabetical by name, its emoji aside, wherever a new entry goes above: the start page and the debug UI's
// scene row both list them in this order.
const sceneSortName = (entry) => entry.name.replace(/^[^\p{L}\p{N}]+/u, '');
scenes.sort((a, b) => sceneSortName(a).localeCompare(sceneSortName(b), 'en', { sensitivity: 'base' }));

async function startScene(entry) {
  document.getElementById('scene_list').style.display = 'none';
  // Keep the scene in the URL, so a reload (or a hot reload) comes back to it.
  const key = sceneKeys(entry).values().next().value;
  if (key && params.get('scene') !== key) {
    params.set('scene', key);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  await game.loadScene(entry.url, { export: entry.export });
}

function sceneKeys(entry) {
  const parts = entry.url.split('/');
  const file = parts[parts.length - 1].replace(/\.js$/i, '');
  const folder = parts[parts.length - 2] || '';
  const keys = new Set();
  for (const raw of [file, folder]) {
    const lower = raw.toLowerCase();
    if (!lower) continue;
    keys.add(lower);
    if (lower.endsWith('scene')) keys.add(lower.slice(0, -5));
  }
  if (keys.has('predator')) {
    keys.add('predators');
    keys.add('predatorsscene');
  }
  return keys;
}

function findScene(query) {
  const want = query.trim().toLowerCase();
  if (!want) return null;
  for (let i = 0; i < scenes.length; i++) {
    if (sceneKeys(scenes[i]).has(want)) return scenes[i];
  }
  return null;
}

function pickSceneGrid(count, availW, availH) {
  const maxW = 210;
  const targetH = 40;
  const minH = 24;
  let best = null;
  const maxCols = Math.min(count, Math.max(1, Math.floor((availW + SCENE_BTN_GAP) / (72 + SCENE_BTN_GAP))));
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(count / cols);
    const w = Math.min(maxW, Math.floor((availW - SCENE_BTN_GAP * (cols - 1)) / cols));
    if (w < 72) continue;
    const slack = availH - SCENE_BTN_GAP * (rows - 1);
    if (slack <= 0) continue;
    const h = Math.min(targetH, Math.floor(slack / rows));
    if (h < minH) continue;
    const gridW = cols * w + SCENE_BTN_GAP * (cols - 1);
    const gridH = rows * h + SCENE_BTN_GAP * (rows - 1);
    const aspect = gridW / gridH;
    const score =
      Math.abs(Math.log(aspect) - Math.log(1.7)) * 36 +
      Math.max(0, 150 - w) * 5 +
      (targetH - h) * 4;
    if (!best || score < best.score) best = { cols, w, h, score };
  }
  if (best) return best;
  const cols = Math.max(1, Math.min(count, Math.floor((availW + SCENE_BTN_GAP) / 64) || 1));
  const rows = Math.ceil(count / cols);
  return {
    cols,
    w: Math.max(1, Math.floor((availW - SCENE_BTN_GAP * (cols - 1)) / cols)),
    h: Math.max(18, Math.floor((availH - SCENE_BTN_GAP * (rows - 1)) / rows)),
  };
}

function layoutSceneList() {
  const list = document.getElementById('scene_list');
  const grid = document.getElementById('scene_grid');
  if (!grid || list.clientWidth < 2 || list.clientHeight < 2) return;

  const bar = document.querySelector('.debug-ui-header');
  const barBottom = bar ? Math.ceil(bar.getBoundingClientRect().bottom) : 0;
  list.style.setProperty('--top-inset', barBottom + 'px');

  const cs = getComputedStyle(list);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const title = list.querySelector('.scene_list_title');
  const titleGap = parseFloat(cs.rowGap || cs.gap) || 0;
  const titleH = title ? title.offsetHeight : 0;
  const availW = Math.max(0, Math.floor(list.clientWidth - padX) - 1);
  const availH = Math.max(0, Math.floor(list.clientHeight - padY - titleH - titleGap) - 1);
  const picked = pickSceneGrid(scenes.length, availW, availH);

  grid.style.gap = SCENE_BTN_GAP + 'px';
  grid.style.width = (picked.cols * picked.w + SCENE_BTN_GAP * (picked.cols - 1)) + 'px';
  grid.style.setProperty('--btn-w', picked.w + 'px');
  grid.style.setProperty('--btn-h', picked.h + 'px');
}

const requested = params.get('scene');
const direct = requested ? findScene(requested) : null;

if (game.debugUI) {
  game.debugUI.registerScenes(scenes);
}

if (direct) {
  startScene(direct);
} else {
  const list = document.getElementById('scene_list');
  const title = document.createElement('p');
  title.className = 'scene_list_title';
  title.textContent = 'WeedJS';
  list.appendChild(title);

  const grid = document.createElement('div');
  grid.id = 'scene_grid';
  list.appendChild(grid);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene_chooser_button';
    button.textContent = scene.name;
    button.title = scene.name;
    button.onclick = () => startScene(scene);
    grid.appendChild(button);
  }

  layoutSceneList();
  window.addEventListener('resize', layoutSceneList);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layoutSceneList);
  const debugBar = document.querySelector('.debug-ui-header');
  if (debugBar && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(layoutSceneList).observe(debugBar);
  }
}
