/**
 * N-256 PW-3: module helpers of the renderer's layers, moved out of pixiWorker.js as they were, for the worker and its
 * custom layers (src/render/pixi/customLayers.js): a layer's visibility from the shared flags, and the engine's
 * uniforms written into a look's or a compute layer's declared ones.
 */
import { Layer } from '../../core/layer.js';

export function finiteOrZero(n) {
  return Number.isFinite(n) ? n : 0;
}

export function layerIsVisible(id) {
  if (id == null || id < 0) return true;
  if (!Layer._visible) return true;
  const i = id | 0;
  if (Layer._visibleDirty) Atomics.load(Layer._visibleDirty, i);
  return Layer._visible[i] !== 0;
}

export function setLookUniform1(map, floats, store, name, value) {
  const e = map[name];
  if (!e || e.size !== 1) return;
  if (floats) floats[e.offset] = value;
  if (store) store[name] = value;
}

export function setLookUniform2(map, floats, store, name, x, y) {
  const e = map[name];
  if (!e || e.size < 2) return;
  if (floats) {
    floats[e.offset] = x;
    floats[e.offset + 1] = y;
  }
  if (!store) return;
  const target = store[name];
  if (target) {
    target[0] = x;
    target[1] = y;
  }
}

/** Engine Frame into declared look uniforms. Overwrites reserved names every frame. */
export function applyEngineLookUniforms(cl, frame) {
  const map = Layer._uniformMaps[cl.layerId];
  if (!map) return;
  const floats = Layer._uniformFloats[cl.layerId];
  const store = cl.uniformStore;
  const zoom = frame.zoom > 0 ? frame.zoom : 1;
  setLookUniform1(map, floats, store, 'uTime', frame.time);
  setLookUniform1(map, floats, store, 'uDt', frame.dt);
  setLookUniform1(map, floats, store, 'uZoom', zoom);
  setLookUniform2(map, floats, store, 'uCameraPos', frame.cameraX, frame.cameraY);
  setLookUniform2(map, floats, store, 'uCanvasSize', frame.canvasW, frame.canvasH);
  setLookUniform2(map, floats, store, 'uWorldSize', frame.worldW, frame.worldH);
  setLookUniform2(map, floats, store, 'uViewSize', frame.canvasW / zoom, frame.canvasH / zoom);
}

export function applyComputeTexSizeUniform(cl) {
  const map = Layer._uniformMaps[cl.layerId];
  if (!map || !cl.compute) return;
  setLookUniform2(
    map,
    Layer._uniformFloats[cl.layerId],
    cl.uniformStore,
    'uTexSize',
    cl.compute.numX,
    cl.compute.numY
  );
}
