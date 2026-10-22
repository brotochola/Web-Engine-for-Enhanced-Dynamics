import test from 'node:test';
import assert from 'node:assert/strict';

import { orderAtlasByDeclaration } from '../../src/core/spriteSheetRegistry.js';

// Spritesheet ids and atlas animation indices come from insertion order, and
// assets were inserted as their loads finished. Components store those numbers
// (saves, hot reload), so after a reload a saved ant could name the "fire"
// sheet ("Animation 'se' not found in 'fire'"). The order is now the declared one.

const assetsConfig = {
  ball: '/ball.png',
  star: '/star.png',
  spritesheets: { car: {}, car_red: {}, bicho: {} },
};

function loadedIn(order) {
  const images = {
    ball: { name: 'ball' },
    star: { name: 'star' },
    car: [{ name: 'car_f1' }, { name: 'car_f2' }],
    car_red: [{ name: 'car_red_f1' }],
    bicho: [{ name: 'bicho_f1' }, { name: 'bicho_f2' }],
  };
  const anims = {
    ball: ['ball'],
    star: ['star'],
    car: { car_drive: ['car_f1', 'car_f2'] },
    car_red: { car_red_drive: ['car_red_f1'] },
    bicho: { bicho_walk: ['bicho_f1'], bicho_run: ['bicho_f2'] },
  };
  const imagesToPack = [];
  const animations = { _empty: ['_empty'] };
  const proxySheets = {};
  for (const asset of order) {
    if (Array.isArray(images[asset])) {
      imagesToPack.push(...images[asset]);
      Object.assign(animations, anims[asset]);
      proxySheets[asset] = { sheet: asset };
    } else {
      imagesToPack.push(images[asset]);
      animations[asset] = anims[asset];
    }
  }
  orderAtlasByDeclaration(assetsConfig, imagesToPack, animations, proxySheets);
  return { images: imagesToPack.map((i) => i.name), animations: Object.keys(animations), proxies: Object.keys(proxySheets) };
}

test('the atlas follows the declared order whatever order the loads finished in', () => {
  const a = loadedIn(['bicho', 'star', 'car_red', 'ball', 'car']);
  const b = loadedIn(['car', 'ball', 'bicho', 'car_red', 'star']);
  assert.deepEqual(a, b);
  assert.deepEqual(a.animations, ['_empty', 'ball', 'star', 'car_drive', 'car_red_drive', 'bicho_walk', 'bicho_run']);
  assert.deepEqual(a.proxies, ['car', 'car_red', 'bicho']);
  assert.deepEqual(a.images, ['ball', 'star', 'car_f1', 'car_f2', 'car_red_f1', 'bicho_f1', 'bicho_f2']);
});
