/**
 * Apply / restore patches for the Wave A (decal stamp) hypothesis campaign.
 *
 * Model: each hyp is a pure transform `(state) => state` where
 * `state = { decalStamp: string, particleEmitter: string, particleWorker: string }`
 * holds in-memory source text. `applyCombo(ids)` restores baselines, sorts ids
 * into CANONICAL_ORDER, folds the matching transforms over a fresh state, then
 * writes the result to src/util/decalStamp.js, src/core/particleEmitter.js and
 * src/workers/particleWorker.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const PATHS = {
  decalStamp: path.join(repoRoot, 'src/util/decalStamp.js'),
  particleEmitter: path.join(repoRoot, 'src/core/particleEmitter.js'),
  particleWorker: path.join(repoRoot, 'src/workers/particleWorker.js'),
  baselineDecalStamp: path.join(here, 'baselineDecalStamp.js'),
  baselineParticleEmitter: path.join(here, 'baselineParticleEmitter.js'),
  baselineParticleWorker: path.join(here, 'baselineParticleWorker.js'),
};

// Save baselines on first load if they don't exist yet — safe to re-run.
for (const [srcKey, baselineKey] of [
  ['decalStamp', 'baselineDecalStamp'],
  ['particleEmitter', 'baselineParticleEmitter'],
  ['particleWorker', 'baselineParticleWorker'],
]) {
  if (!fs.existsSync(PATHS[baselineKey])) {
    fs.copyFileSync(PATHS[srcKey], PATHS[baselineKey]);
  }
}

/** Canonical fold order — determines the order transforms are composed in for a combo. */
export const CANONICAL_ORDER = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];

export function restoreAll() {
  fs.copyFileSync(PATHS.baselineDecalStamp, PATHS.decalStamp);
  fs.copyFileSync(PATHS.baselineParticleEmitter, PATHS.particleEmitter);
  fs.copyFileSync(PATHS.baselineParticleWorker, PATHS.particleWorker);
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
// D1: blend per-pixel — hoist white-tint check, skip the tint multiply when
// tint === 0xffffff, and shortcut the fully-opaque + white-tint normal-blend
// case to a direct copy (no blend math needed when the source fully replaces
// the destination pixel).
// ---------------------------------------------------------------------------
function D1(state) {
  let decalStamp = replaceOnce(
    state.decalStamp,
    `  const tintR = (tint >> 16) & 0xff;
  const tintG = (tint >> 8) & 0xff;
  const tintB = tint & 0xff;`,
    `  const tintR = (tint >> 16) & 0xff;
  const tintG = (tint >> 8) & 0xff;
  const tintB = tint & 0xff;
  // D1: hoisted once per stamp — skip the per-pixel tint multiply when white.
  const tintIsWhite = tintR === 255 && tintG === 255 && tintB === 255;`,
    'D1'
  );

  decalStamp = replaceOnce(
    decalStamp,
    `          if (blendMode === 1) {
            // MULTIPLY BLEND
            const tintedR = (srcR * tintR + 127) >> 8;
            const tintedG = (srcG * tintG + 127) >> 8;
            const tintedB = (srcB * tintB + 127) >> 8;

            const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;`,
    `          if (blendMode === 1) {
            // MULTIPLY BLEND
            // D1: white tint — skip the tint multiply before computing luminance
            const tintedR = tintIsWhite ? srcR : (srcR * tintR + 127) >> 8;
            const tintedG = tintIsWhite ? srcG : (srcG * tintG + 127) >> 8;
            const tintedB = tintIsWhite ? srcB : (srcB * tintB + 127) >> 8;

            const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;`,
    'D1'
  );

  decalStamp = replaceOnce(
    decalStamp,
    `          } else {
            // NORMAL BLEND
            const srcA = (texAlpha * alpha) | 0;

            if (srcA < 1) continue;

            const finalR = (srcR * tintR + 127) >> 8;
            const finalG = (srcG * tintG + 127) >> 8;
            const finalB = (srcB * tintB + 127) >> 8;

            const invSrcA = 255 - srcA;`,
    `          } else {
            // NORMAL BLEND
            const srcA = (texAlpha * alpha) | 0;

            if (srcA < 1) continue;

            // D1: fully opaque + white tint — texture pixel replaces dest outright
            if (tintIsWhite && srcA === 255) {
              bloodTiles[dstOffset] = srcR;
              bloodTiles[dstOffset + 1] = srcG;
              bloodTiles[dstOffset + 2] = srcB;
              bloodTiles[dstOffset + 3] = 255;
              continue;
            }

            // D1: white tint — skip the tint multiply, sample feeds the blend directly
            const finalR = tintIsWhite ? srcR : (srcR * tintR + 127) >> 8;
            const finalG = tintIsWhite ? srcG : (srcG * tintG + 127) >> 8;
            const finalB = tintIsWhite ? srcB : (srcB * tintB + 127) >> 8;

            const invSrcA = 255 - srcA;`,
    'D1'
  );

  return { ...state, decalStamp };
}

// ---------------------------------------------------------------------------
// D2: UV nearest-neighbor sampling — integer DDA accumulator for srcX/srcY
// instead of recomputing `(dst - dstStart) * uvScale` from scratch every pixel.
// uvScaleX/Y and invScaledWidth/Height are stamp-constant (not tile-dependent),
// so the per-pixel work drops from a multiply+subtract to a running add.
// ---------------------------------------------------------------------------
function D2(state) {
  const decalStamp = replaceOnce(
    state.decalStamp,
    `      for (let dstY = dstStartY; dstY < dstEndY; dstY++) {
        const srcScaledY = srcOffsetY + (dstY - dstStartY) * uvScaleY;
        const srcY = (srcScaledY * invScaledHeight) | 0;

        if (srcY < 0 || srcY >= texHeight) continue;

        const srcRowOffset = srcY * texWidth;
        const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

        for (let dstX = dstStartX; dstX < dstEndX; dstX++) {
          const srcScaledX = srcOffsetX + (dstX - dstStartX) * uvScaleX;
          const srcX = (srcScaledX * invScaledWidth) | 0;

          if (srcX < 0 || srcX >= texWidth) continue;`,
    `      // D2: integer DDA — accumulate scaled src coords instead of recomputing
      // (dst - dstStart) * uvScale from scratch on every pixel.
      const stepX = uvScaleX * invScaledWidth;
      const stepY = uvScaleY * invScaledHeight;
      let srcYAccum = srcOffsetY * invScaledHeight;

      for (let dstY = dstStartY; dstY < dstEndY; dstY++, srcYAccum += stepY) {
        const srcY = srcYAccum | 0;

        if (srcY < 0 || srcY >= texHeight) continue;

        const srcRowOffset = srcY * texWidth;
        const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

        let srcXAccum = srcOffsetX * invScaledWidth;
        for (let dstX = dstStartX; dstX < dstEndX; dstX++, srcXAccum += stepX) {
          const srcX = srcXAccum | 0;

          if (srcX < 0 || srcX >= texWidth) continue;`,
    'D2'
  );

  return { ...state, decalStamp };
}

// ---------------------------------------------------------------------------
// D3: stamp budget — clamp stampCollectedParticles to maxStampsPerFrame so a
// burst of simultaneous deaths can't blow DECAL_STAMP_MS out for one frame.
// ponytail: overflow this frame is dropped, not deferred; upgrade path is a
// carry-over queue if bursts regularly exceed the budget.
// ---------------------------------------------------------------------------
function D3(state) {
  let particleWorker = replaceOnce(
    state.particleWorker,
    `    this.maxParticles = 0;
    this.activeParticleCount = 0;
    this.particlesStampedThisFrame = 0;
    this.buildActiveVisibleTimeThisFrame = 0;
    this.particlePhysicsTimeThisFrame = 0;
    this.decalStampTimeThisFrame = 0;`,
    `    this.maxParticles = 0;
    this.activeParticleCount = 0;
    this.particlesStampedThisFrame = 0;
    this.buildActiveVisibleTimeThisFrame = 0;
    this.particlePhysicsTimeThisFrame = 0;
    this.decalStampTimeThisFrame = 0;
    // D3: stamp budget — see stampCollectedParticles for the drop-overflow tradeoff.
    this.maxStampsPerFrame = 256;`,
    'D3'
  );

  particleWorker = replaceOnce(
    particleWorker,
    `    const particleAlpha = ParticleComponent.alpha;
    const particleBlendMode = ParticleComponent.blendMode;

    for (let i = 0; i < this.particlesToStampCount; i++) {
      const particleIndex = this.particlesToStamp[i];

      this.stampParticleToTile(
        particleX[particleIndex],
        particleY[particleIndex],
        particleTint[particleIndex],
        particleScaleX[particleIndex],
        particleScaleY[particleIndex],
        particleTextureId[particleIndex],
        particleAlpha[particleIndex],
        particleBlendMode[particleIndex]
      );
    }

    this.particlesStampedThisFrame = this.particlesToStampCount;
  }`,
    `    const particleAlpha = ParticleComponent.alpha;
    const particleBlendMode = ParticleComponent.blendMode;

    // D3: stamp budget — ponytail: drops overflow past maxStampsPerFrame rather
    // than deferring to next frame; upgrade path is a carry-over queue if
    // bursts regularly exceed the budget.
    const stampCount = Math.min(this.particlesToStampCount, this.maxStampsPerFrame);

    for (let i = 0; i < stampCount; i++) {
      const particleIndex = this.particlesToStamp[i];

      this.stampParticleToTile(
        particleX[particleIndex],
        particleY[particleIndex],
        particleTint[particleIndex],
        particleScaleX[particleIndex],
        particleScaleY[particleIndex],
        particleTextureId[particleIndex],
        particleAlpha[particleIndex],
        particleBlendMode[particleIndex]
      );
    }

    this.particlesStampedThisFrame = stampCount;
  }`,
    'D3'
  );

  return { ...state, particleWorker };
}

// ---------------------------------------------------------------------------
// D4: multi-tile clip cache — skip recalculateDecalTileBounds when this
// stamp's world bounds are identical to the immediately previous stamp.
// Weak: particle positions are almost always unique, so this rarely hits —
// kept as a falsifiable hyp expected to reject in the tournament.
// ---------------------------------------------------------------------------
function D4(state) {
  let decalStamp = replaceOnce(
    state.decalStamp,
    `import { calculateDecalTileBounds, calculateTileClipRegion, _decalTileBounds, _tileClipRegion } from '../util/utils.js';`,
    `import { calculateDecalTileBounds, calculateTileClipRegion, _decalTileBounds, _tileClipRegion } from '../util/utils.js';

// D4: last-stamp bounds cache (weak — positions are usually unique per particle).
let _lastBoundsWorldX = NaN;
let _lastBoundsWorldY = NaN;
let _lastBoundsHalfW = NaN;
let _lastBoundsHalfH = NaN;
const _lastBoundsResult = { minTileX: 0, maxTileX: 0, minTileY: 0, maxTileY: 0, valid: false };`,
    'D4'
  );

  decalStamp = replaceOnce(
    decalStamp,
    `  calculateDecalTileBounds(worldX, worldY, halfWidthWorld, halfHeightWorld, tileSize, tilesX, tilesY, _decalTileBounds);

  if (!_decalTileBounds.valid) return;`,
    `  // D4: skip recomputation if this stamp's decal bounds exactly match the last one.
  if (
    worldX === _lastBoundsWorldX &&
    worldY === _lastBoundsWorldY &&
    halfWidthWorld === _lastBoundsHalfW &&
    halfHeightWorld === _lastBoundsHalfH
  ) {
    _decalTileBounds.minTileX = _lastBoundsResult.minTileX;
    _decalTileBounds.maxTileX = _lastBoundsResult.maxTileX;
    _decalTileBounds.minTileY = _lastBoundsResult.minTileY;
    _decalTileBounds.maxTileY = _lastBoundsResult.maxTileY;
    _decalTileBounds.valid = _lastBoundsResult.valid;
  } else {
    calculateDecalTileBounds(worldX, worldY, halfWidthWorld, halfHeightWorld, tileSize, tilesX, tilesY, _decalTileBounds);
    _lastBoundsWorldX = worldX;
    _lastBoundsWorldY = worldY;
    _lastBoundsHalfW = halfWidthWorld;
    _lastBoundsHalfH = halfHeightWorld;
    _lastBoundsResult.minTileX = _decalTileBounds.minTileX;
    _lastBoundsResult.maxTileX = _decalTileBounds.maxTileX;
    _lastBoundsResult.minTileY = _decalTileBounds.minTileY;
    _lastBoundsResult.maxTileY = _decalTileBounds.maxTileY;
    _lastBoundsResult.valid = _decalTileBounds.valid;
  }

  if (!_decalTileBounds.valid) return;`,
    'D4'
  );

  return { ...state, decalStamp };
}

// ---------------------------------------------------------------------------
// D5: pixi dirty-ring upload path — a real fix belongs in pixi_worker.js's
// decal tile sprite refresh (only re-upload tiles bloodTilesDirty flagged),
// not in the particle-side stamping loop. Deferred: identity transform with a
// marker comment so the tournament can score it (expected reject).
// ---------------------------------------------------------------------------
function D5(state) {
  const particleWorker = replaceOnce(
    state.particleWorker,
    `  // ========================================
  // BLOOD DECAL STAMPING
  // ========================================`,
    `  // ========================================
  // BLOOD DECAL STAMPING
  // D5: deferred — a real dirty-ring upload path belongs in pixi_worker.js's
  // decal tile sprite refresh, not here; this hyp intentionally no-ops so the
  // tournament can score it (expected reject).
  // ========================================`,
    'D5'
  );

  return { ...state, particleWorker };
}

// ---------------------------------------------------------------------------
// D6: ParticleEmitter.stampDecal — skip the delete/copy for-in churn on the
// scratch object (each call deleted every key then re-copied config over it,
// which repeatedly toggles the scratch object into V8 dictionary mode).
// Assign the known decal fields directly so the scratch object keeps a stable
// shape across calls. ponytail: assumes callers only pass documented
// stampDecal fields; upgrade path is reverting to the for-in copy if a caller
// needs an undocumented key.
// ---------------------------------------------------------------------------
function D6(state) {
  const particleEmitter = replaceOnce(
    state.particleEmitter,
    `  static stampDecal(config) {
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
    return this._spawn(s, null);
  }`,
    `  static stampDecal(config) {
    // D6: skip the delete/copy for-in churn — assign known decal fields
    // directly so the scratch object's shape stays stable across calls.
    const s = this._stampScratch;
    s.texture = config.texture;
    s.spritesheet = config.spritesheet;
    s.animation = config.animation;
    s.frame = config.frame;
    s.x = config.x;
    s.y = config.y;
    s.scale = config.scale;
    s.scaleX = config.scaleX;
    s.scaleY = config.scaleY;
    s.tint = config.tint;
    s.alpha = config.alpha;
    s.blendMode = config.blendMode;
    s.flipX = config.flipX;
    s.flipY = config.flipY;
    s.rotation = config.rotation;
    s.z = 0;
    s.lifespan = 100;
    s.stayOnTheFloor = true;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.gravity = 1;
    s.flat = 0;
    s.viewMode = CAMERA_TYPES.TOPDOWN;
    return this._spawn(s, null);
  }`,
    'D6'
  );

  return { ...state, particleEmitter };
}

export const TRANSFORMS = { D1, D2, D3, D4, D5, D6 };

/** Sort hyp ids into CANONICAL_ORDER, dropping unknown ids. */
export function sortHypIds(ids) {
  const set = new Set(ids);
  return CANONICAL_ORDER.filter((id) => set.has(id));
}

/**
 * Restore baselines, then fold the transforms for `ids` (sorted into
 * CANONICAL_ORDER) over the baseline source, writing the result to
 * src/util/decalStamp.js, src/core/particleEmitter.js and
 * src/workers/particleWorker.js.
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
    decalStamp: readLf(PATHS.decalStamp),
    particleEmitter: readLf(PATHS.particleEmitter),
    particleWorker: readLf(PATHS.particleWorker),
  };

  for (const id of sortHypIds(ids)) {
    const transform = TRANSFORMS[id];
    if (!transform) throw new Error(`Unknown hyp: ${id}`);
    state = transform(state);
  }

  fs.writeFileSync(PATHS.decalStamp, state.decalStamp);
  fs.writeFileSync(PATHS.particleEmitter, state.particleEmitter);
  fs.writeFileSync(PATHS.particleWorker, state.particleWorker);
}

/** Apply a single hyp id. BASE means "restore baselines only". */
export function applyHyp(id) {
  if (id === 'BASE') {
    restoreAll();
    return;
  }
  applyCombo([id]);
}

/** Parse a combo id string like 'D1+D2' into ['D1', 'D2']. */
export function parseComboId(comboId) {
  return String(comboId)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const HYPS = [
  { id: 'BASE', apply: () => applyHyp('BASE') },
  { id: 'D1', apply: () => applyHyp('D1') },
  { id: 'D2', apply: () => applyHyp('D2') },
  { id: 'D3', apply: () => applyHyp('D3') },
  { id: 'D4', apply: () => applyHyp('D4') },
  { id: 'D5', apply: () => applyHyp('D5') },
  { id: 'D6', apply: () => applyHyp('D6') },
];
