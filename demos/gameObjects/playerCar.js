// PlayerCar.js - Player-controlled car extending the base Car class
// Adds keyboard input handling for WASD/Arrow keys

import WEED from '/src/index.js';
import { Car, ACCELERATION_FORCE, TURN_FORCE } from './car.js';
import { CarComponent } from '../components/carComponent.js';

const { Keyboard, SpriteRenderer } = WEED;

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
     * W/S = accelerate/brake
     * A/D = turn (steering only works when moving - like real cars!)
     */
    _handleInput(dtRatio) {
        let forwardForce = 0;
        let turnForce = 0;

        // W - Accelerate forward
        if (Keyboard.w || Keyboard.arrowup) {
            forwardForce += ACCELERATION_FORCE;
        }

        // S - Brake/Reverse
        if (Keyboard.s || Keyboard.arrowdown) {
            forwardForce -= ACCELERATION_FORCE;
        }

        // D - Turn right
        if (Keyboard.d || Keyboard.arrowright) {
            turnForce += TURN_FORCE;
        }

        // A - Turn left
        if (Keyboard.a || Keyboard.arrowleft) {
            turnForce -= TURN_FORCE;
        }

        // Apply forces through the base class method
        if (forwardForce !== 0 || turnForce !== 0) {
            this.applyForces(forwardForce, turnForce);
        }
    }
}
