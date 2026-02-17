// CarScene.js - Car physics demo scene
// Demonstrates Verlet physics car using two connected circles

import WEED from '/src/index.js';
import { Car } from '../gameObjects/car.js';
import { CarPart } from '../gameObjects/carPart.js';

const { Camera, Transform } = WEED;

export class CarScene extends WEED.Scene {
    // ========================================
    // STATIC SCENE CONFIGURATION
    // ========================================

    static config = {
        worldWidth: 2000,
        worldHeight: 1500,
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
            subStepCount: 4, // Higher substeps for stable constraints
            noLimitFPS: true,
            maxCollisionPairs: 10000,
            maxConstraints: 100, // Enable constraint system for car physics
            boundaryElasticity: 0.3,
            collisionResponseStrength: 0.8,
            verletDamping: 0.99,  // Slightly lower damping for more momentum
            gravity: { x: 0, y: 0 },
            sleepThreshold: 999,   // Disable sleeping for this scene
            wakeUpThreshold: 1000,
            sleepDuration: 9999,
        },

        renderer: {
            noLimitFPS: true,
            ySorting: true,
            interpolation: true,
            cullingRatio: 0.5,
            maxVisibleRenderables: 1000,
        },

        preRender: {
            noLimitFPS: true,
        },

        lighting: {
            enabled: false,
        },

        navigation: {
            enabled: false,
        },
    };

    // ========================================
    // STATIC ASSETS CONFIGURATION
    // ========================================

    static assets = {
        textures: {

        },
        spritesheets: {
            car: {
                json: '/demos/img/cars/black_car_12.json',
                png: '/demos/img/cars/black_car_12.png',
            },
        },
        tilemaps: {
            myTilemap: {
                json: '/demos/img/tilemap/2.json',
                png: '/demos/img/tilemap/2.png',
            },
        },
    };

    // ========================================
    // STATIC ENTITY REGISTRATION
    // ========================================

    static entities = [
        [Car, 10],      // Player-controlled cars
        [CarPart, 20],  // Physics bodies (2 per car)
    ];

    // ========================================
    // INSTANCE LIFECYCLE HOOKS
    // ========================================

    constructor(game) {
        super(game);
        this.playerCar = null;
    }

    create() {
        // Set tilemap background
        this.setTilemapBackground('myTilemap', { scale: 1 });

        // Spawn player car at center of world
        this.playerCar = Car.spawn({
            x: this.config.worldWidth / 2,
            y: this.config.worldHeight / 2,
        });

        // Center camera on car initially
        if (this.playerCar) {
            Camera.centerOn(
                Transform.x[this.playerCar.index],
                Transform.y[this.playerCar.index]
            );
        }

        console.log('🚗 CarScene: Car spawned! Use WASD/Arrow keys to drive.');
    }

    update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
        // Follow the player car with camera
        if (this.playerCar && Transform.active[this.playerCar.index]) {
            Camera.follow(
                Transform.x[this.playerCar.index],
                Transform.y[this.playerCar.index],
                0.1 // Smooth follow factor
            );
        }
    }

}
