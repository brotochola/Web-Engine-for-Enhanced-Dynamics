// DX-GUARDS C10's fixture: a scene file that imports the engine by a bare specifier (not this repo's own package name, which Node resolves to itself), as a page with an import map
// can and a worker cannot (tests/node/sceneScriptImports.test.js).
import WEED from 'weed-engine';

export const Loaded = WEED;
