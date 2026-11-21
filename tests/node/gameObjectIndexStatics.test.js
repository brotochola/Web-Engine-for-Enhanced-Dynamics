// E-537: the APIs only an instance had, by index. GameObject.sendTo(from, to, ...), GameObject.emit(i, ...),
// GameObject.sendMessageToScene(i, ...), GameObject.isCollidingWith(i, other), the layer and feed-bit statics and
// GameObject.addDecoration(i, ...) do what the entity's methods do. Each case runs the method on one entity and the
// static on a twin from the same columns, and compares what they wrote: the columns, the messages sent, the payloads
// posted.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Messages } from '../../src/core/messages.js';
import { Layer } from '../../src/core/layer.js';
import { noteEntityType } from '../../src/core/entityTypes.js';
import { drainMessages } from '../../src/util/messageRing.js';
import { collisionPairKey } from '../../src/util/utils.js';
import { decorationFacadeCount } from '../../src/util/decorationFacades.js';
import { bindDecorationPool, decorationRow } from '../helpers/decorationPoolWorld.mjs';
import { loadWorker, postedMessages } from '../bench/workerHarness.mjs';

const N = 16;
const D = DecorationComponent;

class Walker extends GameObject {
  static components = [SpriteRenderer, Collider];
}
class Clip extends GameObject {
  static components = [AdobeAnimComponent, MeshRenderer];
}
const WALKER_TYPE = 3;
const CLIP_TYPE = 4;

function bindEntities() {
  for (const C of [Transform, Collider, SpriteRenderer, MeshRenderer, AdobeAnimComponent]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  }
  for (const [C, type] of [[Walker, WALKER_TYPE], [Clip, CLIP_TYPE]]) {
    GameObject._assignComponentClassMap(C);
    C.entityType = type;
    GameObject.classByType[type] = C;
    noteEntityType(type, C);
  }
}

/** Entity `i` of class C, its type written; the instance is the page's kind (it resets nothing). */
function entity(C, i) {
  Transform.entityType[i] = C.entityType;
  return new C(i, {}, null, { page: true });
}

/** Run `fn` with a worker-like `self` whose logic worker holds `frameCollisions`. */
function withLogicSelf(frameCollisions, fn) {
  const previous = globalThis.self;
  globalThis.self = { logicWorker: { frameCollisions } };
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
}

test('E-537: GameObject.sendTo(from, to, ...) sends what entity.sendTo(to, ...) sends', () => {
  bindEntities();
  Messages.bind(Messages.createBuffers(1, 64, N), ['hit', 'heal']);
  try {
    const a = entity(Walker, 2);
    assert.equal(a.sendTo(5, 'hit', 1.5, -2, 3, 4), true);
    assert.equal(a.sendTo(entity(Walker, 6), 'heal'), true);
    assert.equal(GameObject.sendTo(2, 5, 'hit', 1.5, -2, 3, 4), true);
    assert.equal(GameObject.sendTo(2, 6, 'heal'), true);
    assert.equal(GameObject.sendTo(-1, 7, 'heal', 9), true, 'from the scene');
    const got = [];
    drainMessages(Messages.inboxI32[0], Messages.inboxF64[0], (...m) => got.push(m));
    assert.deepEqual(got.slice(0, 2), got.slice(2, 4), 'the instance and the static sent the same');
    assert.deepEqual(got[0], [5, 2, 0, 0, 1.5, -2, 3, 4]);
    assert.deepEqual(got[4], [7, -1, 1, 0, 9, 0, 0, 0]);
  } finally {
    Messages.unbind();
  }
});

test('E-537: GameObject.emit(i, ...) and sendMessageToScene(i, ...) post what the entity\'s methods post', async () => {
  bindEntities();
  await loadWorker('particleWorker.js', 'particleWorker'); // a worker-like self that records what it posts
  const e = entity(Clip, 9);
  const before = postedMessages().length;
  e.emit('died', { score: 40 });
  GameObject.emit(9, 'died', { score: 40 });
  e.sendMessageToScene({ kind: 'ping' });
  GameObject.sendMessageToScene(9, { kind: 'ping' });
  const posted = postedMessages().slice(before);
  assert.equal(posted.length, 4);
  assert.deepEqual(posted[0], posted[1]);
  assert.deepEqual(posted[0], { msg: 'gameObjectEvent', name: 'died', data: { score: 40 }, entityIndex: 9, className: 'Clip' });
  assert.deepEqual(posted[2], posted[3]);
  assert.equal(posted[2].msg, 'messageFromGameObject');
  assert.equal(posted[2].entityIndex, 9);
  assert.equal(posted[2].className, 'Clip');
  // An index no registered type holds: no class name, as an entity without one sent.
  Transform.entityType[10] = 60;
  GameObject.emit(10, 'died');
  assert.equal(postedMessages().at(-1).className, null);
});

test('E-537: GameObject.isCollidingWith(i, other) reads the pair the instance reads', () => {
  const pairs = new Set([collisionPairKey(3, 12)]);
  withLogicSelf(pairs, () => {
    const obj = Object.create(GameObject.prototype);
    obj.index = 12;
    for (const [i, other, want] of [[12, 3, true], [3, 12, true], [12, 4, false]]) {
      assert.equal(GameObject.isCollidingWith(i, other), want, `${i} with ${other}`);
      if (i === 12) assert.equal(obj.isCollidingWith(other), want);
    }
  });
  assert.equal(GameObject.isCollidingWith(3, 12), false, 'no logic worker here: false, as the method says');
});

/** Every layer column of row i. */
function layerRow(i) {
  return [SpriteRenderer.layerMask[i], AdobeAnimComponent.layerMask[i], MeshRenderer.layerMask[i], Collider.layerMask[i], Collider.feedBits[i]];
}

test('E-537: the layer statics write what setLayer, setLayers and setFeedBits write, and layerName reads the same', () => {
  bindEntities();
  Layer.reset();
  Layer.initializeFromConfig({ fx: { zIndex: 8 }, top: { zIndex: 9 } }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    for (const [C, a, b] of [[Walker, 1, 2], [Clip, 3, 4]]) {
      const e = entity(C, a);
      Transform.entityType[b] = C.entityType;
      for (const [method, args] of [['setLayer', ['fx']], ['setLayers', [['fx', 'top']]], ['setLayer', ['entities']], ['setFeedBits', [0x1a3]]]) {
        assert.equal(e[method](...args), e, `${method} chains`);
        assert.equal(GameObject[method](b, ...args), undefined);
        assert.deepEqual(layerRow(b), layerRow(a), `${C.name}.${method}(${JSON.stringify(args)})`);
        assert.equal(GameObject.layerName(b), e.layerName);
        assert.equal(GameObject.getFeedBits(b), e.getFeedBits());
      }
    }
    GameObject.setLayer(2, 'fx');
    assert.equal(GameObject.layerName(2), 'fx');
    assert.equal(GameObject.getFeedBits(2), 0xa3, 'a Walker has a Collider: its feed bits');
    assert.equal(GameObject.getFeedBits(4), 0, 'a Clip has none');
  } finally {
    Layer.reset();
  }
});

test('E-537: GameObject.addDecoration(i, ...) attaches what entity.addDecoration attaches, and makes no facade', () => {
  bindEntities();
  bindDecorationPool(N);
  const e = entity(Walker, 1);
  Transform.entityType[2] = WALKER_TYPE;
  const extra = { alpha: 0.4, tint: 0x33cc99, sortOffsetY: 12 };
  const a = e.addDecoration('_white', 3, -9, 0.5, 2, -4, extra);
  const b = GameObject.addDecoration(2, '_white', 3, -9, 0.5, 2, -4, extra);
  assert.ok(a >= 0 && b >= 0 && a !== b);
  // The parent's index (and its owner, index + 1) aside, the same row.
  assert.deepEqual({ ...decorationRow(b), parentEntityIndex: 1, owner: 2 }, decorationRow(a));
  assert.equal(D.parentEntityIndex[b], 2);
  assert.equal(D.owner[b], 3);
  assert.equal(e.addDecoration('_white', 0, 0, 1, 1, 0), GameObject.getAttachedDecorationIndex(1, 1));
  assert.equal(GameObject.getAttachedDecorationCount(1), e.getAttachedDecorationCount());
  assert.equal(GameObject.getAttachedDecorationCount(2), 1);
  assert.equal(GameObject.getAttachedDecorationIndex(2, 0), b);
  assert.equal(GameObject.getAttachedDecorationIndex(2, 1), -1);
  assert.equal(decorationFacadeCount(), 0, 'no facade made: Decoration.get makes one on demand');
  assert.equal(e.getAttachedDecoration(0).index, a);
  assert.equal(decorationFacadeCount(), 1);
});

