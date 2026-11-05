import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, MeshRenderer, enums } = WEED;
const { ShapeType } = enums;

/** A still sprite that casts shadows. */
export class DxCaptureProp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 16;
    this.collider.visualRange = 64;
    this.setSprite(config.texture || 'barrel1');
    this.setScale(config.scale || 2);
  }
}

/** A black square on the 'shade' MESH layer. Squares overlap: a darker overlap means alpha went per mesh. */
export class DxCaptureShade extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    const s = config.size ?? 90;
    this.setLayer('shade');
    this.meshRenderer.tint = 0x000000;
    this.meshRenderer.alpha = config.alpha ?? 1;
    this.meshRenderer.setMesh([-s, -s, s, -s, s, s, -s, s], [0, 1, 2, 0, 2, 3]);
  }
}

/** A still point light. */
export class DxCaptureLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.collider.visualRange = 400;
    this.lightEmitter.lightColor = config.color ?? 0xffcc88;
    // Read on the logic worker: `?lampIntensity=` reaches it through WEED.params (a revision without it ignores the key).
    this.lightEmitter.lightIntensity = Number(WEED.params?.get('lampIntensity') ?? config.intensity ?? 20000);
  }
}
