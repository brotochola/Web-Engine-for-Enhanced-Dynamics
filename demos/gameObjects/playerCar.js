// PlayerCar.js - Player-controlled car extending the base Car class
// Adds keyboard input handling for WASD/Arrow keys

import WEED from '/src/index.js';
import { Car } from './car.js';
import { CarComponent } from '../components/carComponent.js';
import { CarPart } from './carPart.js';

const { Keyboard, SpriteRenderer, RigidBody, Camera, Transform } = WEED;

// Camera tuning: zoom out when fast, look ahead in movement direction
const ZOOM_AT_MIN_SPEED = 1.0;
const ZOOM_AT_MAX_SPEED = 0.25;
const SPEED_FOR_MIN_ZOOM = 0;
const SPEED_FOR_MAX_ZOOM = 100;
const LOOK_AHEAD_PER_SPEED = 0.5;
const CAMERA_SMOOTH = 0.15; // Lower = smoother, less responsive to jitter

// Module-level smoothed values (no per-frame alloc, no GC)
let _svx = 0, _svy = 0, _ssp = 0;
let _cameraInit = false;

export class PlayerCar extends Car {
    static scriptUrl = import.meta.url;

    // Must explicitly define components for entity pool initialization
    static components = [SpriteRenderer, CarComponent];

    onDespawned() {
        super.onDespawned();
        _cameraInit = false;
    }

    tick(dtRatio) {
        // Call base class tick (updates position and sprite)
        super.tick(dtRatio);

        // Handle player input
        this._handleInput(dtRatio);

        // Camera: zoom out with speed, center on future position (see ahead)
        this._updateCamera();
    }

    /**
     * Handle keyboard input for car controls
     * W/S = accelerate/brake-reverse
     * A/D = turn (works at all speeds - arcade feel)
     */
    _handleInput(dtRatio) {
        let forwardForce = 0;
        let turnForce = 0;

        const accel = this.carComponent.accelerationForce;
        const brakeMult = this.carComponent.brakeForce;

        // W - Accelerate forward
        if (Keyboard.w || Keyboard.arrowup) {
            forwardForce += accel;
        }

        // S - Brake (stronger when going forward) or reverse
        if (Keyboard.s || Keyboard.arrowdown) {
            const forwardSpeed = this._getForwardSpeed();
            const isMovingForward = forwardSpeed > 1;
            forwardForce -= isMovingForward ? accel * brakeMult : accel;
        }

        // D - Turn right
        if (Keyboard.d || Keyboard.arrowright) {
            turnForce += this.carComponent.turnForce;
        }

        // A - Turn left
        if (Keyboard.a || Keyboard.arrowleft) {
            turnForce -= this.carComponent.turnForce;
        }

        if (forwardForce !== 0 || turnForce !== 0) {
            this.applyForces(forwardForce, turnForce);
        }
    }

    _getForwardSpeed() {
        const { frontIndices } = this._getFrontBackParts();
        const angle = this.carComponent.angle;
        const velX = frontIndices.reduce((s, i) => s + RigidBody.vx[i], 0) / frontIndices.length;
        const velY = frontIndices.reduce((s, i) => s + RigidBody.vy[i], 0) / frontIndices.length;
        return velX * Math.cos(angle) + velY * Math.sin(angle);
    }

    _getCenterVelocity() {
        const allParts = this._getAllPartIndices();
        let vx = 0, vy = 0;
        for (const i of allParts) {
            vx += RigidBody.vx[i];
            vy += RigidBody.vy[i];
        }
        vx /= allParts.length;
        vy /= allParts.length;
        return { vx, vy, speed: Math.hypot(vx, vy) };
    }

    _updateCamera() {
        const centerX = Transform.x[this.index];
        const centerY = Transform.y[this.index];
        const pi = this.carComponent.part0Index;
        const vx = RigidBody.vx[pi];
        const vy = RigidBody.vy[pi];
        const speed = RigidBody.speed[pi];

        // Exponential smoothing: no sqrt, no alloc, no GC
        const k = CAMERA_SMOOTH;
        if (!_cameraInit) {
            _svx = vx; _svy = vy; _ssp = speed;
            _cameraInit = true;
        } else {
            _svx += (vx - _svx) * k;
            _svy += (vy - _svy) * k;
            _ssp += (speed - _ssp) * k;
        }

        const lookAheadTime = _ssp * LOOK_AHEAD_PER_SPEED;
        const futureX = centerX + _svx * lookAheadTime;
        const futureY = centerY + _svy * lookAheadTime;

        Camera.follow(futureX, futureY, 0.5);

        const t = _ssp <= SPEED_FOR_MIN_ZOOM ? 0 : (_ssp >= SPEED_FOR_MAX_ZOOM ? 1 : (_ssp - SPEED_FOR_MIN_ZOOM) / (SPEED_FOR_MAX_ZOOM - SPEED_FOR_MIN_ZOOM));
        Camera.setZoom(ZOOM_AT_MIN_SPEED + t * (ZOOM_AT_MAX_SPEED - ZOOM_AT_MIN_SPEED));
    }
}
