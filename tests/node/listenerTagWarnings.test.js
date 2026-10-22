import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Collider } from '../../src/components/collider.js';
import { CollisionListener } from '../../src/components/collisionListener.js';
import { CameraInOutListener } from '../../src/components/cameraInOutListener.js';
import { JointBreakListener } from '../../src/components/jointBreakListener.js';
import { missingListenerTags, warnMissingListenerTags } from '../../src/util/listenerTags.js';

// A collision / screen / joint-break hook without its tag component never runs,
// and nothing said so. The scene now warns once per class at registration.

function reg(EntityClass) {
  return { class: EntityClass, components: GameObject._collectComponents(EntityClass) };
}

function warningsFor(...classes) {
  const out = [];
  warnMissingListenerTags(classes.map(reg), GameObject, (m) => out.push(m));
  return out;
}

test('a class with collision hooks and no CollisionListener gets one warning naming them', () => {
  class Crate extends GameObject {
    static components = [Collider];
    onCollisionEnter() {}
    onCollisionExit() {}
  }
  const w = warningsFor(Crate);
  assert.equal(w.length, 1);
  assert.match(w[0], /Crate defines onCollisionEnter, onCollisionExit/);
  assert.match(w[0], /CollisionListener/);
});

test('listing the tag silences it, and so does not defining the hook', () => {
  class Listening extends GameObject {
    static components = [Collider, CollisionListener, CameraInOutListener, JointBreakListener];
    onCollisionEnter() {}
    onScreenEnter() {}
    onJointBreak() {}
  }
  class Plain extends GameObject {
    static components = [Collider];
    tick() {}
  }
  assert.deepEqual(warningsFor(Listening, Plain), []);
});

test('a hook inherited from a game base class counts; GameObject defaults do not', () => {
  class Base extends GameObject {
    onScreenExit() {}
  }
  class Child extends Base {
    static components = [Collider];
  }
  const missing = missingListenerTags(Child, reg(Child).components, GameObject);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].tag, CameraInOutListener);
  assert.deepEqual(missing[0].hooks, ['onScreenExit']);
});

test('isCollidingWith with no CollisionListener anywhere in the scene warns once', () => {
  class Hunter extends GameObject {
    static components = [Collider];
    tick() {
      if (this.isCollidingWith(0)) this.x = 0;
    }
  }
  class Prey extends GameObject {
    static components = [Collider];
  }
  const w = warningsFor(Hunter, Hunter, Prey);
  assert.equal(w.length, 1);
  assert.match(w[0], /Hunter calls isCollidingWith/);

  class Listener extends GameObject {
    static components = [Collider, CollisionListener];
  }
  assert.deepEqual(warningsFor(Hunter, Listener), []);
});
