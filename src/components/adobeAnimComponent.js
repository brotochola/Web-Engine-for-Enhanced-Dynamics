import { Component } from '../core/component.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';

/** Adobe Animate timeline on an entity (clip playback, SoA pose/tint/layerMask). */
export class AdobeAnimComponent extends Component {
  static _emptyOptions = Object.freeze({});

  static ARRAY_SCHEMA = {
    active: Uint8Array,
    assetId: Uint16Array,
    clipId: Uint16Array,
    time: Float32Array,
    playbackRate: Float32Array,
    loop: Uint8Array,
    playing: Uint8Array,
    scaleX: Float32Array,
    scaleY: Float32Array,
    anchorX: Float32Array,
    anchorY: Float32Array,
    rotC: Float32Array,
    rotS: Float32Array,
    alpha: Float32Array,
    tint: Uint32Array,
    layerMask: Uint16Array,
    renderVisible: Uint8Array,
    isItOnScreen: Uint8Array, // Adobe-specific screen culling - updated by pre_render_worker
    boundsHalfW: Float32Array,
    boundsHalfH: Float32Array,
    screenX: Float32Array,
    screenY: Float32Array,
    // bit 0 flipX, bit 1 flipY (sign of scaleX / scaleY), as on SpriteRenderer.
    flip: Uint8Array,
  };

  static applyClipBounds(entityIndex) {
    const assetId = this.assetId?.[entityIndex] ?? 0;
    const clipId = this.clipId?.[entityIndex] ?? 0;
    const bounds = AdobeAnimRegistry.getClipBounds(assetId, clipId) || AdobeAnimRegistry.getAssetBounds(assetId);
    if (!bounds) {
      this.boundsHalfW[entityIndex] = 0;
      this.boundsHalfH[entityIndex] = 0;
      return;
    }

    const minX = bounds.minX ?? 0;
    const minY = bounds.minY ?? 0;
    const maxX = bounds.maxX ?? 0;
    const maxY = bounds.maxY ?? 0;
    const width = maxX - minX;
    const height = maxY - minY;

    let anchorX = this.anchorX[entityIndex];
    let anchorY = this.anchorY[entityIndex];

    if (!Number.isFinite(anchorX)) {
      anchorX = width !== 0 ? (-minX) / width : 0;
      this.anchorX[entityIndex] = anchorX;
    }
    if (!Number.isFinite(anchorY)) {
      anchorY = height !== 0 ? (-minY) / height : 0;
      this.anchorY[entityIndex] = anchorY;
    }

    const pivotX = minX + width * anchorX;
    const pivotY = minY + height * anchorY;
    this.boundsHalfW[entityIndex] = Math.max(Math.abs(minX - pivotX), Math.abs(maxX - pivotX));
    this.boundsHalfH[entityIndex] = Math.max(Math.abs(minY - pivotY), Math.abs(maxY - pivotY));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // E-537: the clip's methods by entity index (AdobeAnimComponent.play(i, clip, loop) is adobeAnimComponent.play(clip,
  // loop)), for code that holds an index and no instance. A method and its static call the same work (the ...At
  // functions below); the statics return nothing, the reads their number. frameCount and currentFrame make no object.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Entity i plays `clipName` of asset `assetName` (adobeAnimComponent.setAsset): from its start, looping and playing
   * unless the options say otherwise; options also set its rate, scale, anchor, rotation, alpha, tint, layer mask and
   * visibility.
   * @param {number} i
   * @param {string} assetName
   * @param {string|null} [clipName]
   * @param {Object} [options]
   */
  static setAsset(i, assetName, clipName = null, options) {
    setAssetAt(i, assetName, clipName, options);
  }

  /**
   * Entity i plays clip `clipName` of its asset from its start (adobeAnimComponent.play).
   * @param {number} i
   * @param {string} clipName
   * @param {boolean} [loop=true]
   */
  static play(i, clipName, loop = true) {
    playAt(i, clipName, loop);
  }

  /** Entity i's clip shows frame `frameNum` (1-based, clamped) and stops (adobeAnimComponent.gotoAndStop). */
  static gotoAndStop(i, frameNum) {
    gotoFrameAt(i, frameNum, 0);
  }

  /** Entity i's clip plays on from frame `frameNum` (1-based, clamped) (adobeAnimComponent.gotoAndPlay). */
  static gotoAndPlay(i, frameNum) {
    gotoFrameAt(i, frameNum, 1);
  }

  /** Entity i's clip holds its frame (adobeAnimComponent.pause). */
  static pause(i) {
    AdobeAnimComponent.playing[i] = 0;
  }

  /** Entity i's clip plays on (adobeAnimComponent.resume). */
  static resume(i) {
    AdobeAnimComponent.playing[i] = 1;
  }

  /**
   * How many frames entity i's clip has, 0 without one (adobeAnimComponent.frameCount). Makes no object.
   * @param {number} i
   * @returns {number}
   */
  static frameCount(i) {
    return frameCountAt(i);
  }

  /**
   * The frame entity i's clip shows, 1-based, from its time: wrapped when it loops, held at its ends when not; 0 without
   * a clip (adobeAnimComponent.currentFrame). Makes no object.
   * @param {number} i
   * @returns {number}
   */
  static currentFrame(i) {
    return currentFrameAt(i);
  }

  get assetName() {
    return AdobeAnimRegistry.assetNames?.[AdobeAnimComponent.assetId[this.index]] || '';
  }

  get clipName() {
    return AdobeAnimRegistry.getClipName(
      AdobeAnimComponent.assetId[this.index],
      AdobeAnimComponent.clipId[this.index]
    ) || '';
  }

  get frameCount() {
    return frameCountAt(this.index);
  }

  get currentFrame() {
    return currentFrameAt(this.index);
  }

  get anchorX() {
    return AdobeAnimComponent.anchorX[this.index];
  }
  set anchorX(value) {
    AdobeAnimComponent.anchorX[this.index] = value;
    AdobeAnimComponent.applyClipBounds(this.index);
  }

  get anchorY() {
    return AdobeAnimComponent.anchorY[this.index];
  }
  set anchorY(value) {
    AdobeAnimComponent.anchorY[this.index] = value;
    AdobeAnimComponent.applyClipBounds(this.index);
  }

  setAsset(assetName, clipName = null, options) {
    setAssetAt(this.index, assetName, clipName, options);
    return this;
  }

  play(clipName, loop = true) {
    playAt(this.index, clipName, loop);
    return this;
  }

  gotoAndStop(frameNum) {
    gotoFrameAt(this.index, frameNum, 0);
    return this;
  }

  gotoAndPlay(frameNum) {
    gotoFrameAt(this.index, frameNum, 1);
    return this;
  }

  pause() {
    AdobeAnimComponent.playing[this.index] = 0;
    return this;
  }

  resume() {
    AdobeAnimComponent.playing[this.index] = 1;
    return this;
  }

  get rotation() {
    const i = this.index;
    return Math.atan2(AdobeAnimComponent.rotS[i], AdobeAnimComponent.rotC[i]);
  }
  set rotation(v) {
    const i = this.index;
    AdobeAnimComponent.rotC[i] = Math.cos(v);
    AdobeAnimComponent.rotS[i] = Math.sin(v);
  }

  static initializeArrays(buffer, count, byteOffset = 0) {
    super.initializeArrays(buffer, count, byteOffset);
    if (this.rotC) this.rotC.fill(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// E-537: the clip's work by entity index, for the methods and the statics. The clip's frame count and rate are read
// from its asset's columns here, not through functions that return them: a frame rate is a float, which a call TurboFan
// left out would return boxed.
// ═══════════════════════════════════════════════════════════════════════════

/** Entity i's asset, or null. */
function assetAt(i) {
  return AdobeAnimRegistry.getAsset(AdobeAnimComponent.assetId[i]);
}

/** frameCount: entity i's clip's frames, 0 without an asset or a clip. */
function frameCountAt(i) {
  const asset = assetAt(i);
  if (asset === null) return 0;
  const counts = asset.clipFrameCount;
  return counts ? counts[AdobeAnimComponent.clipId[i]] ?? 0 : 0;
}

/** currentFrame: the 1-based frame entity i's clip shows at its time, 0 without a clip. */
function currentFrameAt(i) {
  const asset = assetAt(i);
  if (asset === null) return 0;
  const clipId = AdobeAnimComponent.clipId[i];
  const counts = asset.clipFrameCount;
  const rates = asset.clipFrameRate;
  const frameCount = counts ? counts[clipId] ?? 0 : 0;
  const frameRate = rates ? rates[clipId] ?? 0 : 0;
  if (frameCount <= 0 || frameRate <= 0) return 0;
  const duration = frameCount / frameRate;

  let time = AdobeAnimComponent.time[i];
  if (duration > 0) {
    if (AdobeAnimComponent.loop[i]) {
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
  return frameIndex + 1;
}

/** gotoAndStop (playing 0) and gotoAndPlay (1): the time of frame `frameNum`, clamped to the clip; no clip, no change. */
function gotoFrameAt(i, frameNum, playing) {
  const asset = assetAt(i);
  if (asset === null) return;
  const clipId = AdobeAnimComponent.clipId[i];
  const counts = asset.clipFrameCount;
  const rates = asset.clipFrameRate;
  const frameCount = counts ? counts[clipId] ?? 0 : 0;
  const frameRate = rates ? rates[clipId] ?? 0 : 0;
  if (frameCount <= 0 || frameRate <= 0) return;
  const requestedFrame = Number.isFinite(frameNum) ? Math.floor(frameNum) : 1;
  const clampedFrame = Math.min(frameCount, Math.max(1, requestedFrame));
  AdobeAnimComponent.time[i] = (clampedFrame - 1) / frameRate;
  AdobeAnimComponent.playing[i] = playing;
}

/** play: clip `clipName` of entity i's asset from its start. */
function playAt(i, clipName, loop) {
  const assetId = AdobeAnimComponent.assetId[i];
  AdobeAnimComponent.clipId[i] = AdobeAnimRegistry.getClipId(assetId, clipName);
  AdobeAnimComponent.time[i] = 0;
  AdobeAnimComponent.loop[i] = loop ? 1 : 0;
  AdobeAnimComponent.playing[i] = 1;
  AdobeAnimComponent.applyClipBounds(i);
}

/** setAsset: the asset, its clip from the start, and what the options set (the rest kept, or its default). */
function setAssetAt(i, assetName, clipName, options) {
  const o = options || AdobeAnimComponent._emptyOptions;
  const assetId = AdobeAnimRegistry.getAssetId(assetName);
  AdobeAnimComponent.assetId[i] = assetId;
  AdobeAnimComponent.time[i] = 0;
  AdobeAnimComponent.playbackRate[i] = o.playbackRate ?? 1;
  AdobeAnimComponent.loop[i] = o.loop === false ? 0 : 1;
  AdobeAnimComponent.playing[i] = o.playing === false ? 0 : 1;
  AdobeAnimComponent.scaleX[i] = o.scaleX ?? AdobeAnimComponent.scaleX[i] ?? 1;
  AdobeAnimComponent.scaleY[i] = o.scaleY ?? AdobeAnimComponent.scaleY[i] ?? 1;
  AdobeAnimComponent.anchorX[i] =
    o.anchorX ?? (Number.isFinite(AdobeAnimComponent.anchorX[i]) ? AdobeAnimComponent.anchorX[i] : Number.NaN);
  AdobeAnimComponent.anchorY[i] =
    o.anchorY ?? (Number.isFinite(AdobeAnimComponent.anchorY[i]) ? AdobeAnimComponent.anchorY[i] : Number.NaN);
  {
    const a = o.rotation;
    if (a != null) {
      AdobeAnimComponent.rotC[i] = Math.cos(a);
      AdobeAnimComponent.rotS[i] = Math.sin(a);
    } else if (AdobeAnimComponent.rotC[i] === 0 && AdobeAnimComponent.rotS[i] === 0) {
      AdobeAnimComponent.rotC[i] = 1;
      AdobeAnimComponent.rotS[i] = 0;
    }
  }
  AdobeAnimComponent.alpha[i] = o.alpha ?? AdobeAnimComponent.alpha[i] ?? 1;
  AdobeAnimComponent.tint[i] = o.tint ?? AdobeAnimComponent.tint[i] ?? 0xffffff;
  AdobeAnimComponent.renderVisible[i] = o.visible === false ? 0 : 1;
  AdobeAnimComponent.layerMask[i] = o.layerMask ?? AdobeAnimComponent.layerMask[i] ?? 0;

  AdobeAnimComponent.clipId[i] = clipName ? AdobeAnimRegistry.getClipId(assetId, clipName) : 0;
  AdobeAnimComponent.applyClipBounds(i);
}
