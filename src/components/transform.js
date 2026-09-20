// Transform.js - Entity state SoA + pose views (not in ARRAY_SCHEMA)
// SoA: active / entityType / isItOnScreen
// Pose (x/y/rotation/rotC/rotS): Box2D HEAP after box2dReady, or a Weed SAB when
// config.physics.enabled === false (bindWeedPoseFields at init). Same Float32Array
// views either way — hot loops read Transform.x[i], no architecture branch.

import { Component } from '../core/component.js';

export class Transform extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = inactive, 1 = active
    entityType: Uint8Array, // Entity type ID (auto-assigned during registration)
    isItOnScreen: Uint8Array, // Canonical entity screen visibility, published by pre_render_worker
  };

  static clearArrays() {
    super.clearArrays();
    Transform.x = null;
    Transform.y = null;
    Transform.rotation = null;
    Transform.rotC = null;
    Transform.rotS = null;
  }

  // Pose views (HEAP or Weed SAB) — instance accessors for entity.transform.x etc.
  get x() {
    return Transform.x[this.index];
  }
  set x(value) {
    Transform.x[this.index] = value;
  }
  get y() {
    return Transform.y[this.index];
  }
  set y(value) {
    Transform.y[this.index] = value;
  }
  get rotation() {
    return Transform.rotation ? Transform.rotation[this.index] : 0;
  }
  set rotation(value) {
    const i = this.index;
    if (Transform.rotation) Transform.rotation[i] = value;
    if (Transform.rotC && Transform.rotS) {
      Transform.rotC[i] = Math.cos(value);
      Transform.rotS[i] = Math.sin(value);
    }
  }
  get rotC() {
    return Transform.rotC[this.index];
  }
  get rotS() {
    return Transform.rotS[this.index];
  }
}
