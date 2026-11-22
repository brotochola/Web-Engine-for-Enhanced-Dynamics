// N-303 CR-35: public API nothing in the repo calls (sprite sheets, navigation, tilemaps, entities, sound, Pixi worker).
// Each item keeps a behavioural test so it cannot break unseen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { NavGrid } from '../../src/core/navGrid.js';
import { TileMap } from '../../src/core/tileMap.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Joint } from '../../src/core/joint.js';
import { Grid } from '../../src/core/grid.js';
import { SoundManager } from '../../src/core/soundManager.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { SPRITE_TILE_MODE } from '../../src/util/configDefaults.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { setupAccess } from '../bench/gameObjectAccessMicrobench.mjs';
import { loadWorker } from '../bench/workerHarness.mjs';

/** Run fn with console.error and console.warn captured; returns the lines. */
function captured(fn) {
  const lines = { error: [], warn: [] };
  const { error, warn } = console;
  console.error = (...a) => lines.error.push(a.join(' '));
  console.warn = (...a) => lines.warn.push(a.join(' '));
  try {
    fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return lines;
}

// ---- SpriteSheetRegistry ----

function installSheets() {
  SpriteSheetRegistry.clearForSceneUnload();
  const frame = (w, h) => ({ frame: { x: 0, y: 0, w, h }, sourceSize: { w, h } });
  SpriteSheetRegistry.register('bigAtlas', {
    frames: { civil1_walk_0: frame(8, 8), civil1_walk_1: frame(8, 8), civil1_walk_2: frame(8, 8), civil1_idle_0: frame(8, 8) },
    animations: {
      civil1_walk: ['civil1_walk_0', 'civil1_walk_1', 'civil1_walk_2'],
      civil1_idle: ['civil1_idle_0'],
    },
  });
  SpriteSheetRegistry.registerProxy('civil1', {
    isProxy: true,
    targetSheet: 'bigAtlas',
    prefix: 'civil1_',
    animations: {
      walk: { index: 0, prefixedName: 'civil1_walk' },
      idle: { index: 1, prefixedName: 'civil1_idle' },
    },
    indexToName: { 0: 'walk', 1: 'idle' },
  });
  SpriteSheetRegistry.register('fire', {
    frames: { f0: frame(4, 4), f1: frame(4, 4) },
    animations: { burn: ['f0', 'f1'] },
  });
}

test('SpriteSheetRegistry.validateSpriteConfig accepts a config naming a known sheet and animation', () => {
  installSheets();
  try {
    const lines = captured(() => {
      assert.equal(SpriteSheetRegistry.validateSpriteConfig('Civilian', { spritesheet: 'civil1' }), true);
      assert.equal(
        SpriteSheetRegistry.validateSpriteConfig('Civilian', {
          spritesheet: 'civil1',
          defaultAnimation: 'walk',
          animations: { walk: { speed: 1 } },
        }),
        true,
      );
    });
    assert.deepEqual(lines, { error: [], warn: [] });
  } finally {
    SpriteSheetRegistry.clearForSceneUnload();
  }
});

test('SpriteSheetRegistry.validateSpriteConfig rejects and names what is missing or unknown', () => {
  installSheets();
  try {
    const cases = [
      [undefined, /Civilian: Missing spriteConfig/],
      [{}, /missing "spritesheet"/],
      [{ spritesheet: 'nope' }, /Unknown spritesheet "nope"[\s\S]*Available: .*civil1/],
      [{ spritesheet: 'civil1', defaultAnimation: 'fly' }, /Invalid defaultAnimation "fly"[\s\S]*Available: walk, idle/],
    ];
    for (const [config, message] of cases) {
      const lines = captured(() => assert.equal(SpriteSheetRegistry.validateSpriteConfig('Civilian', config), false));
      assert.equal(lines.error.length, 1, JSON.stringify(config));
      assert.match(lines.error[0], message);
    }
  } finally {
    SpriteSheetRegistry.clearForSceneUnload();
  }
});

test('SpriteSheetRegistry.validateSpriteConfig only warns about a custom animation the sheet lacks', () => {
  installSheets();
  try {
    const lines = captured(() =>
      assert.equal(
        SpriteSheetRegistry.validateSpriteConfig('Civilian', { spritesheet: 'fire', animations: { burn: {}, smoulder: {} } }),
        true,
      ),
    );
    assert.equal(lines.error.length, 0);
    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], /Animation "smoulder" in spriteConfig\.animations not found/);
  } finally {
    SpriteSheetRegistry.clearForSceneUnload();
  }
});

test('SpriteSheetRegistry.getAnimationData returns the animation record of a direct sheet and of a proxy sheet', () => {
  installSheets();
  try {
    assert.deepEqual(SpriteSheetRegistry.getAnimationData('fire', 'burn'), {
      index: 0,
      frameCount: 2,
      frames: ['f0', 'f1'],
    });
    assert.deepEqual(SpriteSheetRegistry.getAnimationData('civil1', 'idle'), { index: 1, prefixedName: 'civil1_idle' });
    assert.equal(SpriteSheetRegistry.getAnimationData('fire', 'nope'), undefined);
    assert.equal(SpriteSheetRegistry.getAnimationData('nosheet', 'burn'), undefined);
  } finally {
    SpriteSheetRegistry.clearForSceneUnload();
  }
});

test('SpriteSheetRegistry.getAnimationFrameCount counts frames for direct, proxy and unregistered sheets', () => {
  installSheets();
  try {
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('fire', 'burn'), 2);
    // A proxy sheet counts the frames of its bigAtlas animation.
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'walk'), 3);
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'idle'), 1);
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'nope'), 0);
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('fire', 'nope'), 0);
    // A sheet this thread never registered (a worker) resolves by the bigAtlas naming convention sheet_anim.
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'walk'), 3);
    SpriteSheetRegistry.spritesheets.delete('civil1');
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'walk'), 3);
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'nope'), 0);
    // No bigAtlas and no sheet: nothing to count.
    SpriteSheetRegistry.clearForSceneUnload();
    assert.equal(SpriteSheetRegistry.getAnimationFrameCount('civil1', 'walk'), 0);
  } finally {
    SpriteSheetRegistry.clearForSceneUnload();
  }
});

// ---- NavGrid ----

const NAV_CONFIG = { cellSize: 32, maxFlowfields: 4, maxPaths: 4, maxPathLength: 16 };

function freshNavGrid() {
  NavGrid.reset();
  const gridWidth = 8;
  const gridHeight = 4;
  const buffer = new SharedArrayBuffer(NavGrid.calculateSABSize(NAV_CONFIG, gridWidth, gridHeight));
  NavGrid.writeHeader(buffer, NAV_CONFIG, gridWidth, gridHeight);
  NavGrid.initialize(buffer, { worldWidth: gridWidth * 32, worldHeight: gridHeight * 32 });
  return buffer;
}

test('NavGrid.setWalkability writes the shared walkability byte of one cell, and ignores cells outside the grid', () => {
  const buffer = freshNavGrid();
  try {
    const bytes = new Uint8Array(buffer, 32, 32); // 32-byte header, then one byte per cell
    NavGrid.setWalkability(5, 1);
    assert.equal(bytes[5], 1);
    NavGrid.setWalkability(5, 7); // 1 and up is walkable (a cost)
    assert.equal(bytes[5], 7);
    NavGrid.setWalkability(5, 0);
    assert.equal(bytes[5], 0);
    NavGrid.setWalkability(-1, 1);
    NavGrid.setWalkability(32, 1);
    assert.equal(bytes.reduce((a, b) => a + b, 0), 0, 'nothing written outside the grid');
    assert.equal(NavGrid.getWalkabilityArray()[5], 0);
  } finally {
    NavGrid.reset();
  }
});

test('NavGrid.isPositionWalkable reads the cell under a world position', () => {
  freshNavGrid();
  try {
    const cell = NavGrid.getCellAt(40, 70); // column 1, row 2
    assert.equal(cell, 2 * 8 + 1);
    assert.equal(NavGrid.isPositionWalkable(40, 70), false, 'a new grid is blocked until written');
    NavGrid.setWalkability(cell, 1);
    assert.equal(NavGrid.isPositionWalkable(40, 70), true);
    assert.equal(NavGrid.isPositionWalkable(63.9, 95.9), true, 'the whole cell');
    assert.equal(NavGrid.isPositionWalkable(64, 70), false, 'the next cell over');
    NavGrid.setWalkability(cell, 0);
    assert.equal(NavGrid.isPositionWalkable(40, 70), false);
    // Outside the world is never walkable.
    assert.equal(NavGrid.isPositionWalkable(-1, 10), false);
    assert.equal(NavGrid.isPositionWalkable(10, 128), false);
    assert.equal(NavGrid.isPositionWalkable(256, 10), false);
  } finally {
    NavGrid.reset();
  }
});

// ---- TileMap ----

function loadTileMap() {
  const w = 4;
  const h = 3;
  const ground = Array.from({ length: w * h }, (_, i) => i + 1);
  const objects = Array.from({ length: w * h }, (_, i) => (i === 5 ? 9 : 0));
  TileMap.initializeFromLoaded({
    uncalled: {
      data: {
        width: w,
        height: h,
        tilewidth: 16,
        tileheight: 8,
        tilesets: [{ firstgid: 1, columns: 4, tilewidth: 16, tileheight: 8 }],
        layers: [
          { type: 'tilelayer', name: 'ground', data: ground, visible: true, opacity: 1 },
          { type: 'tilelayer', name: 'objects', data: objects, visible: true, opacity: 1 },
        ],
      },
    },
  });
  return TileMap.get('uncalled');
}

test('TileMap.getLayerNames lists the tile layers in file order', () => {
  const map = loadTileMap();
  assert.deepEqual([...map.getLayerNames()], ['ground', 'objects']);
  assert.equal(map.getLayerNames().length, map.getLayers().length);
});

test('TileMapLayer.hasTile is true where a world position holds a tile and false for an empty or outside one', () => {
  const map = loadTileMap();
  const ground = map.getLayer('ground');
  const objects = map.getLayer('objects');
  assert.equal(ground.hasTile(0, 0), true);
  assert.equal(ground.hasTile(63.9, 23.9), true, 'the last tile');
  assert.equal(ground.hasTile(64, 0), false, 'past the right edge');
  assert.equal(ground.hasTile(-0.5, 0), false, 'left of the map');
  assert.equal(ground.hasTile(NaN, 0), false);
  // objects holds one tile, at tile (1, 1) = world x 16..31, y 8..15.
  assert.equal(objects.hasTile(20, 10), true);
  assert.equal(objects.hasTile(2, 2), false);
  assert.equal(objects.hasTile(32, 10), false);
  assert.equal(objects.hasTile(20, 10), objects.hasTileAt(1, 1));
});

test('TileMap.tileToWorld gives the centre of a tile in world pixels, into the caller\'s object', () => {
  const map = loadTileMap();
  const out = { x: 0, y: 0 };
  assert.equal(map.tileToWorld(0, 0, out), out);
  assert.deepEqual(out, { x: 8, y: 4 });
  assert.deepEqual(map.tileToWorld(3, 2, out), { x: 56, y: 20 });
  // The centre lies in the tile it came from.
  const tile = { tileX: 0, tileY: 0 };
  assert.deepEqual(map.worldToTile(out.x, out.y, tile), { tileX: 3, tileY: 2 });
  assert.deepEqual(map.tileToWorld(-1, -1, out), { x: -8, y: -4 });
});

// ---- GameObject ----

class Tiled extends GameObject {
  static components = [SpriteRenderer];
}

function spriteEntity(index) {
  const n = 8;
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(n)), n);
  GameObject._assignComponentClassMap(Tiled);
  return new Tiled(index, {}, null, { page: true });
}

test('GameObject.clearTile puts the sprite back to a stretched texture and returns the entity', () => {
  const e = spriteEntity(2);
  e.setTileWorld(64);
  assert.equal(SpriteRenderer.tileMode[2], SPRITE_TILE_MODE.WORLD);
  assert.notEqual(SpriteRenderer.repeatX[2], 0);
  SpriteRenderer.renderDirty[2] = 0;
  assert.equal(e.clearTile(), e);
  assert.equal(SpriteRenderer.tileMode[2], SPRITE_TILE_MODE.STRETCH);
  assert.equal(SpriteRenderer.repeatX[2], 0);
  assert.equal(SpriteRenderer.repeatY[2], 0);
  assert.equal(SpriteRenderer.tileOffsetU[2], 0);
  assert.equal(SpriteRenderer.tileOffsetV[2], 0);
  assert.equal(SpriteRenderer.renderDirty[2], 1, 'the renderer redraws it');
  e.setTileLocal(16, 16, 0.5, 0.5);
  assert.equal(SpriteRenderer.tileMode[2], SPRITE_TILE_MODE.LOCAL);
  e.clearTile();
  assert.equal(SpriteRenderer.tileMode[2], SPRITE_TILE_MODE.STRETCH);
  assert.equal(SpriteRenderer.tileOffsetU[2], 0);
  assert.equal(SpriteRenderer.tileMode[3], SPRITE_TILE_MODE.STRETCH, 'another row is untouched');
});

test('GameObject.setAnimationLoop writes the loop flag of its own row and returns the entity', () => {
  const e = spriteEntity(1);
  assert.equal(e.setAnimationLoop(true), e);
  assert.equal(SpriteRenderer.loop[1], 1);
  e.setAnimationLoop(false);
  assert.equal(SpriteRenderer.loop[1], 0);
  e.setAnimationLoop(1);
  assert.equal(SpriteRenderer.loop[1], 1);
  assert.equal(SpriteRenderer.loop[0], 0);
  assert.equal(SpriteRenderer.loop[2], 0);
});

test('GameObject.getAllNeighborInstances returns one instance per neighbor, in the neighbor list\'s order', { concurrency: false }, () => {
  const { objects, n } = setupAccess('base', 64, 0x3c, { maxNeighbors: 16, maxCount: 8 });
  try {
    let checked = 0;
    for (let i = 0; i < n; i++) {
      const o = objects[i];
      const ids = [...o.getAllNeighborIds()];
      const instances = o.getAllNeighborInstances();
      assert.equal(instances.length, o.neighborCount);
      assert.equal(instances.length, ids.length);
      for (let k = 0; k < ids.length; k++) {
        assert.equal(instances[k], GameObject._at(ids[k]), `entity ${i} neighbor ${k}`);
        assert.equal(instances[k].index, ids[k]);
      }
      // A new array each call, and the zero-allocation form agrees with it.
      assert.notEqual(o.getAllNeighborInstances(), instances);
      assert.deepEqual(o.getAllNeighborInstancesMut([]), instances);
      checked += instances.length;
    }
    assert.ok(checked > 0, 'the fixture has neighbors');
    Grid.reset();
    assert.deepEqual(objects[0].getAllNeighborInstances(), [], 'no grid, no neighbors');
  } finally {
    Grid.reset();
  }
});

function jointSetup(entityCount, maxJoints) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(entityCount)), entityCount);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)), entityCount);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
  RigidBody.sleeping = new Uint8Array(entityCount);
  Joint.reset();
  Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(maxJoints, entityCount)), maxJoints, entityCount);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxJoints * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxJoints, 1);
  Joint.initialize(maxJoints);
  Joint.initializeFreeList(freeList.buffer, freeListTop.buffer);
  for (let i = 0; i < entityCount; i++) {
    Transform.active[i] = 1;
    RigidBody.active[i] = 1;
    Collider.active[i] = 1;
  }
}

test('GameObject.getJoints lists the joint ids the entity is on, both ends alike', () => {
  jointSetup(6, 8);
  try {
    const entity = (i) => {
      const e = Object.create(GameObject.prototype);
      e.index = i;
      return e;
    };
    const a = Joint.addDistance({ entityA: 0, entityB: 1, length: 10 });
    const b = Joint.addRevolute({ entityA: 2, entityB: 0 });
    const c = Joint.addWeld({ entityA: 3, entityB: 4 });
    assert.ok(a >= 0 && b >= 0 && c >= 0);

    const joints0 = entity(0).getJoints();
    assert.equal(joints0.length, 2);
    assert.deepEqual([...joints0].sort(), [a, b].sort());
    assert.equal(entity(0).getJointCount(), 2);
    for (let i = 0; i < joints0.length; i++) assert.equal(joints0[i], entity(0).getJoint(i));
    assert.deepEqual(entity(1).getJoints(), [a], 'the other end of a joint lists it too');
    assert.deepEqual(entity(2).getJoints(), [b]);
    assert.deepEqual(entity(3).getJoints(), [c]);
    assert.deepEqual(entity(5).getJoints(), [], 'an entity with no joint');
    assert.notEqual(entity(5).getJoints(), entity(5).getJoints(), 'a new array each call');
  } finally {
    Joint.reset();
  }
});

// ---- SoundManager ----

function bootSounds(names) {
  SoundManager.setEnabled(true);
  SoundManager._nameToId.clear();
  SoundManager._idToName.length = 0;
  SoundManager._clearAssets();
  const slots = 4;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + slots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots: slots });
  const ids = names.map((name) => SoundManager._assignId(name));
  return ids;
}

test('SoundManager.getSoundId gives the id assigned to a name, and -1 for anything else', { concurrency: false }, () => {
  const ids = bootSounds(['hit', 'quiet', 'loud']);
  assert.deepEqual(ids, [0, 1, 2]);
  assert.equal(SoundManager.getSoundId('hit'), ids[0]);
  assert.equal(SoundManager.getSoundId('loud'), ids[2]);
  assert.equal(SoundManager.getSoundId('missing'), -1);
  for (const notAName of [undefined, null, 1, {}, ['hit']]) assert.equal(SoundManager.getSoundId(notAName), -1);
  assert.deepEqual(SoundManager.exportSoundIdMap(), { hit: 0, quiet: 1, loud: 2 });
});

test('SoundManager.unloadMany unloads each named sound and leaves the others', { concurrency: false }, () => {
  bootSounds(['hit', 'quiet', 'loud', 'soft']);
  SoundManager.unloadMany(['quiet', 'soft']);
  assert.equal(SoundManager.getSoundId('quiet'), -1);
  assert.equal(SoundManager.getSoundId('soft'), -1);
  assert.equal(SoundManager.getSoundId('hit'), 0);
  assert.equal(SoundManager.getSoundId('loud'), 2);
  assert.deepEqual(SoundManager.exportSoundIdMap(), { hit: 0, loud: 2 });
  // Names it does not know are skipped, and a second call is harmless.
  SoundManager.unloadMany(['quiet', 'never-loaded', 'hit']);
  assert.deepEqual(SoundManager.exportSoundIdMap(), { loud: 2 });
});

test('SoundManager.unloadMany ignores a value that is not an array', { concurrency: false }, () => {
  bootSounds(['hit']);
  for (const notAList of [undefined, null, 'hit', { length: 1, 0: 'hit' }]) SoundManager.unloadMany(notAList);
  assert.equal(SoundManager.getSoundId('hit'), 0);
});

test('SoundManager.unloadMany stops a playing voice of the sound it unloads', { concurrency: false }, () => {
  bootSounds(['hit', 'quiet']);
  SoundManager.configureChannels({ sfx: { volume: 1, pan: 0, maxVoices: 4 } });
  SoundManager._f32[SoundManager.HEADER_MIX_GAIN] = 1;
  SoundManager._f32[SoundManager.HEADER_MASTER_VOL] = 1;
  SoundManager._ensureLevelsSab();
  SoundManager.play('hit', 1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  SoundManager.play('quiet', 1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(SoundManager.getActiveSlotCount(), 2);
  SoundManager.unloadMany(['hit']);
  assert.equal(SoundManager.getActiveSlotCount(), 1);
  const voices = SoundManager.readPlayingVoices([]);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].name, 'quiet');
});

// ---- The Pixi worker's self.PIXI ----

test('the Pixi worker puts the PIXI namespace on self for scripts that run inside it', { concurrency: false }, async () => {
  await loadWorker('pixiWorker.js', 'pixiRenderer');
  const { PIXI } = globalThis.self;
  assert.ok(PIXI, 'self.PIXI is set');
  for (const name of ['Container', 'Sprite', 'Texture', 'Mesh', 'RenderTexture']) {
    assert.equal(typeof PIXI[name], 'function', `PIXI.${name}`);
  }
});
