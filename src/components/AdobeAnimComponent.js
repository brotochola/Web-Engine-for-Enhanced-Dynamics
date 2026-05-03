import { Component } from '../core/Component.js';
import { AdobeAnimRegistry } from '../core/AdobeAnimRegistry.js';

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
    rotation: Float32Array,
    alpha: Float32Array,
    tint: Uint32Array,
    layerId: Uint8Array,
    renderVisible: Uint8Array,
    isItOnScreen: Uint8Array, // Adobe-specific screen culling - updated by pre_render_worker
    boundsHalfW: Float32Array,
    boundsHalfH: Float32Array,
    screenX: Float32Array,
    screenY: Float32Array,
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

  get assetName() {
    return AdobeAnimRegistry.assetNames?.[AdobeAnimComponent.assetId[this.index]] || '';
  }

  get clipName() {
    return AdobeAnimRegistry.getClipName(
      AdobeAnimComponent.assetId[this.index],
      AdobeAnimComponent.clipId[this.index]
    ) || '';
  }

  _getClipTiming() {
    const assetId = AdobeAnimComponent.assetId[this.index];
    const clipId = AdobeAnimComponent.clipId[this.index];
    const frameCount = AdobeAnimRegistry.getClipFrameCount(assetId, clipId);
    const frameRate = AdobeAnimRegistry.getClipFrameRate(assetId, clipId);

    return {
      assetId,
      clipId,
      frameCount,
      frameRate,
      duration: frameCount > 0 && frameRate > 0 ? frameCount / frameRate : 0,
    };
  }

  _resolveFrameTime(frameNum) {
    const clip = this._getClipTiming();
    if (clip.frameCount <= 0 || clip.frameRate <= 0) return null;

    const requestedFrame = Number.isFinite(frameNum) ? Math.floor(frameNum) : 1;
    const clampedFrame = Math.min(clip.frameCount, Math.max(1, requestedFrame));
    const frameIndex = clampedFrame - 1;

    return {
      ...clip,
      frameIndex,
      currentFrame: clampedFrame,
      time: frameIndex / clip.frameRate,
    };
  }

  get frameCount() {
    return this._getClipTiming().frameCount;
  }

  get currentFrame() {
    const clip = this._getClipTiming();
    if (clip.frameCount <= 0 || clip.frameRate <= 0) return 0;

    let time = AdobeAnimComponent.time[this.index];
    if (clip.duration > 0) {
      if (AdobeAnimComponent.loop[this.index]) {
        time = ((time % clip.duration) + clip.duration) % clip.duration;
      } else if (time >= clip.duration) {
        time = clip.duration;
      } else if (time < 0) {
        time = 0;
      }
    } else {
      time = 0;
    }

    let frameIndex = clip.frameCount > 1 ? (time * clip.frameRate) | 0 : 0;
    if (frameIndex >= clip.frameCount) frameIndex = clip.frameCount - 1;
    if (frameIndex < 0) frameIndex = 0;
    return frameIndex + 1;
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
    const o = options || AdobeAnimComponent._emptyOptions;
    const i = this.index;
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
    AdobeAnimComponent.rotation[i] = o.rotation ?? AdobeAnimComponent.rotation[i] ?? 0;
    AdobeAnimComponent.alpha[i] = o.alpha ?? AdobeAnimComponent.alpha[i] ?? 1;
    AdobeAnimComponent.tint[i] = o.tint ?? AdobeAnimComponent.tint[i] ?? 0xffffff;
    AdobeAnimComponent.renderVisible[i] = o.visible === false ? 0 : 1;
    AdobeAnimComponent.layerId[i] = o.layerId ?? AdobeAnimComponent.layerId[i] ?? 0;

    AdobeAnimComponent.clipId[i] = clipName ? AdobeAnimRegistry.getClipId(assetId, clipName) : 0;
    AdobeAnimComponent.applyClipBounds(i);
    return this;
  }

  play(clipName, loop = true) {

    const assetId = AdobeAnimComponent.assetId[this.index];
    AdobeAnimComponent.clipId[this.index] = AdobeAnimRegistry.getClipId(assetId, clipName);
    AdobeAnimComponent.time[this.index] = 0;
    AdobeAnimComponent.loop[this.index] = loop ? 1 : 0;
    AdobeAnimComponent.playing[this.index] = 1;
    AdobeAnimComponent.applyClipBounds(this.index);
    return this;
  }

  gotoAndStop(frameNum) {
    const resolvedFrame = this._resolveFrameTime(frameNum);
    if (!resolvedFrame) return this;

    AdobeAnimComponent.time[this.index] = resolvedFrame.time;
    AdobeAnimComponent.playing[this.index] = 0;
    return this;
  }

  gotoAndPlay(frameNum) {
    const resolvedFrame = this._resolveFrameTime(frameNum);
    if (!resolvedFrame) return this;

    AdobeAnimComponent.time[this.index] = resolvedFrame.time;
    AdobeAnimComponent.playing[this.index] = 1;
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
}
