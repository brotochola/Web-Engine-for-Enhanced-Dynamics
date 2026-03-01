// Car.js - Base car class using Verlet physics with a grid of connected circles
// The car consists of a cols x 2 grid of CarPart entities (3x2 or 4x2).
// Triangular mesh constraints keep the shape rigid with fewer constraints.
// Two rows give a flatter front/back for more predictable crash behavior.
// This base class has no input - extend it (like PlayerCar) for controllable cars.

import WEED from '/src/index.js';
import { CarComponent, PART_KEYS, CONSTRAINT_KEYS } from '../components/carComponent.js';
import { CarPart } from './carPart.js';

const { GameObject, RigidBody, SpriteRenderer, Transform, Constraint } = WEED;

// Physics constants
export const CAR_CONSTRAINT_STIFFNESS = 0.99;

// Movement constants (exported for subclasses)
export const ACCELERATION_FORCE = 0.2;  // Forward/backward thrust
export const TURN_FORCE = 0.066;        // Turning force on front parts
export const SPRITE_SCALE = 1.5;
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
        const scale = spawnConfig.scale || SPRITE_SCALE;

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
        const lengthSpan = carLength - 2 * radius;
        const heightSpan = carHeight - 2 * radius;
        const colSpacing = cols > 1 ? lengthSpan / (cols - 1) : 0;
        const rowSpacing = rows > 1 ? heightSpan / (rows - 1) : 0;

        const startX = x - lengthSpan / 2;
        const startY = y - heightSpan / 2;

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
            return Constraint.add(parts[a].index, parts[b].index, dist, CAR_CONSTRAINT_STIFFNESS);
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

        this._updateSpriteFrame();
    }

    applyForces(forwardForce, turnForce) {
        const { frontIndices, backIndices } = this._getFrontBackParts();
        const frontActive = frontIndices.every(i => Transform.active[i]);
        const backActive = backIndices.every(i => Transform.active[i]);
        if (!frontActive || !backActive) return;

        const frontX = frontIndices.reduce((s, i) => s + Transform.x[i], 0) / frontIndices.length;
        const frontY = frontIndices.reduce((s, i) => s + Transform.y[i], 0) / frontIndices.length;
        const backX = backIndices.reduce((s, i) => s + Transform.x[i], 0) / backIndices.length;
        const backY = backIndices.reduce((s, i) => s + Transform.y[i], 0) / backIndices.length;

        const angle = Math.atan2(frontY - backY, frontX - backX);
        const forwardX = Math.cos(angle);
        const forwardY = Math.sin(angle);

        // Use average front velocity for steering
        const velX = frontIndices.reduce((s, i) => s + RigidBody.vx[i], 0) / frontIndices.length;
        const velY = frontIndices.reduce((s, i) => s + RigidBody.vy[i], 0) / frontIndices.length;
        const forwardSpeed = velX * forwardX + velY * forwardY;

        const maxSteerSpeed = 10;
        const steerFactor = Math.min(Math.abs(forwardSpeed) / maxSteerSpeed, 1.0);
        const steerDirection = forwardSpeed >= 0 ? 1 : -1;

        const allParts = this._getAllPartIndices();
        const frontParts = this._getFrontPartIndices();

        if (forwardForce !== 0) {
            for (const partIdx of allParts) {
                RigidBody.ax[partIdx] += forwardX * forwardForce;
                RigidBody.ay[partIdx] += forwardY * forwardForce;
            }
        }

        if (turnForce !== 0) {
            const effectiveTurn = turnForce * steerFactor * steerDirection;
            for (const partIdx of frontParts) {
                RigidBody.ax[partIdx] += -forwardY * effectiveTurn;
                RigidBody.ay[partIdx] += forwardX * effectiveTurn;
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

        const frontX = frontIndices.reduce((s, i) => s + Transform.x[i], 0) / frontIndices.length;
        const frontY = frontIndices.reduce((s, i) => s + Transform.y[i], 0) / frontIndices.length;
        const backX = backIndices.reduce((s, i) => s + Transform.x[i], 0) / backIndices.length;
        const backY = backIndices.reduce((s, i) => s + Transform.y[i], 0) / backIndices.length;

        let angle = Math.atan2(frontY - backY, frontX - backX);
        if (angle < 0) angle += TWO_PI;

        const degrees = (angle * 180) / Math.PI;
        const snappedDegrees = Math.round(degrees / 30) * 30 % 360;
        this.setAnimation(String(snappedDegrees));
    }
}
