// Car.js - Single ShapeType.Box chassis, Box2D-first drive
// Constant accel while W/S held, linearDamping top speed, soft lateral, torque on A/D only.
// Drawn from a car sheet of demos/img/autos (MinZiin's TopDown Vehicles, CC BY 4.0: the right-facing half turn drawn,
// the left half mirrored). The DirectionalSprite shows the frame of the body's rotation; the picture never turns.

import WEED from '/src/index.js';
import { CARS } from '/demos/img/autos/index.js';
import { CarComponent, CAR_DEFAULTS } from '../components/carComponent.js';

const {
    GameObject,
    RigidBody,
    Collider,
    CollisionListener,
    DirectionalSprite,
    Transform,
    ParticleEmitter,
    enums, rng,
    dot2,
    randomUnitCS,
} = WEED;
const { ShapeType } = enums;

// Reused by applyForces / friction (zero alloc)
const _heading = { frontX: 0, frontY: 0, rightX: 0, rightY: 0 };

const _randCS = { c: 1, s: 0 };

/** A car sheet's anchor and box (index.js beside the sheets; bakeCarSheet.mjs writes it with them). */
function carSheetSpec(sheet) {
    const spec = CARS[sheet];
    if (spec !== undefined) return spec;
    console.error(`Car: "${sheet}" is not a car sheet of demos/img/autos (index.js); anchored and sized as hatch_rojo`);
    return CARS.hatch_rojo;
}

export class Car extends GameObject {
    static deriveSpeed = true;

    // DirectionalSprite brings the SpriteRenderer it draws through (its requires).
    static components = [RigidBody, Collider, CollisionListener, DirectionalSprite, CarComponent];

    onSpawned(spawnConfig = {}) {
        const x = spawnConfig.x || 0;
        const y = spawnConfig.y || 0;
        const sprite = spawnConfig.sprite || 'hatch_rojo';
        const spec = carSheetSpec(sprite);

        this.carComponent.driveForce = spawnConfig.driveForce ?? CAR_DEFAULTS.driveForce;
        this.carComponent.lateralFriction = spawnConfig.lateralFriction ?? CAR_DEFAULTS.lateralFriction;
        this.carComponent.turnTorque = spawnConfig.turnTorque ?? CAR_DEFAULTS.turnTorque;
        this.carComponent.minSteerSpeed = spawnConfig.minSteerSpeed ?? CAR_DEFAULTS.minSteerSpeed;
        this.carComponent.minSteerFactor = spawnConfig.minSteerFactor ?? CAR_DEFAULTS.minSteerFactor;
        this.carComponent.maxSteerSpeed = spawnConfig.maxSteerSpeed ?? CAR_DEFAULTS.maxSteerSpeed;

        const scale = spawnConfig.scale ?? spawnConfig.spriteScale ?? CAR_DEFAULTS.spriteScale;
        this.setSpritesheet(sprite);
        // Every cell has the car's centre on the floor at the sheet's anchor: the body's centre.
        this.spriteRenderer.anchorX = spec.anchor[0];
        this.spriteRenderer.anchorY = spec.anchor[1];
        this.setScale(scale, scale);

        // The body is the car's footprint, the sheet's box (x along the car, y across it, floor px), scaled as the
        // sprite is. The cells are not: they have room for every heading around the anchor.
        const box = spec.box;
        const carLength = (box[1] - box[0]) * scale;
        const carWidth = (box[3] - box[2]) * scale;
        const halfDiag = Math.sqrt(carLength * carLength + carWidth * carWidth) * 0.5;
        this._halfDiag = halfDiag;

        this.collider.shapeType = ShapeType.Box;
        this.collider.width = carLength;
        this.collider.height = carWidth;
        this.collider.radius = 0;
        this.collider.isTrigger = 0;
        this.collider.friction = 0.3;
        this.collider.visualRange = halfDiag + 200;

        this.rigidBody.static = 0;
        // Box2D sets terminal speed with driveForce; yaw settle without per-frame torque damp
        this.rigidBody.linearDamping = 1.0;
        this.rigidBody.angularDamping = 3;
        this.rigidBody.sleeping = 0;
        this.setFixedRotation(0);
        this.spriteRenderer.inheritTransformRotation = 0;
        this.spriteRenderer.spriteRotation = 0;

        this.x = x;
        this.y = y;
        const heading = spawnConfig.rotation ?? 0;
        this.rotation = heading;
        // The frame drawn follows the body's rotation, each frame (the logic worker's pass after the ticks).
        this.directionalSprite.facingFrom = 'rotation';
        this.setAnimation('drive');

        this.carComponent.active = 1;
    }

    onDespawned() {
        this.carComponent.active = 0;
        this._halfDiag = 0;
    }

    /** Soft lateral tire friction only — forward coast/top-speed is linearDamping. */
    _updateFriction() {
        const i = this.index;
        GameObject.getHeadingAxes(i, _heading);
        const latSpeed = dot2(RigidBody.vx[i], RigidBody.vy[i], _heading.rightX, _heading.rightY);
        const k = this.carComponent.lateralFriction;
        RigidBody.ax[i] -= _heading.rightX * latSpeed * k;
        RigidBody.ay[i] -= _heading.rightY * latSpeed * k;
    }

    /**
     * @param {number} forwardInput - -1|0|1 (or scaled); constant accel while held
     * @param {number} turnInput - steer in [-1, 1]
     */
    applyForces(forwardInput = 0, turnInput = 0) {
        const i = this.index;
        if (!Transform.active[i]) return;

        GameObject.getHeadingAxes(i, _heading);
        const { frontX, frontY } = _heading;
        const currentSpeed = dot2(RigidBody.vx[i], RigidBody.vy[i], frontX, frontY);

        if (forwardInput !== 0) {
            const force = this.carComponent.driveForce * forwardInput;
            RigidBody.ax[i] += frontX * force;
            RigidBody.ay[i] += frontY * force;
        }

        if (turnInput !== 0) {
            const absFwd = Math.abs(currentSpeed);
            const minSteer = this.carComponent.minSteerSpeed;
            if (absFwd >= minSteer) {
                const maxSteer = this.carComponent.maxSteerSpeed;
                const minFactor = this.carComponent.minSteerFactor;
                const speedFactor = Math.min(absFwd / maxSteer, 1);
                const steerFactor = minFactor + (1 - minFactor) * speedFactor;
                const steerDirection = currentSpeed >= 0 ? 1 : -1;
                const alpha =
                    turnInput * this.carComponent.turnTorque * steerFactor * steerDirection;
                RigidBody.angularAccel[i] += alpha;
            }
        }

        if (forwardInput !== 0 || turnInput !== 0) {
            RigidBody.sleeping[i] = 0;
        }
    }

    tick(_dtRatio) {
        const i = this.index;
        if (!Transform.active[i]) return;

        this._updateFriction();
        // this._emitDust();
    }

    _emitDust() {
        if (this.speed < 10 || rng() > 0.35) return;

        randomUnitCS(_randCS);
        ParticleEmitter.emit({
            count: Math.floor(rng() * 2) + 1,
            x: this.x,
            y: this.y,
            z: -5 - rng() * 10,
            vx: 0,
            vy: 0,
            vz: -rng() * 0.5,
            gravity: 0,
            rotC: _randCS.c,
            rotS: _randCS.s,
            flipX: rng() > 0.5,
            flipY: rng() > 0.5,
            lifespan: { min: 300, max: 1800 },
            scale: { min: 0.4, max: 1.5 },
            texture: 'smoke',
            tint: { min: 0x999999, max: 0xbbbbbb },
            alpha: { from: { min: 0.05, max: 0.1 }, to: 0 },

        });
    }

    onCollisionEnter(otherEntityIndex) {
        const hitX = (this.x + Transform.x[otherEntityIndex]) / 2;
        const hitY = (this.y + Transform.y[otherEntityIndex]) / 2;
        const halfDiag = this._halfDiag;
        const speed = RigidBody.speed[this.index];

        const relSpeed =
            Math.abs(RigidBody.vx[otherEntityIndex] - RigidBody.vx[this.index]) +
            Math.abs(RigidBody.vy[otherEntityIndex] - RigidBody.vy[this.index]);
        const numSparks = Math.min(24, Math.max(1, Math.floor(relSpeed / 60)));

        if (speed > 180) {
            ParticleEmitter.emit({
                count: numSparks,
                x: hitX,
                y: hitY,
                z: -rng() * halfDiag * 0.25,
                angleXY: { min: 0, max: 360 },
                speed: { min: halfDiag * 0.08, max: halfDiag * 0.18 },
                rotation: { min: 0, max: 360 },
                vz: -rng() * 4 - 2,
                gravity: 0.6,
                lifespan: { min: 200, max: 1200 },
                scale: { min: 0.3, max: 0.66 },
                texture: '_whiteCircle',
                tint: { min: 0xffff00, max: 0xffbb00 },
                alpha: { min: 0.8, max: 1 },
                stayOnTheFloor: false,
                despawnOnGroundContact: true,
            });

            ParticleEmitter.emit({
                count: numSparks,
                x: hitX,
                y: hitY + rng() * 8,
                z: -5 - rng() * 10,
                angleXY: 0,
                speed: { min: 0.2, max: 1.2 },
                vz: -rng() * 1.5,
                gravity: 0,
                rotation: { min: 0, max: 360 },
                flipX: rng() > 0.5,
                flipY: rng() > 0.5,
                lifespan: { min: 300, max: 1800 },
                scale: { min: 0.4, max: 1.5 },
                texture: 'smoke',
                tint: { min: 0x999999, max: 0xbbbbbb },
                alpha: { from: { min: 0.05, max: 0.1 }, to: 0 },

            });
        }
    }
}
