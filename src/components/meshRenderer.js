// MeshRenderer — solid fill of Collider fixtures (LAYER_KIND.MESH).
// Color and layer live here, not on Collider. Pose is Transform + local verts.

import { Component } from '../core/component.js';

let _warnedMaxFixtures = false;

export function resetMeshRendererFixtureWarn() {
  _warnedMaxFixtures = false;
}

/** Once: MeshRenderer.active needs a ColliderFixture pool. */
export function warnMeshRendererNeedsFixtures() {
  if (_warnedMaxFixtures) return;
  _warnedMaxFixtures = true;
  console.warn('WeedJS: MeshRenderer requires physics.maxFixtures > 0');
}

export class MeshRenderer extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    tint: Uint32Array,
    alpha: Float32Array,
    layerMask: Uint16Array,
    renderVisible: Uint8Array,
    renderDirty: Uint8Array,
  };

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.layerMask) this.layerMask.fill(0);
    if (this.tint) this.tint.fill(0xffffff);
    if (this.alpha) this.alpha.fill(1);
    if (this.renderVisible) this.renderVisible.fill(1);
    if (this.renderDirty) this.renderDirty.fill(1);
  }

  get tint() {
    return MeshRenderer.tint[this.index] >>> 0;
  }
  set tint(value) {
    MeshRenderer.tint[this.index] = value >>> 0;
    MeshRenderer.renderDirty[this.index] = 1;
  }

  get alpha() {
    return MeshRenderer.alpha[this.index];
  }
  set alpha(value) {
    let a = +value;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    MeshRenderer.alpha[this.index] = a;
    MeshRenderer.renderDirty[this.index] = 1;
  }
}
