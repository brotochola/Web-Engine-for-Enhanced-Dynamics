// CarScene.js - Car physics demo scene
// Demonstrates Verlet physics car using two connected circles

import WEED from '/src/index.js';
import { AICar } from '../gameObjects/aiCar.js';
import { PlayerCar } from '../gameObjects/playerCar.js';
import { CarPart } from '../gameObjects/carPart.js';
import { NavGrid } from '../../src/core/NavGrid.js';
import { rng } from '../../src/core/utils.js';
import { Rock } from '../gameObjects/rock.js';

const { Camera, Transform } = WEED;

export class CarScene extends WEED.Scene {
    // ========================================
    // STATIC SCENE CONFIGURATION
    // ========================================

    static config = {
        worldWidth: 10000,
        worldHeight: 7000,
        seed: 123456,
        debugUpdateInterval: 100,

        // Spatial hash grid configuration
        spatial: {
            cellSize: 128,
            maxNeighbors: 256,
            maxEntitiesPerCell: 32,
            numberOfSpatialWorkers: 1,
            noLimitFPS: true,
        },

        particle: {
            noLimitFPS: true,
            maxParticles: 1000,
            decals: false,
        },

        decoration: {
            maxDecorations: 100,
        },

        // Logic configuration
        logic: {
            noLimitFPS: true,
            numberOfLogicWorkers: 1,
            staggeredUpdates: false,
        },

        // Physics configuration
        physics: {
            subStepCount: 6, // Higher substeps for stable constraints
            noLimitFPS: true,
            maxCollisionPairs: 50000,
            maxConstraints: 50000, // Enable constraint system for car physics
            boundaryElasticity: 0.3,
            collisionResponseStrength: 0.8,
            verletDamping: 0.999, // Very low damping - car maintains momentum
            gravity: { x: 0, y: 0 },
            sleepThreshold: 999,   // Disable sleeping for this scene
            wakeUpThreshold: 1000,
            sleepDuration: 1000,
        },

        renderer: {
            noLimitFPS: true,
            ySorting: true,
            interpolation: true,
            cullingRatio: 0.5,
            maxVisibleRenderables: 5000, // Must fit: cars + rocks + particles + decorations (500 cars + 1000 particles = 1500+)
        },

        preRender: {
            noLimitFPS: true,
        },

        lighting: {
            enabled: false,
        },

        navigation: {
            enabled: true,
            cellSize: 64,
        },
    };

    // ========================================
    // STATIC ASSETS CONFIGURATION
    // ========================================

    static assets = {
        textures: {
            smoke: '/demos/img/smoke.png',
            rock1: '/demos/img/rock1.png',
            rock2: '/demos/img/rock2.png',
            rock3: '/demos/img/rock3.png',
            rock4: '/demos/img/rock4.png',
        },
        spritesheets: {

            red_car: {
                json: '/demos/img/cars/red.json',
                png: '/demos/img/cars/red.png',
            },
            yellow_car: {
                json: '/demos/img/cars/yellow.json',
                png: '/demos/img/cars/yellow.png',
            },
            black_car: {
                json: '/demos/img/cars/black.json',
                png: '/demos/img/cars/black.png',
            },
            white_car: {
                json: '/demos/img/cars/white.json',
                png: '/demos/img/cars/white.png',
            },
            blue_car: {
                json: '/demos/img/cars/blue.json',
                png: '/demos/img/cars/blue.png',
            },
            car_police: {
                json: '/demos/img/cars/poli.json',
                png: '/demos/img/cars/poli.png',
            },
            // car_burnt: {
            //     json: '/demos/img/cars/burnt.json',
            //     png: '/demos/img/cars/burnt.png',
            // },
        },
        tilemaps: {
            myTilemap: {
                json: '/demos/img/tilemap/2.json',
                png: '/demos/img/tilemap/2.png',
            },
        },
        flowfields: {
            roads: '/demos/flowfield1.json',
        },
    };

    // ========================================
    // STATIC ENTITY REGISTRATION
    // ========================================

    static entities = [
        [CarPart, 5000],   // Physics bodies (up to 8 per car, 501 cars) - must load first (Car depends on it)
        [AICar, 1000],    // NPC cars following player via flowfield - must load before PlayerCar
        [PlayerCar, 1],   // Player-controlled car (only 1)
        [Rock, 1000]
    ];

    // ========================================
    // INSTANCE LIFECYCLE HOOKS
    // ========================================

    constructor(game) {
        super(game);
        this.playerCar = null;
    }

    createNavGridForTheFlowField() {
        NavGrid.updateNavGrid([
            ...Rock.getAllActive(),
        ]);
    }

    create() {
        // Set tilemap background
        this.setTilemapBackground('myTilemap', { scale: 1 });

        const centerX = this.config.worldWidth / 2;
        const centerY = this.config.worldHeight / 2;

        // Spawn player car at center of world
        this.playerCar = PlayerCar.spawn({
            x: centerX,
            y: centerY,
            sprite: 'car_police',
        });

        // Spawn NPC cars randomly around the center - they will follow player via flowfield
        const carSprites = ['red_car', 'yellow_car', 'black_car', 'white_car', 'blue_car'];
        const spawnRadius = 2000;

        for (let i = 0; i < 10; i++) {
            const offsetX = (rng() * 2 - 1) * spawnRadius;
            const offsetY = (rng() * 2 - 1) * spawnRadius;
            const sprite = carSprites[Math.floor(rng() * carSprites.length)];

            AICar.spawn({
                x: centerX + offsetX,
                y: centerY + offsetY,
                sprite: sprite,
            });
        }

        // Initialize navigation grid (all cells walkable for open-world driving)
        setTimeout(() => NavGrid.updateNavGrid([]), 500);

        // Center camera on player car initially
        if (this.playerCar) {
            Camera.centerOn(
                Transform.x[this.playerCar.index],
                Transform.y[this.playerCar.index]
            );
        }

        console.log('🚗 CarScene: Player car and AI cars spawned! Drive with WASD/Arrow keys - AI cars follow you via flowfield pathfinding.');
    }

    update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
        if (frameNumber % 300 === 0) {
            this.createNavGridForTheFlowField()
        }
        // Camera is updated by PlayerCar.tick() (zoom + look-ahead follow)
    }

}
