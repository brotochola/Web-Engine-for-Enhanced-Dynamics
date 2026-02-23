// =============================================================================
// Unit Tests for src/core/utils.js
// Tests pure utility functions that don't depend on SABs, Workers, or DOM
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import {
    // Math utilities
    countTrailingZeros,
    clamp,
    clamp01,
    clamp01Fast,
    lerp,
    formatNumber,

    // Binary search
    binarySearchRange,
    binarySearchInsertPoint,
    binarySearchFind,

    // Distance & direction
    distanceSq2D,
    distance2D,
    isWithinRange,
    isWithinRangeSq,
    normalizeDirection,
    normalizeDirectionFast,
    normalizeDirectionFromDistSq,
    directionTo,

    // Ray intersection
    rayCircleIntersect,
    rayCircleHit,
    rayBoxIntersect,
    rayBoxHit,

    // Collision tests
    testCircleCircleCollision,
    testCircleAABBCollision,
    testAABBAABBCollision,

    // Geometry
    closestPointOnAABB,
    closestPointOnAABBMut,
    clampVelocity,
    clampVelocityMut,

    // Physics
    computeCircleMass,
    computeBoxMass,

    // Cantor pairing
    cantorPair,
    cantorUnpair,

    // Color
    applyBrightnessToColor,
    hslToHex,
    stringToHash,
    hashToPastelColorCSS,
    hashToPastelColorHex,

    // Camera
    calculateCameraScreenBounds,
    screenBoundsToWorldBounds,

    // Misc
    sortByY,
    seededRandom,
    randomRange,
    randomColor,
    urlToPath,
} from '../src/core/utils.js';

// =============================================================================
// MATH UTILITIES
// =============================================================================

describe('Math Utilities', () => {
    describe('countTrailingZeros', () => {
        it('returns 64 for zero', () => {
            expect(countTrailingZeros(0n)).toBe(64);
        });

        it('returns 0 for odd numbers', () => {
            expect(countTrailingZeros(1n)).toBe(0);
            expect(countTrailingZeros(3n)).toBe(0);
            expect(countTrailingZeros(7n)).toBe(0);
        });

        it('counts trailing zeros correctly', () => {
            expect(countTrailingZeros(2n)).toBe(1);   // 10
            expect(countTrailingZeros(4n)).toBe(2);   // 100
            expect(countTrailingZeros(8n)).toBe(3);   // 1000
            expect(countTrailingZeros(16n)).toBe(4);  // 10000
            expect(countTrailingZeros(32n)).toBe(5);  // 100000
            expect(countTrailingZeros(64n)).toBe(6);  // 1000000
        });

        it('handles high bit positions', () => {
            expect(countTrailingZeros(1n << 32n)).toBe(32);
            expect(countTrailingZeros(1n << 63n)).toBe(63);
        });
    });

    describe('clamp', () => {
        it('returns value when within range', () => {
            expect(clamp(5, 0, 10)).toBe(5);
        });

        it('clamps to min', () => {
            expect(clamp(-5, 0, 10)).toBe(0);
        });

        it('clamps to max', () => {
            expect(clamp(15, 0, 10)).toBe(10);
        });

        it('handles min === max', () => {
            expect(clamp(5, 3, 3)).toBe(3);
        });
    });

    describe('clamp01', () => {
        it('clamps between 0 and 1', () => {
            expect(clamp01(0.5)).toBe(0.5);
            expect(clamp01(-0.5)).toBe(0);
            expect(clamp01(1.5)).toBe(1);
        });

        it('returns fallback for non-numbers', () => {
            expect(clamp01('hello', 0.5)).toBe(0.5);
            expect(clamp01(undefined, 0)).toBe(0);
        });
    });

    describe('clamp01Fast', () => {
        it('clamps between 0 and 1', () => {
            expect(clamp01Fast(0.5)).toBe(0.5);
            expect(clamp01Fast(-0.5)).toBe(0);
            expect(clamp01Fast(1.5)).toBe(1);
            expect(clamp01Fast(0)).toBe(0);
            expect(clamp01Fast(1)).toBe(1);
        });
    });

    describe('lerp', () => {
        it('interpolates at t=0', () => {
            expect(lerp(0, 10, 0)).toBe(0);
        });

        it('interpolates at t=1', () => {
            expect(lerp(0, 10, 1)).toBe(10);
        });

        it('interpolates at t=0.5', () => {
            expect(lerp(0, 10, 0.5)).toBe(5);
        });

        it('works with negative values', () => {
            expect(lerp(-10, 10, 0.5)).toBe(0);
        });

        it('extrapolates beyond 0-1', () => {
            expect(lerp(0, 10, 2)).toBe(20);
            expect(lerp(0, 10, -1)).toBe(-10);
        });
    });

    describe('formatNumber', () => {
        it('formats small numbers directly', () => {
            expect(formatNumber(42)).toBe('42');
            expect(formatNumber(0)).toBe('0');
            expect(formatNumber(999)).toBe('999');
        });

        it('formats thousands with underscores', () => {
            expect(formatNumber(1000)).toBe('1_000');
            expect(formatNumber(9999)).toBe('9_999');
            expect(formatNumber(50000)).toBe('50_000');
        });

        it('formats millions', () => {
            expect(formatNumber(1000000)).toBe('1_000_000');
        });

        it('returns fallback for invalid inputs', () => {
            expect(formatNumber(null)).toBe('--');
            expect(formatNumber(undefined)).toBe('--');
            expect(formatNumber(NaN)).toBe('--');
            expect(formatNumber(NaN, 'N/A')).toBe('N/A');
        });
    });
});

// =============================================================================
// BINARY SEARCH UTILITIES
// =============================================================================

describe('Binary Search Utilities', () => {
    describe('binarySearchRange', () => {
        it('finds range in sorted array', () => {
            // Layout: [count, val0, val1, ...]
            const data = new Uint16Array([5, 10, 20, 30, 40, 50]);
            const result = binarySearchRange(data, 15, 45);
            expect(Array.from(result)).toEqual([20, 30, 40]);
        });

        it('returns empty for no matches', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            const result = binarySearchRange(data, 50, 100);
            expect(result.length).toBe(0);
        });

        it('handles empty array', () => {
            const data = new Uint16Array([0]);
            const result = binarySearchRange(data, 0, 10);
            expect(result.length).toBe(0);
        });
    });

    describe('binarySearchInsertPoint', () => {
        it('finds insert point in sorted array', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            // Insert 15: should go between 10 and 20 (index 2 in data array)
            expect(binarySearchInsertPoint(data, 15, 3)).toBe(2);
        });

        it('finds insert point at start', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            expect(binarySearchInsertPoint(data, 5, 3)).toBe(1);
        });

        it('finds insert point at end', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            expect(binarySearchInsertPoint(data, 35, 3)).toBe(4);
        });
    });

    describe('binarySearchFind', () => {
        it('finds existing element', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            expect(binarySearchFind(data, 20, 3)).toBe(2);
        });

        it('returns -1 for missing element', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            expect(binarySearchFind(data, 15, 3)).toBe(-1);
        });

        it('finds first element', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            expect(binarySearchFind(data, 10, 3)).toBe(1);
        });

        it('finds last element', () => {
            const data = new Uint16Array([3, 10, 20, 30]);
            expect(binarySearchFind(data, 30, 3)).toBe(3);
        });
    });
});

// =============================================================================
// DISTANCE & DIRECTION UTILITIES
// =============================================================================

describe('Distance & Direction Utilities', () => {
    describe('distanceSq2D', () => {
        it('returns 0 for same point', () => {
            expect(distanceSq2D(5, 5, 5, 5)).toBe(0);
        });

        it('calculates squared distance correctly', () => {
            expect(distanceSq2D(0, 0, 3, 4)).toBe(25); // 3² + 4² = 25
        });

        it('works with negative coordinates', () => {
            expect(distanceSq2D(-1, -1, 2, 3)).toBe(25); // 3² + 4² = 25
        });
    });

    describe('distance2D', () => {
        it('returns 0 for same point', () => {
            expect(distance2D(5, 5, 5, 5)).toBe(0);
        });

        it('calculates distance correctly', () => {
            expect(distance2D(0, 0, 3, 4)).toBe(5); // 3-4-5 triangle
        });
    });

    describe('isWithinRange', () => {
        it('returns true when within range', () => {
            expect(isWithinRange(0, 0, 3, 4, 5)).toBe(true); // exactly at range
            expect(isWithinRange(0, 0, 3, 4, 10)).toBe(true);
        });

        it('returns false when out of range', () => {
            expect(isWithinRange(0, 0, 3, 4, 4)).toBe(false);
        });
    });

    describe('isWithinRangeSq', () => {
        it('compares against squared range', () => {
            expect(isWithinRangeSq(0, 0, 3, 4, 25)).toBe(true);
            expect(isWithinRangeSq(0, 0, 3, 4, 24)).toBe(false);
        });
    });

    describe('normalizeDirection', () => {
        it('normalizes a vector to unit length', () => {
            const result = { x: 0, y: 0, length: 0 };
            normalizeDirection(3, 4, result);
            expect(result.x).toBeCloseTo(0.6);
            expect(result.y).toBeCloseTo(0.8);
            expect(result.length).toBeCloseTo(5);
        });

        it('handles zero vector', () => {
            const result = { x: 0, y: 0, length: 0 };
            normalizeDirection(0, 0, result);
            expect(result.x).toBe(0);
            expect(result.y).toBe(0);
            expect(result.length).toBe(0);
        });
    });

    describe('normalizeDirectionFast', () => {
        it('normalizes without zero-length check', () => {
            const result = { x: 0, y: 0, length: 0 };
            normalizeDirectionFast(3, 4, result);
            expect(result.x).toBeCloseTo(0.6);
            expect(result.y).toBeCloseTo(0.8);
            expect(result.length).toBeCloseTo(5);
        });
    });

    describe('normalizeDirectionFromDistSq', () => {
        it('normalizes using pre-calculated distSq', () => {
            const result = { x: 0, y: 0, length: 0 };
            normalizeDirectionFromDistSq(3, 4, 25, result);
            expect(result.x).toBeCloseTo(0.6);
            expect(result.y).toBeCloseTo(0.8);
            expect(result.length).toBeCloseTo(5);
        });
    });

    describe('directionTo', () => {
        it('returns direction from point A to point B', () => {
            const result = { x: 0, y: 0, length: 0 };
            directionTo(0, 0, 3, 4, result);
            expect(result.x).toBeCloseTo(0.6);
            expect(result.y).toBeCloseTo(0.8);
            expect(result.length).toBeCloseTo(5);
        });
    });
});

// =============================================================================
// RAY INTERSECTION UTILITIES
// =============================================================================

describe('Ray Intersection Utilities', () => {
    describe('rayCircleIntersect', () => {
        it('detects hit on circle directly ahead', () => {
            // Ray from (0,0) pointing right, circle at (10,0) radius 2
            const dist = rayCircleIntersect(0, 0, 1, 0, 10, 0, 2, 100);
            expect(dist).toBeCloseTo(8); // 10 - 2 = 8
        });

        it('returns -1 for miss', () => {
            // Ray from (0,0) pointing right, circle at (10,10) radius 1
            const dist = rayCircleIntersect(0, 0, 1, 0, 10, 10, 1, 100);
            expect(dist).toBe(-1);
        });

        it('returns -1 for circle behind ray', () => {
            // Ray from (0,0) pointing right, circle at (-10,0) radius 2
            const dist = rayCircleIntersect(0, 0, 1, 0, -10, 0, 2, 100);
            expect(dist).toBe(-1);
        });

        it('returns -1 when beyond max distance', () => {
            const dist = rayCircleIntersect(0, 0, 1, 0, 100, 0, 2, 50);
            expect(dist).toBe(-1);
        });
    });

    describe('rayCircleHit', () => {
        it('returns boolean for hit', () => {
            expect(rayCircleHit(0, 0, 1, 0, 10, 0, 2, 100)).toBe(true);
        });

        it('returns boolean for miss', () => {
            expect(rayCircleHit(0, 0, 1, 0, 10, 10, 1, 100)).toBe(false);
        });
    });

    describe('rayBoxIntersect', () => {
        it('detects hit on box directly ahead', () => {
            // Ray from (0,0) pointing right, box centered at (10,0) size 4x4
            const dist = rayBoxIntersect(0, 0, 1, 0, 10, 0, 4, 4, 100);
            expect(dist).toBeCloseTo(8); // box starts at x=8
        });

        it('returns -1 for miss', () => {
            // Ray from (0,0) pointing right, box at (10,10) size 2x2
            const dist = rayBoxIntersect(0, 0, 1, 0, 10, 10, 2, 2, 100);
            expect(dist).toBe(-1);
        });

        it('returns -1 when beyond max distance', () => {
            const dist = rayBoxIntersect(0, 0, 1, 0, 100, 0, 4, 4, 50);
            expect(dist).toBe(-1);
        });
    });

    describe('rayBoxHit', () => {
        it('returns boolean for hit', () => {
            expect(rayBoxHit(0, 0, 1, 0, 10, 0, 4, 4, 100)).toBe(true);
        });

        it('returns boolean for miss', () => {
            expect(rayBoxHit(0, 0, 1, 0, 10, 10, 2, 2, 100)).toBe(false);
        });
    });
});

// =============================================================================
// COLLISION TESTS
// =============================================================================

describe('Collision Tests', () => {
    describe('testCircleCircleCollision', () => {
        it('detects overlapping circles', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            const hit = testCircleCircleCollision(0, 0, 5, 8, 0, 5, result);
            expect(hit).not.toBeNull();
            expect(result.collided).toBe(true);
            expect(result.depth).toBeCloseTo(2); // (5+5) - 8 = 2
            expect(result.nx).toBeCloseTo(-1); // push left (from circle1 perspective)
            expect(result.ny).toBeCloseTo(0);
        });

        it('returns null for non-overlapping circles', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            const hit = testCircleCircleCollision(0, 0, 3, 10, 0, 3, result);
            expect(hit).toBeNull();
        });

        it('detects circles exactly touching', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            // Two circles touching: distance = r1+r2 → NO collision (>= check)
            const hit = testCircleCircleCollision(0, 0, 5, 10, 0, 5, result);
            expect(hit).toBeNull();
        });
    });

    describe('testCircleAABBCollision', () => {
        it('detects circle overlapping box', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            // Circle at (0,0) r=5, box at (6,0) 4x4 → overlap
            const hit = testCircleAABBCollision(0, 0, 5, 6, 0, 4, 4, result);
            expect(hit).not.toBeNull();
            expect(result.collided).toBe(true);
            expect(result.depth).toBeCloseTo(1); // 5 - 4 = 1
        });

        it('returns null for non-overlapping', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            const hit = testCircleAABBCollision(0, 0, 2, 10, 0, 4, 4, result);
            expect(hit).toBeNull();
        });
    });

    describe('testAABBAABBCollision', () => {
        it('detects overlapping boxes', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            // Box1 at (0,0) 4x4, Box2 at (3,0) 4x4 → overlap 1 on X
            const hit = testAABBAABBCollision(0, 0, 4, 4, 3, 0, 4, 4, result);
            expect(hit).not.toBeNull();
            expect(result.collided).toBe(true);
            expect(result.depth).toBeCloseTo(1);
            expect(result.nx).toBe(-1); // push left
        });

        it('returns null for non-overlapping boxes', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            const hit = testAABBAABBCollision(0, 0, 4, 4, 10, 10, 4, 4, result);
            expect(hit).toBeNull();
        });

        it('returns null for touching boxes (zero overlap)', () => {
            const result = { collided: false, depth: 0, nx: 0, ny: 0 };
            // Box1 at (0,0) 4x4, Box2 at (4,0) 4x4 → exactly touching
            const hit = testAABBAABBCollision(0, 0, 4, 4, 4, 0, 4, 4, result);
            expect(hit).toBeNull();
        });
    });
});

// =============================================================================
// GEOMETRY UTILITIES
// =============================================================================

describe('Geometry Utilities', () => {
    describe('closestPointOnAABB', () => {
        it('returns point on edge when outside', () => {
            const result = closestPointOnAABB(10, 0, 0, 0, 4, 4);
            expect(result.x).toBe(2); // Clamped to right edge
            expect(result.y).toBe(0);
        });

        it('returns same point when inside box', () => {
            const result = closestPointOnAABB(1, 1, 0, 0, 10, 10);
            expect(result.x).toBe(1);
            expect(result.y).toBe(1);
        });
    });

    describe('closestPointOnAABBMut', () => {
        it('mutates result object', () => {
            const result = { x: 0, y: 0 };
            closestPointOnAABBMut(10, 0, 0, 0, 4, 4, result);
            expect(result.x).toBe(2);
            expect(result.y).toBe(0);
        });
    });

    describe('clampVelocity', () => {
        it('returns same velocity when under max', () => {
            const result = clampVelocity(3, 4, 10);
            expect(result.vx).toBe(3);
            expect(result.vy).toBe(4);
        });

        it('clamps velocity to max speed', () => {
            const result = clampVelocity(30, 40, 5);
            const speed = Math.sqrt(result.vx ** 2 + result.vy ** 2);
            expect(speed).toBeCloseTo(5);
        });
    });

    describe('clampVelocityMut', () => {
        it('mutates result object', () => {
            const result = { vx: 0, vy: 0 };
            clampVelocityMut(30, 40, 5, result);
            const speed = Math.sqrt(result.vx ** 2 + result.vy ** 2);
            expect(speed).toBeCloseTo(5);
        });

        it('preserves direction when clamping', () => {
            const result = { vx: 0, vy: 0 };
            clampVelocityMut(30, 40, 5, result);
            // Direction should be same as original (3/5, 4/5)
            expect(result.vx / result.vy).toBeCloseTo(30 / 40);
        });
    });
});

// =============================================================================
// PHYSICS UTILITIES
// =============================================================================

describe('Physics Utilities', () => {
    describe('computeCircleMass', () => {
        it('computes mass from radius (π * r²)', () => {
            expect(computeCircleMass(1)).toBeCloseTo(Math.PI);
            expect(computeCircleMass(10)).toBeCloseTo(Math.PI * 100);
        });

        it('returns 0 for radius 0', () => {
            expect(computeCircleMass(0)).toBe(0);
        });
    });

    describe('computeBoxMass', () => {
        it('computes mass from dimensions (w * h)', () => {
            expect(computeBoxMass(4, 5)).toBe(20);
            expect(computeBoxMass(10, 10)).toBe(100);
        });

        it('returns 0 when either dimension is 0', () => {
            expect(computeBoxMass(0, 5)).toBe(0);
            expect(computeBoxMass(5, 0)).toBe(0);
        });
    });
});

// =============================================================================
// CANTOR PAIRING
// =============================================================================

describe('Cantor Pairing', () => {
    describe('cantorPair', () => {
        it('produces unique keys for different pairs', () => {
            const k1 = cantorPair(0, 0);
            const k2 = cantorPair(0, 1);
            const k3 = cantorPair(1, 0);
            expect(k1).not.toBe(k2);
            expect(k2).not.toBe(k3);
        });

        it('is order-dependent', () => {
            expect(cantorPair(3, 5)).not.toBe(cantorPair(5, 3));
        });
    });

    describe('cantorUnpair', () => {
        it('inverts cantorPair correctly', () => {
            const result = { a: 0, b: 0 };

            cantorUnpair(cantorPair(0, 0), result);
            expect(result.a).toBe(0);
            expect(result.b).toBe(0);

            cantorUnpair(cantorPair(3, 5), result);
            expect(result.a).toBe(3);
            expect(result.b).toBe(5);

            cantorUnpair(cantorPair(42, 17), result);
            expect(result.a).toBe(42);
            expect(result.b).toBe(17);
        });

        it('roundtrips many pairs', () => {
            const result = { a: 0, b: 0 };
            for (let a = 0; a < 20; a++) {
                for (let b = 0; b < 20; b++) {
                    const key = cantorPair(a, b);
                    cantorUnpair(key, result);
                    expect(result.a).toBe(a);
                    expect(result.b).toBe(b);
                }
            }
        });
    });
});

// =============================================================================
// COLOR UTILITIES
// =============================================================================

describe('Color Utilities', () => {
    describe('applyBrightnessToColor', () => {
        it('preserves color at brightness 1.0', () => {
            expect(applyBrightnessToColor(0xff8040, 1.0)).toBe(0xff8040);
        });

        it('returns black at brightness 0.0', () => {
            expect(applyBrightnessToColor(0xff8040, 0.0)).toBe(0x000000);
        });

        it('halves each channel at brightness 0.5', () => {
            const result = applyBrightnessToColor(0xff8040, 0.5);
            const r = (result >> 16) & 0xff;
            const g = (result >> 8) & 0xff;
            const b = result & 0xff;
            // Bitwise truncation: (255 * 0.5)|0 = 127, (128 * 0.5)|0 = 64, (64 * 0.5)|0 = 32
            expect(r).toBe(127);
            expect(g).toBe(64);
            expect(b).toBe(32);
        });

        it('clamps brightness above 1.0 to 1.0', () => {
            expect(applyBrightnessToColor(0xff8040, 2.0)).toBe(0xff8040);
        });
    });

    describe('hslToHex', () => {
        it('converts pure red', () => {
            // H=0, S=1, L=0.5 → pure red
            const color = hslToHex(0, 1, 0.5);
            const r = (color >> 16) & 0xff;
            expect(r).toBe(255);
        });

        it('converts pure green', () => {
            // H=120, S=1, L=0.5 → pure green
            const color = hslToHex(120, 1, 0.5);
            const g = (color >> 8) & 0xff;
            expect(g).toBe(255);
        });

        it('converts pure blue', () => {
            // H=240, S=1, L=0.5 → pure blue
            const color = hslToHex(240, 1, 0.5);
            const b = color & 0xff;
            expect(b).toBe(255);
        });

        it('converts black (L=0)', () => {
            expect(hslToHex(0, 0, 0)).toBe(0x000000);
        });

        it('converts white (L=1)', () => {
            const color = hslToHex(0, 0, 1);
            expect(color).toBe(0xffffff);
        });
    });

    describe('stringToHash', () => {
        it('produces deterministic hash', () => {
            expect(stringToHash('hello')).toBe(stringToHash('hello'));
        });

        it('produces different hashes for different strings', () => {
            expect(stringToHash('hello')).not.toBe(stringToHash('world'));
        });

        it('returns unsigned 32-bit integer', () => {
            const hash = stringToHash('test');
            expect(hash).toBeGreaterThanOrEqual(0);
            expect(hash).toBeLessThanOrEqual(0xffffffff);
        });
    });

    describe('hashToPastelColorCSS', () => {
        it('returns CSS HSL string', () => {
            const css = hashToPastelColorCSS(180);
            expect(css).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
        });
    });

    describe('hashToPastelColorHex', () => {
        it('returns a valid hex color', () => {
            const color = hashToPastelColorHex(42);
            expect(color).toBeGreaterThan(0);
            expect(color).toBeLessThanOrEqual(0xffffff);
        });
    });
});

// =============================================================================
// CAMERA UTILITIES
// =============================================================================

describe('Camera Utilities', () => {
    describe('calculateCameraScreenBounds', () => {
        it('computes screen bounds with culling margin', () => {
            const result = { zoom: 0, cameraOffsetX: 0, cameraOffsetY: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
            calculateCameraScreenBounds(1, 100, 50, 800, 600, 0.1, result);
            expect(result.zoom).toBe(1);
            expect(result.cameraOffsetX).toBe(100);
            expect(result.cameraOffsetY).toBe(50);
            expect(result.minX).toBe(-80);   // -800 * 0.1
            expect(result.maxX).toBe(880);   // 800 + 80
            expect(result.minY).toBe(-60);   // -600 * 0.1
            expect(result.maxY).toBe(660);   // 600 + 60
        });
    });

    describe('screenBoundsToWorldBounds', () => {
        it('converts screen bounds to world space', () => {
            const screenBounds = { zoom: 2, cameraOffsetX: 200, cameraOffsetY: 100, minX: -80, maxX: 880, minY: -60, maxY: 660 };
            const result = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
            screenBoundsToWorldBounds(screenBounds, 0, 0, result);
            expect(result.minX).toBeCloseTo(60);   // (-80 + 200) / 2
            expect(result.maxX).toBeCloseTo(540);  // (880 + 200) / 2
            expect(result.minY).toBeCloseTo(20);   // (-60 + 100) / 2
            expect(result.maxY).toBeCloseTo(380);  // (660 + 100) / 2
        });
    });
});

// =============================================================================
// SEEDED RANDOM & DEPENDENT FUNCTIONS
// =============================================================================

describe('seededRandom', () => {
    it('produces deterministic sequence from same seed', () => {
        const rng1 = seededRandom(42);
        const rng2 = seededRandom(42);
        const seq1 = Array.from({ length: 10 }, () => rng1());
        const seq2 = Array.from({ length: 10 }, () => rng2());
        expect(seq1).toEqual(seq2);
    });

    it('produces different sequences from different seeds', () => {
        const rng1 = seededRandom(42);
        const rng2 = seededRandom(99);
        const val1 = rng1();
        const val2 = rng2();
        expect(val1).not.toBe(val2);
    });

    it('returns values in [0, 1)', () => {
        const rng = seededRandom(123);
        for (let i = 0; i < 100; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe('randomRange (with global rng)', () => {
    beforeAll(() => {
        globalThis.rng = seededRandom(42);
    });

    it('returns default for undefined', () => {
        expect(randomRange(undefined, 5)).toBe(5);
        expect(randomRange(null, 3)).toBe(3);
    });

    it('returns the number directly', () => {
        expect(randomRange(7)).toBe(7);
    });

    it('returns value in {min, max} range', () => {
        for (let i = 0; i < 50; i++) {
            const v = randomRange({ min: 10, max: 20 });
            expect(v).toBeGreaterThanOrEqual(10);
            expect(v).toBeLessThanOrEqual(20);
        }
    });
});

describe('randomColor (with global rng)', () => {
    beforeAll(() => {
        globalThis.rng = seededRandom(42);
    });

    it('returns default for undefined', () => {
        expect(randomColor(undefined)).toBe(0xffffff);
    });

    it('returns the color directly for number input', () => {
        expect(randomColor(0xff0000)).toBe(0xff0000);
    });

    it('interpolates between min and max color', () => {
        for (let i = 0; i < 50; i++) {
            const c = randomColor({ min: 0x000000, max: 0xffffff });
            expect(c).toBeGreaterThanOrEqual(0x000000);
            expect(c).toBeLessThanOrEqual(0xffffff);
        }
    });
});

// =============================================================================
// MISCELLANEOUS
// =============================================================================

describe('Miscellaneous', () => {
    describe('sortByY', () => {
        it('sorts objects by y coordinate', () => {
            const items = [{ y: 30 }, { y: 10 }, { y: 20 }];
            items.sort(sortByY);
            expect(items[0].y).toBe(10);
            expect(items[1].y).toBe(20);
            expect(items[2].y).toBe(30);
        });
    });

    describe('urlToPath', () => {
        it('extracts pathname from URL', () => {
            const path = urlToPath('http://localhost:8000/demos/scene.js');
            expect(path).toBe('/demos/scene.js');
        });

        it('returns original string if not a valid URL', () => {
            const path = urlToPath('not-a-url');
            expect(path).toBe('not-a-url');
        });
    });
});
