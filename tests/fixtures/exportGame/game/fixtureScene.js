// A tiny game for tests/node/exportGame.test.js (the editor's Export, ED-32): the engine imported by its site path,
// an entity class in a module of its own, two levels, and assets of each kind the export copies.
import WEED from '/src/index.js';
import { Crate } from './entities/crate.js';

const { Scene } = WEED;

export class FixtureScene extends Scene {
  static config = {
    worldWidth: 800,
    worldHeight: 600,
    layers: { glow: { zIndex: 2, shader: { fragment: '/tests/fixtures/exportGame/shaders/glow.frag' } } },
  };

  static assets = {
    textures: { crate: '/tests/fixtures/exportGame/img/crate.png' },
  };

  static audios = { thud: '/tests/fixtures/exportGame/audio/thud.wav' };

  static entities = [[Crate, 8]];

  static defaultSceneFile = './levels/a.scene.json';
}

/** Not a scene: exported with the module, as it is. */
export const FIXTURE_LEVELS = 2;
