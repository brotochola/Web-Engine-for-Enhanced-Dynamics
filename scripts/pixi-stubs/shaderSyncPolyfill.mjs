// Pixi's WebGL shader sync for a build without eval (pixi.js/unsafe-eval, which the worker bundle installs), without
// its garbage. The upstream polyfill walks `shader.groups` and every `BindGroup.resources` with for…in on each draw.
// Both are integer-keyed (`resources` is Object.create(null)), so V8 builds a key list every time: 0.7 MB/s in
// Predator's Pixi worker, 6 MB/s with GPU particle groups drawn among the entities.
//
// This walks a per-shader plan of [group, binding] pairs instead, built once with for…in, as Pixi's generated sync
// (its default where eval is allowed) bakes them per program at the first bind. The plan is rebuilt when a group
// slot holds another BindGroup or a BindGroup gained a resource slot (`_weedKeys`, counted by the BindGroup patch
// in scripts/buildPixi.mjs). The body per resource is upstream's, in upstream's order, but for integer textures.
//
// N-109: an integer texture (a `…uint` or `…sint` format: the statics of indexed and keyed sprites, the GPU particle
// rings) goes to the top texture units, counting down from the last one, not to the next unit up. WebGL2 checks every
// active sampler of a program against the texture its unit holds, read or not, and drops the draw on a mismatch
// ("Mismatch between texture format and sampler type"). Pixi's batcher declares sixteen float samplers and binds only
// the units its batch uses, so an integer texture left in another of the low units dropped its draws: the lighting
// sprite after the entities, every frame. WebGL2 has at least 32 units and the batcher reads the first 16.
import { BufferResource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/BufferResource.mjs';
import { UniformGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/shader/UniformGroup.mjs';
import { TextureSource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.mjs';
import { TextureView } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/TextureView.mjs';

/** @type {WeakMap<object, { pairs: Int32Array, count: number, slots: Array<number | object> }>} */
const plans = new WeakMap();

/** Entries per group slot in a plan's `slots`: the slot, its BindGroup, that group's `_weedKeys`, a copy of its keys. */
const SLOT_STRIDE = 4;

/**
 * The shader's [group, binding] pairs in for…in order, and per group slot its BindGroup, `_weedKeys` and a copy of its
 * key list (`_weedKeyList`, kept in for…in order by the BindGroup patch), to validate the plan on later binds.
 */
function buildPlan(shader) {
  const groupIndex = [];
  const bindIndex = [];
  const slots = [];
  for (const i in shader.groups) {
    const bindGroup = shader.groups[i];
    const keyList = bindGroup && bindGroup._weedKeyList ? bindGroup._weedKeyList.slice() : null;
    slots.push(Number(i), bindGroup, bindGroup ? bindGroup._weedKeys : 0, keyList);
    if (!bindGroup) continue;
    for (const j in bindGroup.resources) {
      groupIndex.push(Number(i));
      bindIndex.push(Number(j));
    }
  }
  const pairs = new Int32Array(groupIndex.length * 2);
  for (let k = 0; k < groupIndex.length; k++) {
    pairs[k * 2] = groupIndex[k];
    pairs[k * 2 + 1] = bindIndex[k];
  }
  return { pairs, count: groupIndex.length, slots };
}

/**
 * The plan still matches the shader: every slot holds a BindGroup with the plan's keys in the plan's order, none with a
 * new resource slot. E-236: Pixi's batcher, meshes, graphics and tiling sprites put another BindGroup in a slot at each
 * batch or draw (a batch's textures, a mesh's local uniforms, the pass's globals) with the same keys; the plan holds
 * for it, and the slot remembers that group, so its next bind takes the identity test. A group without a key list
 * (not the bundle's BindGroup) rebuilds the plan as before.
 */
function planMatches(plan, shader) {
  const slots = plan.slots;
  const groups = shader.groups;
  for (let s = 0; s < slots.length; s += SLOT_STRIDE) {
    const bindGroup = groups[slots[s]];
    const held = slots[s + 1];
    if (bindGroup === held) {
      if (bindGroup && bindGroup._weedKeys !== slots[s + 2]) return false;
      continue;
    }
    if (!bindGroup || !held) return false;
    const keys = bindGroup._weedKeyList;
    const planKeys = slots[s + 3];
    if (!keys || !planKeys || keys.length !== planKeys.length) return false;
    for (let k = 0; k < keys.length; k++) if (keys[k] !== planKeys[k]) return false;
    slots[s + 1] = bindGroup;
    slots[s + 2] = bindGroup._weedKeys;
  }
  return true;
}

/** The last texture unit of `gl`'s context, where integer textures start (N-109). */
const topUnits = new WeakMap();

function topTextureUnit(gl) {
  let unit = topUnits.get(gl);
  if (unit === undefined) {
    unit = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1;
    topUnits.set(gl, unit);
  }
  return unit;
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
  // The unit the next integer texture takes; -1 until the shader has one.
  let integerUnit = -1;
  for (let k = 0; k < plan.count; k++) {
    const i = pairs[k * 2];
    const j = pairs[k * 2 + 1];
    const resource = groups[i].resources[j];
    if (resource instanceof UniformGroup) {
      if (resource.ubo) {
        shaderSystem.bindUniformBlock(resource, shader._uniformBindMap[i][j], syncData.blockIndex++);
      } else {
        shaderSystem.updateUniformGroup(resource);
      }
    } else if (resource instanceof BufferResource) {
      shaderSystem.bindUniformBlock(resource, shader._uniformBindMap[i][j], syncData.blockIndex++);
    } else if (resource instanceof TextureSource || resource instanceof TextureView) {
      const integer = isIntegerTexture(resource);
      if (integer && integerUnit < 0) integerUnit = topTextureUnit(gl);
      const unit = integer ? integerUnit : syncData.textureCount;
      renderer.texture.bind(resource, unit);
      const uniformName = shader._uniformBindMap[i][j];
      const uniformData = programData.uniformData[uniformName];
      if (uniformData) {
        if (uniformData.value !== unit) {
          gl.uniform1i(uniformData.location, unit);
        }
        if (integer) integerUnit--;
        else syncData.textureCount++;
      }
    }
  }
}

function generateShaderSyncPolyfill() {
  return syncShader;
}

export { generateShaderSyncPolyfill, syncShader };
