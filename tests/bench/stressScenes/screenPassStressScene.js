/**
 * DX-POST: full-screen passes over the Bunny Mark C render screen. `?post=<n>` adds n LAYER_KIND.SCREEN layers (a
 * vignette; `?amount=0` makes each a copy), 0 by default: post=0 is BunnyMarkStressCScene itself, the row that shows
 * a scene without SCREEN layers costs nothing. `?backend=webgl|webgpu` (default webgl), `?bunnies=<n>` as in
 * BunnyMarkStressCScene. `?last=scene` makes the last pass return uScene (the frame before the first pass), for
 * screenIdentityCheck.mjs. Primary: pixi STEP_MS − WAIT_MS. Load: logic0 MARK_ACTIVE.
 */
import WEED from '/src/index.js';
import { BunnyMarkStressCScene } from './bunnyMarkStressScene.js';

const { LAYER_KIND } = WEED;

function param(name) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(name);
  } catch {
    return null;
  }
}

export const POST_PASSES = Math.max(0, Math.min(8, parseInt(param('post') || '0', 10) || 0));
const AMOUNT = Number.isFinite(parseFloat(param('amount'))) ? parseFloat(param('amount')) : 0.6;
const BACKEND = param('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const LAST_SCENE = param('last') === 'scene';
const shader = (file) => new URL(`./screenPass/${file}`, import.meta.url).href;

function passLayers(n) {
  const layers = {};
  for (let i = 0; i < n; i++) {
    layers[`post${i}`] = {
      // LAYER_KIND.SCREEN from DX-POST on; before it the kind is unknown and n must stay 0.
      kind: LAYER_KIND.SCREEN ?? 'screen',
      zIndex: 1000 + i,
      shader: {
        fragment: LAST_SCENE && i === n - 1 ? 'screenPassSceneCopy' : 'screenPassVignette',
        uniforms: { uAmount: { value: AMOUNT, type: 'f32' } },
      },
    };
  }
  return layers;
}

export class ScreenPassStressScene extends BunnyMarkStressCScene {
  static config = {
    ...BunnyMarkStressCScene.config,
    renderer: { ...BunnyMarkStressCScene.config.renderer, backend: BACKEND },
    layers: { ...(BunnyMarkStressCScene.config.layers || {}), ...passLayers(POST_PASSES) },
  };
  static assets = {
    ...BunnyMarkStressCScene.assets,
    shaders: {
      screenPassVignette: { webgl: shader('vignette.frag'), webgpu: shader('vignette.wgsl') },
      screenPassSceneCopy: { webgl: shader('sceneCopy.frag'), webgpu: shader('sceneCopy.wgsl') },
    },
  };
}
