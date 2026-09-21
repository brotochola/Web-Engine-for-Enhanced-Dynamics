// AICar.js - AI-controlled car that follows a static flowfield (or the player as fallback)

import WEED from '/src/index.js';
import { Car } from './car.js';
import { PlayerCar } from './playerCar.js';
import { NavGrid } from '/src/core/navGrid.js';
import { CarComponent } from '../components/carComponent.js';
import { dot2 } from '/src/util/utils.js';

const { SpriteRenderer, RigidBody, Collider, CollisionListener } = WEED;

const _navVec = { x: 0, y: 0 };

export class AICar extends Car {

    static components = [RigidBody, Collider, CollisionListener, SpriteRenderer, CarComponent];

    static aiTurnStrength = 0.8;
    static aiForwardStrength = 0.9;
    static aiForwardAlignmentThreshold = 0.15;
    static aiBrakeForwardSpeedThreshold = 60; // px/s
    static flowfieldName = 'roads';

    tick(dtRatio) {
        super.tick(dtRatio);

        NavGrid.requestVectorFromStaticFlowfield(this.constructor.flowfieldName, this.x, this.y, _navVec);

        if (_navVec.x === 0 && _navVec.y === 0) {
            const player = PlayerCar.getFirstActiveInstance();
            if (player) {
                _navVec.x = player.x - this.x;
                _navVec.y = player.y - this.y;
            }
        }

        const lenSq = _navVec.x * _navVec.x + _navVec.y * _navVec.y;
        if (lenSq < 0.01) return;

        const inv = 1 / Math.sqrt(lenSq);
        const nx = _navVec.x * inv;
        const ny = _navVec.y * inv;
        const fx = this.forwardX;
        const fy = this.forwardY;
        // cross/dot vs Transform.rotC/S facing — no atan2(nav) / cos(angleDiff)
        const cross = fx * ny - fy * nx;
        const alignment = fx * nx + fy * ny;
        // cross ≈ sinθ for unit vectors; k=2 matches prior atan2 gain + clamp
        const turnInput = Math.max(-1, Math.min(1, cross * 2)) * this.constructor.aiTurnStrength;

        const i = this.index;
        const forwardSpeed = dot2(
            RigidBody.vx[i],
            RigidBody.vy[i],
            fx,
            fy
        );

        let forwardInput = 0;
        if (alignment > this.constructor.aiForwardAlignmentThreshold) {
            forwardInput = this.constructor.aiForwardStrength;
        } else if (forwardSpeed > this.constructor.aiBrakeForwardSpeedThreshold) {
            forwardInput = 0; // coast while turning; linearDamping bleeds speed
        }

        this.applyForces(forwardInput, turnInput);
    }
}
