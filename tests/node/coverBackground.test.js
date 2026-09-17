import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COVER_BG_DEFAULT_MARGIN,
  COVER_BG_DEFAULT_PARALLAX,
  COVER_BG_DEFAULT_ZOOM_PARALLAX,
  coverBackgroundTransform,
  normalizeCoverBackgroundOptions,
} from '../../src/render/coverBackground.js';

function assertCovers(t, canvasW, canvasH, texW, texH) {
  const w = texW * t.scale;
  const h = texH * t.scale;
  assert.ok(t.x <= 1e-9, 'left edge at or left of canvas');
  assert.ok(t.y <= 1e-9, 'top edge at or above canvas');
  assert.ok(t.x + w + 1e-9 >= canvasW, 'right edge at or right of canvas');
  assert.ok(t.y + h + 1e-9 >= canvasH, 'bottom edge at or below canvas');
}

test('normalizeCoverBackgroundOptions: string and defaults', () => {
  const a = normalizeCoverBackgroundOptions('landscape');
  assert.equal(a.texture, 'landscape');
  assert.equal(a.parallaxX, COVER_BG_DEFAULT_PARALLAX);
  assert.equal(a.parallaxY, COVER_BG_DEFAULT_PARALLAX);
  assert.equal(a.margin, COVER_BG_DEFAULT_MARGIN);
  assert.equal(a.zoomParallax, COVER_BG_DEFAULT_ZOOM_PARALLAX);
  const b = normalizeCoverBackgroundOptions({
    texture: 'sky',
    parallax: { x: 0.2, y: 0.05 },
    margin: 0.3,
    zoomParallax: 0.4,
  });
  assert.equal(b.texture, 'sky');
  assert.equal(b.parallaxX, 0.2);
  assert.equal(b.parallaxY, 0.05);
  assert.equal(b.margin, 0.3);
  assert.equal(b.zoomParallax, 0.4);
});

const BASE = {
  canvasW: 800,
  canvasH: 600,
  texW: 400,
  texH: 400,
  zoom: 1,
  cameraX: 0,
  cameraY: 0,
  worldW: 4000,
  worldH: 3000,
  parallaxX: 0.15,
  parallaxY: 0.15,
  margin: 0.2,
};

test('coverBackgroundTransform: zoom=1 larger than coverFit; zoom 2 larger; zoom 0.5 still covers', () => {
  const coverFit = Math.max(BASE.canvasW / BASE.texW, BASE.canvasH / BASE.texH);
  const z1 = coverBackgroundTransform(BASE);
  assert.ok(z1.scale > coverFit);
  assert.ok(Math.abs(z1.scale - coverFit * (1 + BASE.margin)) < 1e-9);
  assertCovers(z1, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);

  const z2 = coverBackgroundTransform({ ...BASE, zoom: 2 });
  assert.ok(z2.scale > z1.scale);
  assertCovers(z2, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);

  const zHalf = coverBackgroundTransform({ ...BASE, zoom: 0.5 });
  assert.ok(zHalf.scale >= coverFit - 1e-9);
  assertCovers(zHalf, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);
});

test('coverBackgroundTransform: zoomParallax 0 stays at zoom=1 size; 0.35 slower than camera', () => {
  const coverFit = Math.max(BASE.canvasW / BASE.texW, BASE.canvasH / BASE.texH);
  const glued = coverBackgroundTransform({ ...BASE, zoom: 2, zoomParallax: 0 });
  const z1 = coverBackgroundTransform({ ...BASE, zoom: 1, zoomParallax: 0 });
  assert.ok(Math.abs(glued.scale - z1.scale) < 1e-9);
  assertCovers(glued, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);

  const zp = 0.35;
  const slow = coverBackgroundTransform({ ...BASE, zoom: 2, zoomParallax: zp });
  const full = coverBackgroundTransform({ ...BASE, zoom: 2, zoomParallax: 1 });
  const expected = coverFit * (1 + BASE.margin) * (1 + (2 - 1) * zp);
  assert.ok(Math.abs(slow.scale - expected) < 1e-9);
  assert.ok(slow.scale < full.scale);
  assertCovers(slow, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);
});

test('coverBackgroundTransform: pan is linear in eased camera, covers at world ends', () => {
  const cam0 = 1500;
  const cam1 = 1700;
  const a = coverBackgroundTransform({ ...BASE, cameraX: cam0 });
  const b = coverBackgroundTransform({ ...BASE, cameraX: cam1 });
  const mid = coverBackgroundTransform({ ...BASE, cameraX: (cam0 + cam1) * 0.5 });
  const expectedDx = -(cam1 - cam0) * BASE.zoom * BASE.parallaxX;
  assert.ok(Math.abs((b.x - a.x) - expectedDx) < 1e-6, 'bg screen delta = camera screen delta * parallax');
  assert.ok(Math.abs(mid.x - (a.x + b.x) * 0.5) < 1e-6, 'offset linear in camera (inherits easing)');
  assertCovers(a, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);
  assertCovers(b, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);

  const glued = coverBackgroundTransform({ ...BASE, cameraX: 0, parallaxX: 0, parallaxY: 0 });
  const glued2 = coverBackgroundTransform({ ...BASE, cameraX: 2000, parallaxX: 0, parallaxY: 0 });
  assert.equal(glued.x, glued2.x);

  const far = coverBackgroundTransform({
    ...BASE,
    cameraX: 1e6,
    cameraY: 1e6,
    parallaxX: 1,
    parallaxY: 1,
  });
  assertCovers(far, BASE.canvasW, BASE.canvasH, BASE.texW, BASE.texH);
});

test('pixi_worker: cover type + look RT transparent clear', () => {
  const pixi = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/workers/pixiWorker.js'),
    'utf8'
  );
  assert.match(pixi, /case 'cover':/);
  assert.match(pixi, /_createCoverScenery/);
  assert.match(pixi, /_applyCoverTransform/);
  assert.match(pixi, /_clearTransparent = \[0, 0, 0, 0\]/);
  assert.match(pixi, /clearColor: this\._clearTransparent/);
});

test('Scene.applyConfiguredContent is wired; setBackground is gone', async () => {
  const { Scene } = await import('../../src/core/scene.js');
  assert.equal(Scene.prototype.setBackground, undefined);
  const src = readFileSync(new URL('../../src/core/scene.js', import.meta.url), 'utf8');
  assert.match(src, /Layer\.applyConfiguredContent/);
});
