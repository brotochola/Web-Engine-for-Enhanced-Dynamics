// Instance ranges for Pixi meshes: a Geometry with `weedFirstInstance > 0` draws instances
// [weedFirstInstance, weedFirstInstance + instanceCount) instead of starting at 0. Pixi's mesh pipe never passes a
// first instance, so this hooks the last call of each backend once per renderer:
// - WebGPU: the encoder's draw() already takes `firstInstance` (drawIndexed's last argument); the hook sets it.
// - WebGL2: core has no base instance and Pixi bakes each attribute's offset into its VAO. With
//   WEBGL_draw_instanced_base_vertex_base_instance the draw takes the base instance; otherwise the instance
//   attributes are pointed `first * stride` further for the draw, and back after it, so the VAO Pixi cached is
//   left as Pixi made it.
// GPU particle layers draw ring slices with it (gpuParticleBatch.js), and the y-sort painter's proxies draw the
// entities batch in chunks (gpuParticleProxies.js).

/** Components and GL type of the float formats instance attributes use. */
const FLOAT_FORMATS = Object.freeze({ float32: 1, float32x2: 2, float32x3: 3, float32x4: 4 });

/**
 * Hook `renderer` once. Returns how ranges are drawn: 'firstInstance' (WebGPU), 'baseInstance' (the WebGL
 * extension) or 'repoint' (the WebGL fallback); null when the renderer has neither hook point.
 * @param {object} renderer a Pixi renderer
 * @param {boolean} useWebGpu
 * @returns {string|null}
 */
export function installInstanceRangeDraw(renderer, useWebGpu) {
  if (!renderer) return null;
  if (renderer.__weedInstanceRange) return renderer.__weedInstanceRange;
  if (useWebGpu) {
    const encoder = renderer.encoder;
    if (!encoder || typeof encoder.draw !== 'function') return null;
    const draw = encoder.draw.bind(encoder);
    encoder.draw = (options) => {
      const geometry = options?.geometry;
      const first = geometry ? geometry.weedFirstInstance | 0 : 0;
      if (first <= 0) return draw(options);
      const before = options.firstInstance;
      options.firstInstance = first;
      try {
        return draw(options);
      } finally {
        options.firstInstance = before;
      }
    };
    renderer.__weedInstanceRange = 'firstInstance';
    return renderer.__weedInstanceRange;
  }
  const geometrySystem = renderer.geometry;
  const gl = renderer.gl;
  if (!geometrySystem || !gl || typeof geometrySystem.draw !== 'function' || typeof geometrySystem.bind !== 'function') {
    return null;
  }
  const bufferSystem = renderer.buffer;
  const ext = gl.getExtension('WEBGL_draw_instanced_base_vertex_base_instance');
  let program = null;
  const bind = geometrySystem.bind.bind(geometrySystem);
  geometrySystem.bind = (geometry, glProgram) => {
    program = glProgram;
    return bind(geometry, glProgram);
  };
  const draw = geometrySystem.draw.bind(geometrySystem);
  const MODES = { 'point-list': gl.POINTS, 'line-list': gl.LINES, 'line-strip': gl.LINE_STRIP, 'triangle-list': gl.TRIANGLES, 'triangle-strip': gl.TRIANGLE_STRIP };
  const point = (geometry, first) => {
    let ok = true;
    for (const name in geometry.attributes) {
      const attribute = geometry.attributes[name];
      if (!attribute.instance) continue;
      const data = program?._attributeData?.[name];
      if (!data || data.location < 0) continue;
      const size = FLOAT_FORMATS[attribute.format];
      if (!size) {
        ok = false;
        continue;
      }
      const glBuffer = bufferSystem.getGlBuffer(attribute.buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer.buffer);
      gl.vertexAttribPointer(data.location, size, gl.FLOAT, false, attribute.stride, (attribute.offset | 0) + first * attribute.stride);
    }
    return ok;
  };
  geometrySystem.draw = (topology, size, start, instanceCount) => {
    const geometry = geometrySystem._activeGeometry;
    const first = geometry ? geometry.weedFirstInstance | 0 : 0;
    if (first <= 0 || !geometry.indexBuffer) return draw(topology, size, start, instanceCount);
    const count = instanceCount ?? geometry.instanceCount;
    const mode = MODES[topology || geometry.topology] ?? gl.TRIANGLES;
    const bytes = geometry.indexBuffer.data.BYTES_PER_ELEMENT;
    const type = bytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    const n = size || geometry.indexBuffer.data.length;
    const offset = (start || 0) * bytes;
    if (ext) {
      ext.drawElementsInstancedBaseVertexBaseInstanceWEBGL(mode, n, type, offset, count, 0, first);
      return geometrySystem;
    }
    if (point(geometry, first)) gl.drawElementsInstanced(mode, n, type, offset, count);
    point(geometry, 0);
    return geometrySystem;
  };
  renderer.__weedInstanceRange = ext ? 'baseInstance' : 'repoint';
  return renderer.__weedInstanceRange;
}
