// A scene that reaches into the engine's sources: the export refuses it (tests/node/exportGame.test.js).
import WEED from '/src/index.js';
import { parseSceneFile } from '/src/core/sceneFile.js';

export class InternalScene extends WEED.Scene {
  static parse = parseSceneFile;
}
