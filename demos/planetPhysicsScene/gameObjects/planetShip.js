// Planet variant of the destructible-terrain ship: identical hull, laser,
// tools and camera follow. The differences are radial gravity, the camera roll
// that keeps the planet's local up at the top of the screen, camera-local
// thrusters (so W/A/D still mean screen up/left/right while the view turns) and
// a sprite counter-rotation that keeps the hull upright on screen. The body is
// rotation-locked; the camera roll comes from the ship's radial position, so
// contacts cannot twist the view.

import { Ship, THRUST_ACCEL } from '/demos/destructibleTerrainScene/gameObjects/ship.js';
import { radialCameraAngle, radialPull } from '../planetGravity.js';
import WEED from '/src/index.js';

const { Camera, Keyboard, LightEmitter, ShapeType, normalizeAngle } = WEED;

const CAM_TURN_RATE = 12;
const SIDE_ACCEL = THRUST_ACCEL * 0.25;
const _pull = { x: 0, y: 0 };

export class PlanetShip extends Ship {
  static components = [...Ship.components, LightEmitter];

  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    this.lightEmitter.lightIntensity = 20000;
    // 14 is the radius of a circle with the same area as the 22x28 hull box,
    // so switching shapes keeps the ship's mass.
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 14;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0;
    // Raycasted occluders come from this neighbor list; Ship's 80 px let the
    // light pass through every rock past that.
    this.collider.visualRange = this.lightEmitter.influenceRadius;
    // Contacts must not spin the body; the hull turns only as a sprite.
    this.setFixedRotation(1);
    this.spriteRenderer.inheritTransformRotation = 0;
    this.spriteRenderer.spriteRotation = 0;
  }

  tick(dtRatio, deltaTime, accumulatedTime) {
    radialPull(this.x, this.y, _pull);
    this.addAcceleration(_pull.x, _pull.y);

    super.tick(dtRatio, deltaTime, accumulatedTime);

    // Follow stamps the pose it accepted. A repeated pose keeps the roll that
    // is already on screen; a new pose eases toward that pose's radial up.
    const ready = Camera.poseReadyFrame | 0;
    if (!(ready > 0) || ready === this._rollReady) return;
    this._rollReady = ready;
    const target = radialCameraAngle(Camera.followUsedX, Camera.followUsedY);
    if (this._camAngle === undefined) this._camAngle = Camera.rotation || 0;
    // Into [-π, π] whatever the size: _camAngle accumulates over orbits.
    const diff = normalizeAngle(target - this._camAngle + Math.PI) - Math.PI;
    const dt = dtRatio > 0 ? dtRatio / 60 : 0;
    this._camAngle += diff * (1 - Math.exp(-dt * CAM_TURN_RATE));
    Camera.setAngle(this._camAngle);
    // Opposite sign so the hull cancels the roll. The body stays fixed; only
    // the sprite turns.
    this.spriteRenderer.spriteRotation = -this._camAngle;
  }

  /** Camera-local thrust: W is screen up (radially out), A/D are screen left/right. */
  _applyThrust() {
    const cam = this._camAngle || 0;
    const c = Math.cos(cam);
    const s = Math.sin(cam);
    if (Keyboard.w) this.addAcceleration(-s * THRUST_ACCEL, -c * THRUST_ACCEL);
    if (Keyboard.a) this.addAcceleration(-c * SIDE_ACCEL, s * SIDE_ACCEL);
    if (Keyboard.d) this.addAcceleration(c * SIDE_ACCEL, -s * SIDE_ACCEL);
  }
}
