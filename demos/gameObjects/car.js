// Car.js - Base car class using Verlet physics with a grid of connected circles
// The car consists of a cols x 2 grid of CarPart entities (3x2 or 4x2).
// Triangular mesh constraints keep the shape rigid with fewer constraints.
// Two rows give a flatter front/back for more predictable crash behavior.
// This base class has no input - extend it (like PlayerCar) for controllable cars.

import WEED from '/src/index.js';
import { CarComponent, CAR_DEFAULTS, PART_KEYS, CONSTRAINT_KEYS } from '../components/carComponent.js';
import { CarPart } from './carPart.js';

const { GameObject, RigidBody, SpriteRenderer, Transform, Constraint, SpriteSheetRegistry } = WEED;

const TWO_PI = Math.PI * 2;

export class Car extends GameObject {
    static scriptUrl = import.meta.url;

    static components = [SpriteRenderer, CarComponent];

    setup() {
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;
    }

    onSpawned(spawnConfig = {}) {
        const x = spawnConfig.x || 0;
        const y = spawnConfig.y || 0;
        const sprite = spawnConfig.sprite || 'car';

        // Set car tuning from spawnConfig or defaults (stored in CarComponent)
        this.carComponent.accelerationForce = spawnConfig.accelerationForce ?? CAR_DEFAULTS.accelerationForce;
        this.carComponent.turnForce = spawnConfig.turnForce ?? CAR_DEFAULTS.turnForce;
        this.carComponent.steeringAngle = spawnConfig.steeringAngle ?? CAR_DEFAULTS.steeringAngle;
        this.carComponent.brakeForce = spawnConfig.brakeForce ?? CAR_DEFAULTS.brakeForce;
        this.carComponent.spriteScale = spawnConfig.scale ?? spawnConfig.spriteScale ?? CAR_DEFAULTS.spriteScale;
        this.carComponent.constraintStiffness = spawnConfig.constraintStiffness ?? CAR_DEFAULTS.constraintStiffness;
        this.carComponent.maxSteerSpeed = spawnConfig.maxSteerSpeed ?? CAR_DEFAULTS.maxSteerSpeed;
        this.carComponent.minSteerFactor = spawnConfig.minSteerFactor ?? CAR_DEFAULTS.minSteerFactor;
        this.carComponent.slipSpeed = spawnConfig.slipSpeed ?? CAR_DEFAULTS.slipSpeed;
        this.carComponent.tractionTight = spawnConfig.tractionTight ?? CAR_DEFAULTS.tractionTight;
        this.carComponent.tractionLoose = spawnConfig.tractionLoose ?? CAR_DEFAULTS.tractionLoose;
        this.carComponent.lateralDampening = spawnConfig.lateralDampening ?? CAR_DEFAULTS.lateralDampening;

        const scale = this.carComponent.spriteScale;
        this.setSpritesheet(sprite);
        this.setAnimation('0');
        this.setScale(scale, scale);

        const carLength = this.spriteRenderer.originalWidth * scale * 0.9;
        const carHeight = this.spriteRenderer.originalHeight * scale * 0.75;

        // Circle radius - smaller so 2 rows fit within car height
        const radius = carHeight / 4;

        // Grid: cols x 2 rows. Max 4x2.
        const aspectRatio = carLength / carHeight;
        let cols = aspectRatio >= 2.0 ? 4 : 3;
        if (spawnConfig.gridCols) {
            cols = Math.max(3, Math.min(4, spawnConfig.gridCols));
        }

        const rows = 2;
        const partCount = cols * rows;

        this.carComponent.gridCols = cols;
        this.carComponent.gridRows = rows;
        this.carComponent.partCount = partCount;

        // Spacing: parts span car length and height (minus padding for radius)
        // Minimum center-to-center = 2*radius + 2px so edges are at least 2px apart
        const minGap = 2;
        const minSpacing = 2 * radius + minGap;
        const lengthSpan = carLength - 2 * radius;
        const heightSpan = carHeight - 2 * radius;
        const colSpacing = cols > 1 ? Math.max(lengthSpan / (cols - 1), minSpacing) : minSpacing;
        const rowSpacing = rows > 1 ? Math.max(heightSpan / (rows - 1), minSpacing) : minSpacing;

        const totalLength = (cols - 1) * colSpacing;
        const totalHeight = (rows - 1) * rowSpacing;
        const startX = x - totalLength / 2;
        const startY = y - totalHeight / 2;

        const parts = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const partX = startX + col * colSpacing;
                const partY = startY + row * rowSpacing;
                const part = CarPart.spawn({ x: partX, y: partY, radius });

                if (!part) {
                    console.error(`Car: Failed to spawn CarPart ${row * cols + col}`);
                    for (const p of parts) p.despawn();
                    return;
                }
                parts.push(part);
                this.carComponent[PART_KEYS[row * cols + col]] = part.index;
            }
        }

        // Triangular mesh constraints - unique edges only
        const edgeSet = new Set();
        const addEdge = (a, b) => {
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            if (edgeSet.has(key)) return -1;
            edgeSet.add(key);
            const dist = Math.hypot(
                Transform.x[parts[a].index] - Transform.x[parts[b].index],
                Transform.y[parts[a].index] - Transform.y[parts[b].index]
            );
            return Constraint.add(parts[a].index, parts[b].index, dist, this.carComponent.constraintStiffness);
        };

        let constraintIndex = 0;
        for (let row = 0; row < rows - 1; row++) {
            for (let col = 0; col < cols - 1; col++) {
                const i = row * cols + col;
                const iRight = i + 1;
                const iBottom = i + cols;
                const iDiag = i + cols + 1;
                // Two triangles: (i, iRight, iDiag) and (i, iDiag, iBottom)
                const edges = [
                    [i, iRight], [iRight, iDiag], [i, iDiag],
                    [i, iBottom], [iDiag, iBottom]
                ];
                for (const [a, b] of edges) {
                    const idx = addEdge(a, b);
                    if (idx >= 0 && constraintIndex < CONSTRAINT_KEYS.length) {
                        this.carComponent[CONSTRAINT_KEYS[constraintIndex]] = idx;
                        constraintIndex++;
                    }
                }
            }
        }
        this.carComponent.constraintCount = constraintIndex;
    }

    onDespawned() {
        const constraintCount = this.carComponent.constraintCount;
        const partCount = this.carComponent.partCount;

        for (let i = 0; i < constraintCount; i++) {
            const idx = this.carComponent[CONSTRAINT_KEYS[i]];
            if (idx >= 0) Constraint.remove(idx);
            this.carComponent[CONSTRAINT_KEYS[i]] = -1;
        }

        for (let i = 0; i < partCount; i++) {
            const partIdx = this.carComponent[PART_KEYS[i]];
            if (partIdx > 0 && Transform.active[partIdx]) {
                const part = GameObject.get(partIdx);
                if (part) part.despawn();
            }
            this.carComponent[PART_KEYS[i]] = 0;
        }

        this.carComponent.partCount = 0;
        this.carComponent.constraintCount = 0;
    }

    /** Get front and back row part indices (for position/angle) */
    _getFrontBackParts() {
        const cols = this.carComponent.gridCols;
        const rows = this.carComponent.gridRows;
        const frontIndices = [];
        const backIndices = [];
        for (let r = 0; r < rows; r++) {
            backIndices.push(this.carComponent[PART_KEYS[r * cols]]);
            frontIndices.push(this.carComponent[PART_KEYS[r * cols + cols - 1]]);
        }
        return { frontIndices, backIndices };
    }

    /** Get all part indices (for applying forces) */
    _getAllPartIndices() {
        const partCount = this.carComponent.partCount;
        const indices = [];
        for (let i = 0; i < partCount; i++) {
            indices.push(this.carComponent[PART_KEYS[i]]);
        }
        return indices;
    }

    /** Get front column part indices (for turning) */
    _getFrontPartIndices() {
        const cols = this.carComponent.gridCols;
        const rows = this.carComponent.gridRows;
        const indices = [];
        for (let r = 0; r < rows; r++) {
            indices.push(this.carComponent[PART_KEYS[r * cols + cols - 1]]);
        }
        return indices;
    }

    tick(dtRatio) {
        const { frontIndices, backIndices } = this._getFrontBackParts();

        const frontActive = frontIndices.every(i => Transform.active[i]);
        const backActive = backIndices.every(i => Transform.active[i]);
        if (!frontActive || !backActive) return;

        const frontX = frontIndices.reduce((s, i) => s + Transform.x[i], 0) / frontIndices.length;
        const frontY = frontIndices.reduce((s, i) => s + Transform.y[i], 0) / frontIndices.length;
        const backX = backIndices.reduce((s, i) => s + Transform.x[i], 0) / backIndices.length;
        const backY = backIndices.reduce((s, i) => s + Transform.y[i], 0) / backIndices.length;

        const centerX = (frontX + backX) / 2;
        const centerY = (frontY + backY) / 2;
        Transform.x[this.index] = centerX;
        Transform.y[this.index] = centerY;

        this.carComponent.angle = Math.atan2(frontY - backY, frontX - backX);
        this._applyLateralFriction();
        this._updateSpriteFrame();
    }

    /** Apply force opposing lateral velocity - tire-like friction. Resists sliding from collisions. */
    _applyLateralFriction() {
        const angle = this.carComponent.angle;
        const forwardX = Math.cos(angle);
        const forwardY = Math.sin(angle);
        const lateralX = -forwardY;
        const lateralY = forwardX;
        const strength = (1 - this.carComponent.lateralDampening) * 0.25;

        for (const partIdx of this._getAllPartIndices()) {
            const vx = RigidBody.vx[partIdx];
            const vy = RigidBody.vy[partIdx];
            const lateral = vx * lateralX + vy * lateralY;
            RigidBody.ax[partIdx] -= lateralX * lateral * strength;
            RigidBody.ay[partIdx] -= lateralY * lateral * strength;
        }
    }

    applyForces(forwardForce, turnForce) {
        const { frontIndices, backIndices } = this._getFrontBackParts();
        const frontActive = frontIndices.every(i => Transform.active[i]);
        const backActive = backIndices.every(i => Transform.active[i]);
        if (!frontActive || !backActive) return;

        const angle = this.carComponent.angle;
        const forwardX = Math.cos(angle);
        const forwardY = Math.sin(angle);
        const lateralX = -forwardY;
        const lateralY = forwardX;

        const allParts = this._getAllPartIndices();
        let centerVx = 0, centerVy = 0;
        for (const partIdx of allParts) {
            centerVx += RigidBody.vx[partIdx];
            centerVy += RigidBody.vy[partIdx];
        }
        centerVx /= allParts.length;
        centerVy /= allParts.length;
        const speed = Math.hypot(centerVx, centerVy);
        const forwardSpeed = centerVx * forwardX + centerVy * forwardY;

        const maxSteer = this.carComponent.maxSteerSpeed;
        const minSteer = this.carComponent.minSteerFactor;
        const speedFactor = Math.min(Math.abs(forwardSpeed) / maxSteer, 1.0);
        const steerFactor = minSteer + (1 - minSteer) * speedFactor;
        const steerDirection = forwardSpeed >= 0 ? 1 : -1;

        const cols = this.carComponent.gridCols;
        const partCount = this.carComponent.partCount;
        const fX = frontIndices.reduce((s, i) => s + Transform.x[i], 0) / frontIndices.length;
        const fY = frontIndices.reduce((s, i) => s + Transform.y[i], 0) / frontIndices.length;
        const bX = backIndices.reduce((s, i) => s + Transform.x[i], 0) / backIndices.length;
        const bY = backIndices.reduce((s, i) => s + Transform.y[i], 0) / backIndices.length;
        const wheelBase = Math.hypot(fX - bX, fY - bY);

        let newHeadingX = forwardX;
        let newHeadingY = forwardY;
        if (turnForce !== 0 && wheelBase > 0.1) {
            const steerAngle = turnForce * this.carComponent.steeringAngle;
            const delta = 0.016;
            const rearX = (fX + bX) / 2 - forwardX * wheelBase / 2;
            const rearY = (fY + bY) / 2 - forwardY * wheelBase / 2;
            const rearNextX = rearX + centerVx * delta;
            const rearNextY = rearY + centerVy * delta;
            const cosS = Math.cos(steerAngle);
            const sinS = Math.sin(steerAngle);
            const frontNextX = rearX + forwardX * wheelBase + (centerVx * cosS - centerVy * sinS) * delta;
            const frontNextY = rearY + forwardY * wheelBase + (centerVx * sinS + centerVy * cosS) * delta;
            const dx = frontNextX - rearNextX;
            const dy = frontNextY - rearNextY;
            const len = Math.hypot(dx, dy) || 0.001;
            newHeadingX = dx / len;
            newHeadingY = dy / len;
        }

        const turnMagnitude = turnForce !== 0 ? Math.abs(turnForce) * steerFactor : 0;
        const forwardScale = turnMagnitude > 0 ? 1 / (1 + turnMagnitude * 1.5) : 1;
        const scaledForward = forwardForce * forwardScale;

        const slipSpeed = this.carComponent.slipSpeed;
        const traction = speed > slipSpeed ? this.carComponent.tractionLoose : this.carComponent.tractionTight;
        const redirectK = 0.008 * traction;

        if (speed > 1) {
            const dir = forwardSpeed >= 0 ? 1 : -1;
            const desiredVx = newHeadingX * speed * dir;
            const desiredVy = newHeadingY * speed * dir;
            const corrX = (desiredVx - centerVx) * redirectK;
            const corrY = (desiredVy - centerVy) * redirectK;
            for (const partIdx of allParts) {
                RigidBody.ax[partIdx] += corrX;
                RigidBody.ay[partIdx] += corrY;
            }
        }

        if (scaledForward !== 0) {
            for (const partIdx of allParts) {
                RigidBody.ax[partIdx] += forwardX * scaledForward;
                RigidBody.ay[partIdx] += forwardY * scaledForward;
            }
        }

        if (turnForce !== 0) {
            const effectiveTurn = turnForce * steerFactor * steerDirection;
            for (let i = 0; i < partCount; i++) {
                const partIdx = this.carComponent[PART_KEYS[i]];
                const col = i % cols;
                const frontness = (col - (cols - 1) / 2) * (2 / (cols - 1));
                const partTurn = effectiveTurn * frontness;
                RigidBody.ax[partIdx] += lateralX * partTurn;
                RigidBody.ay[partIdx] += lateralY * partTurn;
            }
        }

        if (forwardForce !== 0 || turnForce !== 0) {
            for (const partIdx of allParts) {
                RigidBody.sleeping[partIdx] = 0;
                RigidBody.stillnessTime[partIdx] = 0;
            }
        }
    }

    _updateSpriteFrame() {
        const { frontIndices, backIndices } = this._getFrontBackParts();
        const frontActive = frontIndices.every(i => Transform.active[i]);
        const backActive = backIndices.every(i => Transform.active[i]);
        if (!frontActive || !backActive) return;

        const spritesheetId = this.spriteRenderer.spritesheetId;
        if (!spritesheetId) return;
        const spritesheet = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
        if (!spritesheet) return;

        const animNames = SpriteSheetRegistry.getAnimationNames(spritesheet);
        const angleKeys = animNames
            .map(k => ({ num: parseFloat(k), key: k }))
            .filter(p => !isNaN(p.num))
            .sort((a, b) => a.num - b.num);
        if (angleKeys.length === 0) return;

        let angle = this.carComponent.angle;
        if (angle < 0) angle += TWO_PI;
        const degrees = (angle * 180) / Math.PI;
        const degreesNorm = ((degrees % 360) + 360) % 360;

        const index = Math.round((degreesNorm / 360) * angleKeys.length) % angleKeys.length;
        this.setAnimation(angleKeys[index].key);
    }
}
