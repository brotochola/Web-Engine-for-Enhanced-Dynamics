// Production build: no render views (see ../../../render/renderViews.js, DBG-5). Same exports: the Pixi worker keeps the
// final picture (no view has a buffer here), and no decode shader ships.
export const RENDER_VIEW = Object.freeze({
  FINAL: 0,
  NORMALS: 1,
  HEIGHT: 2,
  IDS: 3,
  FLAGS: 4,
  LIGHT: 5,
  UNSHADED: 6,
  SHADOWS: 7,
  SUN_MAP: 8,
  LAMP_MAP: 9,
});
export const RENDER_VIEWS = Object.freeze([{ id: 0, label: 'Final', needs: '' }]);
export const RENDER_VIEW_Z = 1e9;
export const RENDER_VIEW_HEIGHT_PX = 256;
export const RENDER_VIEW_VERT = '';
export const RENDER_VIEW_FRAG = '';
export const RENDER_VIEW_WGSL = '';
export function renderViewTextures(_w, _view, out) {
  out[0] = null;
  out[1] = null;
  return out;
}
export function availableRenderViews() {
  return [0];
}
export function renderViewGpuProgram() {
  return null;
}
