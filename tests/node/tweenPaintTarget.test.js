import test from 'node:test';
import assert from 'node:assert/strict';

import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// E-275. A paint tween keeps its target (sprite, mesh or none) in its slot instead of reading
// SpriteRenderer.active every frame. It must still follow the entity when its sprite or mesh
// turns on or off mid-tween: the renderers' `active` setters, spawn, Tween.paintTargetChanged
// for direct array writes, and a save restore (rebuildEntityCounts).

const N = 4;

function renderers() {
  const saved = {};
  for (const name of ['active', 'alpha', 'tint', 'scaleX', 'scaleY', 'renderDirty', 'keyedDirty']) {
    saved[`s.${name}`] = SpriteRenderer[name];
  }
  for (const name of ['active', 'alpha', 'tint', 'renderDirty', 'paintEpoch']) saved[`m.${name}`] = MeshRenderer[name];
  SpriteRenderer.active = new Uint8Array(N);
  SpriteRenderer.alpha = new Float32Array(N).fill(1);
  SpriteRenderer.tint = new Uint32Array(N).fill(0xffffff);
  SpriteRenderer.scaleX = new Float32Array(N).fill(1);
  SpriteRenderer.scaleY = new Float32Array(N).fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(N);
  SpriteRenderer.keyedDirty = new Uint8Array(N);
  MeshRenderer.active = new Uint8Array(N);
  MeshRenderer.alpha = new Float32Array(N).fill(1);
  MeshRenderer.tint = new Uint32Array(N).fill(0xffffff);
  MeshRenderer.renderDirty = new Uint8Array(N);
  MeshRenderer.paintEpoch = new Uint32Array(1);
  return () => {
    Tween.unbind();
    for (const key of Object.keys(saved)) {
      const [owner, name] = key.split('.');
      (owner === 's' ? SpriteRenderer : MeshRenderer)[name] = saved[key];
    }
  };
}

function bind(entityCount) {
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(8, entityCount)), 8, entityCount);
}

function clearDirty() {
  SpriteRenderer.renderDirty.fill(0);
  MeshRenderer.renderDirty.fill(0);
}

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: ${actual} vs ${expected}`);
}

for (const entityCount of [N, 0]) {
  const label = entityCount ? 'with per-entity counts' : 'without per-entity counts (whole-pool scan)';
  test(`a paint tween follows its entity from sprite to mesh, back, and to neither (${label})`, { concurrency: false }, () => {
    const restore = renderers();
    try {
      bind(entityCount);
      const sprite = new SpriteRenderer(0);
      const mesh = new MeshRenderer(0);
      SpriteRenderer.active[0] = 1;
      // A bystander on a sprite: its target must not move with entity 0's.
      SpriteRenderer.active[2] = 1;
      const slot = Tween.to(0, { alpha: 0 }, 100, 0);
      const other = Tween.to(2, { alpha: 0 }, 100, 0);
      assert.ok(slot >= 0 && other >= 0);

      Tween.tick(25);
      close(SpriteRenderer.alpha[0], 0.75, 'sprite painted');
      close(MeshRenderer.alpha[0], 1, 'mesh untouched while the sprite is on');
      assert.equal(SpriteRenderer.renderDirty[0], 1);

      // The mesh turns on: the sprite still wins.
      mesh.active = 1;
      clearDirty();
      Tween.tick(25);
      close(SpriteRenderer.alpha[0], 0.5, 'sprite wins over the mesh');
      close(MeshRenderer.alpha[0], 1, 'mesh still untouched');

      // The sprite turns off mid-tween: paint goes to the mesh.
      sprite.active = 0;
      clearDirty();
      const epoch = MeshRenderer.paintEpoch[0];
      Tween.tick(10);
      close(MeshRenderer.alpha[0], 0.4, 'mesh painted after the sprite left');
      close(SpriteRenderer.alpha[0], 0.5, 'the sprite is no longer painted');
      assert.equal(MeshRenderer.renderDirty[0], 1, 'mesh marked for re-render');
      assert.equal(SpriteRenderer.renderDirty[0], 0, 'sprite not marked');
      assert.equal(MeshRenderer.paintEpoch[0], epoch + 1, 'paint epoch bumped');

      // The sprite comes back: paint returns to it.
      sprite.active = 1;
      clearDirty();
      Tween.tick(10);
      close(SpriteRenderer.alpha[0], 0.3, 'sprite painted again');
      close(MeshRenderer.alpha[0], 0.4, 'mesh left where it was');
      assert.equal(MeshRenderer.renderDirty[0], 0);

      // Both turn off: the tween runs but paints nothing.
      sprite.active = 0;
      mesh.active = 0;
      clearDirty();
      Tween.tick(10);
      close(SpriteRenderer.alpha[0], 0.3, 'no sprite write');
      close(MeshRenderer.alpha[0], 0.4, 'no mesh write');
      assert.equal(SpriteRenderer.renderDirty[0], 0);
      assert.equal(MeshRenderer.renderDirty[0], 0);
      assert.equal(Tween.active[slot], 1, 'still live');

      // The mesh alone comes back.
      mesh.active = 1;
      Tween.tick(10);
      close(MeshRenderer.alpha[0], 0.1, 'mesh painted once it is back');

      close(SpriteRenderer.alpha[2], 0.1, 'the bystander kept painting its sprite');
      close(MeshRenderer.alpha[2], 1, 'and never its mesh');
    } finally {
      restore();
    }
  });
}

test('tint follows the target too; a setter that writes the same value changes nothing', { concurrency: false }, () => {
  const restore = renderers();
  try {
    bind(N);
    MeshRenderer.active[1] = 1;
    const slot = Tween.to(1, { tint: 0x000000, alpha: 0 }, 100, 0);
    assert.ok(slot >= 0);
    Tween.tick(50);
    assert.notEqual(MeshRenderer.tint[1], 0xffffff, 'mesh tint tweened');
    assert.equal(SpriteRenderer.tint[1], 0xffffff, 'sprite tint untouched');
    const meshTint = MeshRenderer.tint[1];

    new MeshRenderer(1).active = 1;
    new SpriteRenderer(1).active = 1;
    Tween.tick(50);
    assert.equal(SpriteRenderer.tint[1], 0x000000, 'sprite tint reaches the end');
    assert.equal(MeshRenderer.tint[1], meshTint, 'mesh tint stopped where the sprite took over');
    close(SpriteRenderer.alpha[1], 0, 'sprite alpha reaches the end');
  } finally {
    restore();
  }
});

test('a direct write of active plus Tween.paintTargetChanged moves the tween', { concurrency: false }, () => {
  const restore = renderers();
  try {
    bind(N);
    SpriteRenderer.active[3] = 1;
    Tween.to(3, { alpha: 0 }, 100, 0);
    Tween.tick(50);
    close(SpriteRenderer.alpha[3], 0.5, 'sprite');
    SpriteRenderer.active[3] = 0;
    MeshRenderer.active[3] = 1;
    Tween.paintTargetChanged(3);
    Tween.tick(25);
    close(MeshRenderer.alpha[3], 0.25, 'mesh after paintTargetChanged');
    close(SpriteRenderer.alpha[3], 0.5, 'sprite left');
  } finally {
    restore();
  }
});

test('rebuildEntityCounts (after a save restore) reads every paint target again', { concurrency: false }, () => {
  const restore = renderers();
  try {
    bind(N);
    SpriteRenderer.active[0] = 1;
    Tween.to(0, { alpha: 0 }, 100, 0);
    // The restored world has a mesh there now, written behind the tween's back.
    SpriteRenderer.active[0] = 0;
    MeshRenderer.active[0] = 1;
    Tween.rebuildEntityCounts();
    Tween.tick(50);
    close(MeshRenderer.alpha[0], 0.5, 'mesh painted');
    close(SpriteRenderer.alpha[0], 1, 'sprite not painted');
    assert.equal(Tween.entityTweens[0], 1, 'count rebuilt');
  } finally {
    restore();
  }
});

test('a tween onSpawned starts on a mesh entity paints the mesh once spawn turns it on', { concurrency: false }, () => {
  const restore = renderers();
  const prevNextTick = GameObject.nextTick;
  const prevForce = GameObject.forceProcessOnLogicWorker;
  const prevTransformActive = Transform.active;
  try {
    bind(N);
    Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
    // Pose lives on the Box2D heap in a scene (bindBox2dHotFields).
    Transform.x = new Float32Array(N);
    Transform.y = new Float32Array(N);
    Transform.rotation = new Float32Array(N);
    Transform.rotC = new Float32Array(N);
    Transform.rotS = new Float32Array(N);
    MeshRenderer.initializeArrays(new SharedArrayBuffer(MeshRenderer.getBufferSize(N)), N);
    GameObject.nextTick = null;
    GameObject.forceProcessOnLogicWorker = null;
    class MeshThing extends GameObject {}
    const freeListTop = new Int32Array(new SharedArrayBuffer(8));
    const freeListLinks = new Uint16Array(1);
    resetFreeList(freeListTop, freeListLinks, 1, 1);
    let activeInOnSpawned = -1;
    const pooled = {
      index: 0,
      _hasComponents: { MeshRenderer: true },
      onSpawned() {
        activeInOnSpawned = MeshRenderer.active[0];
        Tween.to(0, { alpha: 0 }, 100, 0);
      },
    };
    MeshThing.startIndex = 0;
    MeshThing.poolSize = 1;
    MeshThing.entityType = 0;
    MeshThing.freeList = freeListLinks;
    MeshThing.freeListTop = freeListTop;
    MeshThing.instances = [pooled];
    MeshThing._componentClassMap = {};
    assert.equal(MeshThing.spawn({}), pooled);
    assert.equal(activeInOnSpawned, 0, 'premise: the mesh is off during onSpawned');
    assert.equal(MeshRenderer.active[0], 1, 'and on after spawn');
    Tween.tick(50);
    close(MeshRenderer.alpha[0], 0.5, 'the tween paints the mesh');
  } finally {
    Transform.active = prevTransformActive;
    GameObject.nextTick = prevNextTick;
    GameObject.forceProcessOnLogicWorker = prevForce;
    restore();
  }
});
