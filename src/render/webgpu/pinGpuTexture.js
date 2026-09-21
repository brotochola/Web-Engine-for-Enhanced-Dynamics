/**
 * Point a Pixi TextureSource at an engine-owned GPUTexture (no CPU readback).
 * Pixi 8.20 stores GPU objects on source._gpuData[renderer.uid]
 * (`gpuTexture` + `textureViews` cache).
 */
const RGBA32_BYTES = 16;
const RGBA8_BYTES = 4;

let _padBuf = null;
let _padU8 = null;

/** Straight RGBA8 → premultiplied, matching WebGL UNPACK_PREMULTIPLY on ImageBitmap. */
export function copyPremultiplyRgba(dst, src) {
  const n = src.length;
  for (let i = 0; i < n; i += 4) {
    const a = src[i + 3];
    if (a === 255) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = 255;
    } else if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
    } else {
      dst[i] = (src[i] * a * 257 + 32896) >> 16;
      dst[i + 1] = (src[i + 1] * a * 257 + 32896) >> 16;
      dst[i + 2] = (src[i + 2] * a * 257 + 32896) >> 16;
      dst[i + 3] = a;
    }
  }
}

/** WebGPU writeTexture bytesPerRow must be a multiple of 256. */
export function writeRgba32Float(renderer, source, data, width, height, label) {
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
  const unpadded = width * RGBA32_BYTES;
  const bytesPerRow = Math.ceil(unpadded / 256) * 256;
  let upload = data;
  if (bytesPerRow !== unpadded) {
    const srcFloats = width * 4;
    const dstFloats = bytesPerRow / 4;
    const need = dstFloats * height;
    if (!_padBuf || _padBuf.length < need) _padBuf = new Float32Array(need);
    const padded = _padBuf;
    for (let y = 0; y < height; y++) {
      padded.set(data.subarray(y * srcFloats, (y + 1) * srcFloats), y * dstFloats);
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
  const textureView = already ? prev.textureView : gpuTexture.createView();
  if (!already) attachGpuData(source, uid, gpuTexture, textureView);
  // Pixi 8.20 GpuTextureSystem.onSourceResize destroys gpuTexture when
  // source.pixelWidth/Height !== gpuTexture size, then initSource() a 1x1.
  if (sizeMismatch) source.resize(gpuTexture.width, gpuTexture.height, 1);
  const cur = source._gpuData[uid];
  if (!cur || cur.gpuTexture !== gpuTexture) {
    attachGpuData(source, uid, gpuTexture, gpuTexture.createView());
  }
  const texSys = renderer.texture;
  if (texSys && texSys._bindGroupHash) {
    texSys._bindGroupHash[source.uid] = null;
  }
  if (renderer.bindGroup?._hash) {
    renderer.bindGroup._hash = Object.create(null);
  }
}
