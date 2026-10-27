// A small world for the editor's handles tests (tests/node/editorHandles.test.js): the components' columns on shared
// buffers, entity classes whose spawn does what their onSpawned would (a logic worker's fill of the params, then the
// collider or light they set), a scene file that places one of each, and the real EditMode over a fake debug UI. A
// despawn bumps the slot's spawn generation and a spawn takes the lowest free slot, so a respawn usually lands in the
// slot it left, as the pools' free lists make it.
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { Messages } from '../../src/core/messages.js';
import { describeSpawnParams, KIND_ENTITY } from '../../src/core/spawnParams.js';
import { respawnPlaced, indexOfName, recordOf } from '../../src/core/debug/editor/sceneDocument.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';

export const N = 32;

function box(i, w, h) {
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Box;
  Collider.radius[i] = 0;
  Collider.width[i] = w;
  Collider.height[i] = h;
}

function circle(i, r) {
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Circle;
  Collider.radius[i] = r;
}

function light(i, intensity) {
  LightEmitter.active[i] = 1;
  LightEmitter.lightIntensity[i] = intensity;
  LightEmitter.sqrtLightIntensity[i] = Math.sqrt(intensity);
}

/** Each class: its spawnParams, and what its onSpawned does with the entity's index and the filled params. */
const CLASSES = [
  ['Block', { width: { value: 220, min: 8, max: 4000, step: 1 }, height: { value: 36, min: 8, max: 1000, step: 1 } }, (i, p) => box(i, p.width, p.height)],
  ['Ball', { radius: { value: 16, min: 1, max: 500 } }, (i, p) => circle(i, p.radius)],
  [
    'Rock',
    { points: { value: [0, -20, 20, 10, -20, 10], type: 'points' } },
    (i, p) => {
      Collider.active[i] = 1;
      Collider.makePolygon(i, p.points);
    },
  ],
  ['Lamp', { lightIntensity: { value: 2500, min: 0, max: 1000000 } }, (i, p) => light(i, p.lightIntensity)],
  [
    'Guard',
    { route: { value: null, type: 'points' }, door: { value: null, type: 'entity', class: 'Door' }, speed: { value: 3 } },
    () => {},
  ],
  ['Door', undefined, (i) => box(i, 40, 80)],
  ['Pebble', { tint: { value: 0, type: 'color' } }, (i) => circle(i, 8)],
  [
    'Shard',
    undefined,
    (i) => {
      Collider.active[i] = 1;
      Collider.makePolygon(i, [0, -10, 10, 10, -10, 10]);
    },
  ],
  ['Torch', { tint: { value: 0, type: 'color' } }, (i) => light(i, 400)],
];

/** The file: one of each, Door1 before the Guard that names it. */
export function sceneFileEntities() {
  return [
    { name: 'Block1', class: 'Block', x: 300, y: 200, config: { width: 100, height: 20 } },
    { name: 'Ball1', class: 'Ball', x: 500, y: 100 },
    { name: 'Rock1', class: 'Rock', x: 700, y: 300 },
    { name: 'Lamp1', class: 'Lamp', x: 100, y: 500 },
    { name: 'Door1', class: 'Door', x: 1200, y: 400 },
    { name: 'Door2', class: 'Door', x: 1400, y: 400 },
    { name: 'Guard1', class: 'Guard', x: 900, y: 400, config: { route: [900, 400, 1000, 400], door: 'Door1' } },
    { name: 'Pebble1', class: 'Pebble', x: 600, y: 600 },
    { name: 'Shard1', class: 'Shard', x: 800, y: 600 },
    { name: 'Torch1', class: 'Torch', x: 1000, y: 600 },
  ];
}

export function makeWorld() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);

  /** What the classes were asked: ['spawn', class, config] and ['despawn', class, index]. */
  const calls = [];
  const classes = [];
  CLASSES.forEach(([name, spawnParams, onSpawned], type) => {
    const EntityClass = { [name]: class {} }[name];
    if (spawnParams !== undefined) EntityClass.spawnParams = spawnParams;
    EntityClass.poolSize = N;
    EntityClass.spawn = (cfg = {}) => {
      let i = 0;
      while (i < N && Transform.active[i] === 1) i++;
      if (i === N) return null;
      calls.push(['spawn', name, { ...cfg }]);
      Transform.active[i] = 1;
      Transform.entityType[i] = type;
      Transform.x[i] = cfg.x ?? 0;
      Transform.y[i] = cfg.y ?? 0;
      Transform.rotC[i] = 1;
      Transform.rotS[i] = 0;
      onSpawned(i, fill(EntityClass, cfg));
      return { index: i };
    };
    EntityClass.despawn = (i) => {
      calls.push(['despawn', name, i]);
      Transform.active[i] = 0;
      Collider.active[i] = 0;
      Collider.polyCount[i] = 0;
      LightEmitter.active[i] = 0;
      Messages.spawnGen[i]++;
    };
    classes.push(EntityClass);
  });

  const scene = {
    constructor: { name: 'HandlesScene' },
    sceneFile: { format: 1, script: 's.js', entities: sceneFileEntities() },
    sceneFileUrl: null,
    registeredClasses: classes.map((EntityClass, entityType) => ({ class: EntityClass, entityType })),
    _namedEntities: new Map(),
  };
  for (const record of scene.sceneFile.entities) respawnPlaced(scene, record.name);
  calls.length = 0;

  const canvas = { tagName: 'CANVAS' };
  const debugUI = {
    scene,
    gameEngine: { canvas },
    tools: {
      _classNameForType: (type) => classes[type]?.name ?? '',
      updateToolIndicator() {},
      deactivateAll() {},
      _syncDebugToolFlag() {},
    },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
    panels: { scene: { updateEditButton() {} } },
    _ensureTickLoop() {},
  };
  const editMode = new EditMode(debugUI);
  editMode.selection._show = () => {};
  // As if Shift+E: the editor asks its tools only while editing (this world has no listeners, time or camera).
  editMode.active = true;

  const classOf = (name) => classes.find((C) => C.name === name);
  return {
    scene,
    calls,
    canvas,
    editMode,
    handles: editMode.handles,
    classOf,
    indexOf: (name) => indexOfName(scene, name),
    record: (name) => recordOf(scene, name)?.record ?? null,
    select: (name) => editMode.selection.select(indexOfName(scene, name)),
    done: () => clearTimeout(editMode._statusTimer),
  };
}

/** The params a logic worker's fill gives onSpawned: each declared key from the config, else its default. */
function fill(EntityClass, cfg) {
  const description = describeSpawnParams(EntityClass);
  const params = { x: cfg.x ?? 0, y: cfg.y ?? 0 };
  if (description === null) return params;
  for (let k = 0; k < description.keys.length; k++) {
    const key = description.keys[k];
    const value = cfg[key];
    params[key] = value !== undefined && value !== null ? value : description.kinds[k] === KIND_ENTITY ? null : description.defaults[k];
  }
  return params;
}

/** A 2D context that keeps what is drawn: paths as ['M' | 'L', x, y], arcs, rects, texts, strokes, dashes. */
export function fakeContext() {
  const log = [];
  const ctx = {
    log,
    save() {},
    restore() {},
    beginPath() {},
    closePath: () => log.push(['Z']),
    moveTo: (x, y) => log.push(['M', x, y]),
    lineTo: (x, y) => log.push(['L', x, y]),
    arc: (x, y, r) => log.push(['arc', x, y, r]),
    stroke: () => log.push(['stroke', ctx.strokeStyle]),
    fill() {},
    fillRect: (x, y, w, h) => log.push(['rect', x, y, w, h]),
    strokeRect() {},
    setLineDash: (dash) => log.push(['dash', dash.length]),
    measureText: (text) => ({ width: text.length * 6 }),
    fillText: (text, x, y) => log.push(['text', text, x, y]),
  };
  return ctx;
}
