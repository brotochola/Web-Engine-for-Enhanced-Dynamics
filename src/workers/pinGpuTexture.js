/**
 * Point a Pixi TextureSource at an engine-owned GPUTexture (no CPU readback).
 * Pixi 8.20 stores GPU objects on source._gpuData[renderer.uid]
 * (`gpuTexture` + `textureViews` cache).
 */
const RGBA32_BYTES = 16;

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
    const padded = new Float32Array(dstFloats * height);
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

export function pinGpuTexture(renderer, source, gpuTexture) {
  if (!renderer || !source || !gpuTexture) return;
  const uid = renderer.uid;
  if (source._gpuData == null) source._gpuData = [];
  const prev = source._gpuData[uid];
  if (prev && prev.gpuTexture === gpuTexture && prev.textureView) return;
  source.uploadMethodId = 'external';
  const textureView = gpuTexture.createView();
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
  const texSys = renderer.texture;
  if (texSys && texSys._bindGroupHash) {
    texSys._bindGroupHash[source.uid] = null;
  }
  if (renderer.bindGroup?._hash) {
    renderer.bindGroup._hash = Object.create(null);
  }
}
