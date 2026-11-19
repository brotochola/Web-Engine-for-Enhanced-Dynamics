// lighting.shadowSamples: the shadow maps' taps a light pixel averages, 1 to 9 of the 3 x 3 texels around its point, the
// same layout in GLSL and WGSL at the three lookups (the sun's map, a lamp's tile, a lamp's tile for a floor point); 5 is
// the cross the pass always read, in its order; pixelArt reads one. lighting.lightCullingTileSize's range beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { lightingSource, shadowTapsOf } from '../../src/render/faceMap.js';
import { LIGHTING_DEFAULTS, lightCullingTileSizeOf, shadowSamplesOf } from '../../src/util/configDefaults.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
const FLAGS = { faces: true, sunMap: true, selfShadow: true, lampMap: true, ids: true, tiles: true };

// Each language's three lookups: the call each tap makes and the offsets as the language writes them, in texels.
const LANGS = [
  {
    file: 'lightingBasic.frag.glsl',
    sites: [/lit \+= sunTap\(uv(.*?), above, selfId\);/g, /lit \+= lampTap\(cell, uv(.*?), h, toAtlas, bound, selfId\);/g,
      /lit \+= lampTap\(cell, uv(.*?), h, toAtlas, 0\.5 \+ 0\.5 \/ 255\.0, 0\.0\);/g],
    offsets: [
      { '': [0, 0], ' + vec2(texel.x, 0.0)': [1, 0], ' - vec2(texel.x, 0.0)': [-1, 0], ' + vec2(0.0, texel.y)': [0, 1],
        ' - vec2(0.0, texel.y)': [0, -1], ' + texel': [1, 1], ' - texel': [-1, -1], ' + vec2(texel.x, -texel.y)': [1, -1],
        ' - vec2(texel.x, -texel.y)': [-1, 1] },
      { '': [0, 0], ' + vec2(2.0 * h, 0.0)': [1, 0], ' - vec2(2.0 * h, 0.0)': [-1, 0], ' + vec2(0.0, 2.0 * h)': [0, 1],
        ' - vec2(0.0, 2.0 * h)': [0, -1], ' + vec2(2.0 * h)': [1, 1], ' - vec2(2.0 * h)': [-1, -1],
        ' + vec2(2.0 * h, -2.0 * h)': [1, -1], ' - vec2(2.0 * h, -2.0 * h)': [-1, 1] },
    ],
  },
  {
    file: 'lightingBasic.wgsl',
    sites: [/lit \+= sunMapLit\(c(.*?), size, above, selfId\);/g, /lit \+= lampTap\(c(.*?), lo, hi, bound, selfId\);/g,
      /lit \+= lampTap\(c(.*?), lo, hi, 0\.5 \+ 0\.5 \/ 255\.0, 0\.0\);/g],
    offsets: [
      { '': [0, 0], ' + vec2<i32>(1, 0)': [1, 0], ' - vec2<i32>(1, 0)': [-1, 0], ' + vec2<i32>(0, 1)': [0, 1],
        ' - vec2<i32>(0, 1)': [0, -1], ' + vec2<i32>(1, 1)': [1, 1], ' - vec2<i32>(1, 1)': [-1, -1],
        ' + vec2<i32>(1, -1)': [1, -1], ' - vec2<i32>(1, -1)': [-1, 1] },
    ],
  },
];

/** The texels (as "dx,dy") each of a source's three lookups reads, in the order it adds them. */
function tapsAt(lang, src) {
  return lang.sites.map((re, i) => {
    const table = lang.offsets[Math.min(i, lang.offsets.length - 1)];
    return [...src.matchAll(re)].map((m) => {
      assert.ok(m[1] in table, `${lang.file}: an offset the test knows (${m[1]})`);
      return table[m[1]].join(',');
    });
  });
}

const CROSS = ['0,0', '1,0', '-1,0', '0,1', '0,-1'];

test('each count of samples takes that many texels of the 3 x 3, symmetric about the point, the even counts no centre', () => {
  for (let n = 1; n <= 9; n++) {
    const t = shadowTapsOf(n);
    const pairs = [t.x, t.y, t.diagonal, t.antidiagonal].filter(Boolean).length;
    assert.equal(t.count, n);
    assert.equal(pairs * 2 + (t.center ? 1 : 0), n, `${n}: the taps add up`);
    assert.equal(t.center, n % 2 === 1, `${n}: the centre for odd counts`);
  }
  assert.deepEqual([0, -3, 12, 4.6, 4.4, NaN].map((v) => shadowTapsOf(v).count), [1, 1, 9, 5, 4, 1], 'clamped and rounded');
});

for (const lang of LANGS) {
  test(`${lang.file}: every count reads its texels at the sun's and the lamps' three lookups and averages them`, () => {
    const source = shader(lang.file);
    for (let n = 1; n <= 9; n++) {
      const src = lightingSource(source, { ...FLAGS, shadowSamples: n });
      assert.doesNotMatch(src, /SHADOW_TAP/, `${n}: every block and the weight resolved`);
      const taps = tapsAt(lang, src);
      for (const site of taps) {
        assert.equal(site.length, n, `${n}: ${n} taps at each lookup`);
        assert.equal(new Set(site).size, n, `${n}: no texel twice`);
        for (const tap of site) {
          const [dx, dy] = tap.split(',');
          assert.ok(site.includes(`${-dx},${-dy}`), `${n}: ${tap}'s mirror is read too`);
        }
      }
      assert.deepEqual(taps[1], taps[0], `${n}: the lamps read the sun's layout`);
      assert.deepEqual(taps[2], taps[0], `${n}: the floor's lookup too`);
      const weight = (1 / n).toFixed(9);
      assert.equal(src.split(`lit * ${weight}`).length - 1, 3, `${n}: the average over ${n}`);
    }
  });

  test(`${lang.file}: the default reads the cross the pass always read, in its order; pixelArt one texel whatever the count`, () => {
    const source = shader(lang.file);
    const plain = lightingSource(source, FLAGS);
    assert.equal(plain, lightingSource(source, { ...FLAGS, shadowSamples: LIGHTING_DEFAULTS.shadowSamples }));
    assert.equal(LIGHTING_DEFAULTS.shadowSamples, 5);
    for (const site of tapsAt(lang, plain)) assert.deepEqual(site, CROSS);
    const art = lightingSource(source, { ...FLAGS, pixelArt: true, shadowSamples: 9 });
    for (const site of tapsAt(lang, art)) assert.deepEqual(site, ['0,0']);
    assert.equal(art.split('lit * 1.000000000').length - 1, 3);
  });
}

test('a scene\'s shadowSamples and lightCullingTileSize: whole numbers in range, the default\'s when missing or not a number', () => {
  assert.equal(shadowSamplesOf(undefined), 5);
  assert.equal(shadowSamplesOf({}), 5);
  assert.equal(shadowSamplesOf({ shadowSamples: '9' }), 5);
  assert.equal(shadowSamplesOf({ shadowSamples: NaN }), 5);
  assert.deepEqual([1, 9, 0, 14, 2.6, -1].map((v) => shadowSamplesOf({ shadowSamples: v })), [1, 9, 1, 9, 3, 1]);
  assert.equal(lightCullingTileSizeOf(undefined), 16);
  assert.equal(lightCullingTileSizeOf({ lightCullingTileSize: null }), 16);
  assert.deepEqual([8, 32, 24, 1, 1000, 12.4].map((v) => lightCullingTileSizeOf({ lightCullingTileSize: v })), [8, 32, 24, 4, 256, 12]);
});
