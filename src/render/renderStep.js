/**
 * Steps among a container's children that Pixi's custom render pipe runs where they stand, as a RenderContainer is (the
 * bundle exports ViewContainer, not RenderContainer): a stencil mode and colour mask for the meshes after it, a colour
 * mask alone, a copy on the GPU before a mesh. N-303 CR-18: one class for what were four.
 */
import { ViewContainer } from '../vendor/pixi.min.js';

/** Pixi's STENCIL_MODES (the bundle does not export them): off, a mask drawn (equal to the reference, +1), a mask in use, outside it. */
export const STENCIL_OFF = 0;
export const STENCIL_MASK_ADD = 1;
export const STENCIL_MASK_ACTIVE = 2;
export const STENCIL_INVERSE_ACTIVE = 3;

/** A step that runs `run(renderer)` where it stands; it has no bounds and is never culled or batched. */
export class RenderStep extends ViewContainer {
  /**
   * @param {string} label
   * @param {(renderer: object) => void} run
   */
  constructor(label, run) {
    super({ label });
    this.renderPipeId = 'customRender';
    this.batched = false;
    this.cullable = false;
    this._run = run;
  }

  updateBounds() {
    this._bounds.clear();
  }

  render(renderer) {
    this._run(renderer);
  }
}

/**
 * The stencil mode, its reference and the colour mask for the meshes after it. `ensureStencil`: a mask drawn first makes
 * sure the target has a stencil (the unshaded pass's targets may not).
 * @returns {RenderStep}
 */
export function stencilStep(label, mode, reference, colorMask, ensureStencil = false) {
  return new RenderStep(label, (renderer) => {
    if (ensureStencil && mode === STENCIL_MASK_ADD) renderer.renderTarget.ensureDepthStencil();
    renderer.stencil.setStencilMode(mode, reference);
    renderer.colorMask.setMask(colorMask);
  });
}

/** The colour mask for the meshes after it (Pixi's number: WebGL red 8 ... alpha 1, WebGPU red 1 ... alpha 8). */
export function colorMaskStep(mask) {
  return new RenderStep('weed-colour-mask', (renderer) => renderer.colorMask.setMask(mask));
}
