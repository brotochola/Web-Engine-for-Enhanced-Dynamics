import WEED from '/src/index.js';
import { FLOOR_SCALE_Y, PICTURES, SOLIDS } from './checkShapes.js';
import { DEPTH as L, depthPlace } from './layouts.js';
import { anchorAtFoot, checkConfig, num, param, sheet } from './checkScene.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

/**
 * depthSortCheck's still scene (DX-DEPTH, plan §8.2): a table turned 45 degrees (`?object=table`) or a barn turned 20
 * (`?object=barn`), with their height maps, and a person (no maps: it stands at its foot) at place `?pos=` 0..11 on a
 * circle around it. No light, so each pixel is a tint: the person red, the object blue, the floor white. Per-pixel depth
 * on (renderer.pixelDepth). depthSortCheck.mjs works out which of the two each pixel should show. `?backend=webgpu`.
 */
export const OBJECT = param('object') === 'barn' ? 'barn' : 'table';
export const POS = Math.max(0, Math.min(L.positions - 1, Math.floor(num('pos', 0))));

class Thing extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet(OBJECT);
    this.setAnimation(OBJECT);
    anchorAtFoot(this, SOLIDS[OBJECT]);
    this.spriteRenderer.tint = L.objectTint;
  }
}

class Person extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet('walker');
    this.setAnimation('stand_down');
    anchorAtFoot(this, PICTURES.walker);
    this.spriteRenderer.tint = L.personTint;
  }
}

export class DepthSortScene extends Scene {
  static config = checkConfig({
    renderer: { pixelDepth: true },
    lighting: { enabled: false },
  });

  static assets = { spritesheets: { [OBJECT]: sheet(OBJECT), walker: sheet('walker') } };
  static entities = [[Thing, 1], [Person, 1]];

  create() {
    Thing.spawn({ x: L[OBJECT].x, y: L[OBJECT].y });
    Person.spawn(depthPlace(OBJECT, POS, FLOOR_SCALE_Y));
    Camera.setZoom(1);
    Camera.centerOn(640, 360);
  }
}
