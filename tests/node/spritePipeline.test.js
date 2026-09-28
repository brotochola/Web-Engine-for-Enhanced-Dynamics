import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSpritePipeline,
  PACK_GPU_SPRITES_PRERENDER,
  PACK_GPU_SPRITES_PIXI,
  SORT_SPRITES_NONE,
  SORT_SPRITES_PRERENDER,
  SORT_SPRITES_PIXI,
  errorPackGpuSpritesInvalid,
  errorSortSpritesInvalid,
} from '../../src/render/rendererBackend.js';
import { PRE_RENDER_DEFAULTS } from '../../src/util/configDefaults.js';

test('resolveSpritePipeline: ySort off forces sort none', () => {
  const pipe = resolveSpritePipeline({
    ySort: false,
    packGpuSprites: PACK_GPU_SPRITES_PRERENDER,
    sortSprites: SORT_SPRITES_PRERENDER,
  });
  assert.equal(pipe.sortSprites, SORT_SPRITES_NONE);
  assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
});

test('resolveSpritePipeline: ySort on defaults to preRender pack and sort', () => {
  const pipe = resolveSpritePipeline({ ySort: 'cpu' });
  assert.equal(pipe.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
  assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER);
});

test('resolveSpritePipeline: retired preRenderMerge is an unknown sort', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
      sortSprites: 'preRenderMerge',
    });
    assert.equal(pipe.sortSprites, SORT_SPRITES_PRERENDER);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.equal(errs[0], errorSortSpritesInvalid('preRenderMerge'));
});

test('resolveSpritePipeline: pixi sort forces pixi pack', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
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

test('PRE_RENDER_DEFAULTS: pack and sort stay on preRender', () => {
  assert.equal(PRE_RENDER_DEFAULTS.packGpuSprites, PACK_GPU_SPRITES_PRERENDER);
  assert.equal(PRE_RENDER_DEFAULTS.sortSprites, SORT_SPRITES_PRERENDER);
  assert.equal(PRE_RENDER_DEFAULTS.numberOfPreRenderWorkers, undefined);
  assert.equal(PRE_RENDER_DEFAULTS.renderGrid, undefined);
});

test('resolveSpritePipeline: preRender sort forces preRender pack', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
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

test('resolveSpritePipeline: ySort off forces none and still rejects an unknown sort', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: false,
      sortSprites: 'preRenderMerge',
    });
    assert.equal(pipe.sortSprites, SORT_SPRITES_NONE);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.equal(errs[0], errorSortSpritesInvalid('preRenderMerge'));
});

test('resolveSpritePipeline: garbage pack and sort log WeedJS errors', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    const pipe = resolveSpritePipeline({
      ySort: 'cpu',
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
