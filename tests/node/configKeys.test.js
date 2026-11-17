// DX-GUARDS C1: a config key the engine does not read does nothing, and a misspelt one used to be ignored in silence.
// The scene names each one at load, once, with the key it may have meant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as DEFAULTS from '../../src/util/configDefaults.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import {
  ANY,
  NAMED,
  SCENE_CONFIG_SCHEMA,
  keyDistance,
  unknownConfigKeys,
  unknownConfigKeyText,
} from '../../src/util/configKeys.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    fn();
  } finally {
    console.warn = saved;
  }
  return lines;
}

test('a misspelt key is named with the key it may have meant', () => {
  const [item] = unknownConfigKeys({ renderer: { backed: 'webgl' } });
  assert.equal(item.path, 'renderer.backed');
  assert.equal(item.nearest, 'backend');
  assert.equal(
    unknownConfigKeyText('Town', item),
    'Town.config.renderer.backed is not a config key, so it does nothing. Did you mean renderer.backend?',
  );
  assert.equal(unknownConfigKeys({ ligthing: { enabled: true } })[0].nearest, 'lighting', 'a top-level section');
  assert.equal(unknownConfigKeys({ physics: { liquidFun: { maxcount: 9 } } })[0].nearest, 'maxCount', 'nested, any case');
  assert.equal(unknownConfigKeys({ lighting: { sun: { dayCycle: { enable: true } } } })[0].nearest, 'enabled');
});

test('a key no engine section reads is named with the section\'s keys, or where it belongs', () => {
  const [dead] = unknownConfigKeys({ logic: { numberOfEntitiesPerJob: 250 } });
  assert.equal(dead.nearest, null);
  assert.match(unknownConfigKeyText('Bichos', dead), /^Bichos\.config\.logic\.numberOfEntitiesPerJob is not a config key, so it does nothing\. The keys of logic: numberOfLogicWorkers, /);
  const [moved] = unknownConfigKeys({ particle: { maxDecorations: 4 } });
  assert.equal(moved.elsewhere, 'decoration.maxDecorations');
  assert.equal(
    unknownConfigKeyText('Probe', moved),
    'Probe.config.particle.maxDecorations is not a config key there, so it does nothing; decoration.maxDecorations is.',
  );
});

test('layers and audio channels take the game\'s names, and their own keys are checked', () => {
  assert.deepEqual(unknownConfigKeys({ layers: { fire: { zIndex: 4, blendMode: 2, shader: { fragment: 'x', uniforms: { uHeat: 1 } } } } }), []);
  assert.equal(unknownConfigKeys({ layers: { fire: { blendmode: 2 } } })[0].nearest, 'blendMode');
  assert.deepEqual(unknownConfigKeys({ audio: { channels: { sfx: { volume: 1, compressor: { ratio: 2 } } } } }), []);
  assert.equal(unknownConfigKeys({ audio: { channels: { sfx: { volum: 1 } } } })[0].path, 'audio.channels.sfx.volum');
});

test('a retired key says it does nothing any more', () => {
  const [item] = unknownConfigKeys({ renderer: { tilemapCull: true } });
  assert.match(unknownConfigKeyText('Map', item), /^Map\.config\.renderer\.tilemapCull does nothing any more \(.+\)\. Remove it\.$/);
});

test('the game\'s own top-level data is not named; the engine\'s wasm switches have their own warning', () => {
  assert.deepEqual(unknownConfigKeys({ meltBench: { list: true }, levels: [1, 2], wasm: { nope: true } }), []);
});

test('every default is a known key', () => {
  const sections = {
    physics: DEFAULTS.PHYSICS_DEFAULTS, spatial: DEFAULTS.SPATIAL_DEFAULTS, particle: DEFAULTS.PARTICLE_DEFAULTS,
    decoration: DEFAULTS.DECORATION_DEFAULTS, bullet: DEFAULTS.BULLET_DEFAULTS, tween: DEFAULTS.TWEEN_DEFAULTS,
    audio: DEFAULTS.AUDIO_DEFAULTS, assets: DEFAULTS.ASSETS_DEFAULTS, logic: DEFAULTS.LOGIC_DEFAULTS,
    renderer: DEFAULTS.RENDERER_DEFAULTS, preRender: DEFAULTS.PRE_RENDER_DEFAULTS, lighting: DEFAULTS.LIGHTING_DEFAULTS,
    navigation: DEFAULTS.NAVIGATION_DEFAULTS, debug: DEFAULTS.DEBUG_DEFAULTS,
  };
  const config = { ...DEFAULTS.SCENE_DEFAULTS, ...JSON.parse(JSON.stringify(sections)), layers: { fx: { ...DEFAULTS.LAYER_DEFAULTS } } };
  assert.deepEqual(unknownConfigKeys(config), []);
});

test('every config.<section>.<key> the engine reads is a known key', () => {
  const unknown = [];
  for (const name of readdirSync(srcDir, { recursive: true })) {
    if (typeof name !== 'string' || !name.endsWith('.js') || name.includes('vendor')) continue;
    const src = readFileSync(path.join(srcDir, name), 'utf8');
    for (const [section, node] of Object.entries(SCENE_CONFIG_SCHEMA)) {
      if (node === true || node === ANY || node[NAMED]) continue;
      const direct = new RegExp(String.raw`\b(?:config|sceneConfig|_config)\??\.` + section + String.raw`\??\.(\w+)`, 'g');
      for (const m of src.matchAll(direct)) if (!Object.hasOwn(node, m[1])) unknown.push(`${name}: ${section}.${m[1]}`);
      const alias = new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:this\.)?(?:config|sceneConfig|_config|data\.config|scene\.config)\??\.` + section + String.raw`\s*(?:\|\||\?\?|;|,|\)|$)`, 'gm');
      for (const a of src.matchAll(alias)) {
        for (const m of src.matchAll(new RegExp(String.raw`\b` + a[1] + String.raw`\??\.(\w+)`, 'g'))) {
          if (!Object.hasOwn(node, m[1])) unknown.push(`${name}: ${section}.${m[1]} (as ${a[1]})`);
        }
      }
    }
  }
  assert.deepEqual(unknown, [], 'add the key to src/util/configKeys.js (or give it a default)');
});

test('keyDistance counts a swap of two letters as one, and ignores case', () => {
  assert.equal(keyDistance('ligthing', 'lighting'), 1);
  assert.equal(keyDistance('BACKEND', 'backend'), 0);
  assert.equal(keyDistance('backed', 'backend'), 1);
});

class Crate extends GameObject {}

test('a scene names each unknown key once, at load, and a right config is silent', () => {
  class Town extends Scene {
    static entities = [[Crate, 4]];
    static config = { worldWidth: 2000, worldHeight: 2000, renderer: { backed: 'webgl' }, logic: { numberOfLogicWorker: 2 } };
  }
  const lines = warningsOf(() => {
    new Town({});
    new Town({});
  });
  assert.deepEqual(lines, [
    'WeedJS: Town.config.renderer.backed is not a config key, so it does nothing. Did you mean renderer.backend?',
    'WeedJS: Town.config.logic.numberOfLogicWorker is not a config key, so it does nothing. Did you mean logic.numberOfLogicWorkers?',
  ]);
  class Fine extends Scene {
    static entities = [[Crate, 4]];
    static config = { worldWidth: 2000, worldHeight: 2000, renderer: { backend: 'webgl' }, logic: { numberOfLogicWorkers: 2 }, myLevels: [1] };
  }
  assert.deepEqual(warningsOf(() => new Fine({})), []);
});
