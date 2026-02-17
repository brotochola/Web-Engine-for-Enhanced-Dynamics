// CarScene.js - Car physics demo scene
// Demonstrates Verlet physics car using two connected circles

import WEED from '/src/index.js';
import { Car } from '../gameObjects/car.js';
import { PlayerCar } from '../gameObjects/playerCar.js';
import { CarPart } from '../gameObjects/carPart.js';

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
            subStepCount: 4, // Higher substeps for stable constraints
            noLimitFPS: true,
            maxCollisionPairs: 10000,
            maxConstraints: 100, // Enable constraint system for car physics
            boundaryElasticity: 0.3,
            collisionResponseStrength: 0.8,
            verletDamping: 0.999, // Very low damping - car maintains momentum
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
            car_red: {
                json: '/demos/img/cars/red_car_12.json',
                png: '/demos/img/cars/red_car_12.png',
            },
            car_yellow: {
                json: '/demos/img/cars/yellow_car_12.json',
                png: '/demos/img/cars/yellow_car_12.png',
            },
            car_police: {
                json: '/demos/img/cars/poli.json',
                png: '/demos/img/cars/poli.png',
            },
            car_burnt: {
                json: '/demos/img/cars/burnt.json',
                png: '/demos/img/cars/burnt.png',
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
        [CarPart, 200],   // Physics bodies (2 per car) - must load first (Car depends on it)
        [Car, 100],       // NPC cars - must load before PlayerCar (PlayerCar extends Car)
        [PlayerCar, 1],   // Player-controlled car (only 1)
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

        const centerX = this.config.worldWidth / 2;
        const centerY = this.config.worldHeight / 2;

        // Spawn player car at center of world
        this.playerCar = PlayerCar.spawn({
            x: centerX,
            y: centerY,
        });

        // Spawn NPC cars around the world with different sprites
        const npcCars = [
            { x: centerX + 20, y: centerY - 100, sprite: 'car_red' },
            { x: centerX - 20, y: centerY + 100, sprite: 'car_yellow' },
            { x: centerX + 30, y: centerY + 200, sprite: 'car_police' },
            { x: centerX - 30, y: centerY - 200, sprite: 'car_burnt' },
        ];

        for (const npcConfig of npcCars) {
            Car.spawn(npcConfig);
        }

        // Center camera on player car initially
        if (this.playerCar) {
            Camera.centerOn(
                Transform.x[this.playerCar.index],
                Transform.y[this.playerCar.index]
            );
        }

        console.log('🚗 CarScene: Player car and NPC cars spawned! Use WASD/Arrow keys to drive.');
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
