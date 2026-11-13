import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, MeshRenderer, enums } = WEED;
const { ShapeType } = enums;

const LAMP_OFFSET = Number(WEED.params?.get('lampOffset') ?? 0);
/** `?lampCone=` degrees (DX-SPOT): each lamp a cone that aperture wide, soft 0.3, pointing away from the view's centre. */
const LAMP_CONE = Number(WEED.params?.get('lampCone') ?? 0);

/** A still sprite that casts shadows. */
export class DxCaptureProp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 16;
    this.collider.visualRange = 64;
    // `?propSprite=`, `?propAlpha=`, and `?propShadow=` the frame its ShadowCaster casts (a revision without it ignores the key).
    this.setSprite(WEED.params?.get('propSprite') || config.texture || 'barrel1');
    this.setScale(config.scale || 2);
    const alpha = WEED.params?.get('propAlpha');
    if (alpha !== null && alpha !== undefined) this.spriteRenderer.alpha = Number(alpha);
    const shadow = WEED.params?.get('propShadow');
    if (shadow) this.shadowCaster.setTexture?.(shadow);
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
    this.lightEmitter.shadowRange = 900;
    // `?lampOffset=d`: the light d px ahead of an entity turned 90 degrees (so d px down); `?lampShift=d` the same spot
    // without either. The two must draw the same picture.
    const offset = LAMP_OFFSET;
    if (offset !== 0) this.lightEmitter.offsetX = offset;
    this.lightEmitter.color = config.color ?? 0xffcc88;
    // Read on the logic worker: `?lampIntensity=` reaches it through WEED.params (a revision without it ignores the key).
    // The old API's intensity I: reach 10·√I, glow I / 50000.
    const intensity = Number(WEED.params?.get('lampIntensity') ?? config.intensity ?? 20000);
    this.lightEmitter.radius = 10 * Math.sqrt(intensity);
    this.lightEmitter.glow = intensity / 50000;
    if (LAMP_CONE > 0) {
      // Its direction from where it stands (no random draw, so the lamps stand where they always did).
      this.lightEmitter.coneAngle = (LAMP_CONE * Math.PI) / 180;
      this.lightEmitter.coneSoftness = 0.3;
      this.lightEmitter.direction = Math.atan2((config.y ?? 360) - 360, (config.x ?? 640) - 640);
    }
  }

  /** A body's rotation is the physics worker's after it is created, so the turn goes in here. */
  tick() {
    if (LAMP_OFFSET !== 0) this.rotation = Math.PI / 2;
  }
}
