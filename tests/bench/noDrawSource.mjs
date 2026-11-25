/**
 * The end of the renderer worker's module in a --no-draw run (runIntegratedWorkerBenchmark.mjs): every call that makes pixels
 * does nothing, on WebGL and on WebGPU. A machine without a GPU then times the workers, Pixi's uploads and state calls among
 * them, and not a software rasterizer on the same cores. Chromium's --disable-gl-drawing-for-tests is not enough: with it
 * SwiftShader still drew on Linux (bunnyMark drew four times the frames in a canvas of a sixteenth of the pixels).
 */
export const NO_DRAW_SOURCE = `{
  const none = () => {};
  const off = (proto, names) => {
    for (const name of names) if (proto && name in proto) Object.defineProperty(proto, name, { value: none, configurable: true, writable: true });
  };
  const gl = globalThis.WebGL2RenderingContext?.prototype;
  off(gl, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv',
    'clearBufferfi', 'clearBufferiv', 'clearBufferuiv', 'blitFramebuffer', 'generateMipmap']);
  if (gl) {
    const getExtension = gl.getExtension;
    gl.getExtension = function (name) {
      const ext = getExtension.call(this, name);
      if (ext && /draw/i.test(name)) {
        for (const key in ext) if (typeof ext[key] === 'function' && /^(multi)?draw/i.test(key)) ext[key] = none;
      }
      return ext;
    };
  }
  off(globalThis.GPURenderPassEncoder?.prototype, ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']);
  off(globalThis.GPURenderBundleEncoder?.prototype, ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']);
  off(globalThis.GPUComputePassEncoder?.prototype, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);
}`;
