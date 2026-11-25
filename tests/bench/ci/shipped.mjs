import fs from 'node:fs';

/**
 * The Node kernels that time one variant a process, with the arguments that time what the engine ships: by default many
 * time the JavaScript a WASM kernel replaced (their variants' base). A kernel with two shipped forms has two entries.
 * The rest run as they are. tests/node/ciShippedVariants.test.js checks each name against its script.
 */
export const SHIPPED_ARGS = Object.freeze({
  bulletTickWasmMicrobench: ['--variant wasm_lean'],
  decorationSwayWasmMicrobench: ['--variant wasm-f32x4'],
  gpuPackWasmMicrobench: ['--variant wasm'],
  meshCornersWasmMicrobench: ['--variant wasm'],
  painterRadixWasmMicrobench: ['--variant simd_inplace'],
  preRenderCollectWasmMicrobench: ['--variant wasm'],
  preRenderEmitAdobeMicrobench: ['--variant wasm'],
  preRenderEmitWasmMicrobench: ['', '--variant wasmKeyedSkip'],
  preRenderPersistWasmMicrobench: ['--variant wasm', '--variant keyed'],
  spatialGatherWasmMicrobench: ['--variant ordered'],
  spatialGridMoversMicrobench: ['--variant auto'],
});

/** The argument lists to time kernel `file` (a name in tests/bench) with: one entry a run. */
export function shippedArgs(file) {
  return SHIPPED_ARGS[file.replace(/^.*\//, '').replace(/\.mjs$/, '')] ?? [''];
}

/**
 * Whether a kernel (a file's URL) times the engine's code: its source, or one it imports by a relative path, names src/. The
 * others time ideas of their own (a hypotenuse, a call's cost): no revision of the engine moves them.
 */
export function reachesEngine(url, seen = new Set()) {
  if (seen.has(url.href) || !fs.existsSync(url)) return false;
  seen.add(url.href);
  const source = fs.readFileSync(url, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  if (/\/src\/|'src'|"src"/.test(source)) return true;
  for (const m of source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!/(microbenchHelpers|measureLib|wasmKernelHelpers|revWorktree)\.mjs$/.test(m[1]) && reachesEngine(new URL(m[1], url), seen)) return true;
  }
  return false;
}

/**
 * The engine's parts, for a page that groups the kernels: the first whose words a kernel's name matches. Not a verdict on
 * which worker runs it.
 */
const AREAS = [
  ['lights and shadows', /shadow|light|lamp|vis(ibility|Poly|Span)|polar|compoundSolid|solidSegments|sweepLight|glow|^sun|angularSweep|polygons|wallRow/i],
  ['particles and decals', /particle|decal|bullet|emit(Gpu)?Call|gpuParticle|liquidFun|lf[A-Z]|decoration|sway|premultiply|^ease/i],
  ['physics and rays', /ray|contact|physics|box2d|body|collider|joint|query|publishPose|clearShapes|fixture|aim|flowfield|nav|path|astar|deriveSpeed/i],
  ['spatial', /spatial|grid|neighbo|gather(?!Instanced)|rebuildOwnedRows|layerFeed/i],
  ['drawing', /pack|painter|pixi|sprite|mesh|preRender|collect|texture|atlas|blit|sort|radix|camera|tile|opaque|keyed|instanced|queue|stamp|scenery|preHot/i],
  ['game logic', /fsm|tick|entity|gameObject|setter|spawn|despawn|tween|component|access|anim|steer|listUpdate|impact|logic|boid|^save|timeScale|collisionHooks/i],
  ['sound and input', /audio|sound|keyboard|mouse|input/i],
];

export function areaOf(kernel) {
  const name = kernel.replace(/^.*\//, '').replace(/(Wasm)?(Microbench|Kernel)(\.mjs)?$/, '');
  return (AREAS.find(([, re]) => re.test(name)) ?? ['other'])[0];
}
