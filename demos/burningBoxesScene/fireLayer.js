// fireLayer.js – burningBoxesScene's fire, as a layer other scenes can use too (the landing page sets bricks on fire).
//
// A WebGPU compute fluid over a world-fixed lattice: the compute texture covers the whole world at `cellSize` world
// units per texel, so texel (i,j) is always the same world position — no origin shift/wipe on pan or zoom.
// uLatticePad (in cells) bounds which cells the fluid passes actually simulate (camera view + margin); the rest stay
// at rest (see cell_active() in fireFluid.wgsl / fireStamp.wgsl / fireParticles.wgsl). Bodies routed to the layer
// feed it: one with FIRE_HEAT in its feed bits (setFeedBits) burns, the others are solids the smoke flows around.
// WebGPU only: the scene needs renderer.backend 'webgpu'.

import WEED from '/src/index.js';

const { BLEND_MODES, LAYER_COMPUTE_SOURCE } = WEED;

/** The feed bit that sets a body on fire. */
export const FIRE_HEAT = 1;

export const FIRE_PASSES = [
  { entry: 'raster_stamp', source: 'fireStamp' },
  { entry: 'raster_particles', source: 'fireParticles', workgroup: [64], dispatchFrom: 'particles' },
  { entry: 'apply_stamp', source: 'fireFluid', swap: ['t'] },
  { entry: 'cool_rise', source: 'fireFluid', swap: ['t', 'v'] },
  { entry: 'step_swirls', source: 'fireFluid', workgroup: [64], dispatchFrom: 'swirls' },
  { entry: 'apply_swirls', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'push_from_solid', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'clear_pressure', source: 'fireFluid', swap: ['p'] },
  { entry: 'jacobi_pressure', source: 'fireFluid', iterate: 'uPressureIters', swap: ['p'] },
  { entry: 'project_velocity', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'advect_velocity', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'advect_temperature', source: 'fireFluid', swap: ['t'] },
  { entry: 'diffuse_temperature', source: 'fireFluid', swap: ['t'] },
  { entry: 'pack_heat', source: 'firePack' },
];

export const FIRE_TEXTURES = [
  { name: 'u', format: 'r32float', pingPong: true },
  { name: 'v', format: 'r32float', pingPong: true },
  { name: 't', format: 'r32float', pingPong: true },
  { name: 'p', format: 'r32float', pingPong: true },
  { name: 'stamp', format: 'rgba8unorm' },
  { name: 'vel', format: 'rgba32float' },
  { name: 'fuel', format: 'rgba32float' },
  { name: 'pack', format: 'rgba8unorm', look: true },
];

/** The fire's shaders, for a scene's static assets.shaders. */
export const fireAssets = {
  shaders: {
    fireLook: '/demos/burningBoxesScene/shaders/fireLook.wgsl',
    fireFluid: '/demos/burningBoxesScene/shaders/fireFluid.wgsl',
    fireStamp: '/demos/burningBoxesScene/shaders/fireStamp.wgsl',
    firePack: '/demos/burningBoxesScene/shaders/firePack.wgsl',
    fireParticles: '/demos/burningBoxesScene/shaders/fireParticles.wgsl',
  },
};

/**
 * The fire layer, for a scene's static config.layers.
 * @param {object} options
 * @param {number} options.worldWidth - The world the lattice covers, allocated once.
 * @param {number} options.worldHeight
 * @param {number} options.cellSize - World units per fluid cell.
 * @param {number} options.lfRadius - LiquidFun particle radius: its splat blocks fire and smoke.
 * @param {number} options.maxBodies - Bodies the layer packs each frame.
 * @param {number} options.maxParticles - LiquidFun particles the layer packs each frame.
 * @param {number} [options.zIndex=4.9] - Above lighting (4): the plume draws after the vis-poly multiply.
 *
 * Uniform hints (min/max/step/label/tip/widget/negate) drive the engine LayersPanel sliders — expand the "fire"
 * layer in the debug UI to tweak. uTime/uDt/uZoom/uCameraPos/uCanvasSize/uWorldSize/uViewSize/uTexSize are
 * engine-reserved: fed every frame, never declared here.
 */
export function fireLayer({ worldWidth, worldHeight, cellSize, lfRadius, maxBodies, maxParticles, zIndex = 4.9 }) {
  return {
    zIndex,
    blendMode: BLEND_MODES.NORMAL,
    resolution: 1,
    alpha: 0.9,
    maxItems: 0,
    shader: {
      fragment: 'fireLook',
      compute: {
        source: 'fireFluid',
        // Explicit pixels via the engine's plain {width,height} mode — computed here from world dims / cell size
        // (demo math, not an engine sizing concept). Whole world, allocated once.
        size: {
          width: Math.ceil(worldWidth / cellSize),
          height: Math.ceil(worldHeight / cellSize),
        },
        passes: FIRE_PASSES,
        textures: FIRE_TEXTURES,
        buffers: [{ name: 'swirls', strideFloats: 8, count: 200 }],
      },
      source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
      maxBodies,
      maxParticles,
      uniforms: {
        uCellSize: { value: cellSize, type: 'f32', min: 1, max: 32, step: 0.5, label: 'Cell size', tip: 'World units per fluid cell. Grid covers the whole world at this size (compute.size above). Dragging this live does not resize the grid — reload to apply.' },
        uLatticePad: { value: 32, type: 'f32', min: 0, max: 256, step: 1, label: 'Lattice pad', tip: 'Cells outside camera view + this margin (in cells) do not simulate — they stay at rest (no heat/velocity).' },
        uRise: { value: -1000, type: 'f32', min: 0, max: 4000, step: 0.5, label: 'Rise', negate: true, tip: 'Buoyancy. How hard hot air lifts. 0 = no plume.' },
        uSmokeSplit: { value: 0.28, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke split', tip: 'Heat below this draws as smoke, above as fire.' },
        uPressureIters: { value: 20, type: 'f32', min: 0, max: 20, step: 1, label: 'Pressure', tip: 'Incompressibility iterations. More = less mushy flow, more cost.' },
        uDrawCutoff: { value: 0, type: 'f32', min: 0, max: 0.2, step: 0.005, label: 'Draw cutoff', tip: 'Hide heat below this. Cuts faint haze.' },
        uFireCool: { value: 1.8, type: 'f32', min: 0, max: 10, step: 0.1, label: 'Fire cool', tip: 'How fast flame cells lose heat each step.' },
        uSmokeCool: { value: 0.01, type: 'f32', min: 0, max: 5, step: 0.01, label: 'Smoke cool', tip: 'How fast smoke cells fade. Lower = longer trails.' },
        uDiffusion: { value: 0.66, type: 'f32', min: 0, max: 100, step: 0.01, label: 'Diffusion', tip: 'How fast heat blurs into neighboring cells.' },
        uSwirlForce: { value: 0.66, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Swirl force', tip: 'How strongly swirls push the air.' },
        uEmberOn: { value: 1, type: 'f32', widget: 'check', label: 'Ember', tip: 'Glowing fill drawn on top of the flames, sized to the collider (Ember pad 0).' },
        uEmberAlpha: { value: 0.85, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Ember alpha', tip: 'How opaque the ember overlay is on top of live fire.' },
        uEmberBright: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Ember bright', tip: 'Ember heat. Higher = hotter fill.' },
        uEmberFlick: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Ember flick', tip: 'How much the ember twinkles. 0 = steady glow.' },
        uEmberPad: { value: 0, type: 'f32', min: -8, max: 8, step: 0.25, label: 'Ember pad', tip: 'Ember inset/outset in grid cells. 0 = collider size.' },
        uStampInner: { value: 16, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Stamp inner', tip: 'Burning boxes only. Live-fire depth into the crate, in cells. 0 = full solid (ring of fire). High = fills the crate. Floors and unlit boxes ignore this.' },
        uStampOuter: { value: 0.5, type: 'f32', min: -8, max: 20, step: 0.25, label: 'Stamp outer', tip: 'Burning boxes only. How far outside the collider air ignites, in cells. 1 = one-cell ring. Floors and unlit boxes ignore this.' },
        uOverRelax: { value: 1, type: 'f32', min: 1, max: 2, step: 0.05, label: 'Relax', tip: 'Pressure over-relaxation. 1 = stable. Higher = faster, noisier.' },
        uBodyDrive: { value: 0, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Body drive', tip: 'Extra air drag near crates. 0 = walls still push (MAC faces). 1 = glue nearby air to the crate (shrinks fire on still crates).' },
        uSwirlDamp: { value: 15.5, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Swirl damp', tip: 'How fast swirl spin fades. High = a quick kick, then gone.' },
        uStampPad: { value: -1.1, type: 'f32', min: -30, max: 30, step: 0.25, label: 'Stamp pad', tip: 'Solid stamp inset/outset for floors and unlit boxes, in grid cells. 0 = collider edge. Burning boxes use Stamp inner/outer instead.' },
        uSolidPush: { value: 4000, type: 'f32', min: 0, max: 100000, step: 10, label: 'Solid push', tip: 'Outward kick from floors (static), mid-edge only — corners do not jet. Flying crates skip this. Burning bodies skip this so they do not blow their own flames away. 0 = off.' },
        uSwirlChance: { value: 0.8, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Swirl chance', tip: 'How often a burning body spawns a swirl eddy.' },
        uSwirlSpin: { value: 28, type: 'f32', min: 0, max: 80, step: 1, label: 'Swirl spin', tip: 'How hard spawned swirls rotate.' },
        uSwirlLife: { value: 2.5, type: 'f32', min: 0, max: 5, step: 0.1, label: 'Swirl life', tip: 'Seconds a swirl lives before it dies.' },
        uSwirlRadius: { value: 2.5, type: 'f32', min: 0.5, max: 8, step: 0.1, label: 'Swirl size', tip: 'Radius of each swirl, in grid cells.' },
        uMaxSwirls: { value: 155, type: 'f32', min: 0, max: 200, step: 1, label: 'Max swirls', tip: 'Cap on live swirls. 0 = none.' },
        uSmokeOn: { value: 1, type: 'f32', widget: 'check', label: 'Smoke', tip: 'Draw smoke (heat below the split). Off = flames only.' },
        uFireOn: { value: 1, type: 'f32', widget: 'check', label: 'Fire', tip: 'Draw flame pixels (heat at or above the split).' },
        uView: { value: 0, type: 'f32', min: 0, max: 3, step: 1, label: 'View', tip: 'Look = composite. Heat = raw t. FBM = overlay grain (not the fluid). Flow = velocity color.' },
        uSmokeAlpha: { value: 0.77, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke alpha', tip: 'Smoke opacity.' },
        uSmokePuff: { value: 5, type: 'f32', min: 0, max: 100, step: 0.05, label: 'Smoke puff', tip: 'Wisp shape. Higher = thinner, puffier edges.' },
        uSmokeNoise: { value: 0.55, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke noise', tip: 'How lumpy the smoke is. At 1, noise punches holes in the puff.' },
        uSmokeDens: { value: 1.3, type: 'f32', min: 0.4, max: 2.5, step: 0.05, label: 'Smoke density', tip: 'How thick and sooty the smoke is. Raise this for darker plumes.' },
        uSmokeScroll0: { value: 3.5, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Smoke n1', tip: 'Slow coarse smoke grain crawl. Negative = up with the plume (Y-down lattice).' },
        uSmokeScroll1: { value: 4.5, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Smoke n2', tip: 'Mid smoke octave crawl.' },
        uSmokeScroll2: { value: 0.55, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Smoke n3', tip: 'Fine smoke octave crawl. Faster = more boil.' },
        uFireScroll0: { value: 2.0, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Fire n1', tip: 'Slow coarse fire grain crawl.' },
        uFireScroll1: { value: 0.0, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Fire n2', tip: 'Mid fire octave crawl.' },
        uFireScroll2: { value: 18.0, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Fire n3', tip: 'Fine fire octave crawl.' },
        uFireAlpha: { value: 0.85, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Fire alpha', tip: 'Flame opacity.' },
        uFireNoise: { value: 0.15, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Fire noise', tip: 'How hard FBM wriggles flame bands and punches dark patches. 0 = smooth fill.' },
        uLfRadius: { value: lfRadius, type: 'f32', min: 1, max: 40, step: 0.5, label: 'LF radius', tip: 'LiquidFun solid splat radius in world units. Occupied cells block fire/smoke. Hot particles also ignite a one-cell ring outside this radius.' },
        uLfHeat: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'LF heat', tip: 'Heat stamped at each LiquidFun particle. 0 = particles do not fuel the fire.' },
        uLfDrive: { value: 0.65, type: 'f32', min: 0, max: 1, step: 0.01, label: 'LF drive', tip: 'How much particle velocity is mixed into the Eulerian air.' },
        uBlowForce: { value: 900, type: 'f32', min: 0, max: 4000, step: 10, label: 'Blow force', tip: 'Wind speed written in front of blower bodies (local +X).' },
        uBlowReach: { value: 14, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Blow reach', tip: 'Blower wind slab length, in grid cells.' },
        uJetForce: { value: 1200, type: 'f32', min: 0, max: 4000, step: 10, label: 'Jet force', tip: 'Exhaust speed on the nozzle face of jet crates.' },
        uSmokeLift: { value: 0, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke lift', tip: 'Pales the soot toward ash gray. Raise it over a dark sky, where soot does not show.' },
      },
    },
  };
}
