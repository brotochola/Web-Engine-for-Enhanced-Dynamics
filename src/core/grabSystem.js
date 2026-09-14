// GrabSystem.js - Main-thread mouse grab for entity types that list Grab
// One owner (one cursor). Logic workers must not run this — they partition ticks.

import { Mouse } from './Mouse.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { pointInCollider } from './ColliderUtils.js';

function isExplicitStatic(i) {
  return !!(RigidBody.active && RigidBody.active[i] && RigidBody.static[i]);
}

function isDynamicRigidBody(i) {
  return !!(RigidBody.active && RigidBody.active[i] && !RigidBody.static[i]);
}

function pointInSprite(i, x, y) {
  if (!SpriteRenderer.active || !SpriteRenderer.active[i]) return false;
  const hw = SpriteRenderer.boundsHalfW ? SpriteRenderer.boundsHalfW[i] : 0;
  const hh = SpriteRenderer.boundsHalfH ? SpriteRenderer.boundsHalfH[i] : 0;
  if (!(hw > 0) && !(hh > 0)) return false;
  const dx = x - Transform.x[i];
  const dy = y - Transform.y[i];
  return dx <= hw && dx >= -hw && dy <= hh && dy >= -hh;
}

function hitsGrabTarget(i, x, y) {
  if (Collider.active && Collider.active[i]) return pointInCollider(i, x, y);
  return pointInSprite(i, x, y);
}

export class GrabSystem {
  static _dragIdx = null;
  static _dragOffX = 0;
  static _dragOffY = 0;
  static _prevMouseX = 0;
  static _prevMouseY = 0;
  static _tossVx = 0;
  static _tossVy = 0;
  static _tossOmega = 0;

  static reset() {
    this._dragIdx = null;
    this._dragOffX = 0;
    this._dragOffY = 0;
    this._prevMouseX = 0;
    this._prevMouseY = 0;
    this._tossVx = 0;
    this._tossVy = 0;
    this._tossOmega = 0;
  }

  /**
   * @param {import('./Scene.js').Scene} scene
   */
  static update(scene) {
    if (!scene) return;
    if (Mouse.isDebugToolActive && this._dragIdx == null) return;
    if (this._dragIdx == null && !scene._anyGrabType) return;

    if (Mouse.isButton0Down && this._dragIdx == null) {
      this._tryPick(scene);
    }

    if (this._dragIdx == null) return;

    if (!Mouse.isButton0Down || !Transform.active[this._dragIdx]) {
      this._release(scene);
      return;
    }

    this._hold(scene);
  }

  static _tryPick(scene) {
    const mx = Mouse.x;
    const my = Mouse.y;
    let bestDist = Infinity;
    let bestIdx = null;

    const grabByType = scene.grabByType;
    const registered = scene.registeredClasses;
    if (!grabByType || !registered) return;

    for (let t = 0; t < registered.length; t++) {
      if (!grabByType[t]) continue;
      const EntityClass = registered[t].class;
      if (!EntityClass || typeof EntityClass.getAllActive !== 'function') continue;
      const active = EntityClass.getAllActive();
      if (!active) continue;

      for (let n = 0; n < active.length; n++) {
        const i = active[n];
        if (!Transform.active[i]) continue;
        if (isExplicitStatic(i)) continue;
        if (!hitsGrabTarget(i, mx, my)) continue;
        const dx = Transform.x[i] - mx;
        const dy = Transform.y[i] - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) {
          bestDist = d2;
          bestIdx = i;
        }
      }
    }

    if (bestIdx == null) return;

    this._dragIdx = bestIdx;
    this._dragOffX = Transform.x[bestIdx] - mx;
    this._dragOffY = Transform.y[bestIdx] - my;
    this._prevMouseX = mx;
    this._prevMouseY = my;
    this._tossVx = 0;
    this._tossVy = 0;
    this._tossOmega = 0;
  }

  static _hold(scene) {
    const i = this._dragIdx;
    const mx = Mouse.x;
    const my = Mouse.y;
    this._tossVx = (mx - this._prevMouseX) * 60;
    this._tossVy = (my - this._prevMouseY) * 60;
    const rx = mx + this._dragOffX - Transform.x[i];
    const ry = my + this._dragOffY - Transform.y[i];
    this._tossOmega = ((rx * this._tossVy - ry * this._tossVx) * 0.00005) / 60;
    this._prevMouseX = mx;
    this._prevMouseY = my;

    const box = scene.getEntityView(i, { cache: true });
    box.setPosition(mx + this._dragOffX, my + this._dragOffY);
    if (isDynamicRigidBody(i)) {
      box.setVelocity(0, 0);
      box.angularVelocity = 0;
      RigidBody.sleeping[i] = 0;
    }
  }

  static _release(scene) {
    const i = this._dragIdx;
    this._dragIdx = null;
    if (i == null || !Transform.active || !Transform.active[i]) return;
    if (!isDynamicRigidBody(i)) return;
    const box = scene.getEntityView(i, { cache: true });
    box.setVelocity(this._tossVx, this._tossVy);
    box.angularVelocity = this._tossOmega;
    RigidBody.sleeping[i] = 0;
  }
}
