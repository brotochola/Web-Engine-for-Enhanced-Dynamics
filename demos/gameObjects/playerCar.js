// PlayerCar.js - Player-controlled car extending the base Car class
// Adds keyboard input handling for WASD/Arrow keys

import WEED from '/src/index.js';
import { Car } from './car.js';
import { CarComponent } from '../components/carComponent.js';

const { Keyboard, SpriteRenderer, RigidBody, Camera } = WEED;
const ZOOM_AT_MIN_SPEED = 1.0;
const ZOOM_AT_MAX_SPEED = 0.25;
const SPEED_FOR_MIN_ZOOM = 0;
const SPEED_FOR_MAX_ZOOM = 60;
const LOOK_AHEAD_PER_SPEED = 15;
const CAMERA_SMOOTH = 0.015;
const CAMERA_FOLLOW_SMOOTH = 0.05//0.05;

export class PlayerCar extends Car {
    static scriptUrl = import.meta.url;

    // Must explicitly define components for entity pool initialization
    static components = [SpriteRenderer, CarComponent];

    tick(dtRatio) {
        super.tick(dtRatio);
        this._updateCamera(dtRatio);
        this._handleInput(dtRatio);
    }
    _updateCamera(dtRatio) {
        const player = this.index
        if (player === null) return;
        if (!Transform.active[player]) return;

        const centerX = Transform.x[player];
        const centerY = Transform.y[player];
        const vx = CarComponent.vx[player];
        const vy = CarComponent.vy[player];

        const futureX = centerX + vx * LOOK_AHEAD_PER_SPEED;
        const futureY = centerY + vy * LOOK_AHEAD_PER_SPEED;
        Camera.follow(futureX, futureY, CAMERA_FOLLOW_SMOOTH, dtRatio);

        const speed = Math.abs(vx) + Math.abs(vy)
        const speedT = Math.min(
            1,
            Math.max(0, (speed - SPEED_FOR_MIN_ZOOM) / (SPEED_FOR_MAX_ZOOM - SPEED_FOR_MIN_ZOOM))
        );
        const zoom = ZOOM_AT_MIN_SPEED + speedT * (ZOOM_AT_MAX_SPEED - ZOOM_AT_MIN_SPEED);
        Camera.setZoom(zoom);
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
            this.applyForces(forwardForce, turnForce, dtRatio);
        }
    }

    _getForwardSpeed() {
        const { frontIndices } = this._getFrontBackParts();
        const angle = this.carComponent.angle;
        const velX = frontIndices.reduce((s, i) => s + RigidBody.vx[i], 0) / frontIndices.length;
        const velY = frontIndices.reduce((s, i) => s + RigidBody.vy[i], 0) / frontIndices.length;
        return velX * Math.cos(angle) + velY * Math.sin(angle);
    }

}
