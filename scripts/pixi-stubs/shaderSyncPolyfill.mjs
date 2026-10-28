// Pixi's WebGL shader sync for a build without eval (pixi.js/unsafe-eval, which the worker bundle installs), without
// its garbage. The upstream polyfill walks `shader.groups` and every `BindGroup.resources` with for…in on each draw.
// Both are integer-keyed (`resources` is Object.create(null)), so V8 builds a key list every time: 0.7 MB/s in
// Predator's Pixi worker, 6 MB/s with GPU particle groups drawn among the entities.
//
// This walks a per-shader plan of [group, binding] pairs instead, built once with for…in, as Pixi's generated sync
// (its default where eval is allowed) bakes them per program at the first bind. The plan is rebuilt when a group
// slot holds another BindGroup or a BindGroup gained a resource slot (`_weedKeys`, counted by the BindGroup patch
// in scripts/buildPixi.mjs). The body per resource is upstream's, in upstream's order.
import { BufferResource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/BufferResource.mjs';
import { UniformGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/shader/UniformGroup.mjs';
import { TextureSource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.mjs';
import { TextureView } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/TextureView.mjs';

/** @type {WeakMap<object, { pairs: Int32Array, count: number, slots: Array<number | object> }>} */
const plans = new WeakMap();

/**
 * The shader's [group, binding] pairs in for…in order, and per group slot its BindGroup and `_weedKeys`, to
 * validate the plan on later binds.
 */
function buildPlan(shader) {
  const groupIndex = [];
  const bindIndex = [];
  const slots = [];
  for (const i in shader.groups) {
    const bindGroup = shader.groups[i];
    slots.push(Number(i), bindGroup, bindGroup ? bindGroup._weedKeys : 0);
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

/** The plan still matches the shader: the same BindGroup in every slot, none with a new resource slot. */
function planMatches(plan, shader) {
  const slots = plan.slots;
  const groups = shader.groups;
  for (let s = 0; s < slots.length; s += 3) {
    const bindGroup = groups[slots[s]];
    if (bindGroup !== slots[s + 1]) return false;
    if (bindGroup && bindGroup._weedKeys !== slots[s + 2]) return false;
  }
  return true;
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
      renderer.texture.bind(resource, syncData.textureCount);
      const uniformName = shader._uniformBindMap[i][j];
      const uniformData = programData.uniformData[uniformName];
      if (uniformData) {
        if (uniformData.value !== syncData.textureCount) {
          gl.uniform1i(uniformData.location, syncData.textureCount);
        }
        syncData.textureCount++;
      }
    }
  }
}

function generateShaderSyncPolyfill() {
  return syncShader;
}

export { generateShaderSyncPolyfill, syncShader };
