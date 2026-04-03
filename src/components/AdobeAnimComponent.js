import { Component } from '../core/Component.js';
import { AdobeAnimRegistry } from '../core/AdobeAnimRegistry.js';

export class AdobeAnimComponent extends Component {
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
    rotation: Float32Array,
    alpha: Float32Array,
    tint: Uint32Array,
    layerId: Uint8Array,
    renderVisible: Uint8Array,
    isItOnScreen: Uint8Array,
    boundsHalfW: Float32Array,
    boundsHalfH: Float32Array,
    screenX: Float32Array,
    screenY: Float32Array,
  };

  static applyClipBounds(entityIndex) {
    const assetId = this.assetId?.[entityIndex] ?? 0;
    const clipId = this.clipId?.[entityIndex] ?? 0;
    const bounds = AdobeAnimRegistry.getClipBounds(assetId, clipId);
    this.boundsHalfW[entityIndex] = bounds?.halfW ?? 0;
    this.boundsHalfH[entityIndex] = bounds?.halfH ?? 0;
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

  setAsset(assetName, clipName = null, options = {}) {
    const assetId = AdobeAnimRegistry.getAssetId(assetName);
    AdobeAnimComponent.assetId[this.index] = assetId;
    AdobeAnimComponent.time[this.index] = 0;
    AdobeAnimComponent.playbackRate[this.index] = options.playbackRate ?? 1;
    AdobeAnimComponent.loop[this.index] = options.loop === false ? 0 : 1;
    AdobeAnimComponent.playing[this.index] = options.playing === false ? 0 : 1;
    AdobeAnimComponent.scaleX[this.index] = options.scaleX ?? AdobeAnimComponent.scaleX[this.index] ?? 1;
    AdobeAnimComponent.scaleY[this.index] = options.scaleY ?? AdobeAnimComponent.scaleY[this.index] ?? 1;
    AdobeAnimComponent.rotation[this.index] = options.rotation ?? AdobeAnimComponent.rotation[this.index] ?? 0;
    AdobeAnimComponent.alpha[this.index] = options.alpha ?? AdobeAnimComponent.alpha[this.index] ?? 1;
    AdobeAnimComponent.tint[this.index] = options.tint ?? AdobeAnimComponent.tint[this.index] ?? 0xffffff;
    AdobeAnimComponent.renderVisible[this.index] = options.visible === false ? 0 : 1;
    AdobeAnimComponent.layerId[this.index] = options.layerId ?? AdobeAnimComponent.layerId[this.index] ?? 0;

    let nextClipId = 0;
    if (clipName) {
      nextClipId = AdobeAnimRegistry.getClipId(assetId, clipName);
    }
    AdobeAnimComponent.clipId[this.index] = nextClipId;
    AdobeAnimComponent.applyClipBounds(this.index);
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

  pause() {
    AdobeAnimComponent.playing[this.index] = 0;
    return this;
  }

  resume() {
    AdobeAnimComponent.playing[this.index] = 1;
    return this;
  }
}
