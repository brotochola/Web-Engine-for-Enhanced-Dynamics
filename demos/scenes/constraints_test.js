// ConstraintsTestScene.js - Distance Constraints Demo
// Demonstrates distance constraints (ropes, chains, soft bodies)

import { Ball } from '/demos/gameObjects/ball.js';
import { Floor } from '/demos/gameObjects/floor.js';

import WEED from '/src/index.js';
const { Scene, Camera, Mouse, Constraint, RigidBody, Transform, Grid, Collider, distanceSq2D } = WEED;

export class ConstraintsTestScene extends Scene {
    // ========================================
    // STATIC SCENE CONFIGURATION
    // ========================================

    static config = {
        worldWidth: 6000,
        worldHeight: 4000,

        // Spatial hash grid configuration
        spatial: {
            numberOfSpatialWorkers: 2,
            cellSize: 100,
            maxNeighbors: 512,
            noLimitFPS: true,
            collisionCandidateSearchMargin: 0.5
        },

        // Logic configuration
        logic: {
            noLimitFPS: true,
        },

        particle: {
            noLimitFPS: true,
            maxParticles: 0,
            decals: false,
            decalsTileSize: 256,
            decalsResolution: 0.5,
        },

        // Physics configuration
        physics: {
            subStepCount: 8, // Higher substeps for stable constraints
            noLimitFPS: true,
            maxCollisionPairs: 100000,
            maxConstraints: 50000, // Enable constraint system
            verletDamping: 0.999,
            boundaryElasticity: 0,
            collisionResponseStrength: 0.66,
            gravity: { x: 0, y: 0.5 },
            sleepThreshold: 0.5,
            wakeUpThreshold: 0.5,
            sleepDuration: 1000,
        },

        renderer: {
            noLimitFPS: true,
        },

        lighting: {
            enabled: false,
        },
    };

    // ========================================
    // STATIC ASSETS CONFIGURATION
    // ========================================

    static assets = {
        textures: {
            ball: '/demos/img/bola.png',
        },
    };

    // ========================================
    // STATIC ENTITY REGISTRATION
    // ========================================

    static entities = [
        [Ball, 10000], // Pre-allocate pool for 10000 balls
        [Floor, 1000], // Pre-allocate pool for floor and walls
    ];

    // ========================================
    // INSTANCE LIFECYCLE HOOKS
    // ========================================

    constructor(game) {
        super(game);

        // Camera control settings
        this.cameraPanSpeed = 10;
        this.cameraFollowX = 0;
        this.cameraFollowY = 0;

        // Track spawned chains for demo
        this.chains = [];

        // Click-to-connect constraint mode
        this.constraintMode = false;
        this.selectedEntityForConstraint = -1; // First selected entity index
        this.constraintStiffness = 0.8; // Default stiffness for new constraints

        // Builder mode - click to spawn ball and connect to neighbors
        this.builderMode = false;
        this.builderNeighborRadius = 100; // Max distance to connect neighbors
        this.builderConstraintStiffness = 0.5; // Stiffness for builder constraints
    }

    create() {
        // Spawn floor and walls first (static colliders)
        console.log('🎬 ConstraintsTestScene: Spawning floor and walls...');
        this.spawnFloorAndWalls();

        // Initialize camera at world center
        this.cameraFollowX = this.config.worldWidth / 2;
        this.cameraFollowY = this.config.worldHeight / 2;
        Camera.centerOn(this.cameraFollowX, this.cameraFollowY);

        // Spawn demo constraint structures
        console.log('🎬 ConstraintsTestScene: Creating constraint demos...');

        // // Create several hanging chains
        // this.createHangingChain(800, 200, 15, 40, 0.8);
        // this.createHangingChain(1200, 200, 20, 35, 0.9);
        // this.createHangingChain(1600, 200, 12, 45, 0.7);
        // this.createHangingChain(2000, 200, 18, 38, 0.85);
        // this.createHangingChain(2400, 200, 25, 30, 0.95);

        // Create a rope bridge
        // this.createRopeBridge(2800, 800, 3200, 800, 20, 0.6);

        // Create a soft body (circular arrangement)
        this.createSoftBody(3000, 500, 40, 120, 0.1);
        // this.createSoftBody(1800, 1500, 12, 120, 0.4);
        // this.createSoftBody(2600, 1500, 6, 80, 0.6);

        // Create a grid/cloth simulation
        this.createCloth(1200, 2500, 20, 20, 40, 0.1, 20);

        // Spawn some free balls for interaction
        console.log('🎬 ConstraintsTestScene: Spawning free balls...');
        // this.spawnBalls(500);

        console.log('✅ ConstraintsTestScene: Demo ready!');
        console.log('📝 Controls:');
        console.log('   WASD/Arrows - Pan camera');
        console.log('   Mouse wheel - Zoom');
        console.log('   Click+drag - Push balls');
        console.log('   C - Create chain at mouse');
        console.log('   G - Toggle gravity');
        console.log('   X - Toggle constraint mode (click two balls to connect)');
        console.log('   R - Toggle remove mode (click two balls to disconnect)');
        console.log('   B - Toggle builder mode (click to spawn ball + connect to neighbors)');
        console.log('   K - Toggle constraint visualization in DebugUI');
    }

    /**
     * Create a hanging chain (rope) of connected balls
     * @param {number} startX - X position of anchor point
     * @param {number} startY - Y position of anchor point
     * @param {number} length - Number of balls in chain
     * @param {number} spacing - Distance between balls
     * @param {number} stiffness - Constraint stiffness (0-1)
     */
    createHangingChain(startX, startY, length, spacing, stiffness = 0.8) {
        const balls = [];

        for (let i = 0; i < length; i++) {
            const ball = Ball.spawn({
                x: startX,
                y: startY + i * spacing,
                vx: 0,
                vy: 0,
            });

            if (ball) {
                // First ball is static (anchor point)
                // Use direct array access since ball is just { index }
                if (balls.length === 0) {
                    RigidBody.static[ball.index] = 1;
                    RigidBody.invMass[ball.index] = 0; // Static = infinite mass
                }

                // Connect to previous ball (use balls.length - 1, not i - 1)
                if (balls.length > 0) {
                    const prevBall = balls[balls.length - 1];
                    Constraint.add(prevBall.index, ball.index, spacing, stiffness);
                }

                balls.push(ball);
            }
        }

        this.chains.push(balls);
        return balls;
    }

    /**
     * Create a rope bridge between two anchor points
     */
    createRopeBridge(x1, y1, x2, y2, segments, stiffness = 0.5) {
        const balls = [];
        const dx = (x2 - x1) / (segments - 1);
        const dy = (y2 - y1) / (segments - 1);
        const spacing = Math.sqrt(dx * dx + dy * dy);

        for (let i = 0; i < segments; i++) {
            const ball = Ball.spawn({
                x: x1 + dx * i,
                y: y1 + dy * i + (i > 0 && i < segments - 1 ? 50 : 0), // Sag in middle
                vx: 0,
                vy: 0,
            });

            if (ball) {
                balls.push(ball);

                // First and last balls are static (anchors)
                if (i === 0 || i === segments - 1) {
                    RigidBody.static[ball.index] = 1;
                    RigidBody.invMass[ball.index] = 0;
                }

                // Connect to previous ball
                if (i > 0 && balls[i - 1]) {
                    Constraint.add(balls[i - 1].index, ball.index, spacing, stiffness);
                }
            }
        }

        this.chains.push(balls);
        return balls;
    }

    /**
     * Create a soft body (circular arrangement of connected balls)
     */
    createSoftBody(centerX, centerY, numBalls, radius, stiffness = 0.5) {
        const balls = [];
        const angleStep = (Math.PI * 2) / numBalls;

        // Create balls in a circle
        for (let i = 0; i < numBalls; i++) {
            const angle = i * angleStep;
            const ball = Ball.spawn({
                x: centerX + Math.cos(angle) * radius,
                y: centerY + Math.sin(angle) * radius,
                radius: 10,
                vx: 0,
                vy: 0,
            });

            if (ball) {
                balls.push(ball);
            }
        }

        // Need at least 2 balls for constraints
        if (balls.length < 2) {
            console.warn('createSoftBody: Not enough balls spawned');
            return balls;
        }

        // Connect adjacent balls (perimeter)
        const actualBallCount = balls.length;
        const actualAngleStep = (Math.PI * 2) / actualBallCount;
        const perimeterSpacing = 2 * radius * Math.sin(actualAngleStep / 2);
        for (let i = 0; i < actualBallCount; i++) {
            const next = (i + 1) % actualBallCount;
            Constraint.add(balls[i].index, balls[next].index, perimeterSpacing, stiffness);
        }

        // Connect opposite balls (cross-bracing for shape retention)
        if (actualBallCount >= 4) {
            const crossSpacing = radius * 2;
            for (let i = 0; i < Math.floor(actualBallCount / 2); i++) {
                const opposite = (i + Math.floor(actualBallCount / 2)) % actualBallCount;
                Constraint.add(balls[i].index, balls[opposite].index, crossSpacing, stiffness * 0.8);
            }
        }

        // Add a center ball connected to all perimeter balls
        const centerBall = Ball.spawn({
            x: centerX,
            y: centerY,
            vx: 0,
            vy: 0,
        });

        if (centerBall) {
            // Connect center to all perimeter balls (use actualBallCount, not numBalls)
            for (let i = 0; i < actualBallCount; i++) {
                Constraint.add(centerBall.index, balls[i].index, radius, stiffness * 0.6);
            }
            balls.push(centerBall); // Add center ball after creating constraints
        }

        return balls;
    }

    /**
     * Create a cloth-like grid of connected balls
     */
    createCloth(startX, startY, width, height, spacing, stiffness = 0.3, radius = 10) {
        const balls = [];
        const grid = [];

        // Create grid of balls
        for (let row = 0; row < height; row++) {
            grid[row] = [];
            for (let col = 0; col < width; col++) {
                const ball = Ball.spawn({
                    x: startX + col * spacing,
                    y: startY + row * spacing,
                    radius: radius,
                    vx: 0,
                    vy: 0,
                });

                if (ball) {
                    balls.push(ball);
                    grid[row][col] = ball;

                    // Top row is static (anchored)
                    // if (row === 0) {
                    // RigidBody.static[ball.index] = 1;
                    // RigidBody.invMass[ball.index] = 0;
                    // }
                }
            }
        }

        // Connect horizontally and vertically
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const ball = grid[row][col];
                if (!ball) continue;

                // Connect to right neighbor
                if (col < width - 1 && grid[row][col + 1]) {
                    Constraint.add(ball.index, grid[row][col + 1].index, spacing, stiffness);
                }

                // Connect to bottom neighbor
                if (row < height - 1 && grid[row + 1][col]) {
                    Constraint.add(ball.index, grid[row + 1][col].index, spacing, stiffness);
                }

                // Diagonal connections for shear resistance (optional, improves stability)
                if (col < width - 1 && row < height - 1 && grid[row + 1][col + 1]) {
                    const diagSpacing = spacing * Math.SQRT2;
                    Constraint.add(ball.index, grid[row + 1][col + 1].index, diagSpacing, stiffness * 0.5);
                }

                // Diagonal connections in the other direction (top-right to bottom-left)
                if (col > 0 && row < height - 1 && grid[row + 1][col - 1]) {
                    const diagSpacing = spacing * Math.SQRT2;
                    Constraint.add(ball.index, grid[row + 1][col - 1].index, diagSpacing, stiffness * 0.5);
                }
            }
        }

        return balls;
    }

    update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
        if (Mouse.isDown) {
            [...Ball.getAllActive()].forEach(i => {
                RigidBody.sleeping[i] = 0
            });
        }
        // Handle WASD camera panning
        const panSpeed = this.cameraPanSpeed / Camera.zoom;
        const kb = this.keyboard;

        if (kb.w || kb.arrowup) this.cameraFollowY -= panSpeed;
        if (kb.s || kb.arrowdown) this.cameraFollowY += panSpeed;
        if (kb.a || kb.arrowleft) this.cameraFollowX -= panSpeed;
        if (kb.d || kb.arrowright) this.cameraFollowX += panSpeed;

        // Clamp camera target to world bounds
        this.cameraFollowX = Math.max(0, Math.min(this.cameraFollowX, this.config.worldWidth));
        this.cameraFollowY = Math.max(0, Math.min(this.cameraFollowY, this.config.worldHeight));

        Camera.follow(this.cameraFollowX, this.cameraFollowY, 0.15);
        Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.001));

        // Press C to create a new chain at mouse position
        if (kb.c && !this._cPressed) {
            this._cPressed = true;
            this.createHangingChain(Mouse.x, Mouse.y, 10, 35, 0.8);
            console.log(`Created new chain at (${Mouse.x.toFixed(0)}, ${Mouse.y.toFixed(0)})`);
        }
        if (!kb.c) this._cPressed = false;

        // Press G to toggle gravity direction
        if (kb.g && !this._gPressed) {
            this._gPressed = true;
            // Toggle gravity (send message to physics worker)
            const currentGravity = this.config.physics.gravity;
            const newGravityY = currentGravity.y > 0 ? -0.5 : 0.5;
            this.workers.physics.postMessage({
                msg: 'updatePhysicsConfig',
                config: { gravity: { x: 0, y: newGravityY } }
            });
            this.config.physics.gravity.y = newGravityY;
            console.log(`Gravity toggled to y=${newGravityY}`);
        }
        if (!kb.g) this._gPressed = false;

        // Press X to toggle constraint creation mode
        if (kb.x && !this._xPressed) {
            this._xPressed = true;
            this.constraintMode = !this.constraintMode;
            this.selectedEntityForConstraint = -1;
            console.log(`Constraint mode: ${this.constraintMode ? 'ON - Click two balls to connect' : 'OFF'}`);
        }
        if (!kb.x) this._xPressed = false;

        // Press R to remove constraint between two clicked balls
        if (kb.r && !this._rPressed) {
            this._rPressed = true;
            this._removeMode = !this._removeMode;
            this.selectedEntityForConstraint = -1;
            console.log(`Remove constraint mode: ${this._removeMode ? 'ON - Click two balls to disconnect' : 'OFF'}`);
        }
        if (!kb.r) this._rPressed = false;

        // Press B to toggle builder mode
        if (kb.b && !this._bPressed) {
            this._bPressed = true;
            this.builderMode = !this.builderMode;
            // Disable other modes when builder mode is enabled
            if (this.builderMode) {
                this.constraintMode = false;
                this._removeMode = false;
                this.selectedEntityForConstraint = -1;
            }
            console.log(`Builder mode: ${this.builderMode ? 'ON - Click to spawn ball and connect to neighbors' : 'OFF'}`);
        }
        if (!kb.b) this._bPressed = false;

        // Handle click-to-connect/remove in constraint mode
        if ((this.constraintMode || this._removeMode) && Mouse.isDown && !this._mouseWasDown) {
            this._handleConstraintClick();
        }

        // Handle builder mode click
        if (this.builderMode && Mouse.isDown && !this._mouseWasDown) {
            this._handleBuilderClick();
        }
        this._mouseWasDown = Mouse.isDown;

        // Log FPS periodically
        if (frameNumber % (60 * 5) === 0) {
            this.printFPS();
            // console.log(`Active constraints: ${Constraint.getActiveCount()}`);
        }
    }

    /**
     * Handle click in constraint mode - find nearest ball and select/connect
     */
    _handleConstraintClick() {
        const nearestIdx = this._findNearestBall(Mouse.x, Mouse.y, 100);

        if (nearestIdx < 0) {
            console.log('No ball found near click position');
            return;
        }

        if (this.selectedEntityForConstraint < 0) {
            // First click - select this ball
            this.selectedEntityForConstraint = nearestIdx;
            console.log(`Selected ball ${nearestIdx} - click another to ${this.constraintMode ? 'connect' : 'disconnect'}`);
        } else {
            // Second click - connect/disconnect to first selected
            if (nearestIdx === this.selectedEntityForConstraint) {
                console.log('Same ball clicked - selection cleared');
                this.selectedEntityForConstraint = -1;
                return;
            }

            if (this.constraintMode) {
                // Calculate distance between balls
                const ax = Transform.x[this.selectedEntityForConstraint];
                const ay = Transform.y[this.selectedEntityForConstraint];
                const bx = Transform.x[nearestIdx];
                const by = Transform.y[nearestIdx];
                const distance = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);

                // Create constraint
                const idx = Constraint.add(this.selectedEntityForConstraint, nearestIdx, distance, this.constraintStiffness);
                if (idx >= 0) {
                    console.log(`Created constraint ${idx} between ${this.selectedEntityForConstraint} and ${nearestIdx} (dist: ${distance.toFixed(1)})`);
                } else {
                    console.log('Failed to create constraint - pool may be full');
                }
            } else if (this._removeMode) {
                // Find and remove constraint between these two balls
                this._removeConstraintBetween(this.selectedEntityForConstraint, nearestIdx);
            }

            // Reset selection
            this.selectedEntityForConstraint = -1;
        }
    }

    /**
     * Find the nearest ball to a position within maxDistance
     */
    _findNearestBall(x, y, maxDistance) {
        let nearest = -1;
        let nearestDistSq = maxDistance * maxDistance;

        // Simple iteration over all active entities

        const active = Transform.active;
        const ex = Transform.x;
        const ey = Transform.y;

        for (let i = 0; i < active.length; i++) {
            if (!active[i]) continue;

            // Check if it's a Ball (has Collider with circle shape)
            if (!Collider.active[i] || Collider.shapeType[i] !== 0) continue;

            const dx = ex[i] - x;
            const dy = ey[i] - y;
            const distSq = dx * dx + dy * dy;

            if (distSq < nearestDistSq) {
                nearestDistSq = distSq;
                nearest = i;
            }
        }

        return nearest;
    }

    /**
     * Handle click in builder mode - spawn ball and connect to neighbors
     */
    _handleBuilderClick() {
        // Spawn a new ball at mouse position
        const newBall = Ball.spawn({
            x: Mouse.x,
            y: Mouse.y,
            vx: 0,
            vy: 0,
            visualRange: 200

        });

        // // Find all nearby balls
        setTimeout(() => {
            Collider.visualRange[newBall.index] = 500;
            const neighbors = [...Grid.getNeighborsOfEntityId(newBall.index)]
            console.log('Builder: Spawning ball', newBall.index, neighbors);

            for (const neighbor of neighbors) {
                const distSq = distanceSq2D(Transform.x[newBall.index], Transform.y[newBall.index], Transform.x[neighbor], Transform.y[neighbor]);
                console.log("creating constraint between", newBall.index, neighbor, Math.sqrt(distSq));
                Constraint.add(newBall.index, neighbor, Math.sqrt(distSq), this.builderConstraintStiffness);

            }

        }, 60);

    }

    /**
     * Remove any constraint between two entities
     */
    _removeConstraintBetween(entityA, entityB) {
        const pairs = Constraint.pairs;
        const constraintActive = Constraint.active;
        const maxConstraints = Constraint.maxCount;

        for (let i = 0; i < maxConstraints; i++) {
            if (!constraintActive[i]) continue;

            const packed = pairs[i];
            const a = packed >>> 16;
            const b = packed & 0xFFFF;

            if ((a === entityA && b === entityB) || (a === entityB && b === entityA)) {
                Constraint.remove(i);
                console.log(`Removed constraint ${i} between ${entityA} and ${entityB}`);
                return;
            }
        }

        console.log(`No constraint found between ${entityA} and ${entityB}`);
    }

    printFPS() {
        const smoothing = this.game.debugUI?.fpsSmoothing;
        if (!smoothing) {
            console.log('DebugUI not available');
            return;
        }

        const getSmoothedFPS = (s) => (s.sum / s.values.length).toFixed(2);

        console.log('=== Worker FPS (averaged) ===', performance.now());
        for (let i = 0; i < smoothing.spatial.length; i++) {
            console.log(`Spatial ${i}: ${getSmoothedFPS(smoothing.spatial[i])} FPS`);
        }
        console.log(`Physics: ${getSmoothedFPS(smoothing.physics)} FPS`);
        console.log(`Renderer: ${getSmoothedFPS(smoothing.renderer)} FPS`);
        console.log(`Particle: ${getSmoothedFPS(smoothing.particle)} FPS`);
        for (let i = 0; i < smoothing.logic.length; i++) {
            console.log(`Logic ${i}: ${getSmoothedFPS(smoothing.logic[i])} FPS`);
        }
    }

    // ========================================
    // SPAWNING HELPERS
    // ========================================

    spawnFloorAndWalls() {
        const wallThickness = 150;
        const worldWidth = this.config.worldWidth;
        const worldHeight = this.config.worldHeight;

        // Floor
        Floor.spawn({
            x: worldWidth / 2,
            y: worldHeight - wallThickness / 2 - wallThickness * 3,
            width: worldWidth,
            height: wallThickness,
        });

        // Top wall
        Floor.spawn({
            x: worldWidth / 2,
            y: wallThickness / 2,
            width: worldWidth,
            height: wallThickness,
        });

        // Left wall
        Floor.spawn({
            x: wallThickness / 2,
            y: worldHeight / 2,
            width: wallThickness,
            height: worldHeight,
        });

        // Right wall
        Floor.spawn({
            x: worldWidth - wallThickness / 2,
            y: worldHeight / 2,
            width: wallThickness,
            height: worldHeight,
        });
    }

    spawnBalls(count) {
        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                Ball.spawn({
                    x: 0.2 * this.config.worldWidth + this.rng() * this.config.worldWidth * 0.6,
                    y: 0.2 * this.config.worldHeight + this.rng() * this.config.worldHeight * 0.6,
                    vx: 0,
                    vy: 0,
                });
            }, i);
        }
    }

    // ========================================
    // PUBLIC SPAWNING METHODS (for UI buttons)
    // ========================================

    spawnRandomBall() {
        Ball.spawn({
            x: this.rng() * this.config.worldWidth,
            y: this.rng() * this.config.worldHeight,
            vx: 0,
            vy: 0,
        });
    }

    spawnBallAtMouse() {
        if (Mouse.x > 0 && Mouse.y > 0) {
            Ball.spawn({
                x: Mouse.x,
                y: Mouse.y,
                vx: 0,
                vy: 0,
            });
        }
    }

    spawnChainAtMouse() {
        if (Mouse.x > 0 && Mouse.y > 0) {
            this.createHangingChain(Mouse.x, Mouse.y, 15, 40, 0.8);
        }
    }
}
