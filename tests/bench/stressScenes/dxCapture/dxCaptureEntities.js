import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, MeshRenderer, enums } = WEED;
const { ShapeType } = enums;

const LAMP_OFFSET = Number(WEED.params?.get('lampOffset') ?? 0);

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
    // `?shadeHeight=`: a height on the far corners, on a sunProjected layer.
    const h = WEED.params?.get('shadeHeight');
    if (h !== null && h !== undefined) this.meshRenderer.setHeights?.([0, 0, Number(h), Number(h)]);
  }
}

/** A still point light. */
export class DxCaptureLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.collider.visualRange = 900;
    // `?lampOffset=d`: the light d px ahead of an entity turned 90 degrees (so d px down); `?lampShift=d` the same spot
    // without either. The two must draw the same picture.
    const offset = LAMP_OFFSET;
    if (offset !== 0) this.lightEmitter.offsetX = offset;
    this.lightEmitter.lightColor = config.color ?? 0xffcc88;
    // Read on the logic worker: `?lampIntensity=` reaches it through WEED.params (a revision without it ignores the key).
    this.lightEmitter.lightIntensity = Number(WEED.params?.get('lampIntensity') ?? config.intensity ?? 20000);
  }

  /** A body's rotation is the physics worker's after it is created, so the turn goes in here. */
  tick() {
    if (LAMP_OFFSET !== 0) this.rotation = Math.PI / 2;
  }
}
