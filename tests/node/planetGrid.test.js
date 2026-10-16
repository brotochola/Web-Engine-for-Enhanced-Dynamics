import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedResource } from '../../src/core/sharedResource.js';
import { PlanetGrid, CELL, GRID } from '../../demos/planetScene/planetGrid.js';

function teardown() {
  SharedResource.resetAll();
  PlanetGrid.cols = GRID;
  PlanetGrid.rows = GRID;
  PlanetGrid.cell = CELL;
  PlanetGrid.radius = 0;
  PlanetGrid.cx = GRID >> 1;
  PlanetGrid.cy = GRID >> 1;
}

test('get/set round-trip and a second write does not re-dirty', () => {
  try {
    PlanetGrid.attach(64, 64);
    assert.equal(PlanetGrid.get(3, 4), 0);
    PlanetGrid.set(3, 4, 1);
    assert.equal(PlanetGrid.get(3, 4), 1);
    const head = PlanetGrid.dirtyMeta.load(0);
    assert.equal(head, 1);
    PlanetGrid.set(3, 4, 1);
    assert.equal(PlanetGrid.dirtyMeta.load(0), head);
    PlanetGrid.takeDirtyRect();
    PlanetGrid.set(3, 4, 0);
    assert.equal(PlanetGrid.get(3, 4), 0);
    assert.equal(PlanetGrid.dirtyMeta.load(0), 2);
    assert.equal(PlanetGrid.get(-1, 0), 0);
    assert.equal(PlanetGrid.get(64, 0), 0);
  } finally {
    teardown();
  }
});

test('fillRow writes a byte-aligned span and leaves the neighbors clear', () => {
  try {
    PlanetGrid.attach(64, 64);
    PlanetGrid.fillRow(2, 1, 10);
    assert.equal(PlanetGrid.get(0, 2), 0);
    assert.equal(PlanetGrid.get(1, 2), 1);
    assert.equal(PlanetGrid.get(8, 2), 1);
    assert.equal(PlanetGrid.get(10, 2), 1);
    assert.equal(PlanetGrid.get(11, 2), 0);
    assert.equal(PlanetGrid.get(1, 3), 0);
  } finally {
    teardown();
  }
});

test('configure fills the disk and marks chunks dirty', () => {
  try {
    PlanetGrid.attach(128, 128);
    assert.equal(PlanetGrid.configure(128, 40), true);
    assert.equal(PlanetGrid.get(64, 64), 1);
    assert.equal(PlanetGrid.get(0, 0), 0);
    assert.equal(PlanetGrid.get(64, 64 + 40 + 6), 0);
    assert.ok(PlanetGrid.dirtyMeta.load(0) !== PlanetGrid.dirtyMeta.load(1));
    assert.equal(PlanetGrid.params[0], 40);
    assert.equal(PlanetGrid.params[3], CELL);
    const rect = PlanetGrid.takeDirtyRect();
    assert.ok(rect);
    assert.ok(rect.tw > 0 && rect.th > 0);
    assert.equal(PlanetGrid.takeDirtyRect(), null);
    PlanetGrid.set(10, 10, 1);
    const again = PlanetGrid.takeDirtyRect();
    assert.ok(again);
    assert.equal(again.tw, 4);
    assert.equal(again.th, 32);
  } finally {
    teardown();
  }
});
