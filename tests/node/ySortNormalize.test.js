import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeYSort,
  resolveYSort,
  ySortEnabled,
  assertSceneRendererConfig,
  errorYSortInvalid,
} from '../../src/render/rendererBackend.js';

test('normalizeYSort: false / true / cpu; bitonic becomes cpu', () => {
  assert.equal(normalizeYSort(false), false);
  assert.equal(normalizeYSort(undefined), false);
  assert.equal(normalizeYSort(''), false);
  assert.equal(normalizeYSort(true), 'cpu');
  assert.equal(normalizeYSort('cpu'), 'cpu');
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => { warns.push(String(m)); };
  try {
    assert.equal(normalizeYSort('bitonic'), 'cpu');
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /bitonic/);
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

test('resolveYSort: bitonic is the CPU painter on either backend', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => { warns.push(String(m)); };
  try {
    assert.equal(resolveYSort('bitonic', 'webgl'), 'cpu');
    assert.equal(resolveYSort('bitonic', 'webgpu'), 'cpu');
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 2);
});

test('ySortEnabled', () => {
  assert.equal(ySortEnabled(false), false);
  assert.equal(ySortEnabled(true), true);
  assert.equal(ySortEnabled('cpu'), true);
  assert.equal(ySortEnabled('bitonic'), false);
});

test('assertSceneRendererConfig writes resolved ySort', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => { warns.push(String(m)); };
  const cfg = { renderer: { backend: 'webgl', ySort: 'bitonic' } };
  try {
    assert.equal(assertSceneRendererConfig(cfg), 'webgl');
  } finally {
    console.warn = orig;
  }
  assert.equal(cfg.renderer.ySort, 'cpu');
  assert.match(warns[0], /bitonic/);
});
