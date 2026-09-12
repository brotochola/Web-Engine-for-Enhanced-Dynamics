// Car.js - Single ShapeType.Box chassis, Box2D-first drive
// Constant accel while W/S held, linearDamping top speed, soft lateral, torque on A/D only.

import WEED from '/src/index.js';
import { CarComponent, CAR_DEFAULTS } from '../components/carComponent.js';
import { dot2 } from '/src/core/utils.js';
import { randomUnitCS } from '/src/core/utils.js';

const {
    GameObject,
    RigidBody,
    Collider,
    CollisionListener,
    SpriteRenderer,
    SpriteSheetRegistry,
    Transform,
    ParticleEmitter,
    enums, rng
} = WEED;
const { ShapeType } = enums;

const DEG2RAD = Math.PI / 180;

// Reused by applyForces / friction (zero alloc)
const _heading = { frontX: 0, frontY: 0, rightX: 0, rightY: 0 };

/** Cached numeric anim keys + unit (c,s) per spritesheet name — avoid rebuild/sort every tick. */
const _angleKeysBySheet = new Map();
const _randCS = { c: 1, s: 0 };

function getAngleKeys(spritesheet) {
    let cached = _angleKeysBySheet.get(spritesheet);
    if (cached) return cached;
    const animNames = SpriteSheetRegistry.getAnimationNames(spritesheet);
    const keys = animNames
        .map(k => {
            const num = parseFloat(k);
            const rad = num * DEG2RAD;
            return { num, key: k, c: Math.cos(rad), s: Math.sin(rad) };
        })
        .filter(p => !isNaN(p.num))
        .sort((a, b) => a.num - b.num);
    cached = {
        keys,
        halfStepCos: keys.length ? Math.cos(Math.PI / keys.length) : 1,
    };
    _angleKeysBySheet.set(spritesheet, cached);
    return cached;
}

export class Car extends GameObject {
    static scriptUrl = import.meta.url;

    static components = [RigidBody, Collider, CollisionListener, SpriteRenderer, CarComponent];

    setup() {
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;
    }

    onSpawned(spawnConfig = {}) {
        const x = spawnConfig.x || 0;
        const y = spawnConfig.y || 0;
        const sprite = spawnConfig.sprite || 'car';

        this.carComponent.driveForce = spawnConfig.driveForce ?? CAR_DEFAULTS.driveForce;
        this.carComponent.lateralFriction = spawnConfig.lateralFriction ?? CAR_DEFAULTS.lateralFriction;
        this.carComponent.turnTorque = spawnConfig.turnTorque ?? CAR_DEFAULTS.turnTorque;
        this.carComponent.minSteerSpeed = spawnConfig.minSteerSpeed ?? CAR_DEFAULTS.minSteerSpeed;
        this.carComponent.minSteerFactor = spawnConfig.minSteerFactor ?? CAR_DEFAULTS.minSteerFactor;
        this.carComponent.maxSteerSpeed = spawnConfig.maxSteerSpeed ?? CAR_DEFAULTS.maxSteerSpeed;

        const scale = spawnConfig.scale ?? spawnConfig.spriteScale ?? CAR_DEFAULTS.spriteScale;
        this.setSpritesheet(sprite);
        this.setAnimation('0');
        this.setScale(scale, scale);

        const carLength = this.spriteRenderer.originalWidth * scale * 0.9;
        const carHeight = this.spriteRenderer.originalHeight * scale * 0.75;
        const halfDiag = Math.hypot(carLength, carHeight) * 0.5;
        this._halfDiag = halfDiag;

        this.collider.shapeType = ShapeType.Box;
        this.collider.width = carLength;
        this.collider.height = carHeight;
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

        this.carComponent.active = 1;
        this._lastAngleKey = null;
        this._updateSpriteFrame();
    }

    onDespawned() {
        this.carComponent.active = 0;
        this._lastAngleKey = null;
        this._halfDiag = 0;
    }

    /** Host applies torque = angularAccel * mass; map desired alpha → angularAccel via I/m. */
    _alphaToAngularAccel(alpha) {
        const i = this.index;
        const mass = RigidBody.mass[i];
        const inertia = RigidBody.inertia[i];
        if (!(mass > 0) || !(inertia > 0)) return alpha;
        return (alpha * inertia) / mass;
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
                RigidBody.angularAccel[i] += this._alphaToAngularAccel(alpha);
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
        this._updateSpriteFrame();
    }

    _updateSpriteFrame() {
        const i = this.index;
        const spritesheetId = this.spriteRenderer.spritesheetId;
        if (!spritesheetId) return;
        const spritesheet = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
        if (!spritesheet) return;

        const { keys, halfStepCos } = getAngleKeys(spritesheet);
        if (keys.length === 0) return;

        const c = Transform.rotC ? Transform.rotC[i] : 1;
        const s = Transform.rotS ? Transform.rotS[i] : 0;

        const last = this._lastAngleKey;
        if (last && c * last.c + s * last.s >= halfStepCos) return;

        let best = keys[0];
        let bestDot = c * best.c + s * best.s;
        for (let k = 1; k < keys.length; k++) {
            const d = c * keys[k].c + s * keys[k].s;
            if (d > bestDot) {
                bestDot = d;
                best = keys[k];
            }
        }
        if (last !== best) {
            this._lastAngleKey = best;
            this.setAnimation(best.key);
        }
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
        this.rigidBody.ax *= 0.3;
        this.rigidBody.ay *= 0.3;

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
