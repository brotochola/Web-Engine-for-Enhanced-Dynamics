import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeYSort,
  resolveYSort,
  ySortEnabled,
  assertSceneRendererConfig,
  errorYSortBitonicWebgl,
  errorYSortInvalid,
} from '../../src/render/rendererBackend.js';

test('normalizeYSort: false / true / cpu / bitonic', () => {
  assert.equal(normalizeYSort(false), false);
  assert.equal(normalizeYSort(undefined), false);
  assert.equal(normalizeYSort(''), false);
  assert.equal(normalizeYSort(true), 'cpu');
  assert.equal(normalizeYSort('cpu'), 'cpu');
  assert.equal(normalizeYSort('bitonic'), 'bitonic');
});

test('normalizeYSort: garbage logs WeedJS error and falls back to false', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    assert.equal(normalizeYSort('radix'), false);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.equal(errs[0], errorYSortInvalid('radix'));
});

test('resolveYSort: bitonic + webgl logs and falls back to cpu', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  try {
    assert.equal(resolveYSort('bitonic', 'webgl'), 'cpu');
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.equal(errs[0], errorYSortBitonicWebgl());
});

test('resolveYSort: bitonic + webgpu stays bitonic', () => {
  assert.equal(resolveYSort('bitonic', 'webgpu'), 'bitonic');
});

test('ySortEnabled', () => {
  assert.equal(ySortEnabled(false), false);
  assert.equal(ySortEnabled(true), true);
  assert.equal(ySortEnabled('cpu'), true);
  assert.equal(ySortEnabled('bitonic'), true);
});

test('assertSceneRendererConfig writes resolved ySort', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => { errs.push(String(m)); };
  const cfg = { renderer: { backend: 'webgl', ySort: 'bitonic' } };
  try {
    assert.equal(assertSceneRendererConfig(cfg), 'webgl');
  } finally {
    console.error = orig;
  }
  assert.equal(cfg.renderer.ySort, 'cpu');
  assert.equal(errs[0], errorYSortBitonicWebgl());
});
