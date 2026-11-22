/**
 * N-402: a scoreboard row whose scene uses an API an older base lacks names the oldest commit it runs on (scene.since),
 * and the scoreboard skips that scene against an older base instead of comparing different work (visPoly's walls,
 * which v0.14.0 ignored, read +1087 %; the DirectionalSprite scenes threw on v0.14.0's load and waited 320 s twice).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENGINE_FEATURES } from '../bench/engineFeatureCatalog.mjs';
import { BASE_TOO_OLD, baseLacksScene } from '../bench/runScoreboard.mjs';

test('a base older than the scene skips it; a base that has the commit, or a scene without since, runs', () => {
  const history = { v0140: new Set(['aaa']), main: new Set(['aaa', 'bbb']) };
  const isAncestor = (commit, rev) => history[rev].has(commit);
  const scene = { since: 'bbb' };
  const why = baseLacksScene(scene, 'v0140', isAncestor);
  assert.ok(why.startsWith(BASE_TOO_OLD));
  assert.match(why, /needs bbb or later, and v0140 is older/);
  assert.equal(baseLacksScene(scene, 'main', isAncestor), null);
  assert.equal(baseLacksScene({}, 'v0140', isAncestor), null);
  assert.equal(baseLacksScene(null, 'v0140', isAncestor), null);
});

test('the rows N-402 found carry their since, as commit ids', () => {
  const since = Object.fromEntries(ENGINE_FEATURES.filter((f) => f.scene?.since).map((f) => [f.id, f.scene.since]));
  for (const id of ['visPoly', 'flashlights']) assert.equal(since[id], '94e31445', id);
  for (const id of ['sunShadowMap', 'selfShadow', 'depthSort', 'unshaded']) assert.equal(since[id], '4bf4d21a', id);
  for (const value of Object.values(since)) assert.match(value, /^[0-9a-f]{7,40}$/);
});
