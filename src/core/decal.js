// Decal.js — static floor stamp API (particle pool + tile blend). Not LiquidFun.

import { ParticleEmitter } from './particleEmitter.js';
import { CAMERA_TYPES } from '../util/configDefaults.js';

export class Decal {
  static _stampScratch = Object.create(null);

  /**
   * Stamp a decal onto the floor tilemap (instant-stamp particle).
   * Blend happens later on the particle worker — not sync with this call.
   * @param {Object} config
   * @returns {number} spawned count (0 if pool not ready / empty)
   */
  static stamp(config) {
    const s = this._stampScratch;
    for (const k in s) delete s[k];
    for (const k in config) s[k] = config[k];
    s.z = 0;
    s.lifespan = 100;
    s.stayOnTheFloor = true;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.gravity = 1;
    s.flat = 0;
    s.viewMode = CAMERA_TYPES.TOPDOWN;
    return ParticleEmitter._spawn(s, null);
  }
}
