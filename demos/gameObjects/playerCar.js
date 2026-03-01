// PlayerCar.js - Player-controlled car extending the base Car class
// Adds keyboard input handling for WASD/Arrow keys

import WEED from '/src/index.js';
import { Car } from './car.js';
import { CarComponent } from '../components/carComponent.js';

const { Keyboard, SpriteRenderer, RigidBody } = WEED;

export class PlayerCar extends Car {
    static scriptUrl = import.meta.url;

    // Must explicitly define components for entity pool initialization
    static components = [SpriteRenderer, CarComponent];

    tick(dtRatio) {
        // Call base class tick (updates position and sprite)
        super.tick(dtRatio);

        // Handle player input
        this._handleInput(dtRatio);
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
}
