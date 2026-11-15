// DX-PIXELSHADOW: lighting.pixelArt's light pass: every term at the world pixel's centre and the maps read with one tap;
// off, the five-tap pass as before. Both backends' sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { lightingSource } from '../../src/render/faceMap.js';

const GLSL = fs.readFileSync('src/shaders/lightingBasic.frag.glsl', 'utf8');
const WGSL = fs.readFileSync('src/shaders/lightingBasic.wgsl', 'utf8');
const FLAGS = { faces: true, sunMap: true, selfShadow: true, lampMap: true, ids: true };

for (const [name, source] of [['GLSL', GLSL], ['WGSL', WGSL]]) {
  test(`DX-PIXELSHADOW (${name}): pixel art snaps the point and reads each map once`, () => {
    const on = lightingSource(source, { ...FLAGS, pixelArt: true });
    assert.match(on, /fragWorld = floor\(fragWorld\) \+ 0\.5;/);
    assert.doesNotMatch(on, /lit \* 0\.2/, 'no five-tap average is left');
    assert.doesNotMatch(on, /#if !?PIXELART/, 'every block resolved');
  });

  test(`DX-PIXELSHADOW (${name}): off, the pass keeps its five taps and its point`, () => {
    const off = lightingSource(source, { ...FLAGS, pixelArt: false });
    assert.doesNotMatch(off, /floor\(fragWorld\)/);
    // The sun map, the lamps' map and its floor-only lookup (DX-LAMPPANO) average five taps.
    assert.equal(off.match(/lit \* 0\.2/g)?.length, 3, 'every map lookup averages five taps');
  });
}
