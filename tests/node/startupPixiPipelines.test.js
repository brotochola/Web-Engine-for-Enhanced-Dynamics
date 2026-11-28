// SST-7 step 3 (E-495): Pixi's WebGPU pipeline system builds a draw's render pipeline ahead with
// createRenderPipelineAsync (scripts/buildPixi.mjs, patchPixiPipelinesAhead), for a given target, and Pixi's own draw into
// that target later finds it under its key instead of making one with the synchronous createRenderPipeline. The
// system's target state is left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Geometry, GpuProgram, PipelineSystem, State } from '../../src/vendor/pixi.min.js';

const WGSL = `
@vertex fn mainVert(@location(0) aPosition: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(aPosition, 0.0, 1.0);
}
@fragment fn mainFrag() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

/** A WebGPU device that logs how each pipeline was made. */
function fakeDevice() {
  const made = [];
  return {
    made,
    createShaderModule: (d) => ({ code: d.code }),
    createRenderPipeline: (d) => {
      const p = { how: 'sync', label: d.label, format: d.fragment.targets[0].format, depth: d.depthStencil?.format ?? null };
      made.push(p);
      return p;
    },
    createRenderPipelineAsync: async (d) => {
      const p = { how: 'async', label: d.label, format: d.fragment.targets[0].format, depth: d.depthStencil?.format ?? null };
      made.push(p);
      return p;
    },
  };
}

/** A render target as Pixi's RenderTarget gives it to the pipeline system: its colour formats, depth, flip. */
function target(format, depthFormat = null, depthReadOnly = false) {
  return {
    colorAttachments: [{ texture: { format, source: { antialias: false } } }],
    depthStencilAttachment: depthFormat ? { texture: { format: depthFormat }, depthReadOnly } : undefined,
    flipY: false,
  };
}

function pipelineSystem(device) {
  const renderer = {
    state: { getColorTargets: (state, formats) => formats.map((format) => ({ format })) },
    renderTarget: { isFrontFaceInverted: (renderTarget, flipY) => !!flipY },
    shader: { getProgramData: () => ({ pipeline: 'layout' }) },
    limits: { supportsOverrideConstants: true },
  };
  const system = new PipelineSystem(renderer);
  system.contextChange({ device });
  return system;
}

test("a pipeline built ahead for a target is the one Pixi's draw into it finds; none is made then", async () => {
  const device = fakeDevice();
  const system = pipelineSystem(device);
  const program = new GpuProgram({
    vertex: { source: WGSL, entryPoint: 'mainVert' },
    fragment: { source: WGSL, entryPoint: 'mainFrag' },
    name: 'ahead-test',
  });
  const geometry = new Geometry({ attributes: { aPosition: [0, 0, 1, 0, 1, 1] } });
  const state = State.for2d();
  const canvas = target('bgra8unorm', 'depth24plus-stencil8');
  const light = target('rgba8unorm');

  // The system is drawing into the canvas when the worker builds the light pass's pipeline ahead.
  system.setRenderTarget(canvas);
  const formatsBefore = system._colorFormats;
  const stateBefore = [system._colorFormatId, system._stencilReadOnly, system.bundleStateKey];
  const built = system.weedPipelineAhead(geometry, program, state, undefined, light);
  assert.ok(built instanceof Promise, 'built asynchronously');
  assert.deepEqual(system._colorFormats, ['bgra8unorm'], "the system's target state as it was");
  assert.equal(system._colorFormats, formatsBefore, 'its own list, put back in place');
  assert.deepEqual([system._colorFormatId, system._stencilReadOnly, system.bundleStateKey], stateBefore);
  assert.equal(system._depthStencilFormat, 'depth24plus-stencil8');
  assert.equal(system.weedPipelineAhead(geometry, program, state, undefined, light), null, 'one build a pipeline');
  await built;
  assert.deepEqual(device.made.map((p) => [p.how, p.format, p.depth]), [['async', 'rgba8unorm', null]]);

  // Pixi's draw into the light pass's target finds it.
  system.setRenderTarget(light);
  const drawn = system.getPipeline(geometry, program, state);
  assert.equal(drawn, device.made[0], 'the pipeline built ahead');
  assert.equal(device.made.length, 1, 'no pipeline made at the draw');

  // A draw into another target (the canvas: its format, its depth) is another pipeline, made as Pixi always made it.
  system.setRenderTarget(canvas);
  const onCanvas = system.getPipeline(geometry, program, state);
  assert.deepEqual([onCanvas.how, onCanvas.format, onCanvas.depth], ['sync', 'bgra8unorm', 'depth24plus-stencil8']);
  assert.equal(system.weedPipelineAhead(geometry, program, state, undefined, canvas), null, 'nothing to build: it has one');

  // Bound to a read-only depth (its stencil read-only with it), two colour targets: all of it comes back after a build.
  const readOnly = target('rgba16float', 'depth24plus-stencil8', true);
  readOnly.colorAttachments.push({ texture: { format: 'r32uint', source: { antialias: false } } });
  system.setRenderTarget(readOnly);
  const keyBefore = system.bundleStateKey;
  system.weedPipelineAhead(geometry, program, state, undefined, target('rgba8unorm', null, false));
  assert.deepEqual([system._colorFormats, system._depthReadOnly, system._stencilReadOnly], [['rgba16float', 'r32uint'], true, true]);
  assert.equal(system.bundleStateKey, keyBefore);
});
