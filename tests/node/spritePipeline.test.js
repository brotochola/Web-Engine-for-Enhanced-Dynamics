import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSpritePipeline,
  PACK_GPU_SPRITES_PRERENDER,
  PACK_GPU_SPRITES_PIXI,
  SORT_SPRITES_NONE,
  SORT_SPRITES_PRERENDER,
  SORT_SPRITES_PRERENDER_MERGE,
  SORT_SPRITES_PIXI,
  errorPackGpuSpritesInvalid,
  errorSortSpritesInvalid,
} from '../../src/render/rendererBackend.js';
import { PRE_RENDER_DEFAULTS } from '../../src/util/configDefaults.js';

test('resolveSpritePipeline: ySort off forces sort none', () => {
  const pipe = resolveSpritePipeline({
    ySort: false,
    workerCount: 2,
    packGpuSprites: PACK_GPU_SPRITES_PRERENDER,
    sortSprites: SORT_SPRITES_PRERENDER,
  });
  assert.equal(pipe.sortSprites, SORT_SPRITES_NONE);
  assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
});

test('resolveSpritePipeline: ySort on defaults to preRender pack and sort', () => {
  const pipe = resolveSpritePipeline({ ySort: 'cpu', workerCount: 1 });
  assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
  assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER);
});

test('resolveSpritePipeline: merge with N=1 becomes preRender', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
      workerCount: 1,
      sortSprites: SORT_SPRITES_PRERENDER_MERGE,
    });
    assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /preRenderMerge/);
});

test('resolveSpritePipeline: pixi sort forces pixi pack', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
      workerCount: 2,
      packGpuSprites: PACK_GPU_SPRITES_PRERENDER,
      sortSprites: SORT_SPRITES_PIXI,
    });
    assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PIXI);
    assert.equal(pipe.sortSprites, SORT_SPRITES_PIXI);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
});

test('resolveSpritePipeline: merge needs preRender pack', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: true,
      workerCount: 2,
      packGpuSprites: PACK_GPU_SPRITES_PIXI,
      sortSprites: SORT_SPRITES_PRERENDER_MERGE,
    });
    assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
    assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER_MERGE);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
});

test('PRE_RENDER_DEFAULTS: pack and sort stay on preRender; worker count stays 1', () => {
  assert.equal(PRE_RENDER_DEFAULTS.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
  assert.equal(PRE_RENDER_DEFAULTS.sortSprites, SORT_SPRITES_PRERENDER);
  assert.equal(PRE_RENDER_DEFAULTS.numberOfPreRenderWorkers, 1);
});

test('resolveSpritePipeline: preRender sort forces preRender pack', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
      workerCount: 2,
      packGpuSprites: PACK_GPU_SPRITES_PIXI,
      sortSprites: SORT_SPRITES_PRERENDER,
    });
    assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
    assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /SoA is not permuted/);
});

test('resolveSpritePipeline: ySort off forces none even if merge is requested', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: false,
      workerCount: 4,
      sortSprites: SORT_SPRITES_PRERENDER_MERGE,
    });
    assert.equal(pipe.sortSprites, SORT_SPRITES_NONE);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 0);
});

test('resolveSpritePipeline: garbage pack and sort log WeedJS errors', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
      workerCount: 2,
      packGpuSprites: 'gpu',
      sortSprites: 'radix',
    });
    assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
    assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 2);
  assert.equal(errs[0], errorPackGpuSpritesInvalid('gpu'));
  assert.equal(errs[1], errorSortSpritesInvalid('radix'));
});
