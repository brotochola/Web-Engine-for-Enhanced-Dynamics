/**
 * Apply / restore patches for the Wave B (particle emit + integrate) hypothesis campaign.
 *
 * Model: each hyp is a pure transform `(state) => state` where
 * `state = { particleEmitter: string, particleIntegrate: string, sharedAtomicPool: string,
 * atomicFreeList: string }` holds in-memory source text. `applyCombo(ids)` restores
 * baselines, sorts ids into CANONICAL_ORDER, folds the matching transforms over a fresh
 * state, then writes the result to src/core/particleEmitter.js, src/util/particleIntegrate.js,
 * src/core/sharedAtomicPool.js and src/util/atomicFreeList.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const PATHS = {
  particleEmitter: path.join(repoRoot, 'src/core/particleEmitter.js'),
  particleIntegrate: path.join(repoRoot, 'src/util/particleIntegrate.js'),
  sharedAtomicPool: path.join(repoRoot, 'src/core/sharedAtomicPool.js'),
  atomicFreeList: path.join(repoRoot, 'src/util/atomicFreeList.js'),
  baselineParticleEmitter: path.join(here, 'baselineParticleEmitter.js'),
  baselineParticleIntegrate: path.join(here, 'baselineParticleIntegrate.js'),
  baselineSharedAtomicPool: path.join(here, 'baselineSharedAtomicPool.js'),
  baselineAtomicFreeList: path.join(here, 'baselineAtomicFreeList.js'),
};

// Save baselines on first load if they don't exist yet — safe to re-run.
for (const [srcKey, baselineKey] of [
  ['particleEmitter', 'baselineParticleEmitter'],
  ['particleIntegrate', 'baselineParticleIntegrate'],
  ['sharedAtomicPool', 'baselineSharedAtomicPool'],
  ['atomicFreeList', 'baselineAtomicFreeList'],
]) {
  if (!fs.existsSync(PATHS[baselineKey])) {
    fs.copyFileSync(PATHS[srcKey], PATHS[baselineKey]);
  }
}

/** Canonical fold order — determines the order transforms are composed in for a combo. */
export const CANONICAL_ORDER = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

export function restoreAll() {
  // Baselines are pre-P2/P6. Running the old tournament overwrites shipped src.
  // Always restoreAll() in a finally, or re-checkout those four files after.
  fs.copyFileSync(PATHS.baselineParticleEmitter, PATHS.particleEmitter);
  fs.copyFileSync(PATHS.baselineParticleIntegrate, PATHS.particleIntegrate);
  fs.copyFileSync(PATHS.baselineSharedAtomicPool, PATHS.sharedAtomicPool);
  fs.copyFileSync(PATHS.baselineAtomicFreeList, PATHS.atomicFreeList);
}

function mustInclude(src, needle, hyp) {
  if (!src.includes(needle)) throw new Error(`${hyp}: patch anchor missing: ${needle.slice(0, 100)}`);
}

function replaceOnce(src, from, to, hyp) {
  mustInclude(src, from, hyp);
  const out = src.replace(from, to);
  if (out === src) throw new Error(`${hyp}: replace had no effect`);
  return out;
}

// ---------------------------------------------------------------------------
// P1: buildActiveListBuffers scans every particle slot even when most of the
// pool is inactive. When `active`'s SAB byte offset is 4-byte aligned, test 4
// slots at once via a Uint32 view — an all-zero word means "skip 4 inactive
// slots" with one comparison instead of 4 branches. Falls back to the plain
// per-byte scan when unaligned (still correct, just no fast path).
// ---------------------------------------------------------------------------
function P1(state) {
  const particleIntegrate = replaceOnce(
    state.particleIntegrate,
    `export function buildActiveListBuffers({ maxParticles, active, localIndices, activeData, expectedActive }) {
  let count = 0;
  let i = 0;

  for (; i + 3 < maxParticles && count < expectedActive; i += 4) {
    if (active[i]) {`,
    `export function buildActiveListBuffers({ maxParticles, active, localIndices, activeData, expectedActive }) {
  let count = 0;
  let i = 0;

  // P1: 4-at-a-time zero-skip — an all-zero 32-bit word means all 4 slots are
  // inactive, so we can skip them with one comparison instead of 4 branches.
  // Only safe when active's SAB byte offset is 4-byte aligned; otherwise fall
  // back to the unmodified per-byte scan below (still fully correct).
  const wordAligned = (active.byteOffset & 3) === 0;
  const words = wordAligned
    ? new Uint32Array(active.buffer, active.byteOffset, maxParticles >> 2)
    : null;

  for (; i + 3 < maxParticles && count < expectedActive; i += 4) {
    if (words && words[i >> 2] === 0) continue;
    if (active[i]) {`,
    'P1'
  );

  return { ...state, particleIntegrate };
}

// ---------------------------------------------------------------------------
// P2: ParticleEmitter._mergeCfg deletes every key of `_cfgScratch` then
// re-copies the new config's own keys via for-in — that add/delete churn
// repeatedly knocks the scratch object into V8 dictionary mode (same root
// cause as the decal D6 patch on stampDecal's scratch). Assigning a fixed,
// known field list in the same order every call keeps `_cfgScratch`'s hidden
// class stable across calls (fields simply become `undefined` when absent,
// which randomRange/the ?? defaults already treat identically to "missing").
// ---------------------------------------------------------------------------
function P2(state) {
  let particleEmitter = replaceOnce(
    state.particleEmitter,
    `  static _stampScratch = Object.create(null);`,
    `  static _stampScratch = Object.create(null);

  // P2: fixed field list for _mergeCfg — see the function doc below.
  static _cfgFieldList = [
    'count', 'flat', 'viewMode', 'texture', 'spritesheet', 'animation', 'frame',
    'x', 'y', 'z', 'dirX', 'dirY', 'speed', 'spread', 'angleXY',
    'vx', 'vy', 'vz', 'lifespan', 'gravity',
    'scale', 'scaleX', 'scaleY', 'alpha', 'tint',
    'rotC', 'rotS', 'rotation', 'flipX', 'flipY',
    'fadeOnTheFloor', 'stayOnTheFloor', 'despawnOnGroundContact',
    'blendMode', 'layerId',
  ];`,
    'P2'
  );

  particleEmitter = replaceOnce(
    particleEmitter,
    `  /** Merge config + overrides into reusable scratch (clears stale keys). */
  static _mergeCfg(config, modeOverrides) {
    const s = this._cfgScratch;
    for (const k in s) delete s[k];
    for (const k in config) s[k] = config[k];
    for (const k in modeOverrides) s[k] = modeOverrides[k];
    return s;
  }`,
    `  /**
   * Merge config + overrides into reusable scratch (stable shape — see _cfgFieldList).
   * P2: assign each known field explicitly instead of delete-all + for-in copy, which
   * kept toggling _cfgScratch into V8 dictionary mode every call.
   */
  static _mergeCfg(config, modeOverrides) {
    const s = this._cfgScratch;
    const fields = this._cfgFieldList;
    for (let f = 0; f < fields.length; f++) {
      const k = fields[f];
      s[k] = config[k];
    }
    for (const k in modeOverrides) s[k] = modeOverrides[k];
    return s;
  }`,
    'P2'
  );

  return { ...state, particleEmitter };
}

// ---------------------------------------------------------------------------
// P3: the angleXY spawn path calls Math.cos/Math.sin once each per particle.
// A 0.1°-resolution LUT trades a tiny (<0.05% of unit-circle magnitude)
// direction quantization for two array reads instead of two transcendental
// calls — imperceptible for particle velocity direction.
// ---------------------------------------------------------------------------
function P3(state) {
  let particleEmitter = replaceOnce(
    state.particleEmitter,
    `export const DECAL_STAMPS_BLEND_MODE = Object.freeze({`,
    `// P3: 0.1°-resolution cos/sin LUT for the angleXY spawn path (see the angleXY
// branch in _spawn) — avoids two Math.cos/Math.sin calls per particle.
const ANGLE_LUT_STEPS = 3600;
const ANGLE_COS_LUT = new Float32Array(ANGLE_LUT_STEPS);
const ANGLE_SIN_LUT = new Float32Array(ANGLE_LUT_STEPS);
for (let _a = 0; _a < ANGLE_LUT_STEPS; _a++) {
  const _rad = (_a / 10) * (Math.PI / 180);
  ANGLE_COS_LUT[_a] = Math.cos(_rad);
  ANGLE_SIN_LUT[_a] = Math.sin(_rad);
}

export const DECAL_STAMPS_BLEND_MODE = Object.freeze({`,
    'P3'
  );

  particleEmitter = replaceOnce(
    particleEmitter,
    `      } else if (cfg.angleXY !== undefined && cfg.speed !== undefined) {
        const angleDeg = randomRange(cfg.angleXY, 0);
        const angleRad = (angleDeg * Math.PI) / 180;
        const speed = randomRange(cfg.speed, 0);

        particleVx = speed * Math.cos(angleRad);
        particleVy = speed * Math.sin(angleRad);
      } else {`,
    `      } else if (cfg.angleXY !== undefined && cfg.speed !== undefined) {
        const angleDeg = randomRange(cfg.angleXY, 0);
        const speed = randomRange(cfg.speed, 0);

        // P3: LUT lookup instead of Math.cos/Math.sin — see ANGLE_COS_LUT above.
        const lutIndex = ((((angleDeg % 360) + 360) % 360) * 10) | 0;
        particleVx = speed * ANGLE_COS_LUT[lutIndex];
        particleVy = speed * ANGLE_SIN_LUT[lutIndex];
      } else {`,
    'P3'
  );

  return { ...state, particleEmitter };
}

// ---------------------------------------------------------------------------
// P4: updateParticlePhysicsBuffers interleaves flat and heighted particles in
// one pass, branching on `flat[i]` every iteration. Classify once (lifetime +
// tween, shared by both kinds), then run two tight, single-purpose passes —
// flat particles never touch gravity/z/ground logic, and heighted particles
// never touch the flat integrate branch.
// ---------------------------------------------------------------------------
function P4(state) {
  const particleIntegrate = replaceOnce(
    state.particleIntegrate,
    `import { ParticleEmitter } from './particleEmitter.js';`,
    `import { ParticleEmitter } from './particleEmitter.js';

// P4: reused across calls (single-threaded per worker module instance, same
// non-reentrancy assumption as ParticleEmitter's other hot-path scratches).
// Sized to the particle index type range (Uint16 free-list links).
const _flatScratch = new Uint16Array(65536);
const _heightedScratch = new Uint16Array(65536);`,
    'P4'
  );

  const patchedIntegrate = replaceOnce(
    particleIntegrate,
    `  let activeCount = 0;
  let stampedCount = 0;

  for (let idx = 0; idx < count; idx++) {
    const i = activeIndices[idx];

    currentLife[i] += deltaTime;

    if (currentLife[i] >= lifespan[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }
    // Flat: screen-plane only — always integrate XY (ignore z / floor flags)
    if (flat[i]) {
      x[i] += vx[i] * dtRatio;
      y[i] += vy[i] * dtRatio;
      activeCount++;
      continue;
    }

    // Heighted: gravity + air / ground
    vz[i] += gravity[i] * dtRatio;

    if (z[i] < 0) {
      x[i] += vx[i] * dtRatio;
      y[i] += vy[i] * dtRatio;
      z[i] += vz[i] * dtRatio;
      activeCount++;
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
      if (decalsEnabled && particlesToStamp) {
        particlesToStamp[stampedCount++] = i;
      }
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
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

    activeCount++;
  }

  return { activeCount, stampedCount };
}`,
    `  let stampedCount = 0;

  // P4: classify once (shared lifetime/tween work), then run two tight,
  // single-purpose passes instead of branching on flat[i] every iteration.
  let flatCount = 0;
  let heightedCount = 0;

  for (let idx = 0; idx < count; idx++) {
    const i = activeIndices[idx];

    currentLife[i] += deltaTime;

    if (currentLife[i] >= lifespan[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }
    if (flat[i]) {
      _flatScratch[flatCount++] = i;
    } else {
      _heightedScratch[heightedCount++] = i;
    }
  }

  // Flat pass: pure XY integration, no ground/floor branches ever taken.
  for (let k = 0; k < flatCount; k++) {
    const i = _flatScratch[k];
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
      if (decalsEnabled && particlesToStamp) {
        particlesToStamp[stampedCount++] = i;
      }
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
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
}`,
    'P4'
  );

  return { ...state, particleIntegrate: patchedIntegrate };
}

// ---------------------------------------------------------------------------
// P5: flat particles never read z/vz — particleIntegrate.js's flat branch
// integrates XY and returns before touching either field. Skip the
// randomRange call + SoA write for both when flatMode (recycled slots carry
// stale float values, which is harmless since the flat path never reads
// them).
// ---------------------------------------------------------------------------
function P5(state) {
  let particleEmitter = replaceOnce(
    state.particleEmitter,
    `      x[i] = randomRange(cfg.x);
      y[i] = randomRange(cfg.y);
      z[i] = randomRange(cfg.z, 0);`,
    `      x[i] = randomRange(cfg.x);
      y[i] = randomRange(cfg.y);
      // P5: flat particles never read z (see particleIntegrate.js's flat branch) —
      // skip the write + randomRange call entirely.
      if (!flatMode) z[i] = randomRange(cfg.z, 0);`,
    'P5'
  );

  particleEmitter = replaceOnce(
    particleEmitter,
    `      vx[i] = particleVx;
      vy[i] = particleVy;
      vz[i] = randomRange(cfg.vz, 0);`,
    `      vx[i] = particleVx;
      vy[i] = particleVy;
      // P5: flat particles never read vz either — skip the write.
      if (!flatMode) vz[i] = randomRange(cfg.vz, 0);`,
    'P5'
  );

  return { ...state, particleEmitter };
}

// ---------------------------------------------------------------------------
// P6: _spawn's acquire loop pops one free index per CAS (`while (spawned <
// count) { acquireIndex(); ... }`). atomicFreeList.js's Treiber stack can
// walk N links ahead with plain reads (safe under the same ABA argument as a
// single pop — nothing is published until the CAS) and publish all N via ONE
// compare-exchange. This adds popFreeIndices to atomicFreeList.js and
// acquireIndices to SharedAtomicPool.js (existing popFreeIndex/pushFreeIndex/
// acquireIndex are untouched — other pools keep using the one-at-a-time API),
// then _spawn batch-acquires once per emit() call instead of once per
// particle.
// ---------------------------------------------------------------------------
function P6(state) {
  const atomicFreeList = replaceOnce(
    state.atomicFreeList,
    `    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 1, 1);
      return startIndex + local;
    }
    // CAS lost - another thread popped/pushed first. Retry.
  }
}

/**
 * Atomically push an index back to the free list. Lock-free; safe from any`,
    `    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 1, 1);
      return startIndex + local;
    }
    // CAS lost - another thread popped/pushed first. Retry.
  }
}

/**
 * P6: batch pop — walk up to \`maxToPop\` links ahead with plain reads (safe;
 * nothing is published until the CAS below), then publish the whole batch
 * with ONE compare-exchange instead of one CAS per item. Falls back to
 * popping fewer than maxToPop (never more) if the list runs out early.
 *
 * @param {Int32Array} top
 * @param {Uint16Array} links
 * @param {number} maxToPop
 * @param {Uint16Array|Uint32Array|Int32Array} outArray - Receives global indices
 * @param {number} [outOffset=0]
 * @param {number} [startIndex=0] - Pool's global start offset
 * @returns {number} Number of indices actually popped (0..maxToPop)
 */
export function popFreeIndices(top, links, maxToPop, outArray, outOffset = 0, startIndex = 0) {
  if (maxToPop <= 0) return 0;
  for (;;) {
    const head = Atomics.load(top, 0);
    let plusOne = head & 0xffff;
    if (plusOne === 0) return 0; // empty

    let popped = 0;
    let cur = plusOne;
    while (cur !== 0 && popped < maxToPop) {
      outArray[outOffset + popped] = startIndex + (cur - 1);
      cur = links[cur - 1];
      popped++;
    }

    const newHead = ((head + 0x10000) & ~0xffff) | cur;
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 1, popped);
      return popped;
    }
    // CAS lost - another thread mutated the stack since our walk. Retry the
    // whole walk (the discarded reads above were never published).
  }
}

/**
 * Atomically push an index back to the free list. Lock-free; safe from any`,
    'P6'
  );

  let sharedAtomicPool = replaceOnce(
    state.sharedAtomicPool,
    `import {
  resetFreeList,
  popFreeIndex,
  pushFreeIndex,
  getFreeListCount,
} from '../util/atomicFreeList.js';`,
    `import {
  resetFreeList,
  popFreeIndex,
  popFreeIndices,
  pushFreeIndex,
  getFreeListCount,
} from '../util/atomicFreeList.js';`,
    'P6'
  );

  sharedAtomicPool = replaceOnce(
    sharedAtomicPool,
    `    static acquireIndex() {
        if (!this.initialized || !this.freeList || !this.freeListTop) {
            return -1;
        }
        return popFreeIndex(this.freeListTop, this.freeList);
    }`,
    `    static acquireIndex() {
        if (!this.initialized || !this.freeList || !this.freeListTop) {
            return -1;
        }
        return popFreeIndex(this.freeListTop, this.freeList);
    }

    /**
     * P6: batch-acquire up to \`maxToPop\` free indices in one CAS instead of
     * \`maxToPop\` separate CAS operations.
     * @param {number} maxToPop
     * @param {Uint16Array|Uint32Array|Int32Array} outArray - Receives global indices
     * @param {number} [outOffset=0]
     * @returns {number} Number of indices actually acquired (0..maxToPop)
     */
    static acquireIndices(maxToPop, outArray, outOffset = 0) {
        if (!this.initialized || !this.freeList || !this.freeListTop) {
            return 0;
        }
        return popFreeIndices(this.freeListTop, this.freeList, maxToPop, outArray, outOffset);
    }`,
    'P6'
  );

  let particleEmitter = replaceOnce(
    state.particleEmitter,
    `  static _stampScratch = Object.create(null);`,
    `  static _stampScratch = Object.create(null);

  // P6: batch-acquire scratch — sized to the particle index type range
  // (Uint16 free-list links), reused across calls (see _spawn).
  static _acquireScratch = new Uint16Array(65536);`,
    'P6'
  );

  particleEmitter = replaceOnce(
    particleEmitter,
    `    while (spawned < count) {
      const i = this.acquireIndex();
      if (i < 0) {
        break;
      }

      x[i] = randomRange(cfg.x);`,
    `    // P6: batch-acquire up to \`count\` free indices in one CAS instead of one
    // CAS per particle (see atomicFreeList.popFreeIndices).
    const acquireScratch = this._acquireScratch;
    const toAcquire = count < acquireScratch.length ? count : acquireScratch.length;
    const acquired = this.acquireIndices(toAcquire, acquireScratch);

    for (; spawned < acquired; ) {
      const i = acquireScratch[spawned];

      x[i] = randomRange(cfg.x);`,
    'P6'
  );

  return { ...state, particleEmitter, sharedAtomicPool, atomicFreeList };
}

export const TRANSFORMS = { P1, P2, P3, P4, P5, P6 };

/** Sort hyp ids into CANONICAL_ORDER, dropping unknown ids. */
export function sortHypIds(ids) {
  const set = new Set(ids);
  return CANONICAL_ORDER.filter((id) => set.has(id));
}

/**
 * Restore baselines, then fold the transforms for `ids` (sorted into
 * CANONICAL_ORDER) over the baseline source, writing the result to
 * src/core/particleEmitter.js, src/util/particleIntegrate.js,
 * src/core/sharedAtomicPool.js and src/util/atomicFreeList.js.
 */
// Source files are checked out CRLF (Windows) — normalize to LF for anchor
// matching, and write patched output back as LF (restoreAll() still restores
// the original CRLF baseline bytes untouched).
function readLf(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

export function applyCombo(ids) {
  restoreAll();

  let state = {
    particleEmitter: readLf(PATHS.particleEmitter),
    particleIntegrate: readLf(PATHS.particleIntegrate),
    sharedAtomicPool: readLf(PATHS.sharedAtomicPool),
    atomicFreeList: readLf(PATHS.atomicFreeList),
  };

  for (const id of sortHypIds(ids)) {
    const transform = TRANSFORMS[id];
    if (!transform) throw new Error(`Unknown hyp: ${id}`);
    state = transform(state);
  }

  fs.writeFileSync(PATHS.particleEmitter, state.particleEmitter);
  fs.writeFileSync(PATHS.particleIntegrate, state.particleIntegrate);
  fs.writeFileSync(PATHS.sharedAtomicPool, state.sharedAtomicPool);
  fs.writeFileSync(PATHS.atomicFreeList, state.atomicFreeList);
}

/** Apply a single hyp id. BASE means "restore baselines only". */
export function applyHyp(id) {
  if (id === 'BASE') {
    restoreAll();
    return;
  }
  applyCombo([id]);
}

/** Parse a combo id string like 'P1+P2' into ['P1', 'P2']. */
export function parseComboId(comboId) {
  return String(comboId)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const HYPS = [
  { id: 'BASE', apply: () => applyHyp('BASE') },
  { id: 'P1', apply: () => applyHyp('P1') },
  { id: 'P2', apply: () => applyHyp('P2') },
  { id: 'P3', apply: () => applyHyp('P3') },
  { id: 'P4', apply: () => applyHyp('P4') },
  { id: 'P5', apply: () => applyHyp('P5') },
  { id: 'P6', apply: () => applyHyp('P6') },
];
