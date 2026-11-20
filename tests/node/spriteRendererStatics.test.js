// E-533: an entity's sprite methods have a static form on SpriteRenderer, by entity index (SpriteRenderer.setAlpha(i, a)
// is this.setAlpha(a)), and the static form's work is the implementation. These run GameObject's method on one entity
// and the static on a twin (same class, same type, same starting columns) and compare every column of the renderers,
// the Adobe clip, the light and the directional sprite, the bounds and clip-bounds calls, the static scenery counter,
// and the warnings. The facade setters SpriteRenderer turned into statics (zIndex, repeatX, normals…) are checked by
// their effects.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer, resetSpriteLookups, packTileOffset01 } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { VolumeShadowCaster } from '../../src/components/volumeShadowCaster.js';
import { DirectionalSprite } from '../../src/components/directionalSprite.js';
import { SpriteSheetRegistry, addBigAtlasChunks, bigAtlasChunkName, BIG_ATLAS_CHUNK } from '../../src/core/spriteSheetRegistry.js';
import { noteEntityType } from '../../src/core/entityTypes.js';
import { bindStaticSceneryGen, bindStaticTypes, staticSceneryGen } from '../../src/core/staticScenery.js';
import { buildDirectionTable } from '../../src/core/spriteDirections.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { SPRITE_TILE_MODE } from '../../src/util/configDefaults.js';
import { GBUF_FLAGS } from '../../src/render/gbufWord.js';

const N = 400;
const f = Math.fround;

class SpriteOnly extends GameObject {
  static components = [SpriteRenderer];
}
class Layered extends GameObject {
  static components = [SpriteRenderer, AdobeAnimComponent, MeshRenderer];
}
class AdobeOnly extends GameObject {
  static components = [AdobeAnimComponent];
}
class MeshOnly extends GameObject {
  static components = [MeshRenderer, Collider];
}
class Caster extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];
}
class Lamp extends GameObject {
  static components = [SpriteRenderer, LightEmitter];
}
class LitClip extends GameObject {
  static components = [SpriteRenderer, AdobeAnimComponent, LightEmitter];
}
class Walker extends GameObject {
  static components = [DirectionalSprite];
}
class Prop extends GameObject {
  static components = [SpriteRenderer];
  static isStatic = true;
}
class NoSpriteYet extends GameObject {
  static components = [SpriteRenderer];
}
class Bare extends GameObject {
  static components = [];
}
/** Never registered by type: a static finds its bits through GameObject.classByType. */
class Unnoted extends GameObject {
  static components = [SpriteRenderer];
}

const CLASSES = [SpriteOnly, Layered, AdobeOnly, MeshOnly, Caster, Lamp, LitClip, Walker, Prop, NoSpriteYet, Bare];
const typeOf = new Map();
const UNNOTED_TYPE = CLASSES.length + 1;

const LPC = ['walk_up', 'walk_left', 'walk_down', 'walk_right', 'idle_up', 'idle_left', 'idle_down', 'idle_right', 'die'];

/** The atlas, two animated sheets and a directional one, as a scene installs them. */
function installSheets() {
  SpriteSheetRegistry.clearForSceneUnload();
  const animations = {};
  const frames = {};
  for (let k = 0; k < 600; k++) {
    animations[`a${k}`] = [`a${k}`];
    frames[`a${k}`] = { frame: { x: 0, y: 0, w: k + 1, h: 2 } };
  }
  animations.civil_hurt = ['civil_hurt_0', 'civil_hurt_1', 'civil_hurt_2'];
  for (let k = 0; k < 3; k++) {
    animations[`civil_hurt_${k}`] = [`civil_hurt_${k}`];
    frames[`civil_hurt_${k}`] = { frame: { x: 0, y: 0, w: 10 + k, h: 7 } };
  }
  const json = { animations, frames, meta: { proxySheets: { walker: { isProxy: true, targetSheet: 'bigAtlas', prefix: 'walker_', animations: {}, indexToName: {} } } } };
  const proxies = { ...json.meta.proxySheets };
  addBigAtlasChunks(json, proxies);
  SpriteSheetRegistry.register('bigAtlas', json);
  for (const [name, proxy] of Object.entries(proxies)) SpriteSheetRegistry.registerProxy(name, proxy);

  SpriteSheetRegistry.register('pairA', {
    animations: { n: ['pa0'], s: ['pa1'], e: ['pa2'] },
    frames: { pa0: { frame: { w: 8, h: 4 } }, pa1: { frame: { w: 30, h: 40 } }, pa2: { frame: { w: 2, h: 2 } } },
  });
  SpriteSheetRegistry.register('pairB', { animations: { s: ['pb0'], n: ['pb1'] } });

  const indexToName = {};
  const anims = {};
  LPC.forEach((n, k) => {
    indexToName[k] = n;
    anims[n] = { originalName: n, index: k };
  });
  const directions = buildDirectionTable('civilDir', undefined, LPC);
  SpriteSheetRegistry.registerProxy('civilDir', { isProxy: true, targetSheet: 'bigAtlas', prefix: 'civilDir_', animations: anims, indexToName, directions });
  SpriteSheetRegistry.frameDimensions.set('civilDir', new Map());
  DirectionalSprite._tables = [];
  GameObject._globalAnimationCache = Object.create(null);
  GameObject._animIndexBySheet = [];
  resetSpriteLookups();
}

const log = { bounds: [], clip: [] };

before(() => {
  for (const C of [Transform, RigidBody, Collider, SpriteRenderer, MeshRenderer, AdobeAnimComponent, LightEmitter, DirectionalSprite, VolumeShadowCaster]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  }
  // The pose and velocity columns live with Box2D's hot fields, not in the components' blocks.
  for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  Transform.rotC.fill(1);
  for (const k of ['vx', 'vy', 'angularVelocity']) RigidBody[k] = new Float32Array(N);
  const realUpdateBounds = SpriteRenderer.updateBounds;
  SpriteRenderer.updateBounds = (i) => {
    log.bounds.push(i);
    realUpdateBounds(i);
  };
  AdobeAnimComponent.applyClipBounds = (i) => {
    log.clip.push(i);
  };
  CLASSES.forEach((C, k) => {
    const type = k + 1;
    typeOf.set(C, type);
    GameObject._assignComponentClassMap(C);
    GameObject.classByType[type] = C;
    noteEntityType(type, C);
  });
  GameObject._assignComponentClassMap(Unnoted);
  GameObject.classByType[UNNOTED_TYPE] = Unnoted;
  typeOf.set(Unnoted, UNNOTED_TYPE);
  bindStaticSceneryGen(new SharedArrayBuffer(4));
  bindStaticTypes(CLASSES.map((C) => ({ entityType: typeOf.get(C), class: C })));
  installSheets();
});

/** Row i as a spawn leaves it, plus what the twins share. */
function resetRow(i) {
  for (const C of [SpriteRenderer, MeshRenderer, AdobeAnimComponent, LightEmitter, DirectionalSprite]) {
    for (const [key, spec] of Object.entries(C.ARRAY_SCHEMA)) {
      const { length } = C._schemaEntry(spec);
      C[key].fill(0, i * length, (i + 1) * length);
    }
  }
  SpriteRenderer.active[i] = 1;
  SpriteRenderer.alpha[i] = 1;
  SpriteRenderer.scaleX[i] = 1;
  SpriteRenderer.scaleY[i] = 1;
  SpriteRenderer.anchorX[i] = 0.5;
  SpriteRenderer.anchorY[i] = 1;
  SpriteRenderer.renderVisible[i] = 1;
  SpriteRenderer.tint[i] = 0xffffff;
  SpriteRenderer.baseTint[i] = 0xffffff;
  SpriteRenderer.spriteRotC[i] = 1;
  AdobeAnimComponent.alpha[i] = 1;
  AdobeAnimComponent.scaleX[i] = 1;
  AdobeAnimComponent.scaleY[i] = 1;
  AdobeAnimComponent.renderVisible[i] = 1;
  MeshRenderer.alpha[i] = 1;
  MeshRenderer.renderVisible[i] = 1;
  MeshRenderer.tint[i] = 0xffffff;
  LightEmitter.dirC[i] = 1;
  Transform.x[i] = 1234.5;
  Transform.y[i] = -77.25;
  Collider.width[i] = 0;
  Collider.height[i] = 0;
}

/** Every column of the row (the strided ones element by element), by name. */
function rowOf(i) {
  const out = {};
  for (const C of [SpriteRenderer, MeshRenderer, AdobeAnimComponent, LightEmitter, DirectionalSprite, Transform]) {
    for (const [key, spec] of Object.entries(C.ARRAY_SCHEMA)) {
      const { length } = C._schemaEntry(spec);
      const col = C[key];
      if (!col) continue;
      for (let k = 0; k < length; k++) out[`${C.name}.${key}${length > 1 ? `[${k}]` : ''}`] = col[i * length + k];
    }
  }
  return out;
}

/** fn's bounds and clip-bounds calls (row i named 'row'), warnings, errors and static scenery steps. */
function run(i, fn) {
  log.bounds = [];
  log.clip = [];
  resetWarnOnce();
  const warns = [];
  const errors = [];
  const g0 = staticSceneryGen();
  const warn = console.warn;
  const error = console.error;
  console.warn = (...a) => warns.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  const named = (calls) => calls.map((k) => (k === i ? 'row' : k));
  return { bounds: named(log.bounds), clip: named(log.clip), warns, errors, scenery: staticSceneryGen() - g0 };
}

/** The setters an entity has as accessors, and their statics. */
const STATIC_OF_SETTER = { alpha: 'setAlpha', tint: 'setTint', visible: 'setVisible', scaleX: 'setScaleX', scaleY: 'setScaleY', flipX: 'setFlipX', flipY: 'setFlipY' };

/** Entity i through SpriteRenderer's statics, called and assigned the way an entity is; each static returns nothing. */
function staticView(i) {
  return new Proxy(
    {},
    {
      get(_, name) {
        return (...args) => {
          assert.equal(typeof SpriteRenderer[name], 'function', `SpriteRenderer.${String(name)} exists`);
          assert.equal(SpriteRenderer[name](i, ...args), undefined, `SpriteRenderer.${String(name)} returns nothing`);
        };
      },
      set(_, name, value) {
        SpriteRenderer[STATIC_OF_SETTER[name]](i, value);
        return true;
      },
    },
  );
}

let nextRow = 1;

/**
 * Each step on an entity of class C (GameObject's method) and on its twin (the static), from the same columns: the same
 * columns, calls and warnings after each. The dirty flags are cleared between steps, so a step that changes nothing
 * shows it.
 */
function twin(C, seed, steps, label) {
  const a = nextRow++;
  const b = nextRow++;
  assert.ok(b < N, 'rows enough');
  for (const i of [a, b]) {
    Transform.entityType[i] = typeOf.get(C);
    resetRow(i);
    if (seed) seed(i);
  }
  const entity = new C(a, {}, null, { page: true });
  const view = staticView(b);
  const logs = steps.map((step, k) => {
    const name = `${label ?? C.name} step ${k} (${step.toString()})`;
    const old = run(a, () => step(entity));
    // The entity's method and the static are one implementation since E-533's rewiring, with one "needs a sprite"
    // warn-once: the twin warns as its first call would.
    if (old.warns.length) resetSpriteLookups();
    const now = run(b, () => step(view));
    assert.deepStrictEqual(now, old, `${name}: calls and warnings`);
    assert.deepStrictEqual(rowOf(b), rowOf(a), `${name}: columns`);
    for (const i of [a, b]) {
      SpriteRenderer.renderDirty[i] = 0;
      SpriteRenderer.keyedDirty[i] = 0;
      MeshRenderer.renderDirty[i] = 0;
    }
    return now;
  });
  return { a, b, logs };
}

/** fn with no room for shadow volumes in the scene (a ShadowCaster's mesh row then follows nothing). */
function withoutVolumes(fn) {
  const col = VolumeShadowCaster.floorScaleY;
  VolumeShadowCaster.floorScaleY = null;
  try {
    fn();
  } finally {
    VolumeShadowCaster.floorScaleY = col;
  }
}

test('markDirty', () => {
  for (const C of [SpriteOnly, Bare]) twin(C, null, [(e) => e.markDirty()]);
});

test('setAlpha and set alpha: the sprite, the Adobe clip, the mesh of a mesh or a shadow volume', () => {
  const steps = [
    (e) => e.setAlpha(0.3),
    (e) => e.setAlpha(0.3),
    (e) => {
      e.alpha = 0.7;
    },
    (e) => {
      e.alpha = 0.7;
    },
    (e) => e.setAlpha(Number.NaN),
    (e) => e.setAlpha(1),
  ];
  for (const C of [SpriteOnly, Layered, AdobeOnly, MeshOnly, Caster, Bare]) twin(C, null, steps);
  withoutVolumes(() => twin(Caster, null, steps, 'Caster without volumes'));
});

test('setTint and set tint', () => {
  const steps = [
    (e) => e.setTint(0xff8800),
    (e) => e.setTint(0xff8800),
    (e) => {
      e.tint = 0x123456;
    },
    (e) => {
      e.tint = 0xffffffff;
    },
    (e) => e.setTint(0xffffffff),
  ];
  for (const C of [SpriteOnly, Layered, AdobeOnly, MeshOnly, Bare]) twin(C, null, steps);
});

test('setVisible and set visible', () => {
  const steps = [
    (e) => e.setVisible(false),
    (e) => e.setVisible(false),
    (e) => {
      e.visible = 1;
    },
    (e) => {
      e.visible = '';
    },
    (e) => e.setVisible(true),
  ];
  for (const C of [SpriteOnly, Layered, AdobeOnly, Caster, Bare]) twin(C, null, steps);
  withoutVolumes(() => twin(Caster, null, steps, 'Caster without volumes'));
});

test('setScale, set scaleX and set scaleY keep the flip', () => {
  const steps = [
    (e) => e.setScale(0.3),
    (e) => e.setScale(0.3),
    (e) => e.setScale(2, 0.7),
    (e) => {
      e.scaleX = 0.3;
    },
    (e) => {
      e.scaleX = 0.3;
    },
    (e) => {
      e.scaleY = -1.5;
    },
    (e) => {
      e.scaleY = -1.5;
    },
    (e) => e.setScale(Number.NaN),
  ];
  const flipped = (i) => {
    SpriteRenderer.flip[i] = 3;
    SpriteRenderer.scaleX[i] = -1;
    SpriteRenderer.scaleY[i] = -1;
    AdobeAnimComponent.flip[i] = 1;
    AdobeAnimComponent.scaleX[i] = -1;
  };
  for (const C of [SpriteOnly, Layered, AdobeOnly, Bare]) {
    twin(C, null, steps);
    twin(C, flipped, steps, `${C.name} flipped`);
  }
});

test('setFlip, set flipX and set flipY: the sprite, the Adobe clip, and a light that follows the flip', () => {
  const steps = [
    (e) => e.setFlip(true),
    (e) => e.setFlip(true),
    (e) => e.setFlip(false, true),
    (e) => {
      e.flipX = 1;
    },
    (e) => {
      e.flipY = 0;
    },
    (e) => {
      e.flipX = false;
    },
    (e) => e.setFlip(1, 1),
  ];
  const light = (follow) => (i) => {
    LightEmitter.followFlip[i] = follow;
    LightEmitter.offsetX[i] = 12;
    LightEmitter.dirC[i] = 0.5;
    SpriteRenderer.scaleX[i] = 2;
  };
  for (const C of [SpriteOnly, Layered, AdobeOnly, Bare]) twin(C, null, steps);
  twin(Lamp, light(1), steps, 'Lamp following the flip');
  twin(Lamp, light(0), steps, 'Lamp not following it');
  twin(LitClip, light(1), steps, 'LitClip following the flip');
  const { b } = twin(Lamp, light(1), [(e) => e.setFlip(true)], 'Lamp flipped once');
  assert.deepEqual([LightEmitter.offsetX[b], LightEmitter.dirC[b]], [-12, -0.5], 'the light mirrored (this checks something)');
});

test('setTileWorld, setTileLocal and clearTile: the sprite and the mesh', () => {
  const steps = [
    (e) => e.setTileWorld(64),
    (e) => e.setTileWorld(70000, -3, 1234.567, -0.25),
    (e) => e.setTileLocal(32, 16, 0.5),
    (e) => e.setTileLocal(8.9, undefined, 7.0001),
    (e) => e.setTileWorld(16, null, undefined, 0.75),
    (e) => e.clearTile(),
  ];
  for (const C of [SpriteOnly, MeshOnly, Layered, Bare]) twin(C, null, steps);
  const { b } = twin(SpriteOnly, null, [(e) => e.setTileWorld(10, 20, 1234.567, 0.5)], 'a large phase');
  assert.equal(SpriteRenderer.tileOffsetU[b], packTileOffset01(1234.567), 'the phase is not rounded to float32 on the way');
  assert.equal(SpriteRenderer.tileMode[b], SPRITE_TILE_MODE.WORLD);
});

test('bakeWorldTileToLocal: the crop at the entity’s position, from its bounds or its collider', () => {
  const tiled = (i) => {
    SpriteRenderer.repeatX[i] = 64;
    SpriteRenderer.repeatY[i] = 48;
    SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.WORLD;
    SpriteRenderer.boundsHalfW[i] = 10.5;
    SpriteRenderer.boundsHalfH[i] = 5;
    MeshRenderer.repeatX[i] = 32;
    MeshRenderer.repeatY[i] = 16;
    MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.WORLD;
    Collider.width[i] = 40;
  };
  const acrossOnly = (i) => {
    tiled(i);
    SpriteRenderer.repeatY[i] = 0;
    MeshRenderer.repeatX[i] = 0;
  };
  for (const C of [SpriteOnly, MeshOnly, Layered, Bare]) {
    twin(C, tiled, [(e) => e.bakeWorldTileToLocal()]);
    twin(C, acrossOnly, [(e) => e.bakeWorldTileToLocal()], `${C.name} one axis`);
    twin(C, null, [(e) => e.bakeWorldTileToLocal()], `${C.name} untiled`);
  }
});

test('setDisplaySize: world px from the frame’s size; without a sprite, one warning', () => {
  const sized = (i) => {
    SpriteRenderer.spritesheetId[i] = SpriteSheetRegistry.getSpritesheetId('pairA');
    SpriteRenderer.animationState[i] = 0;
  };
  const steps = [(e) => e.setDisplaySize(32), (e) => e.setDisplaySize(32, 8), (e) => e.setDisplaySize(16.3, 0.1)];
  const { b } = twin(SpriteOnly, sized, steps);
  assert.deepEqual([SpriteRenderer.scaleX[b], SpriteRenderer.scaleY[b]], [f(16.3 / 8), f(0.1 / 4)], 'the frame was found');
  twin(Layered, sized, steps);
  twin(Bare, sized, steps);
  // The first call of a class without a sprite warns, naming the class (the static: its type's), once.
  const { logs } = twin(NoSpriteYet, null, [(e) => e.setDisplaySize(10), (e) => e.setDisplaySize(10)]);
  assert.deepEqual(logs.map((l) => l.warns), [
    ['WeedJS: NoSpriteYet.setDisplaySize needs a sprite: call setSprite / setSpritesheet first.'],
    [],
  ]);
});

test('setAnchor: the sprite (and the static scenery counter of a static type) and the Adobe clip', () => {
  const steps = [(e) => e.setAnchor(0.3, 1), (e) => e.setAnchor(0.5), (e) => e.setAnchor(0.25, 0.75)];
  for (const C of [SpriteOnly, Layered, AdobeOnly, Bare]) twin(C, null, steps);
  const { logs } = twin(Prop, null, steps);
  assert.equal(logs[0].scenery, 1, 'a static entity’s anchor moves the counter (this checks something)');
});

test('setAnimationState, setAnimationSpeed and setAnimationLoop', () => {
  const steps = [
    (e) => e.setAnimationState(3),
    (e) => e.setAnimationState(3),
    (e) => e.setAnimationState(300),
    (e) => e.setAnimationSpeed(0.3),
    (e) => e.setAnimationSpeed(0.3),
    (e) => e.setAnimationSpeed(37.5 * 0.00277),
    (e) => e.setAnimationSpeed(37.5 * 0.00277),
    (e) => e.setAnimationSpeed(0),
    (e) => e.setAnimationLoop(false),
    (e) => e.setAnimationLoop(1),
  ];
  for (const C of [SpriteOnly, Bare]) twin(C, null, steps);
});

test('setSpritesheet: animated, visible, bounds; a directional sprite resolves on its new sheet', () => {
  const steps = [(e) => e.setSpritesheet('pairA'), (e) => e.setSpritesheet('nope'), (e) => e.setSpritesheet('civilDir'), (e) => e.setSpritesheet('pairB')];
  const directional = (i) => DirectionalSprite.resetRow(i);
  twin(SpriteOnly, null, steps);
  twin(Walker, directional, steps);
  twin(Bare, null, steps);
});

test('setAnimation: by name on the sheet, once; a directional sprite plays a group or pins a plain animation', () => {
  const onSheet = (name) => (i) => {
    SpriteRenderer.spritesheetId[i] = SpriteSheetRegistry.getSpritesheetId(name);
  };
  const steps = [
    (e) => e.setAnimation('s'),
    (e) => e.setAnimation('s'),
    (e) => e.setAnimation('s', false),
    (e) => e.setAnimation('jump'),
    (e) => e.setAnimation('n'),
    (e) => e.setAnimation('e', 0),
  ];
  const { b } = twin(SpriteOnly, onSheet('pairA'), steps);
  assert.deepEqual([SpriteRenderer.animationState[b], SpriteRenderer.loop[b]], [2, 0]);
  twin(SpriteOnly, onSheet('pairB'), steps, 'SpriteOnly on pairB');
  twin(SpriteOnly, null, steps, 'SpriteOnly without a sheet');
  twin(Bare, onSheet('pairA'), steps);
  const directional = (i) => {
    onSheet('civilDir')(i);
    DirectionalSprite.resetRow(i);
    SpriteRenderer.animationState[i] = 255;
  };
  const turns = [
    (e) => e.setAnimation('walk'),
    (e) => e.setAnimation('walk'),
    (e) => e.setAnimation('die', false),
    (e) => e.setAnimation('nope'),
    (e) => e.setAnimation('idle'),
    (e) => e.setAnimation('walk_left'),
  ];
  const w = twin(Walker, directional, turns);
  assert.equal(SpriteSheetRegistry.getAnimationName('civilDir', SpriteRenderer.animationState[w.b]), 'walk_left', 'pinned');
});

test('setSprite: a texture, a chunk past 255, a frame of an animation; what is missing is reported', () => {
  const steps = [
    (e) => e.setSprite('a10'),
    (e) => e.setSprite('a300'),
    (e) => e.setSprite('a300'),
    (e) => e.setSprite('a599'),
    (e) => e.setSprite('civil', 'hurt', -1),
    (e) => e.setSprite('civil', 'hurt'),
    (e) => e.setSprite('walker', 'hurt', 0),
    (e) => e.setSprite('missing'),
    (e) => e.setSprite('a10'),
  ];
  for (const C of [SpriteOnly, Bare]) twin(C, null, steps);
  const { b } = twin(SpriteOnly, null, [(e) => e.setSprite('a599')], 'a599');
  assert.equal(SpriteSheetRegistry.getSpritesheetName(SpriteRenderer.spritesheetId[b]), bigAtlasChunkName(2));
  assert.equal(SpriteRenderer.animationState[b], 599 - 2 * BIG_ATLAS_CHUNK);
});

test('resetSpriteLookups: a new atlas numbers its sprites again', () => {
  const i = nextRow++;
  resetRow(i);
  Transform.entityType[i] = typeOf.get(SpriteOnly);
  SpriteRenderer.setSprite(i, 'a10');
  assert.equal(SpriteRenderer.animationState[i], 10);
  SpriteSheetRegistry.clearForSceneUnload();
  SpriteSheetRegistry.register('bigAtlas', { animations: { other: ['o'], a10: ['x'] } });
  SpriteRenderer.setAnimationState(i, 0);
  SpriteRenderer.setSprite(i, 'a10');
  assert.equal(SpriteRenderer.animationState[i], 10, 'kept from the last atlas until reset');
  resetSpriteLookups();
  SpriteRenderer.setSprite(i, 'a10');
  assert.equal(SpriteRenderer.animationState[i], 1);
  installSheets();
});

test('a static on a type no registration noted finds its class through GameObject.classByType', () => {
  const i = nextRow++;
  resetRow(i);
  Transform.entityType[i] = UNNOTED_TYPE;
  SpriteRenderer.setAlpha(i, 0.5);
  SpriteRenderer.setFlipX(i, true);
  assert.deepEqual([SpriteRenderer.alpha[i], SpriteRenderer.flip[i], SpriteRenderer.scaleX[i]], [0.5, 1, -1]);
});

// ─── the facade setters' statics ───

/** A SpriteRenderer instance on row i (what entity.spriteRenderer is). */
function facade(i) {
  return new SpriteRenderer(i);
}

test('zIndex: the column and the count of sprites with one, from the facade and the static', () => {
  const users = () => SpriteRenderer.zIndexUsers();
  const a = nextRow++;
  const b = nextRow++;
  resetRow(a);
  resetRow(b);
  const u0 = users();
  facade(a).zIndex = 5;
  SpriteRenderer.setZIndex(b, 5.9);
  assert.deepEqual([SpriteRenderer.zIndex[a], SpriteRenderer.zIndex[b], users() - u0], [5, 5, 2]);
  facade(a).zIndex = 7;
  SpriteRenderer.setZIndex(b, 5);
  assert.deepEqual([SpriteRenderer.zIndex[a], SpriteRenderer.zIndex[b], users() - u0], [7, 5, 2], 'a change between non-zero values counts nothing');
  facade(a).zIndex = 0;
  SpriteRenderer.setZIndex(b, 0);
  assert.equal(users() - u0, 0);
  SpriteRenderer.setZIndex(b, 0);
  assert.equal(users() - u0, 0, 'zero again: nothing');
});

test('repeatX, repeatY, tileMode, tileOffsetU, tileOffsetV: clamped or packed, the row marked', () => {
  for (const [set, i] of [
    [(i, k, v) => (facade(i)[k] = v), nextRow++],
    [(i, k, v) => SpriteRenderer[`set${k[0].toUpperCase()}${k.slice(1)}`](i, v), nextRow++],
  ]) {
    resetRow(i);
    const marked = () => {
      const m = [SpriteRenderer.renderDirty[i], SpriteRenderer.keyedDirty[i]];
      SpriteRenderer.renderDirty[i] = 0;
      SpriteRenderer.keyedDirty[i] = 0;
      return m;
    };
    set(i, 'repeatX', 70000);
    assert.deepEqual([SpriteRenderer.repeatX[i], ...marked()], [65535, 1, 1]);
    set(i, 'repeatY', -4);
    assert.deepEqual([SpriteRenderer.repeatY[i], ...marked()], [0, 1, 1]);
    set(i, 'repeatY', 12.7);
    assert.equal(SpriteRenderer.repeatY[i], 12);
    set(i, 'tileMode', 9);
    assert.deepEqual([SpriteRenderer.tileMode[i], ...marked()], [SPRITE_TILE_MODE.LOCAL, 1, 1]);
    set(i, 'tileMode', -1);
    assert.equal(SpriteRenderer.tileMode[i], SPRITE_TILE_MODE.STRETCH);
    set(i, 'tileOffsetU', 2.25);
    assert.deepEqual([SpriteRenderer.tileOffsetU[i], ...marked()], [packTileOffset01(0.25), 1, 1]);
    set(i, 'tileOffsetV', -0.25);
    assert.deepEqual([SpriteRenderer.tileOffsetV[i], ...marked()], [packTileOffset01(0.75), 1, 1]);
    assert.equal(facade(i).tileOffsetV, packTileOffset01(0.75) / 65535);
  }
});

test('spriteRotation: its cosine and sine', () => {
  const a = nextRow++;
  const b = nextRow++;
  facade(a).spriteRotation = 0.3;
  SpriteRenderer.setSpriteRotation(b, 0.3);
  for (const i of [a, b]) {
    assert.deepEqual([SpriteRenderer.spriteRotC[i], SpriteRenderer.spriteRotS[i]], [f(Math.cos(0.3)), f(Math.sin(0.3))]);
  }
  assert.ok(Math.abs(facade(b).spriteRotation - 0.3) < 1e-6);
});

test('normals, surface and unshaded: their bits of the G-buffer flags; a wrong value warned once; the unshaded count', () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    for (const [set, i] of [
      [(i, k, v) => (facade(i)[k] = v), nextRow++],
      [(i, k, v) => SpriteRenderer[`set${k[0].toUpperCase()}${k.slice(1)}`](i, v), nextRow++],
    ]) {
      resetRow(i);
      const s = facade(i);
      set(i, 'normals', 'height');
      set(i, 'surface', 'floor');
      assert.deepEqual([s.normals, s.surface], ['height', 'floor']);
      assert.equal(SpriteRenderer.gbufFlags[i] & GBUF_FLAGS.FLOOR, GBUF_FLAGS.FLOOR);
      set(i, 'normals', 'shiny');
      set(i, 'surface', 'wall');
      assert.deepEqual([s.normals, s.surface], ['height', 'floor'], 'a wrong value changes nothing');
      set(i, 'surface', 'standing');
      assert.equal(s.surface, 'standing');
      const u0 = SpriteRenderer.unshadedUsers();
      set(i, 'unshaded', true);
      set(i, 'unshaded', true);
      assert.deepEqual([s.unshaded, SpriteRenderer.unshadedUsers() - u0], [true, 1]);
      set(i, 'unshaded', 1);
      assert.deepEqual([s.unshaded, SpriteRenderer.unshadedUsers() - u0], [false, 0], 'only true is on');
      assert.equal(s.normals, 'height', 'unshaded leaves the other bits');
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 2, `each wrong value said once: ${warned.join(' | ')}`);
});

// ─── TurboFan inlines the statics ───

/** V8 inlines a callee handed a heap number when its bytecode is 75 bytes or less (setterArgs.js); a bundle widens
 * up to four of a static's operands (its module slots past the 255th) by 4 bytes each, so the source keeps that room. */
const STATIC_MAX = 75 - 4 * 4;
const STATICS = {
  setAlpha: [0.3],
  setTint: [0xff0000],
  setVisible: [true],
  setScale: [0.3, 0.7],
  setScaleX: [0.3],
  setScaleY: [0.3],
  setFlip: [true, false],
  setFlipX: [true],
  setFlipY: [true],
  setTileWorld: [16, 16, 0.5, 0.5],
  setTileLocal: [16, 16, 0.5, 0.5],
  setDisplaySize: [10, 10],
  setAnchor: [0.5, 1],
  setAnimationState: [1],
  setAnimationSpeed: [0.3],
  setAnimationLoop: [true],
  setSpritesheet: ['nope'],
  setAnimation: ['walk'],
  setSprite: ['nope'],
  setSpriteRotation: [0.3],
  setRepeatX: [4],
  setRepeatY: [4],
  setTileMode: [1],
  setTileOffsetU: [0.5],
  setTileOffsetV: [0.5],
  setZIndex: [2],
  setNormals: ['flat'],
  setSurface: ['floor'],
  setUnshaded: [false],
  markDirty: [],
  clearTile: [],
  bakeWorldTileToLocal: [],
};

test('every static stays small enough for TurboFan to inline it when it is handed a heap number', () => {
  const src = new URL('../../src/components/spriteRenderer.js', import.meta.url).href;
  const transform = new URL('../../src/components/transform.js', import.meta.url).href;
  const driver = `
    import { SpriteRenderer } from ${JSON.stringify(src)};
    import { Transform } from ${JSON.stringify(transform)};
    const N = 4;
    SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
    Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
    console.error = () => {};
    console.warn = () => {};
    for (const [name, args] of Object.entries(${JSON.stringify(STATICS)})) SpriteRenderer[name](1, ...args);
  `;
  const lengths = new Map();
  for (const filter of ['set*', 'markDirty', 'clearTile', 'bakeWorldTileToLocal']) {
    const r = spawnSync(process.execPath, ['--print-bytecode', `--print-bytecode-filter=${filter}`, '--input-type=module', '-e', driver], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.stderr);
    const header = /\[generated bytecode for function: (\S+) \(0x[0-9a-fA-F]+ <SharedFunctionInfo[^\n]*\r?\nBytecode length: (\d+)/g;
    for (const m of r.stdout.matchAll(header)) {
      if (!lengths.has(m[1])) lengths.set(m[1], []);
      lengths.get(m[1]).push(Number(m[2]));
    }
  }
  for (const name of Object.keys(STATICS)) {
    const found = lengths.get(name);
    assert.ok(found, `${name}: no bytecode printed`);
    assert.equal(found.length, 1, `${name}: one function of that name ran`);
    assert.ok(found[0] <= STATIC_MAX, `SpriteRenderer.${name} is ${found[0]} bytes of bytecode, over ${STATIC_MAX}: keep its work in its ...At function`);
  }
});
