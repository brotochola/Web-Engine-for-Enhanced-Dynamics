/**
 * Manual lockstep visual catalog.
 * Patch only config.manualStep — production Box2D thread count stays on the demo.
 */

export const LOCKSTEP_VISUAL_SCENES = [
  {
    id: 'balls',
    module: '/demos/ballsScene/ballsScene.js',
    exportName: 'BallsScene',
    steps: 90,
    dtMs: 16.67,
    minActive: 9004,
    minLiquidFun: 0,
    minParticles: 0,
    zoom: 0.15,
    match: 'exact',
  },
  {
    id: 'water',
    module: '/demos/waterAndBoxesScene/waterAndBoxesScene.js',
    exportName: 'WaterAndBoxesScene',
    steps: 90,
    dtMs: 16.67,
    minActive: 4006,
    minLiquidFun: 0,
    minParticles: 0,
    zoom: 0.22,
    match: 'not-black',
  },
  {
    id: 'liquidfun',
    module: '/demos/liquidFunDemoScene/liquidFunDemoScene.js',
    exportName: 'LiquidFunDemoScene',
    steps: 100,
    dtMs: 16.67,
    minActive: 20,
    minLiquidFun: 10,
    minParticles: 0,
    zoom: 0.3,
    centerX: 2000,
    centerY: 1200,
    match: 'exact',
  },
  {
    id: 'particles',
    module: '/demos/particleLabScene/particleLabScene.js',
    exportName: 'ParticleLabScene',
    steps: 40,
    dtMs: 16.67,
    minActive: 0,
    minLiquidFun: 0,
    minParticles: 80,
    zoom: 1,
    match: 'exact',
  },
  {
    id: 'oriented',
    module: '/demos/orientedBoxScene/orientedBoxScene.js',
    exportName: 'OrientedBoxScene',
    steps: 90,
    dtMs: 16.67,
    minActive: 1044,
    minLiquidFun: 0,
    minParticles: 0,
    zoom: 0.18,
    match: 'exact',
  },
  {
    id: 'lfstress',
    module: '/tests/bench/stressScenes/liquidFunStressScene.js',
    exportName: 'LiquidFunStressScene',
    steps: 100,
    dtMs: 16.67,
    minActive: 3,
    minLiquidFun: 8000,
    minParticles: 0,
    zoom: 0.25,
    centerX: 2000,
    centerY: 1750,
    match: 'exact',
  },
  {
    // Product vehicle for engine hypotheses: 16k bodies, lighting, shadows,
    // bullets, particles, decals. Three logic workers tick AI in parallel, so
    // two runs of the same commit are not bit-identical: not-black + counts.
    id: 'predator',
    module: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    steps: 90,
    dtMs: 16.67,
    minActive: 15000,
    minLiquidFun: 0,
    minParticles: 0,
    zoom: 0.4,
    match: 'not-black',
  },
];

export function resolveLockstepScenes(ids) {
  if (!ids || ids.length === 0) return LOCKSTEP_VISUAL_SCENES;
  const want = new Set(ids);
  const picked = LOCKSTEP_VISUAL_SCENES.filter((s) => want.has(s.id));
  const missing = [...want].filter((id) => !picked.some((s) => s.id === id));
  if (missing.length) {
    throw new Error(`unknown visual scene id(s): ${missing.join(', ')}`);
  }
  return picked;
}
