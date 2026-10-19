// Planet variant of the destructible-terrain ship: identical hull, laser,
// tools and camera follow. The differences are radial gravity, the camera roll
// that keeps the planet's local up at the top of the screen, camera-local
// thrusters (so W/A/D still mean screen up/left/right while the view turns) and
// a sprite counter-rotation that keeps the hull upright on screen.

import { Ship, THRUST_ACCEL } from '/demos/destructibleTerrainScene/gameObjects/ship.js';
import { CX, CY, G, radialCameraAngle } from '../planetGravity.js';
import WEED from '/src/index.js';

const { Camera, Keyboard, SpriteRenderer, LightEmitter, RigidBody, Collider } = WEED;

const CAM_TURN_RATE = 12;
const SIDE_ACCEL = THRUST_ACCEL * 0.25;

export class PlanetShip extends Ship {
  static components = [...Ship.components, LightEmitter];

  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    this.lightEmitter.lightIntensity = 20000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0
    // Draw the hull with its own rotation (below) instead of the physics angle.
    SpriteRenderer.inheritTransformRotation[this.index] = 0;
  }

  tick(dtRatio, deltaTime, accumulatedTime) {
    const dx = CX - this.x;
    const dy = CY - this.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    this.addAcceleration((dx / len) * G, (dy / len) * G);

    // Rotate the view so the surface under the ship stays at the bottom as it
    // travels around the disk. Smooth the shortest arc; seed from the current
    // camera angle so a restored/moved camera does not snap.
    const target = radialCameraAngle(this.x, this.y);
    if (this._camAngle === undefined) this._camAngle = Camera.rotation || 0;
    let diff = target - this._camAngle;
    diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const dt = dtRatio > 0 ? dtRatio / 60 : 0;
    this._camAngle += diff * (1 - Math.exp(-dt * CAM_TURN_RATE));
    Camera.setAngle(this._camAngle);

    // The camera rolls the world; counter-rotate the hull so it stays upright.
    this.spriteRenderer.spriteRotation = -this._camAngle;

    super.tick(dtRatio, deltaTime, accumulatedTime);
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
