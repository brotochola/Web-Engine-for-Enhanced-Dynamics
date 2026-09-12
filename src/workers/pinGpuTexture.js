/**
 * Point a Pixi TextureSource at an engine-owned GPUTexture (no CPU readback).
 * Pixi 8.20 stores GPU objects on source._gpuData[renderer.uid]
 * (`gpuTexture` + `textureViews` cache).
 */
const RGBA32_BYTES = 16;

let _padBuf = null;

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
