// The JS emit pre-render ran before preRenderEmit.wasm took every queue (E-112, W4a-W4d, W27; close-out group B): the
// row loop of emitSpriteQueue for every row type, the entities queue's persist path (W4c: the check, the poses-only pass,
// the remember), the Adobe expansion (_emitAdobePieces) and
// clocks (advanceAdobeAnimations), as they were in src/workers/preRenderWorker.js. The kernel's parity tests compare it
// with them: installEmitJs puts it on a pre-render worker, which then emits through this JS while its _emitWasm is null
// and through its kernel (its own emitSpriteQueue and advanceAdobeAnimations) otherwise.
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';
import { CAMERA_TYPES, SPRITE_TILE_MODE } from '../../src/util/configDefaults.js';
import { lightGlowScale } from '../../src/util/utils.js';

// As in preRenderWorker.js (that module installs its worker when it is imported, so it is not imported here).
const INVALID_TEXTURE_ID = 0xFFFF;
const TILE_MODE_LOCAL = SPRITE_TILE_MODE.LOCAL;
const ANIM_LABEL_TAG = Object.freeze({
    PARTICLE: 0,
    LIQUID_FUN: 1,
    DECORATION: 2,
    BULLET: 3,
});
// The frame's step in seconds for _advancePersistFrame, written once per persist frame.
const PERSIST_DT = new Float64Array(1);

/** Stretch / skip tiling on non-entity queue rows (particles, adobe pieces, …). */
function clearTileFields(ref, out) {
    if (ref.tileMode) ref.tileMode[out] = 0;
    if (ref.tileOffsetU) ref.tileOffsetU[out] = 0;
    if (ref.tileOffsetV) ref.tileOffsetV[out] = 0;
    if (ref.tileMulX) ref.tileMulX[out] = 0;
    if (ref.tileMulY) ref.tileMulY[out] = 0;
}

/** Non-caster rows: zero stamp extras instead of fill() of the whole prefix. */
function clearQueueShadow(ref, out) {
    if (ref.shadowH) ref.shadowH[out] = 0;
    if (ref.shadowOffX) ref.shadowOffX[out] = 0;
    if (ref.shadowOffY) ref.shadowOffY[out] = 0;
}

/**
 * Copy SoA tile fields and resolve signed GPU mul:
 * WORLD (or legacy repeatX with mode 0): +1/period
 * LOCAL: -(2 * boundsHalf) / period
 */
function writeEntityTileFields(
    ref, out, idx,
    srTileMode, srTileOffU, srTileOffV,
    srRepeatX, srRepeatY, srBHW, srBHH
) {
    const mode = srTileMode[idx];
    if (ref.tileMode) ref.tileMode[out] = mode;
    if (ref.tileOffsetU) ref.tileOffsetU[out] = srTileOffU[idx];
    if (ref.tileOffsetV) ref.tileOffsetV[out] = srTileOffV[idx];
    const rx = srRepeatX[idx];
    const ry = srRepeatY[idx];
    let mx = 0;
    let my = 0;
    if (rx > 0) mx = mode === TILE_MODE_LOCAL ? -(srBHW[idx] * 2) / rx : 1 / rx;
    if (ry > 0) my = mode === TILE_MODE_LOCAL ? -(srBHH[idx] * 2) / ry : 1 / ry;
    if (ref.tileMulX) ref.tileMulX[out] = mx;
    if (ref.tileMulY) ref.tileMulY[out] = my;
}

/**
 * Write one sprite layer from a collector into SoA columns already bound
 * on this.renderQueue*. Main queue and custom layers share this loop.
 */
function emitSpriteQueue(deltaTime, source) {
    const count = source.count;
    const maxItems = source.maxItems;
    const collectorY = source.collectorY;
    const collectorType = source.collectorType;
    const collectorIndex = source.collectorIndex;
    const stashPx = source.stashX;
    const stashPy = source.stashY;
    const stashRc = source.stashRotC;
    const stashRs = source.stashRotS;

    // sortKey is written for the CPU painter. Pixi reinserts; this pass does not sort.
    const detail = source.persist && this.collectDetailedStats;
    if (detail) this.sortTimeThisFrame = 0;
    const tEmit = detail ? performance.now() : 0;

    // Cache output arrays
    const rqX = this.renderQueueX;
    const rqY = this.renderQueueY;
    const rqScaleX = this.renderQueueScaleX;
    const rqScaleY = this.renderQueueScaleY;
    const rqRotC = this.renderQueueRotC;
    const rqRotS = this.renderQueueRotS;
    const rqAlpha = this.renderQueueAlpha;
    const rqTint = this.renderQueueTint;
    const rqTextureId = this.renderQueueTextureId;
    const rqAnchorX = this.renderQueueAnchorX;
    const rqAnchorY = this.renderQueueAnchorY;
    const rqType = this.renderQueueType;
    const rqSortKey = this.renderQueueSortKey;
    const rqRepeatX = this.renderQueueRepeatX;
    const rqRepeatY = this.renderQueueRepeatY;
    const rqTileMode = this.renderQueueTileMode;
    const rqTileOffsetU = this.renderQueueTileOffsetU;
    const rqTileOffsetV = this.renderQueueTileOffsetV;
    const rqTileMulX = this.renderQueueTileMulX;
    const rqTileMulY = this.renderQueueTileMulY;
    const entityLastTextureId = this.entityLastTextureId;

    // Cache component arrays
    const entityX = Transform.x;
    const entityY = Transform.y;

    const srScaleX = SpriteRenderer.scaleX;
    const srScaleY = SpriteRenderer.scaleY;
    const srAlpha = SpriteRenderer.alpha;
    const srTint = SpriteRenderer.tint;
    const srAnchorX = SpriteRenderer.anchorX;
    const srAnchorY = SpriteRenderer.anchorY;
    const srAnimState = SpriteRenderer.animationState;
    const srSpritesheetId = SpriteRenderer.spritesheetId;
    const srAnimSpeed = SpriteRenderer.animationSpeed;
    const srLoop = SpriteRenderer.loop;
    const srIsAnimated = SpriteRenderer.isAnimated;
    const srInheritTransformRotation = SpriteRenderer.inheritTransformRotation;
    const srSpriteRotC = SpriteRenderer.spriteRotC;
    const srSpriteRotS = SpriteRenderer.spriteRotS;
    const srRepeatX = SpriteRenderer.repeatX;
    const srRepeatY = SpriteRenderer.repeatY;
    const srTileMode = SpriteRenderer.tileMode;
    const srTileOffsetU = SpriteRenderer.tileOffsetU;
    const srTileOffsetV = SpriteRenderer.tileOffsetV;
    const srBoundsHalfW = SpriteRenderer.boundsHalfW;
    const srBoundsHalfH = SpriteRenderer.boundsHalfH;

    const particleX = ParticleComponent.x;
    const particleY = ParticleComponent.y;
    const particleZ = ParticleComponent.z;
    const particleScaleX = ParticleComponent.scaleX;
    const particleScaleY = ParticleComponent.scaleY;
    const particleFlipX = ParticleComponent.flipX;
    const particleFlipY = ParticleComponent.flipY;
    const particleRotC = ParticleComponent.rotC;
    const particleRotS = ParticleComponent.rotS;
    const particleAlpha = ParticleComponent.alpha;
    const particleTint = ParticleComponent.tint;
    const particleTextureId = ParticleComponent.textureId;
    const particleFlat = ParticleComponent.flat;
    const particleViewMode = ParticleComponent.viewMode;

    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
    const glowHeightOffset = LightEmitter.glowHeightOffset;
    const glowSprite = LightEmitter.hasGlowSprite;
    const lightGradientTextureId = this._resolveBuiltinTextureId('_lightGradient');
    const whiteCircleTextureId = this._resolveBuiltinTextureId('_whiteCircle');

    const decoX = DecorationComponent.x;
    const decoY = DecorationComponent.y;
    const decoOffsetX = DecorationComponent.offsetX;
    const decoOffsetY = DecorationComponent.offsetY;
    const decoScaleX = DecorationComponent.scaleX;
    const decoScaleY = DecorationComponent.scaleY;
    const decoRotC = DecorationComponent.rotC;
    const decoRotS = DecorationComponent.rotS;
    const decoAlpha = DecorationComponent.alpha;
    const decoTint = DecorationComponent.tint;
    const decoTextureId = DecorationComponent.textureId;
    const decoAnchorX = DecorationComponent.anchorX;
    const decoAnchorY = DecorationComponent.anchorY;

    const bulletX = BulletComponent.x;
    const bulletY = BulletComponent.y;
    const bulletStartX = BulletComponent.startX ?? BulletComponent.prevX;
    const bulletStartY = BulletComponent.startY ?? BulletComponent.prevY;
    const bulletOffsetY = BulletComponent.offsetY;
    const bulletScale = BulletComponent.scale;
    const bulletAlpha = BulletComponent.alpha;
    const bulletTint = BulletComponent.tint;
    const bulletTextureId = BulletComponent.textureId;
    const bulletSpriteRotC = BulletComponent.spriteRotC;
    const bulletSpriteRotS = BulletComponent.spriteRotS;
    const bulletRotC = BulletComponent.bulletRotC;
    const bulletRotS = BulletComponent.bulletRotS;
    const bulletTrailWidth = BulletComponent.trailWidth;
    const bulletAnchorX = BulletComponent.anchorX;
    const bulletAnchorY = BulletComponent.anchorY;
    const bulletActive = BulletComponent.active;

    const bulletTrailTextureId = this._resolveBuiltinTextureId('_bulletTrail');
    const BULLET_TRAIL_MIN_LENGTH_SQ = 0.01;

    const frameIndex = this.entityFrameIndex;
    const frameAccum = this.entityFrameAccumulator;
    const deltaSeconds = deltaTime / 1000;
    const ref = this._emitRef;
    ref.x = rqX; ref.y = rqY; ref.scaleX = rqScaleX; ref.scaleY = rqScaleY;
    ref.rotC = rqRotC; ref.rotS = rqRotS; ref.alpha = rqAlpha; ref.tint = rqTint;
    ref.textureId = rqTextureId; ref.anchorX = rqAnchorX; ref.anchorY = rqAnchorY;
    ref.type = rqType;
    ref.sortKey = rqSortKey;
    ref.repeatX = rqRepeatX; ref.repeatY = rqRepeatY;
    ref.tileMode = rqTileMode; ref.tileOffsetU = rqTileOffsetU; ref.tileOffsetV = rqTileOffsetV;
    ref.tileMulX = rqTileMulX; ref.tileMulY = rqTileMulY;
    const tilesDirty = rqTileMode !== null && this._tiledTileColumns.has(rqTileMode);
    ref.tilesDirty = tilesDirty;
    let tiledRows = false;
    const rqShadowH = this.renderQueueShadowH;
    const rqShadowOffX = this.renderQueueShadowOffX;
    const rqShadowOffY = this.renderQueueShadowOffY;
    const scActive = ShadowCaster.active;
    const scH = ShadowCaster.heightMultiplier;
    const scOx = ShadowCaster.anchorOffsetX;
    const scOy = ShadowCaster.anchorOffsetY;

    ref.shadowH = rqShadowH;
    ref.shadowOffX = rqShadowOffX;
    ref.shadowOffY = rqShadowOffY;
    ref.scActive = scActive;
    ref.scH = scH;
    ref.scOx = scOx;
    ref.scOy = scOy;

    let writeCount = 0;
    const stashPose = this._displayPoseOut;
    const writeSortKey = !!(rqSortKey && source.hasOrder);
    const ySort = !!source.ySort;
    // -1 when off: buffer 0 is a valid persist target (it used to read as false).
    const persistBuf = source.persist ? this._queueBuf : -1;
    let persistHit = false;
    // Rows other than sprites are rewritten in full on a persist frame too (E-82 staticGen).
    let persistOthers = 0;
    if (persistBuf >= 0) {
        persistHit = this._type0PersistHit(persistBuf, count, collectorType, collectorIndex);
        if (persistHit) {
            persistOthers = this._writeType0PosesOnly(count, collectorType, collectorIndex, collectorY, stashPx, stashPy, stashRc, stashRs, deltaTime);
        }
    }
    // E-98b. On a persist frame of sprites only, the loop below would only count the rows.
    let loopCount = count;
    if (persistHit && persistOthers === 0) {
        writeCount = count < maxItems ? count : maxItems;
        loopCount = 0;
    }

    for (let i = 0; i < loopCount && writeCount < maxItems; i++) {
        const type = collectorType[i];
        const idx = collectorIndex[i];

        if (persistHit && type === 0) {
            writeCount++;
            continue;
        }
        const yKey = collectorY[i];
        const sk = writeSortKey ? this._orderKey(type, idx, yKey, ySort) : yKey;

        if (type === 6) {
            if (stashPx) {
                stashPose[0] = stashPx[i];
                stashPose[1] = stashPy[i];
                stashPose[2] = stashRc[i];
                stashPose[3] = stashRs[i];
                writeCount = this._emitAdobePieces(ref, writeCount, idx, sk, stashPose);
            } else {
                writeCount = this._emitAdobePieces(ref, writeCount, idx, sk, null);
            }
            continue;
        }

        const out = writeCount++;
        if (writeSortKey) rqSortKey[out] = sk;
        if (type !== 0) {
            if (tilesDirty) {
                if (rqRepeatX) rqRepeatX[out] = 0;
                if (rqRepeatY) rqRepeatY[out] = 0;
                clearTileFields(ref, out);
            }
            clearQueueShadow(ref, out);
        }

        if (type === 0) {
            // === ENTITY === (pose stashed at collect when the collector has it)
            let currX;
            let currY;
            let rc;
            let rs;
            if (stashPx) {
                currX = stashPx[i];
                currY = stashPy[i];
                if (srInheritTransformRotation[idx]) {
                    rc = stashRc[i];
                    rs = stashRs[i];
                } else {
                    rc = srSpriteRotC[idx];
                    rs = srSpriteRotS[idx];
                }
            } else {
                this._displayPose(idx, stashPose);
                currX = stashPose[0];
                currY = stashPose[1];
                if (srInheritTransformRotation[idx]) {
                    rc = stashPose[2];
                    rs = stashPose[3];
                } else {
                    rc = srSpriteRotC[idx];
                    rs = srSpriteRotS[idx];
                }
            }
            const sx = srScaleX[idx];
            const sy = srScaleY[idx];
            const a = srAlpha[idx];
            const tint = srTint[idx];
            const ax = srAnchorX[idx];
            const ay = srAnchorY[idx];
            rqAlpha[out] = a;
            this._writeQueueShadow(out, idx);
            const rx0 = srRepeatX[idx];
            const ry0 = srRepeatY[idx];
            if (rx0 !== 0 || ry0 !== 0) {
                tiledRows = true;
                if (rqRepeatX) rqRepeatX[out] = rx0;
                if (rqRepeatY) rqRepeatY[out] = ry0;
                writeEntityTileFields(
                    ref, out, idx,
                    srTileMode, srTileOffsetU, srTileOffsetV,
                    srRepeatX, srRepeatY, srBoundsHalfW, srBoundsHalfH
                );
            } else if (tilesDirty) {
                if (rqRepeatX) rqRepeatX[out] = 0;
                if (rqRepeatY) rqRepeatY[out] = 0;
                if (rqTileMulX) rqTileMulX[out] = 0;
                if (rqTileMulY) rqTileMulY[out] = 0;
            }

            rqX[out] = currX;
            rqY[out] = currY;
            rqScaleX[out] = sx;
            rqScaleY[out] = sy;
            rqRotC[out] = rc;
            rqRotS[out] = rs;
            rqTint[out] = tint;
            rqAnchorX[out] = ax;
            rqAnchorY[out] = ay;

            this._setQueueType(ref, out, 0, idx);
            const sheetId = srSpritesheetId[idx];
            const animState = srAnimState[idx];
            let tex = INVALID_TEXTURE_ID;

            const proxyMap = this.proxyToGlobalAnim?.[sheetId];
            const globalAnimIdx = proxyMap?.[animState];

            if (globalAnimIdx !== undefined) {
                const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;
                if (frameIndex[idx] >= animFrameCount) {
                    frameIndex[idx] = 0;
                }

                if (srIsAnimated[idx] && animFrameCount > 1) {
                    frameAccum[idx] += deltaSeconds;
                    const frameDuration = 1 / (srAnimSpeed[idx] * 60);

                    if (frameAccum[idx] >= frameDuration) {
                        frameAccum[idx] -= frameDuration;

                        const currentFrame = frameIndex[idx];
                        const isLastFrame = currentFrame >= animFrameCount - 1;
                        const shouldLoop = srLoop[idx] === 1;

                        if (!shouldLoop && isLastFrame) {
                            // The last frame of a play-once animation finished showing.
                            if (this._animEndByType[Transform.entityType[idx]] === 1) {
                                this._spriteAnimationEnded(idx, animState);
                            }
                        } else {
                            frameIndex[idx] = (currentFrame + 1) % animFrameCount;
                            // Bounds may change (variable frame sizes)
                            if (this.frameWidth && this.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH) {
                                const texId = (this.animationFrameStart?.[globalAnimIdx] ?? 0) + frameIndex[idx];
                                const origW = this.frameWidth[texId] || 0;
                                const origH = this.frameHeight[texId] || 0;
                                const sx = Math.abs(srScaleX[idx]) || 1; // flip = negative scale
                                const sy = Math.abs(srScaleY[idx]) || 1;
                                SpriteRenderer.boundsHalfW[idx] = (origW * sx) * 0.5;
                                SpriteRenderer.boundsHalfH[idx] = (origH * sy) * 0.5;
                            }
                        }
                    }
                }

                const animStart = this.animationFrameStart?.[globalAnimIdx];
                if (animStart === undefined) {
                    this._warnMissingTexture(
                        `animStart:${globalAnimIdx}`,
                        `[PRE_RENDER] animationFrameStart missing for globalAnimIdx=${globalAnimIdx} entity=${idx}`
                    );
                } else {
                    tex = animStart + frameIndex[idx];
                    if (entityLastTextureId) entityLastTextureId[idx] = tex;
                }
            } else {
                // Never reuse stale lastTextureId (pool recycle / spawn before setSprite).
                if (entityLastTextureId) entityLastTextureId[idx] = INVALID_TEXTURE_ID;
                // sheetId 0 = unset sentinel — expected under collect→emit recycle. No warn.
                if (sheetId) {
                    this._warnMissingTexture(
                        `sprite:${sheetId}:${animState}`,
                        `[PRE_RENDER] no global anim for sheetId=${sheetId} animState=${animState} entity=${idx}; using INVALID textureId`
                    );
                }
            }
            rqTextureId[out] = tex;
        } else if (type === 1) {
            // === PARTICLE ===
            rqX[out] = particleX[idx];
            // Zenithal: height → scale (and alpha). Never fold z into Y.
            // Flat: y only. Else (topdown): screenY = y + z.
            if (particleViewMode && particleViewMode[idx] === CAMERA_TYPES.ZENITHAL && !(particleFlat && particleFlat[idx])) {
                rqY[out] = particleY[idx];
                const height = -particleZ[idx];
                const heightFactor = 1 + (height / this.zenithalMaxHeight) * this.zenithalScaleFactor;
                rqScaleX[out] = particleScaleX[idx] * heightFactor * (particleFlipX[idx] ? -1 : 1);
                rqScaleY[out] = particleScaleY[idx] * heightFactor * (particleFlipY[idx] ? -1 : 1);
                let a = particleAlpha[idx];
                if (this.zenithalAlphaFade > 0) {
                    const alphaFade = Math.min(1, (height / this.zenithalMaxHeight) * this.zenithalAlphaFade);
                    a *= Math.max(0, 1 - alphaFade);
                }
                rqAlpha[out] = a;
            } else if (particleFlat && particleFlat[idx]) {
                rqY[out] = particleY[idx];
                rqScaleX[out] = particleScaleX[idx] * (particleFlipX[idx] ? -1 : 1);
                rqScaleY[out] = particleScaleY[idx] * (particleFlipY[idx] ? -1 : 1);
                rqAlpha[out] = particleAlpha[idx];
            } else {
                rqY[out] = particleY[idx] + particleZ[idx];
                rqScaleX[out] = particleScaleX[idx] * (particleFlipX[idx] ? -1 : 1);
                rqScaleY[out] = particleScaleY[idx] * (particleFlipY[idx] ? -1 : 1);
                rqAlpha[out] = particleAlpha[idx];
            }
            rqRotC[out] = particleRotC[idx];
            rqRotS[out] = particleRotS[idx];
            rqTint[out] = particleTint[idx];
            const pAnimIdx = particleTextureId[idx];
            rqTextureId[out] = pAnimIdx === 0
                ? whiteCircleTextureId
                : this._resolveAnimFrameStart(pAnimIdx, ANIM_LABEL_TAG.PARTICLE);
            rqAnchorX[out] = 0.5;
            rqAnchorY[out] = 0.5;
            this._setQueueType(ref, out, 1, idx);
        } else if (type === 7) {
            const lf = this.liquidFun;
            if (
                this.interpolatePhysicsPose &&
                this._prevLfX &&
                this._prevLfCount > idx
            ) {
                const alpha = this._poseAlpha;
                const px = this._prevLfX[idx];
                const py = this._prevLfY[idx];
                rqX[out] = px + (lf.x[idx] - px) * alpha;
                rqY[out] = py + (lf.y[idx] - py) * alpha;
            } else {
                rqX[out] = lf.x[idx];
                rqY[out] = lf.y[idx];
            }
            rqScaleX[out] = lf.scaleX[idx];
            rqScaleY[out] = lf.scaleY[idx];
            rqAlpha[out] = lf.alpha[idx] * (lf.baseAlpha ? lf.baseAlpha[idx] : 1);
            rqRotC[out] = lf.rotC[idx];
            rqRotS[out] = lf.rotS[idx];
            rqTint[out] = lf.tint[idx];
            const lfAnimIdx = lf.textureId[idx];
            rqTextureId[out] = lfAnimIdx === 0
                ? whiteCircleTextureId
                : this._resolveAnimFrameStart(lfAnimIdx, ANIM_LABEL_TAG.LIQUID_FUN);
            rqAnchorX[out] = 0.5;
            rqAnchorY[out] = 0.5;
            this._setQueueType(ref, out, 1, idx);
        } else if (type === 2) {
            // === DECORATION === (world xy + facing stashed at collect when present)
            let decoWorldX;
            let decoWorldY;
            let decoRotCos;
            let decoRotSin;
            if (stashPx) {
                decoWorldX = stashPx[i];
                decoWorldY = stashPy[i];
                decoRotCos = stashRc[i];
                decoRotSin = stashRs[i];
            } else {
                this._decorationWorldXY(idx, stashPose);
                decoWorldX = stashPose[0];
                decoWorldY = stashPose[1];
                decoRotCos = decoRotC[idx];
                decoRotSin = decoRotS[idx];
            }
            rqX[out] = decoWorldX;
            rqY[out] = decoWorldY;
            rqScaleX[out] = decoScaleX[idx];
            rqScaleY[out] = decoScaleY[idx];
            rqRotC[out] = decoRotCos;
            rqRotS[out] = decoRotSin;
            rqAlpha[out] = decoAlpha[idx] * this._decorationZoomAlpha;
            rqTint[out] = decoTint[idx];
            const dAnimIdx = decoTextureId[idx];
            rqTextureId[out] = this._resolveAnimFrameStart(dAnimIdx, ANIM_LABEL_TAG.DECORATION);
            rqAnchorX[out] = decoAnchorX[idx];
            rqAnchorY[out] = decoAnchorY[idx];
            this._setQueueType(ref, out, 2, idx);
        } else if (type === 4) {
            // === BULLET ===
            if (!bulletActive[idx]) {
                rqAlpha[out] = 0;
                rqScaleX[out] = 0;
                rqScaleY[out] = 0;
                rqX[out] = -10000;
                rqY[out] = -10000;
            } else {
                rqX[out] = bulletX[idx];
                rqY[out] = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                rqScaleX[out] = bulletScale[idx];
                rqScaleY[out] = bulletScale[idx];
                rqRotC[out] = bulletSpriteRotC[idx];
                rqRotS[out] = bulletSpriteRotS[idx];
                rqAlpha[out] = bulletAlpha[idx];
                rqTint[out] = bulletTint[idx];
                const bAnimIdx = bulletTextureId[idx];
                rqTextureId[out] = this._resolveAnimFrameStart(bAnimIdx, ANIM_LABEL_TAG.BULLET);
                rqAnchorX[out] = bulletAnchorX[idx];
                rqAnchorY[out] = bulletAnchorY[idx];
            }
            this._setQueueType(ref, out, 4, idx);
        } else if (type === 5) {
            // === BULLET TRAIL (line from start to curr, 0-alpha at start) ===
            if (!bulletActive[idx]) {
                rqAlpha[out] = 0;
                rqScaleX[out] = 0;
                rqScaleY[out] = 0;
                rqX[out] = -10000;
                rqY[out] = -10000;
            } else {
                const currX = bulletX[idx];
                const currY = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                const startX = bulletStartX[idx];
                const startY = bulletStartY[idx] + (bulletOffsetY[idx] ?? 0);
                const dx = currX - startX;
                const dy = currY - startY;
                const lenSq = dx * dx + dy * dy;

                if (lenSq < BULLET_TRAIL_MIN_LENGTH_SQ) {
                    rqAlpha[out] = 0;
                    rqScaleX[out] = 0;
                    rqScaleY[out] = 0;
                    rqX[out] = -10000;
                    rqY[out] = -10000;
                } else {
                    const adx = dx < 0 ? -dx : dx;
                    const ady = dy < 0 ? -dy : dy;
                    const max = adx > ady ? adx : ady;
                    const min = adx > ady ? ady : adx;
                    const lengthApprox = 0.96 * max + 0.4 * min;

                    rqX[out] = (startX + currX) * 0.5;
                    rqY[out] = (startY + currY) * 0.5;
                    rqScaleX[out] = lengthApprox / 10;
                    rqScaleY[out] = bulletTrailWidth[idx];
                    // Flight dir already in bulletRotC/S (straight bullets)
                    rqRotC[out] = bulletRotC[idx];
                    rqRotS[out] = bulletRotS[idx];
                    rqAlpha[out] = bulletAlpha[idx] * 0.9;
                    rqTint[out] = 0xffffff;
                }
            }
            rqTextureId[out] = bulletTrailTextureId;
            rqAnchorX[out] = 0.5;
            rqAnchorY[out] = 0.5;
            this._setQueueType(ref, out, 5, idx);
        } else {
            // === LIGHT GLOW (type=3) ===
            const scale = lightGlowScale(sqrtLightIntensity[idx]);
            // hasGlowSprite 0.5 → /50000; 1 → /25000
            const glowAlpha = lightIntensity[idx] * glowSprite[idx] * (1 / 25000);

            if (scale < 0.1 || glowAlpha < 0.001) {
                rqAlpha[out] = 0;
                rqScaleX[out] = 0;
                rqScaleY[out] = 0;
                rqX[out] = -10000;
                rqY[out] = -10000;
            } else {
                rqX[out] = entityX[idx];
                rqY[out] = entityY[idx] - (glowHeightOffset[idx] || 0);
                rqScaleX[out] = scale;
                rqScaleY[out] = scale;
                rqAlpha[out] = glowAlpha;
                rqTint[out] = lightColor[idx];
            }
            rqRotC[out] = 1;
            rqRotS[out] = 0;
            rqTextureId[out] = lightGradientTextureId;
            rqAnchorX[out] = 0.5;
            rqAnchorY[out] = 0.5;
            if (this._lightGlowAsSprite && rqAlpha[out] > 0) rqAlpha[out] *= this._glowLayerAlpha;
            this._setQueueType(ref, out, 3, idx);
        }
    }

    if (detail) this.emitTimeThisFrame = performance.now() - tEmit;
    // E-102b: from now on this queue's other rows must clear what a repeating sprite left.
    if (tiledRows && rqTileMode !== null) this._tiledTileColumns.add(rqTileMode);
    if (source.persist && !persistHit) {
        this._rememberType0Set(persistBuf, count, collectorType, collectorIndex);
    }
    if (source.persist) {
        // E-82. A frame that only moved sprites keeps the count; anything else is a new one
        // (0 is skipped: it means unknown).
        if (!persistHit || persistOthers > 0 || this._persistFramesMoved > 0 || this._persistFramesRepaired > 0) {
            this._staticGen = ((this._staticGen + 1) >>> 0) || 1;
        }
        if (this.renderQueueStaticGen.length) this.renderQueueStaticGen[0] = this._staticGen;
    }
    return writeCount;
}

function advanceAdobeAnimations(deltaTime) {
    if (!AdobeAnimComponent.active) return;

    const deltaSeconds = deltaTime / 1000;
    if (deltaSeconds <= 0) return;

    const active = AdobeAnimComponent.active;
    const playing = AdobeAnimComponent.playing;
    const playbackRate = AdobeAnimComponent.playbackRate;
    const assetId = AdobeAnimComponent.assetId;
    const clipId = AdobeAnimComponent.clipId;
    const time = AdobeAnimComponent.time;
    const loop = AdobeAnimComponent.loop;

    const adobeEntities = this._frameAdobeEntities;
    if (!adobeEntities || adobeEntities.length === 0) return;

    for (let n = 0; n < adobeEntities.length; n++) {
        const i = adobeEntities[n];
        if (!active[i] || !playing[i]) continue;

        const frameCount = AdobeAnimRegistry.getClipFrameCount(assetId[i], clipId[i]);
        const frameRate = AdobeAnimRegistry.getClipFrameRate(assetId[i], clipId[i]);
        if (frameCount <= 0 || frameRate <= 0) continue;

        const duration = frameCount / frameRate;
        const nextTime = time[i] + deltaSeconds * playbackRate[i];

        if (loop[i]) {
            time[i] = duration > 0 ? ((nextTime % duration) + duration) % duration : 0;
        } else if (nextTime >= duration) {
            time[i] = duration;
            playing[i] = 0;
            this._adobeAnimationEnded(i);
        } else if (nextTime <= 0) {
            time[i] = 0;
            playing[i] = 0;
            this._adobeAnimationEnded(i);
        } else {
            time[i] = nextTime;
        }
    }
}

function _setQueueType(ref, out, type) {
    if (ref.type) ref.type[out] = type;
}

function _type0PersistHit(bufIdx, count, collectorType, collectorIndex) {
    if (!this._persistEntity || this._persistCount[bufIdx] !== count) return false;
    const prevE = this._persistEntity[bufIdx];
    const prevT = this._persistType[bufIdx];
    const prevF = this._persistFrame[bufIdx];
    const prevA = this._persistAnim[bufIdx];
    const dirty = SpriteRenderer.renderDirty;
    const frameIndex = this.entityFrameIndex;
    const animState = SpriteRenderer.animationState;
    let repaired = 0;
    this._persistFramesRepaired = 0;
    for (let i = 0; i < count; i++) {
        const type = collectorType[i];
        const idx = collectorIndex[i];
        if (prevT[i] !== type || prevE[i] !== idx) return false;
        // Adobe (type 6) expands to N queue rows. Persist writes at the
        // collector index, which is not the emit write index once any
        // expanded row is in the list — skip persist for that frame.
        if (type === 6) return false;
        if (type !== 0) continue;
        if (dirty && dirty[idx]) return false;
        if (animState && prevA[i] !== (animState[idx] | 0)) return false;
        // E-98g. The frame moved since this buffer last showed the row: the other buffer's emit or
        // persist frame advanced it. The row gets the current frame's texture; a full emit for
        // that made every frame of an animated scene a full one.
        if (frameIndex && prevF[i] !== (frameIndex[idx] | 0)) {
            if (!this._repairPersistFrame(i, idx)) return false;
            prevF[i] = frameIndex[idx];
            repaired++;
        }
    }
    this._persistFramesRepaired = repaired;
    return true;
}

/**
 * E-98g. Row i of the queue being written gets entity idx's current frame, as the full emit
 * writes it (animStart + frame). False when the full emit must decide: no animation entry, or a
 * frame past the animation's end (the emit resets it).
 */
function _repairPersistFrame(i, idx) {
    const proxyMap = this.proxyToGlobalAnim?.[SpriteRenderer.spritesheetId[idx]];
    const globalAnimIdx = proxyMap?.[SpriteRenderer.animationState[idx]];
    if (globalAnimIdx === undefined) return false;
    const animStart = this.animationFrameStart?.[globalAnimIdx];
    if (animStart === undefined) return false;
    const frame = this.entityFrameIndex[idx];
    if (frame >= (this.animationFrameCount?.[globalAnimIdx] ?? 1)) return false;
    const tex = animStart + frame;
    this.renderQueueTextureId[i] = tex;
    if (this.entityLastTextureId) this.entityLastTextureId[idx] = tex;
    return true;
}

function _rememberType0Set(bufIdx, count, collectorType, collectorIndex) {
    if (!this._persistEntity) return;
    const prevE = this._persistEntity[bufIdx];
    const prevT = this._persistType[bufIdx];
    const prevF = this._persistFrame[bufIdx];
    const prevA = this._persistAnim[bufIdx];
    const dirty = SpriteRenderer.renderDirty;
    const frameIndex = this.entityFrameIndex;
    const animState = SpriteRenderer.animationState;
    let clearedDirty = false;
    for (let i = 0; i < count; i++) {
        const type = collectorType[i];
        const idx = collectorIndex[i];
        prevT[i] = type;
        prevE[i] = idx;
        prevF[i] = frameIndex ? (frameIndex[idx] | 0) : 0;
        prevA[i] = type === 0 && animState ? (animState[idx] | 0) : 0;
        if (type === 0 && dirty && dirty[idx]) {
            dirty[idx] = 0;
            clearedDirty = true;
        }
    }
    this._persistCount[bufIdx] = count;
    // The dirty flag is one per entity, but the queue has two buffers. This buffer
    // just took the change; the other one still holds the old columns, so its next
    // emit must be a full one or it flickers the old tint/alpha/scale at 30 Hz.
    if (clearedDirty) this._persistCount[bufIdx ^ 1] = -1;
}

function _writeQueueShadow(out, entityIndex, ref) {
    const shadowH = (ref && ref.shadowH) || this.renderQueueShadowH;
    if (!shadowH) return;
    const i = entityIndex | 0;
    const scActive = (ref && ref.scActive) || ShadowCaster.active;
    const cast = scActive && scActive[i];
    const scH = (ref && ref.scH) || ShadowCaster.heightMultiplier;
    shadowH[out] = cast ? (scH ? (scH[i] || 0) : 0) : 0;
    const offX = (ref && ref.shadowOffX) || this.renderQueueShadowOffX;
    const offY = (ref && ref.shadowOffY) || this.renderQueueShadowOffY;
    const scOx = (ref && ref.scOx) || ShadowCaster.anchorOffsetX;
    const scOy = (ref && ref.scOy) || ShadowCaster.anchorOffsetY;
    if (offX) offX[out] = cast ? (scOx ? (scOx[i] || 0) : 0) : 0;
    if (offY) offY[out] = cast ? (scOy ? (scOy[i] || 0) : 0) : 0;
}

function _writeType0PosesOnly(count, collectorType, collectorIndex, collectorY, stashPx, stashPy, stashRc, stashRs, deltaTime) {
    const rqX = this.renderQueueX;
    const rqY = this.renderQueueY;
    const rqRotC = this.renderQueueRotC;
    const rqRotS = this.renderQueueRotS;
    const rqSortKey = this.renderQueueSortKey;
    const writeSortKey = !!(rqSortKey && this._queueHasOrder());
    const ySort = writeSortKey && this._entityYSort();
    const inherit = SpriteRenderer.inheritTransformRotation;
    const spriteC = SpriteRenderer.spriteRotC;
    const spriteS = SpriteRenderer.spriteRotS;
    // Animations advance here too, not only in the full emit: a persist frame skips the
    // sprite rows there, so in a scene whose rows held still every animation froze.
    const animated = SpriteRenderer.isAnimated || null;
    PERSIST_DT[0] = deltaTime / 1000;
    let others = 0;
    let moved = 0;
    if (stashPx === rqX) {
        // E-98d. The collect wrote the poses into these columns: only a sprite drawn with its
        // own facing needs its rotation. A copy of the loop below.
        for (let i = 0; i < count; i++) {
            if (collectorType[i] !== 0) {
                others++;
                continue;
            }
            const idx = collectorIndex[i];
            if (inherit && !inherit[idx] && spriteC && spriteS) {
                rqRotC[i] = spriteC[idx];
                rqRotS[i] = spriteS[idx];
            }
            if (writeSortKey) rqSortKey[i] = this._orderKey(0, idx, collectorY[i], ySort);
            this._writeQueueShadow(i, idx);
            if (animated !== null && animated[idx]) moved += this._advancePersistFrame(i, idx);
        }
        this._persistFramesMoved = moved;
        return others;
    }
    for (let i = 0; i < count; i++) {
        if (collectorType[i] !== 0) {
            others++;
            continue;
        }
        const idx = collectorIndex[i];
        rqX[i] = stashPx[i];
        rqY[i] = stashPy[i];
        if (inherit && inherit[idx]) {
            rqRotC[i] = stashRc[i];
            rqRotS[i] = stashRs[i];
        } else if (inherit && spriteC && spriteS) {
            rqRotC[i] = spriteC[idx];
            rqRotS[i] = spriteS[idx];
        }
        if (writeSortKey) rqSortKey[i] = this._orderKey(0, idx, collectorY[i], ySort);
        this._writeQueueShadow(i, idx);
        if (animated !== null && animated[idx]) moved += this._advancePersistFrame(i, idx);
    }
    this._persistFramesMoved = moved;
    return others;
}

/**
 * One animated sprite's clock on a persist frame: the full emit's advance, copied (the emit
 * loop is too hot to share it). When the frame moves, row i gets the new texture.
 * Returns 1 when it did, else 0.
 */
function _advancePersistFrame(i, idx) {
    const animState = SpriteRenderer.animationState[idx];
    const proxyMap = this.proxyToGlobalAnim?.[SpriteRenderer.spritesheetId[idx]];
    const globalAnimIdx = proxyMap?.[animState];
    if (globalAnimIdx === undefined) return 0;
    const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;
    if (animFrameCount <= 1) return 0;
    const frameIndex = this.entityFrameIndex;
    const frameAccum = this.entityFrameAccumulator;
    frameAccum[idx] += PERSIST_DT[0];
    const frameDuration = 1 / (SpriteRenderer.animationSpeed[idx] * 60);
    if (!(frameAccum[idx] >= frameDuration)) return 0; // the full emit's test: a NaN clock never advances (N-65)
    frameAccum[idx] -= frameDuration;
    const currentFrame = frameIndex[idx];
    if (SpriteRenderer.loop[idx] !== 1 && currentFrame >= animFrameCount - 1) {
        // The last frame of a play-once animation finished showing.
        if (this._animEndByType[Transform.entityType[idx]] === 1) {
            this._spriteAnimationEnded(idx, animState);
        }
        return 0;
    }
    frameIndex[idx] = (currentFrame + 1) % animFrameCount;
    const animStart = this.animationFrameStart?.[globalAnimIdx];
    if (animStart === undefined) return 0;
    const tex = animStart + frameIndex[idx];
    this.renderQueueTextureId[i] = tex;
    if (this.entityLastTextureId) this.entityLastTextureId[idx] = tex;
    // This buffer now shows the new frame: its next check needs no repair (E-98g).
    const prevF = this._persistFrame && this._persistFrame[this._queueBuf];
    if (prevF) prevF[i] = frameIndex[idx];
    // Bounds may change (variable frame sizes)
    if (this.frameWidth && this.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH) {
        const sx = Math.abs(SpriteRenderer.scaleX[idx]) || 1; // flip = negative scale
        const sy = Math.abs(SpriteRenderer.scaleY[idx]) || 1;
        SpriteRenderer.boundsHalfW[idx] = ((this.frameWidth[tex] || 0) * sx) * 0.5;
        SpriteRenderer.boundsHalfH[idx] = ((this.frameHeight[tex] || 0) * sy) * 0.5;
    }
    return 1;
}

function _resolveAdobeFrameIndex(entityIndex) {
    const r = this._adobeFrameResult;
    const assetId = AdobeAnimComponent.assetId[entityIndex];
    const clipId = AdobeAnimComponent.clipId[entityIndex];
    const frameCount = AdobeAnimRegistry.getClipFrameCount(assetId, clipId);
    const frameRate = AdobeAnimRegistry.getClipFrameRate(assetId, clipId);

    if (frameCount <= 0 || frameRate <= 0) {
        r.asset = null; r.clipId = 0; r.frameIndex = 0;
        return r;
    }

    const asset = AdobeAnimRegistry.getAsset(assetId);
    if (!asset) {
        r.asset = null; r.clipId = 0; r.frameIndex = 0;
        return r;
    }

    const duration = frameCount / frameRate;
    let time = AdobeAnimComponent.time[entityIndex];
    if (duration > 0) {
        if (AdobeAnimComponent.loop[entityIndex]) {
            time = ((time % duration) + duration) % duration;
        } else if (time >= duration) {
            time = duration;
        } else if (time < 0) {
            time = 0;
        }
    } else {
        time = 0;
    }

    let frameIndex = frameCount > 1 ? (time * frameRate) | 0 : 0;
    if (frameIndex >= frameCount) frameIndex = frameCount - 1;
    if (frameIndex < 0) frameIndex = 0;

    r.asset = asset; r.clipId = clipId; r.frameIndex = frameIndex;
    return r;
}

function _emitAdobePieces(ref, writeIndex, entityIndex, sortKey = 0, stashedPose = null) {
    const resolved = this._resolveAdobeFrameIndex(entityIndex);
    const asset = resolved.asset;
    if (!asset) return writeIndex;

    const clipFrameStart = asset.clipFrameStart;
    const framePieceCount = asset.framePieceCount;
    const framePieceStart = asset.framePieceStart;
    const pieceX = asset.pieceX;
    const pieceY = asset.pieceY;
    const pieceScaleX = asset.pieceScaleX;
    const pieceScaleY = asset.pieceScaleY;
    const pieceRotation = asset.pieceRotation;
    const pieceRotCArr = asset.pieceRotC;
    const pieceRotSArr = asset.pieceRotS;
    const pieceAlpha = asset.pieceAlpha;
    const pieceAnchorX = asset.pieceAnchorX;
    const pieceAnchorY = asset.pieceAnchorY;
    const textureIds = asset.pieceTextureId;
    const clipId = resolved.clipId;
    const clipBoundsMinX = asset.clipBoundsMinX;
    const clipBoundsMinY = asset.clipBoundsMinY;
    const clipBoundsMaxX = asset.clipBoundsMaxX;
    const clipBoundsMaxY = asset.clipBoundsMaxY;
    const assetBoundsMinX = asset.assetBoundsMinX;
    const assetBoundsMinY = asset.assetBoundsMinY;
    const assetBoundsMaxX = asset.assetBoundsMaxX;
    const assetBoundsMaxY = asset.assetBoundsMaxY;

    let rootX, rootY, poseC, poseS;
    if (stashedPose) {
        rootX = stashedPose[0];
        rootY = stashedPose[1];
        poseC = stashedPose[2];
        poseS = stashedPose[3];
    } else {
        const pose = this._displayPoseOut;
        this._displayPose(entityIndex, pose);
        rootX = pose[0];
        rootY = pose[1];
        poseC = pose[2];
        poseS = pose[3];
    }
    // body pose CS × AdobeAnimComponent CS (inline — hot piece loop)
    const ac = AdobeAnimComponent.rotC[entityIndex];
    const as = AdobeAnimComponent.rotS[entityIndex];
    const rootC = poseC * ac - poseS * as;
    const rootS = poseS * ac + poseC * as;
    const rootScaleX = AdobeAnimComponent.scaleX[entityIndex];
    const rootScaleY = AdobeAnimComponent.scaleY[entityIndex];
    const rootAnchorX = AdobeAnimComponent.anchorX[entityIndex];
    const rootAnchorY = AdobeAnimComponent.anchorY[entityIndex];
    const rootAlpha = AdobeAnimComponent.alpha[entityIndex];
    const rootTint = AdobeAnimComponent.tint[entityIndex];

    const frameIndex = resolved.frameIndex;
    const absoluteFrame = (clipFrameStart?.[clipId] ?? 0) + frameIndex;
    const pieceCount = framePieceCount?.[absoluteFrame] ?? 0;
    const start = framePieceStart?.[absoluteFrame] ?? 0;
    const end = start + pieceCount;
    const maxItems = ref.textureId.length;
    const minX = clipBoundsMinX?.[clipId] ?? assetBoundsMinX ?? 0;
    const minY = clipBoundsMinY?.[clipId] ?? assetBoundsMinY ?? 0;
    const maxX = clipBoundsMaxX?.[clipId] ?? assetBoundsMaxX ?? 0;
    const maxY = clipBoundsMaxY?.[clipId] ?? assetBoundsMaxY ?? 0;
    const pivotX = minX + (maxX - minX) * rootAnchorX;
    const pivotY = minY + (maxY - minY) * rootAnchorY;

    // Mirror sign: -1 when exactly one of the parent scales is negative
    // (a reflection). Required because S(-1,1)*R(θ) = R(-θ)*S(-1,1), so a
    // piece's local rotation must be negated under a single-axis flip,
    // otherwise rotated pieces (e.g. tilted hands in a "running" clip)
    // appear mirrored to the wrong side after a horizontal flip.
    const mirrorSign = ((rootScaleX < 0) !== (rootScaleY < 0)) ? -1 : 1;

    let feetSlot = -1;
    let feetY = 0;
    let p = start;
    for (; p < end && writeIndex < maxItems; p++) {
        const localX = (pieceX[p] - pivotX) * rootScaleX;
        const localY = (pieceY[p] - pivotY) * rootScaleY;

        ref.x[writeIndex] = rootX + rootC * localX - rootS * localY;
        ref.y[writeIndex] = rootY + rootS * localX + rootC * localY;
        ref.scaleX[writeIndex] = pieceScaleX[p] * rootScaleX;
        ref.scaleY[writeIndex] = pieceScaleY[p] * rootScaleY;
        // Prebaked piece CS; mirrorSign flips sin under single-axis reflection
        const pc = pieceRotCArr ? pieceRotCArr[p] : Math.cos(pieceRotation[p]);
        const ps = (pieceRotSArr ? pieceRotSArr[p] : Math.sin(pieceRotation[p])) * mirrorSign;
        ref.rotC[writeIndex] = rootC * pc - rootS * ps;
        ref.rotS[writeIndex] = rootS * pc + rootC * ps;
        ref.alpha[writeIndex] = pieceAlpha[p] * rootAlpha;
        ref.tint[writeIndex] = rootTint;
        ref.textureId[writeIndex] = textureIds[p];
        ref.anchorX[writeIndex] = pieceAnchorX[p];
        ref.anchorY[writeIndex] = pieceAnchorY[p];
        this._setQueueType(ref, writeIndex, 6, entityIndex);
        if (ref.tilesDirty) {
            if (ref.repeatX) ref.repeatX[writeIndex] = 0;
            if (ref.repeatY) ref.repeatY[writeIndex] = 0;
            clearTileFields(ref, writeIndex);
        }
        if (ref.sortKey) ref.sortKey[writeIndex] = sortKey;
        if (ref.shadowH) {
            ref.shadowH[writeIndex] = 0;
            if (ref.shadowOffX) ref.shadowOffX[writeIndex] = 0;
            if (ref.shadowOffY) ref.shadowOffY[writeIndex] = 0;
        }
        const pieceWorldY = ref.y[writeIndex];
        if (feetSlot < 0 || pieceWorldY >= feetY) {
            feetY = pieceWorldY;
            feetSlot = writeIndex;
        }
        writeIndex++;
    }

    if (feetSlot >= 0) this._writeQueueShadow(feetSlot, entityIndex, ref);

    if (p < end && !this._adobeRenderQueueOverflowWarned) {
        this._adobeRenderQueueOverflowWarned = true;
        console.warn('[PRE_RENDER] Adobe Animate piece expansion exceeded render queue capacity. Increase renderer.maxVisibleRenderables.');
    }

    return writeIndex;
}

const JS_METHODS = { _setQueueType, _type0PersistHit, _repairPersistFrame, _rememberType0Set, _writeQueueShadow, _writeType0PosesOnly, _advancePersistFrame, _resolveAdobeFrameIndex, _emitAdobePieces };

/** Put the JS emit on a pre-render worker: it emits through it while its _emitWasm is null, through its kernel otherwise. */
export function installEmitJs(worker) {
    const kernelEmit = Object.getPrototypeOf(worker).emitSpriteQueue;
    const kernelAdvance = Object.getPrototypeOf(worker).advanceAdobeAnimations;
    Object.assign(worker, JS_METHODS);
    // The objects the JS reused frame after frame (pre-render's constructor made them).
    worker._adobeFrameResult = { asset: null, clipId: 0, frameIndex: 0 };
    worker._emitRef = {
        x: null, y: null, scaleX: null, scaleY: null,
        rotC: null, rotS: null, alpha: null, tint: null, textureId: null,
        anchorX: null, anchorY: null, type: null,
        repeatX: null, repeatY: null,
        tileMode: null, tileOffsetU: null, tileOffsetV: null,
        tileMulX: null, tileMulY: null,
        // E-102b: whether this queue's tile columns may hold a repeating sprite's values.
        tilesDirty: false,
        // Set by emitSpriteQueue each frame; declared so the first frame does not reshape it (N-32).
        sortKey: null, shadowH: null, shadowOffX: null, shadowOffY: null,
        scActive: null, scH: null, scOx: null, scOy: null,
    };
    worker.emitSpriteQueue = function emitSpriteQueueEither(deltaTime, source) {
        return this._emitWasm === null ? emitSpriteQueue.call(this, deltaTime, source) : kernelEmit.call(this, deltaTime, source);
    };
    worker.advanceAdobeAnimations = function advanceAdobeAnimationsEither(deltaTime) {
        return this._emitWasm === null ? advanceAdobeAnimations.call(this, deltaTime) : kernelAdvance.call(this, deltaTime);
    };
    return worker;
}
