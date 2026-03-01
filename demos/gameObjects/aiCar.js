// AICar.js - AI-controlled car that follows the player using flowfield pathfinding

import WEED from '/src/index.js';
import { Car } from './car.js';
import { PlayerCar } from './playerCar.js';
import { NavGrid } from '../../src/core/NavGrid.js';
import { CarComponent } from '../components/carComponent.js';

const { Transform, SpriteRenderer } = WEED;

// Reusable object for flowfield sampling (zero allocation)
const _navVec = { x: 0, y: 0 };

export class AICar extends Car {
    static scriptUrl = import.meta.url;

    static components = [SpriteRenderer, CarComponent];

    static aiTurnStrength = 0.8;
    static aiForwardStrength = 0.9;
    static closeToPlayerDistSq = 800 * 800;

    tick(dtRatio) {
        super.tick(dtRatio);

        const player = PlayerCar.getFirstActiveInstance();

        if (!player) return;

        const dx = player.x - this.x;
        const dy = player.y - this.y;
        if (dx * dx + dy * dy < this.constructor.closeToPlayerDistSq) return;

        NavGrid.requestVector(this.x, this.y, player.x, player.y, _navVec);

        const lenSq = _navVec.x * _navVec.x + _navVec.y * _navVec.y;
        if (lenSq < 0.01) return;

        const { frontIndices, backIndices } = this._getFrontBackParts();
        const frontActive = frontIndices.every(i => Transform.active[i]);
        const backActive = backIndices.every(i => Transform.active[i]);
        if (!frontActive || !backActive) return;

        const frontX = frontIndices.reduce((s, i) => s + Transform.x[i], 0) / frontIndices.length;
        const frontY = frontIndices.reduce((s, i) => s + Transform.y[i], 0) / frontIndices.length;
        const backX = backIndices.reduce((s, i) => s + Transform.x[i], 0) / backIndices.length;
        const backY = backIndices.reduce((s, i) => s + Transform.y[i], 0) / backIndices.length;

        const currentAngle = Math.atan2(frontY - backY, frontX - backX);
        const desiredAngle = Math.atan2(_navVec.y, _navVec.x);

        let angleDiff = desiredAngle - currentAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        const turnForce = Math.sign(angleDiff) * Math.min(Math.abs(angleDiff) * 2, 1) * this.constructor.aiTurnStrength;

        const alignment = Math.cos(angleDiff);
        const accel = this.carComponent.accelerationForce;
        const forwardForce = alignment > 0
            ? accel * this.constructor.aiForwardStrength
            : -accel * this.constructor.aiForwardStrength * 0.6;

        this.applyForces(forwardForce, turnForce);
    }
}
