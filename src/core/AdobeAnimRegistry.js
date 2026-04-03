export class AdobeAnimRegistry {
  static assets = new Map();
  static assetNames = [''];
  static assetNameToId = new Map([['', 0]]);

  static clearForSceneUnload() {
    this.assets.clear();
    this.assetNames = [''];
    this.assetNameToId.clear();
    this.assetNameToId.set('', 0);
  }

  static register(name, asset) {
    if (!name || !asset) return 0;

    let assetId = this.assetNameToId.get(name);
    if (assetId == null) {
      assetId = this.assetNames.length;
      this.assetNames[assetId] = name;
      this.assetNameToId.set(name, assetId);
    }

    asset.id = assetId;
    asset.name = name;
    this.assets.set(name, asset);
    return assetId;
  }

  static getAssetId(name) {
    return this.assetNameToId.get(name) ?? 0;
  }

  static getAsset(assetOrId) {
    if (typeof assetOrId === 'string') {
      return this.assets.get(assetOrId) || null;
    }
    const name = this.assetNames[assetOrId] || '';
    return name ? this.assets.get(name) || null : null;
  }

  static getClipId(assetOrId, clipName) {
    const asset = this.getAsset(assetOrId);
    if (!asset || !clipName) return 0;
    return asset.clipNameToId?.[clipName] ?? 0;
  }

  static getClipName(assetOrId, clipId) {
    const asset = this.getAsset(assetOrId);
    return asset?.clipNames?.[clipId] ?? null;
  }

  static getClipFrameCount(assetOrId, clipId) {
    const asset = this.getAsset(assetOrId);
    return asset?.clipFrameCount?.[clipId] ?? 0;
  }

  static getClipFrameRate(assetOrId, clipId) {
    const asset = this.getAsset(assetOrId);
    return asset?.clipFrameRate?.[clipId] ?? 0;
  }

  static getClipBounds(assetOrId, clipId) {
    const asset = this.getAsset(assetOrId);
    if (!asset) return null;
    return {
      minX: asset.clipBoundsMinX?.[clipId] ?? 0,
      minY: asset.clipBoundsMinY?.[clipId] ?? 0,
      maxX: asset.clipBoundsMaxX?.[clipId] ?? 0,
      maxY: asset.clipBoundsMaxY?.[clipId] ?? 0,
      halfW: asset.clipBoundsHalfW?.[clipId] ?? 0,
      halfH: asset.clipBoundsHalfH?.[clipId] ?? 0,
    };
  }

  static serialize() {
    const serializedAssets = {};
    for (const [name, asset] of this.assets) {
      serializedAssets[name] = {
        id: asset.id,
        name: asset.name,
        clipNames: asset.clipNames,
        clipNameToId: asset.clipNameToId,
        clipFrameStart: asset.clipFrameStart,
        clipFrameCount: asset.clipFrameCount,
        clipFrameRate: asset.clipFrameRate,
        clipBoundsMinX: asset.clipBoundsMinX,
        clipBoundsMinY: asset.clipBoundsMinY,
        clipBoundsMaxX: asset.clipBoundsMaxX,
        clipBoundsMaxY: asset.clipBoundsMaxY,
        clipBoundsHalfW: asset.clipBoundsHalfW,
        clipBoundsHalfH: asset.clipBoundsHalfH,
        framePieceStart: asset.framePieceStart,
        framePieceCount: asset.framePieceCount,
        pieceTextureId: asset.pieceTextureId,
        pieceX: asset.pieceX,
        pieceY: asset.pieceY,
        pieceRotation: asset.pieceRotation,
        pieceScaleX: asset.pieceScaleX,
        pieceScaleY: asset.pieceScaleY,
        pieceAlpha: asset.pieceAlpha,
        pieceAnchorX: asset.pieceAnchorX,
        pieceAnchorY: asset.pieceAnchorY,
        pieceInnerZ: asset.pieceInnerZ,
      };
    }

    return {
      assetNames: this.assetNames,
      assets: serializedAssets,
    };
  }

  static deserialize(serialized) {
    this.clearForSceneUnload();
    if (!serialized) return;

    const assetNames = serialized.assetNames || [''];
    this.assetNames = assetNames.slice();
    for (let i = 0; i < this.assetNames.length; i++) {
      this.assetNameToId.set(this.assetNames[i], i);
    }

    const assets = serialized.assets || {};
    for (const [name, asset] of Object.entries(assets)) {
      this.assets.set(name, asset);
    }
  }
}
