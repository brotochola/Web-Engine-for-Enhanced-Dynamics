// Import first, then load demo modules with a dynamic import():
//
//   import '../helpers/registerWebRoot.mjs';
//   const { PlanetPull } = await import('../../demos/planetPhysicsScene/gameObjects/planetPull.js');
//
// Static imports of a demo would resolve before the hook is registered.
import { register } from 'node:module';

register('./webRootHooks.mjs', import.meta.url);
