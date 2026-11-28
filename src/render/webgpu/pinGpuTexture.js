/**
 * Point a Pixi TextureSource at an engine-owned GPUTexture (no CPU readback).
 * Pixi 8 stores GPU objects on source._gpuData[renderer.uid]
 * (`gpuTexture` + `textureViews` cache).
 */
const RGBA32_BYTES = 16;
const RGBA8_BYTES = 4;

let _padBuf = null;
let _padU8 = null;
/** The bind group cache ids pinGpuTexture gives Pixi's BindGroupSystem: negative, Pixi's own count from 1 up. */
let _pinCacheId = 0;

/**
 * WebGPU writeTexture of rgba32float, bytesPerRow padded to 256; E-511: `columns` under `width` writes only each row's first
 * texels; OL-4: `rows` under `height` only the first rows.
 */
export function writeRgba32Float(renderer, source, data, width, height, label, columns = width, rows = height) {
  const device = renderer?.gpu?.device;
  if (!device || !source || !data || width < 1 || height < 1) return;
  const uid = renderer.uid;
  let gpuTex = source._gpuData?.[uid]?.gpuTexture;
  if (!gpuTex || gpuTex.width !== width || gpuTex.height !== height) {
    gpuTex = device.createTexture({
      label: label || 'rgba32float',
      size: { width, height },
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    pinGpuTexture(renderer, source, gpuTex);
  }
  if (columns < width || rows < height) {
    // E-511: only each row's first `columns` texels changed: queue.writeTexture takes the rows as they lie, any bytesPerRow.
    const cols = columns < width ? (columns > 0 ? columns | 0 : 0) : width;
    const high = rows < height ? (rows > 0 ? rows | 0 : 0) : height;
    if (cols > 0 && high > 0) {
      device.queue.writeTexture({ texture: gpuTex }, data, { bytesPerRow: width * RGBA32_BYTES, rowsPerImage: height }, { width: cols, height: high });
    }
    return;
  }
  const unpadded = width * RGBA32_BYTES;
  const bytesPerRow = Math.ceil(unpadded / 256) * 256;
  let upload = data;
  if (bytesPerRow !== unpadded) {
    const srcFloats = width * 4;
    const dstFloats = bytesPerRow / 4;
    const need = dstFloats * height;
    if (!_padBuf || _padBuf.length < need) _padBuf = new Float32Array(need);
    const padded = _padBuf;
    // N-152: a plain copy; data.subarray made a view object per row every frame.
    for (let y = 0; y < height; y++) {
      const from = y * srcFloats;
      const to = y * dstFloats;
      for (let f = 0; f < srcFloats; f++) padded[to + f] = data[from + f];
    }
    upload = padded;
  }
  device.queue.writeTexture(
    { texture: gpuTex },
    upload,
    { bytesPerRow, rowsPerImage: height },
    { width, height }
  );
}

/** WebGPU writeTexture of rgba8unorm. bytesPerRow padded to 256. */
export function writeRgba8(renderer, source, data, width, height, label) {
  const device = renderer?.gpu?.device;
  if (!device || !source || !data || width < 1 || height < 1) return;
  const uid = renderer.uid;
  let gpuTex = source._gpuData?.[uid]?.gpuTexture;
  if (!gpuTex || gpuTex.width !== width || gpuTex.height !== height) {
    gpuTex = device.createTexture({
      label: label || 'rgba8unorm',
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    pinGpuTexture(renderer, source, gpuTex);
  }
  const unpadded = width * RGBA8_BYTES;
  const bytesPerRow = Math.ceil(unpadded / 256) * 256;
  let upload = data;
  if (bytesPerRow !== unpadded) {
    const need = bytesPerRow * height;
    if (!_padU8 || _padU8.length < need) _padU8 = new Uint8Array(need);
    const padded = _padU8;
    for (let y = 0; y < height; y++) {
      padded.set(data.subarray(y * unpadded, (y + 1) * unpadded), y * bytesPerRow);
    }
    upload = padded.subarray(0, need);
  }
  device.queue.writeTexture(
    { texture: gpuTex },
    upload,
    { bytesPerRow, rowsPerImage: height },
    { width, height }
  );
}

/**
 * E-552: the array texture behind a '2d-array' source: `layers` of `px` x `px` rgba8unorm texels (src/render/pixi/decalTiles.js).
 */
export function createDecalArrayTexture(renderer, source, px, layers) {
  const device = renderer?.gpu?.device;
  if (!device || !source || px < 1 || layers < 1) return;
  const gpuTex = device.createTexture({
    label: 'weed-decal-tiles',
    size: { width: px, height: px, depthOrArrayLayers: layers },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  pinGpuTexture(renderer, source, gpuTex);
}

/** E-552, E-270: `data` (px x px rgba8unorm a layer) into `layers` layers from `layer` on of the source's array texture. */
export function writeRgba8Layers(renderer, source, data, px, layer, layers) {
  const device = renderer?.gpu?.device;
  const gpuTex = source?._gpuData?.[renderer?.uid]?.gpuTexture;
  if (!device || !gpuTex || !data || px < 1) return;
  device.queue.writeTexture(
    { texture: gpuTex, origin: { x: 0, y: 0, z: layer } },
    data,
    { bytesPerRow: px * RGBA8_BYTES, rowsPerImage: px },
    { width: px, height: px, depthOrArrayLayers: layers }
  );
}

function attachGpuData(source, uid, gpuTexture, textureView) {
  source._gpuData[uid] = {
    gpuTexture,
    textureView,
    textureViews: { 0: textureView },
    destroy() {
      this.gpuTexture = null;
      this.textureView = null;
      this.textureViews = null;
    },
  };
}

export function pinGpuTexture(renderer, source, gpuTexture) {
  if (!renderer || !source || !gpuTexture) return;
  const uid = renderer.uid;
  if (source._gpuData == null) source._gpuData = [];
  source.uploadMethodId = 'external';
  source.autoGarbageCollect = false;
  const prev = source._gpuData[uid];
  const already = prev && prev.gpuTexture === gpuTexture && prev.textureView;
  const sizeMismatch =
    source.pixelWidth !== gpuTexture.width || source.pixelHeight !== gpuTexture.height;
  if (already && !sizeMismatch) return;
  const textureView = already ? prev.textureView : gpuTexture.createView({ dimension: source.viewDimension || '2d' });
  if (!already) attachGpuData(source, uid, gpuTexture, textureView);
  // Pixi 8.20 GpuTextureSystem.onSourceResize destroys gpuTexture when
  // source.pixelWidth/Height !== gpuTexture size, then initSource() a 1x1.
  if (sizeMismatch) source.resize(gpuTexture.width, gpuTexture.height, 1);
  const cur = source._gpuData[uid];
  if (!cur || cur.gpuTexture !== gpuTexture) {
    attachGpuData(source, uid, gpuTexture, gpuTexture.createView({ dimension: source.viewDimension || '2d' }));
  }
  const texSys = renderer.texture;
  if (texSys && texSys._bindGroupHash) {
    texSys._bindGroupHash[source.uid] = null;
  }
  // The GPU bind groups made with the source's old view, found by keys that did not change (the source's resource id
  // moves only on a resize): Pixi 8.23 keeps them in the hash and on each BindGroup (_gpuEntry), valid while the entry's
  // cache id is the system's. A new cache id makes every group look its bind group up again, in the emptied hash.
  const bindGroups = renderer.bindGroup;
  if (bindGroups?._hash) {
    bindGroups._hash = Object.create(null);
    bindGroups._cacheId = --_pinCacheId;
  }
}
