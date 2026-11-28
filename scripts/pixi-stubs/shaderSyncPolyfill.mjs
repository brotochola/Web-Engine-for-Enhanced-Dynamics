// Pixi's WebGL shader sync for a build without eval (pixi.js/unsafe-eval, which the worker bundle installs), without
// its garbage. The upstream polyfill walks `shader.groups` and every `BindGroup.resources` with for…in on each draw.
// Both are integer-keyed (`resources` is Object.create(null)), so V8 builds a key list every time: 0.7 MB/s in
// Predator's Pixi worker, 6 MB/s with GPU particle groups drawn among the entities. Pixi 8.23's polyfill still does.
//
// This walks a per-shader plan of [group, binding] pairs instead, built once with for…in, as Pixi's generated sync
// (its default where eval is allowed) bakes them per program at the first bind. The plan is rebuilt when a group
// slot holds another BindGroup with other bindings, or a BindGroup gained a binding: Pixi 8.23 lists a group's binding
// numbers in `_resourceKeys`, a new array each time one is added. A group keyed by name (8.23's `layout`, #12293)
// binds each resource under its layout name, a group keyed by number under the shader's `_uniformBindMap` name, as
// upstream's polyfill does. A slot the shader gains after the plan is built is not seen (the plan walks its own slots).
// Pixi 8.23 binds each uniform block to a fixed slot when the program links (#12307): a block is bound by its name,
// only when the program has it. The body per resource is upstream's, in upstream's order, but for textures.
//
// N-109: an integer texture (a `…uint` or `…sint` format: the statics of indexed and keyed sprites, the GPU particle
// rings) goes to the top texture units, counting down from the last one, not to the next unit up. WebGL2 checks every
// active sampler of a program against the texture its unit holds, read or not, and drops the draw on a mismatch
// ("Mismatch between texture format and sampler type"). Pixi's batcher declares sixteen float samplers and binds only
// the units its batch uses, so an integer texture left in another of the low units dropped its draws: the lighting
// sprite after the entities, every frame. WebGL2 has at least 32 units and the batcher reads the first 16.
//
// E-417: a float texture takes the unit it already sits on (any program's earlier bind left it there), or else the least
// recently used unit above the batcher's BATCH_UNITS that this bind has not taken for another of the program's samplers
// (the batcher's units only when those are all taken); not the next unit up from 0. Pixi numbered each program's
// samplers from unit 0, so the next program bound its own textures over the last one's, and over the batcher's, which
// binds a batch's texture k to unit k: 205 texture binds and 183 unit switches a frame in Predator ?light3d=1, over half
// its 713 GL calls, each a command Chrome's GPU process decodes. The top INTEGER_UNITS units stay the integer textures'
// (N-109), so a float sampler never finds an integer texture; an integer texture keeps its unit among them the same way
// (the statics, the poses and the light tiles each took the last unit in turn, three binds a frame). E-389: a sampler's uniform1i is written when its unit changes and
// remembered (uniformData.value); upstream compared the value and never stored it, so it wrote every sampler each draw.
import { BufferResource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/BufferResource.mjs';
import { UniformGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/shader/UniformGroup.mjs';
import { TextureSource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.mjs';
import { TextureView } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/TextureView.mjs';

/**
 * @type {WeakMap<object, { pairs: Int32Array, names: Array<string | null>, count: number, slots: Array<unknown> }>}
 */
const plans = new WeakMap();

/**
 * Entries per group slot in a plan's `slots`: the slot, its BindGroup, that group's bindings (`groupBindings`), a copy
 * of them (`bindingsCopy`) and whether the group is keyed by name (1) or by number (0).
 */
const SLOT_STRIDE = 5;

/**
 * What a group binds, compared by identity on each bind: a group keyed by name walks its `layout` (made once, in its
 * constructor), one keyed by number its `_resourceKeys` (a new array when it gains a binding); null once destroyed.
 */
function groupBindings(bindGroup) {
  if (!bindGroup.resources) return null;
  const layout = bindGroup.layout;
  return layout ? layout : bindGroup._resourceKeys;
}

/** A copy of what a group binds: its binding numbers, or for a group keyed by name its [name, binding] pairs. */
function bindingsCopy(bindGroup) {
  if (!bindGroup.resources) return null;
  const layout = bindGroup.layout;
  if (!layout) return bindGroup._resourceKeys.slice();
  const copy = [];
  for (const name in layout) copy.push(name, layout[name]);
  return copy;
}

/** Whether `bindGroup` binds what `copy` (bindingsCopy of another group, keyed by name or not) holds, in its order. */
function bindsAsCopy(bindGroup, copy, named) {
  if (copy === null || !bindGroup.resources) return false;
  const layout = bindGroup.layout;
  if (named) {
    if (!layout) return false;
    let k = 0;
    for (const name in layout) {
      if (copy[k] !== name || copy[k + 1] !== layout[name]) return false;
      k += 2;
    }
    return k === copy.length;
  }
  if (layout) return false;
  const keys = bindGroup._resourceKeys;
  if (keys.length !== copy.length) return false;
  for (let k = 0; k < keys.length; k++) if (keys[k] !== copy[k]) return false;
  return true;
}

/**
 * The shader's [group, binding] pairs in upstream's order (the groups for…in, then a group's layout names or its
 * binding numbers), the layout name of each pair (null: the shader's `_uniformBindMap` names it, read at each bind as
 * upstream does), and per group slot what `planMatches` checks on later binds.
 */
function buildPlan(shader) {
  const groupIndex = [];
  const bindIndex = [];
  const names = [];
  const slots = [];
  for (const i in shader.groups) {
    const g = Number(i);
    const bindGroup = shader.groups[i];
    if (!bindGroup || !bindGroup.resources) {
      slots.push(g, bindGroup, null, null, 0);
      continue;
    }
    const layout = bindGroup.layout;
    if (layout) {
      for (const name in layout) {
        groupIndex.push(g);
        bindIndex.push(layout[name]);
        names.push(name);
      }
    } else {
      const keys = bindGroup._resourceKeys;
      for (let k = 0; k < keys.length; k++) {
        groupIndex.push(g);
        bindIndex.push(keys[k]);
        names.push(null);
      }
    }
    slots.push(g, bindGroup, groupBindings(bindGroup), bindingsCopy(bindGroup), layout ? 1 : 0);
  }
  const pairs = new Int32Array(groupIndex.length * 2);
  for (let k = 0; k < groupIndex.length; k++) {
    pairs[k * 2] = groupIndex[k];
    pairs[k * 2 + 1] = bindIndex[k];
  }
  return { pairs, names, count: groupIndex.length, slots };
}

/**
 * The plan still matches the shader: every slot holds the plan's BindGroup with the bindings it had, or another one
 * that binds the same, in the same order. E-236: Pixi's batcher, meshes, graphics and tiling sprites put another
 * BindGroup in a slot at each batch or draw (a batch's textures, a mesh's local uniforms, the pass's globals) with the
 * same bindings; the plan holds for it, and the slot remembers that group, so its next bind takes the identity test.
 */
function planMatches(plan, shader) {
  const slots = plan.slots;
  const groups = shader.groups;
  for (let s = 0; s < slots.length; s += SLOT_STRIDE) {
    const bindGroup = groups[slots[s]];
    const held = slots[s + 1];
    if (bindGroup === held) {
      if (bindGroup && groupBindings(bindGroup) !== slots[s + 2]) return false;
      continue;
    }
    if (!bindGroup || !held || !bindsAsCopy(bindGroup, slots[s + 3], slots[s + 4] === 1)) return false;
    slots[s + 1] = bindGroup;
    slots[s + 2] = groupBindings(bindGroup);
  }
  return true;
}

/** E-417: the top units kept for integer textures (N-109's count down from the last unit) and raw integer bindings. */
const INTEGER_UNITS = 4;
/** E-417: the units Pixi's batcher binds its batches' textures to (GlBatchAdaptor: texture k on unit k), at most 16. */
const BATCH_UNITS = 16;

/**
 * Per context: the last unit (where integer textures start, N-109), the float range's end and the first unit a new
 * texture takes (past the batcher's), and per unit the sync that last used it and the sync that took it (a sync's tick).
 * @type {WeakMap<object, { top: number, floatEnd: number, floatFirst: number, lastUse: Float64Array, taken: Float64Array,
 *   tick: number }>}
 */
const unitStates = new WeakMap();

function unitState(gl) {
  let state = unitStates.get(gl);
  if (state === undefined) {
    const units = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    const floatEnd = Math.max(16, units - INTEGER_UNITS);
    state = {
      top: units - 1,
      floatEnd,
      floatFirst: floatEnd - BATCH_UNITS >= 8 ? BATCH_UNITS : 0,
      lastUse: new Float64Array(units),
      taken: new Float64Array(units),
      tick: 0,
    };
    unitStates.set(gl, state);
  }
  return state;
}

/**
 * E-417: a float texture's unit for this sync: the float unit `source` is bound on (`bound`, the texture system's
 * per-unit sources), or the least recently used one past the batcher's that this sync has not taken, or any float unit
 * this sync has not taken when those are all taken.
 */
function floatUnit(state, bound, source, tick) {
  const end = state.floatEnd;
  const lastUse = state.lastUse;
  const taken = state.taken;
  for (let u = 0; u < end; u++) {
    if (bound[u] === source) {
      lastUse[u] = tick;
      taken[u] = tick;
      return u;
    }
  }
  let best = -1;
  let bestUse = Infinity;
  for (let u = state.floatFirst; u < end; u++) {
    if (taken[u] === tick) continue;
    if (lastUse[u] < bestUse) {
      bestUse = lastUse[u];
      best = u;
    }
  }
  for (let u = 0; best < 0 && u < end; u++) {
    if (taken[u] !== tick && lastUse[u] < bestUse) {
      bestUse = lastUse[u];
      best = u;
    }
  }
  if (best < 0) best = 0;
  lastUse[best] = tick;
  taken[best] = tick;
  return best;
}

/**
 * E-417: an integer texture's unit for this sync, among the top units (N-109): the one `source` is bound on, or the
 * least recently used one this sync has not taken, the highest on a tie; -1 when this sync took them all.
 */
function integerUnitOf(state, bound, source, tick) {
  const lastUse = state.lastUse;
  const taken = state.taken;
  for (let u = state.top; u >= state.floatEnd; u--) {
    if (bound[u] === source) {
      lastUse[u] = tick;
      taken[u] = tick;
      return u;
    }
  }
  let best = -1;
  let bestUse = Infinity;
  for (let u = state.top; u >= state.floatEnd; u--) {
    if (taken[u] !== tick && lastUse[u] < bestUse) {
      bestUse = lastUse[u];
      best = u;
    }
  }
  if (best >= 0) {
    lastUse[best] = tick;
    taken[best] = tick;
  }
  return best;
}

/** A texture sampled as integers: a `…uint` or `…sint` format (no other format ends in "int"). */
function isIntegerTexture(resource) {
  const format = resource.source.format;
  return typeof format === 'string' && format.endsWith('int');
}

function syncShader(renderer, shader, syncData) {
  const gl = renderer.gl;
  const shaderSystem = renderer.shader;
  const programData = shaderSystem._getProgramData(shader.glProgram);
  let plan = plans.get(shader);
  if (plan === undefined || !planMatches(plan, shader)) {
    plan = buildPlan(shader);
    plans.set(shader, plan);
  }
  const groups = shader.groups;
  const pairs = plan.pairs;
  const names = plan.names;
  // The unit the next integer texture takes; -1 until the shader has one.
  let integerUnit = -1;
  // E-417: this sync's tick, for the float units it takes, and the texture system's per-unit sources.
  let units = null;
  let tick = 0;
  let bound = null;
  for (let k = 0; k < plan.count; k++) {
    const i = pairs[k * 2];
    const j = pairs[k * 2 + 1];
    const resource = groups[i].resources[j];
    if (!resource) continue;
    let name = names[k];
    if (name === null) {
      const bindingNames = shader._uniformBindMap[i];
      name = bindingNames === undefined ? undefined : bindingNames[j];
    }
    if (resource instanceof UniformGroup && !resource.ubo) {
      shaderSystem.updateUniformGroup(resource);
    } else if (resource instanceof UniformGroup || resource instanceof BufferResource) {
      if (shader.glProgram._uniformBlockData[name]) shaderSystem.bindUniformBlock(resource, name);
    } else if (resource instanceof TextureSource || resource instanceof TextureView) {
      const integer = isIntegerTexture(resource);
      if (units === null) {
        units = unitState(gl);
        tick = ++units.tick;
        bound = renderer.texture._boundTextures;
      }
      let unit;
      if (integer) {
        unit = integerUnitOf(units, bound, resource.source, tick);
        // More integer textures than the top units: below them, counting down as N-109 did.
        if (unit < 0) {
          if (integerUnit < 0) integerUnit = units.floatEnd - 1;
          unit = integerUnit;
        }
      } else {
        unit = floatUnit(units, bound, resource.source, tick);
      }
      renderer.texture.bind(resource, unit);
      const uniformData = programData.uniformData[name];
      if (uniformData) {
        if (uniformData.value !== unit) {
          gl.uniform1i(uniformData.location, unit);
          uniformData.value = unit;
        }
        if (integer) {
          if (unit === integerUnit) integerUnit--;
        } else {
          syncData.textureCount++;
        }
      }
    }
  }
}

function generateShaderSyncPolyfill() {
  return syncShader;
}

export { generateShaderSyncPolyfill, syncShader };
