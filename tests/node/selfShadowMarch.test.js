// E-423: lighting.selfShadowMarch picks the self-shadow's walk: 'steps' (6 fixed steps of 4 floor px from 8 px on) or
// 'dda' (every cell the ray crosses, in order, the pixel's own skipped). Each backend's light pass keeps exactly one of the
// two selfShadowToward bodies, with the ids filter inside it when the ids map is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lightingSource } from '../../src/render/faceMap.js';
import { LIGHTING_DEFAULTS, SELF_SHADOW_MARCHES, selfShadowMarchOf } from '../../src/util/configDefaults.js';
import { readEngineShader } from './engineShaderSources.mjs';

const FLAGS = { faces: true, sunMap: true, selfShadow: true, lampMap: true, ids: true };
const BACKENDS = [
  ['GLSL', readEngineShader('lightingBasic.frag.glsl'), 'float selfShadowToward(', 'for (int i = 2; i <= 9; i++)', 'texelFetch(uFaceIds, tc, 0)'],
  ['WGSL', readEngineShader('lightingBasic.wgsl'), 'fn selfShadowToward(', 'for (var i = 2; i <= 9; i++)', 'textureLoad(uFaceIds, tc, 0)'],
];

/** The source of the one selfShadowToward a pass keeps, from its head to the next function. */
function march(source, head) {
  const at = source.indexOf(head);
  assert.ok(at >= 0, 'the pass keeps selfShadowToward');
  assert.equal(source.indexOf(head, at + 1), -1, 'one selfShadowToward, not two');
  const end = source.indexOf('selfShadow(', at);
  assert.ok(end > at, 'selfShadow follows it');
  return source.slice(at, end);
}

for (const [name, source, head, stepsLoop, ddaIds] of BACKENDS) {
  test(`E-423 (${name}): 'dda' keeps the cell walk alone, with its ids filter`, () => {
    const out = lightingSource(source, { ...FLAGS, selfShadowMarch: 'dda' });
    const body = march(out, head);
    assert.ok(body.includes('step(tNext, tNext.yx)'), 'the next cell is the nearer edge\'s');
    assert.ok(body.includes('SELF_DDA_CELLS'), 'a fixed bound with a break');
    assert.ok(body.includes('if (run > 1.5)'), 'two cells under the ray in a row shade, a lone one does not');
    assert.ok(body.includes(ddaIds), 'only the pixel\'s own entity\'s heights count');
    assert.ok(!body.includes(stepsLoop), 'no fixed steps are left');
    assert.doesNotMatch(out, /#(if|endif) !?SELFSHADOW/, 'every self-shadow block resolved');
  });

  test(`E-423 (${name}): 'steps' and the default keep the fixed steps alone`, () => {
    const steps = lightingSource(source, { ...FLAGS, selfShadowMarch: 'steps' });
    assert.equal(lightingSource(source, FLAGS), steps, 'the default is the steps');
    const body = march(steps, head);
    assert.ok(body.includes(stepsLoop));
    assert.ok(!body.includes('tNext') && !steps.includes('SELF_DDA_CELLS'), 'no cell walk is left');
    assert.doesNotMatch(steps, /#(if|endif) !?SELFSHADOW/);
  });

  test(`E-423 (${name}): without self-shadow neither walk is in the pass, whatever the march`, () => {
    const off = lightingSource(source, { ...FLAGS, selfShadow: false, selfShadowMarch: 'dda' });
    assert.ok(!off.includes('selfShadowToward') && !off.includes('SELF_DDA_CELLS'));
    assert.doesNotMatch(off, /#(if|endif) !?SELFSHADOW/);
  });
}

test('E-423: lighting.selfShadowMarch reads \'steps\' or \'dda\', anything else the default (\'steps\')', () => {
  assert.equal(LIGHTING_DEFAULTS.selfShadowMarch, 'steps');
  assert.deepEqual([...SELF_SHADOW_MARCHES], ['steps', 'dda']);
  assert.equal(selfShadowMarchOf({ selfShadowMarch: 'dda' }), 'dda');
  assert.equal(selfShadowMarchOf({ selfShadowMarch: 'steps' }), 'steps');
  for (const v of [undefined, 'DDA', true, 1, null]) assert.equal(selfShadowMarchOf({ selfShadowMarch: v }), 'steps', String(v));
  assert.equal(selfShadowMarchOf(undefined), 'steps');
});
