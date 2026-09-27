import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeYSort,
  resolveYSort,
  ySortEnabled,
  assertSceneRendererConfig,
  errorYSortInvalid,
} from '../../src/render/rendererBackend.js';

test('normalizeYSort: false / true / cpu', () => {
  assert.equal(normalizeYSort(false), false);
  assert.equal(normalizeYSort(undefined), false);
  assert.equal(normalizeYSort(''), false);
  assert.equal(normalizeYSort(true), 'cpu');
  assert.equal(normalizeYSort('cpu'), 'cpu');
});

test('normalizeYSort: garbage logs WeedJS error and falls back to false', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    assert.equal(normalizeYSort('radix'), false);
    assert.equal(normalizeYSort('bitonic'), false);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 2);
  assert.equal(errs[0], errorYSortInvalid('radix'));
  assert.equal(errs[1], errorYSortInvalid('bitonic'));
});

test('resolveYSort: unknown names are off on either backend', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    assert.equal(resolveYSort('bitonic', 'webgl'), false);
    assert.equal(resolveYSort('bitonic', 'webgpu'), false);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 2);
});

test('ySortEnabled', () => {
  assert.equal(ySortEnabled(false), false);
  assert.equal(ySortEnabled(true), true);
  assert.equal(ySortEnabled('cpu'), true);
  assert.equal(ySortEnabled('bitonic'), false);
});

test('assertSceneRendererConfig writes resolved ySort', () => {
  const cfg = { renderer: { backend: 'webgl', ySort: 'cpu' } };
  assert.equal(assertSceneRendererConfig(cfg), 'webgl');
  assert.equal(cfg.renderer.ySort, 'cpu');
});
