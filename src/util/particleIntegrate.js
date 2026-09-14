// particleIntegrate.js - Pure particle physics integration + active/visible list building
// Extracted from particle_worker.js (same pattern as decalStamp.js) so the hot per-particle
// loops can be exercised from Node (tests/bench) without instantiating workers.
// particle_worker.js calls these as thin wrappers (this.* -> plain params).

import { ParticleEmitter } from './ParticleEmitter.js';
import {
  PARTICLE_TWEEN,
  applyParticleEase,
  lerpRgb,
} from './particleTween.js';

// P4: reused across calls (single-threaded per worker module instance, same
// non-reentrancy assumption as ParticleEmitter's other hot-path scratches).
// Sized to the particle index type range (Uint16 free-list links).
const _flatScratch = new Uint16Array(65536);
const _heightedScratch = new Uint16Array(65536);

/**
 * Advance physics for the currently active particle list: lifetime, gravity, ground
 * contact, floor fade/despawn. Despawns particles back to ParticleEmitter's free list
 * in place (component.active[i] = 0 + ParticleEmitter.returnToPool(i)), except
 * stayOnTheFloor stamps: those indices stay allocated until the caller reads SoA
 * and returnToPool's them (else logic can reuse the slot mid-stamp).
 *
 * @param {Object} p
 * @param {Uint16Array} p.activeIndices - Local index buffer (built by buildActiveListBuffers /
 *   buildActiveAndVisibleListBuffers)
 * @param {number} p.count - Valid entries in activeIndices
 * @param {number} p.deltaTime - Frame delta time (ms)
 * @param {number} p.dtRatio - Fixed-step delta ratio
 * @param {boolean} p.decalsEnabled
 * @param {Uint16Array|null} p.particlesToStamp - Output buffer for stayOnTheFloor indices (may be null)
 * @param {Object} p.components - ParticleComponent-shaped SoA views: active, x, y, z, vx, vy, vz,
 *   lifespan, currentLife, gravity, alpha, fadeOnTheFloor, timeOnFloor, initialAlpha,
 *   stayOnTheFloor, despawnOnGroundContact, flat
 * @returns {{ activeCount: number, stampedCount: number }}
 */
export function updateParticlePhysicsBuffers({
  activeIndices,
  count,
  deltaTime,
  dtRatio,
  decalsEnabled,
  particlesToStamp,
  components,
}) {
  const {
    active,
    x,
    y,
    z,
    vx,
    vy,
    vz,
    lifespan,
    currentLife,
    gravity,
    alpha,
    fadeOnTheFloor,
    timeOnFloor,
    initialAlpha,
    stayOnTheFloor,
    despawnOnGroundContact,
    flat,
    tweenMask,
    easeId,
    alphaFrom,
    alphaTo,
    scaleX,
    scaleY,
    scaleXFrom,
    scaleXTo,
    scaleYFrom,
    scaleYTo,
    tint,
    baseTint,
    tintFrom,
    tintTo,
    rotC,
    rotS,
    rotFrom,
    rotTo,
    angularVelFrom,
    angularVelTo,
    hasAngularVel,
    animCount,
    animMode,
    animFrames,
    textureId,
  } = components;

  let stampedCount = 0;

  // P4: classify once (shared lifetime/tween work), then run two tight,
  // single-purpose passes instead of branching on flat[i] every iteration.
  let flatCount = 0;
  let heightedCount = 0;

  for (let idx = 0; idx < count; idx++) {
    const i = activeIndices[idx];

    currentLife[i] += deltaTime;

    if (lifespan[i] > 0 && currentLife[i] >= lifespan[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }

    {
      const lifeProgress = lifespan[i] > 0 ? currentLife[i] / lifespan[i] : 1;
      const mask = tweenMask ? tweenMask[i] : 0;
      const needEase =
        mask ||
        (hasAngularVel && hasAngularVel[i]) ||
        (animMode && animMode[i]);
      const eased = needEase
        ? applyParticleEase(lifeProgress, easeId ? easeId[i] : 0)
        : lifeProgress;

      if (mask & PARTICLE_TWEEN.ALPHA) {
        alpha[i] = alphaFrom[i] + (alphaTo[i] - alphaFrom[i]) * eased;
      }
      if (mask & PARTICLE_TWEEN.SCALEX) {
        scaleX[i] = scaleXFrom[i] + (scaleXTo[i] - scaleXFrom[i]) * eased;
      }
      if (mask & PARTICLE_TWEEN.SCALEY) {
        scaleY[i] = scaleYFrom[i] + (scaleYTo[i] - scaleYFrom[i]) * eased;
      }
      if (mask & PARTICLE_TWEEN.TINT) {
        const c = lerpRgb(tintFrom[i], tintTo[i], eased);
        tint[i] = c;
        baseTint[i] = c;
      }

      let angleDeg = rotFrom ? rotFrom[i] : 0;
      if (mask & PARTICLE_TWEEN.ROT) {
        angleDeg = rotFrom[i] + (rotTo[i] - rotFrom[i]) * eased;
      }
      if (hasAngularVel && hasAngularVel[i]) {
        const av = angularVelFrom[i] + (angularVelTo[i] - angularVelFrom[i]) * eased;
        angleDeg += av * currentLife[i];
      }
      if ((mask & PARTICLE_TWEEN.ROT) || (hasAngularVel && hasAngularVel[i])) {
        const rad = (angleDeg * Math.PI) / 180;
        rotC[i] = Math.cos(rad);
        rotS[i] = Math.sin(rad);
      }

      if (animMode && animMode[i] === 1 && animCount && animCount[i] > 0) {
        const n = animCount[i];
        let fi = (lifeProgress * n) | 0;
        if (fi >= n) fi = n - 1;
        textureId[i] = animFrames[i * 8 + fi];
      }
    }

    if (flat[i]) {
      _flatScratch[flatCount++] = i;
    } else {
      _heightedScratch[heightedCount++] = i;
    }
  }

  // Flat pass: XY + gravity on vy. No ground/floor/collision.
  for (let k = 0; k < flatCount; k++) {
    const i = _flatScratch[k];
    vy[i] += gravity[i] * dtRatio;
    x[i] += vx[i] * dtRatio;
    y[i] += vy[i] * dtRatio;
  }

  // Heighted pass: gravity + air / ground / floor fade / despawn.
  let heightedSurvivors = 0;
  for (let k = 0; k < heightedCount; k++) {
    const i = _heightedScratch[k];

    vz[i] += gravity[i] * dtRatio;

    if (z[i] < 0) {
      x[i] += vx[i] * dtRatio;
      y[i] += vy[i] * dtRatio;
      z[i] += vz[i] * dtRatio;
      heightedSurvivors++;
      continue;
    }

    // On ground
    z[i] = 0;
    vx[i] = 0;
    vy[i] = 0;
    vz[i] = 0;

    if (despawnOnGroundContact[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }

    if (stayOnTheFloor[i]) {
      active[i] = 0;
      if (decalsEnabled && particlesToStamp) {
        particlesToStamp[stampedCount++] = i;
        // Hold slot until caller stamps SoA — logic must not acquire this index yet.
      } else {
        ParticleEmitter.returnToPool(i);
      }
      continue;
    }

    if (fadeOnTheFloor[i] > 0) {
      if (timeOnFloor[i] === 0) {
        initialAlpha[i] = alpha[i];
      }

      timeOnFloor[i] += deltaTime;
      const fadeProgress = Math.min(timeOnFloor[i] / fadeOnTheFloor[i], 1);
      alpha[i] = initialAlpha[i] * (1 - fadeProgress);

      if (alpha[i] <= 0) {
        active[i] = 0;
        ParticleEmitter.returnToPool(i);
        continue;
      }
    }

    heightedSurvivors++;
  }

  return { activeCount: flatCount + heightedSurvivors, stampedCount };
}

/**
 * Build the active particle index list only (no camera / visibility test).
 * Mirrors the "camera not ready" fallback branch of buildActiveAndVisibleListBuffers.
 *
 * @param {Object} p
 * @param {number} p.maxParticles
 * @param {Uint8Array} p.active
 * @param {Uint16Array} p.localIndices - Output: local active index buffer
 * @param {Int32Array|null} [p.activeData] - Optional SAB [count, idx0, idx1, ...]
 * @param {number} p.expectedActive - Free-list-derived upper bound (early exit)
 * @returns {number} activeCount
 */
export function buildActiveListBuffers({ maxParticles, active, localIndices, activeData, expectedActive }) {
  let count = 0;
  let i = 0;

  for (; i + 3 < maxParticles && count < expectedActive; i += 4) {
    if (active[i]) {
      localIndices[count] = i;
      if (activeData) activeData[1 + count] = i;
      count++;
      if (count >= expectedActive) break;
    }
    if (active[i + 1]) {
      localIndices[count] = i + 1;
      if (activeData) activeData[1 + count] = i + 1;
      count++;
      if (count >= expectedActive) break;
    }
    if (active[i + 2]) {
      localIndices[count] = i + 2;
      if (activeData) activeData[1 + count] = i + 2;
      count++;
      if (count >= expectedActive) break;
    }
    if (active[i + 3]) {
      localIndices[count] = i + 3;
      if (activeData) activeData[1 + count] = i + 3;
      count++;
    }
  }

  for (; i < maxParticles && count < expectedActive; i++) {
    if (active[i]) {
      localIndices[count] = i;
      if (activeData) activeData[1 + count] = i;
      count++;
    }
  }

  if (activeData) activeData[0] = count;
  return count;
}

/**
 * Fused active-list + screen-visibility build (camera-ready path). Camera bounds must
 * already be resolved to scalar screen-space min/max (see utils.calculateCameraScreenBounds).
 *
 * @param {Object} p
 * @param {number} p.maxParticles
 * @param {Uint8Array} p.active
 * @param {Float32Array} p.x
 * @param {Float32Array} p.y
 * @param {Uint8Array} p.isItOnScreen - Written per-particle
 * @param {Uint16Array} p.localIndices - Output: local active index buffer
 * @param {Int32Array|null} [p.activeData]
 * @param {Int32Array|null} [p.visibleData]
 * @param {number} p.expectedActive
 * @param {number} p.camZoom
 * @param {number} p.camOffX
 * @param {number} p.camOffY
 * @param {number} p.camMinX
 * @param {number} p.camMaxX
 * @param {number} p.camMinY
 * @param {number} p.camMaxY
 * @returns {{ activeCount: number, visibleCount: number }}
 */
export function buildActiveAndVisibleListBuffers({
  maxParticles,
  active,
  x,
  y,
  isItOnScreen,
  localIndices,
  activeData,
  visibleData,
  expectedActive,
  camZoom,
  camOffX,
  camOffY,
  camMinX,
  camMaxX,
  camMinY,
  camMaxY,
}) {
  let activeCount = 0;
  let visibleCount = 0;
  let i = 0;

  for (; i + 3 < maxParticles && activeCount < expectedActive; i += 4) {
    if (active[i]) {
      localIndices[activeCount] = i;
      if (activeData) activeData[1 + activeCount] = i;
      activeCount++;

      const screenX = x[i] * camZoom - camOffX;
      const screenY = y[i] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i;
        visibleCount++;
      } else {
        isItOnScreen[i] = 0;
      }
      if (activeCount >= expectedActive) break;
    }

    if (active[i + 1]) {
      localIndices[activeCount] = i + 1;
      if (activeData) activeData[1 + activeCount] = i + 1;
      activeCount++;

      const screenX = x[i + 1] * camZoom - camOffX;
      const screenY = y[i + 1] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i + 1] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i + 1;
        visibleCount++;
      } else {
        isItOnScreen[i + 1] = 0;
      }
      if (activeCount >= expectedActive) break;
    }

    if (active[i + 2]) {
      localIndices[activeCount] = i + 2;
      if (activeData) activeData[1 + activeCount] = i + 2;
      activeCount++;

      const screenX = x[i + 2] * camZoom - camOffX;
      const screenY = y[i + 2] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i + 2] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i + 2;
        visibleCount++;
      } else {
        isItOnScreen[i + 2] = 0;
      }
      if (activeCount >= expectedActive) break;
    }

    if (active[i + 3]) {
      localIndices[activeCount] = i + 3;
      if (activeData) activeData[1 + activeCount] = i + 3;
      activeCount++;

      const screenX = x[i + 3] * camZoom - camOffX;
      const screenY = y[i + 3] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i + 3] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i + 3;
        visibleCount++;
      } else {
        isItOnScreen[i + 3] = 0;
      }
    }
  }

  for (; i < maxParticles && activeCount < expectedActive; i++) {
    if (!active[i]) continue;

    localIndices[activeCount] = i;
    if (activeData) activeData[1 + activeCount] = i;
    activeCount++;

    const screenX = x[i] * camZoom - camOffX;
    const screenY = y[i] * camZoom - camOffY;
    const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;

    if (onScreen) {
      isItOnScreen[i] = 1;
      if (visibleData) visibleData[1 + visibleCount] = i;
      visibleCount++;
    } else {
      isItOnScreen[i] = 0;
    }
  }

  if (activeData) activeData[0] = activeCount;
  if (visibleData) visibleData[0] = visibleCount;

  return { activeCount, visibleCount };
}
