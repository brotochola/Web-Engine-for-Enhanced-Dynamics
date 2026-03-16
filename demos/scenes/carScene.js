// CarScene.js - Car physics demo scene
// Demonstrates Verlet physics car using two connected circles

import WEED from '/src/index.js';
import { Layer } from '/src/core/Layer.js';
import { AICar } from '../gameObjects/aiCar.js';
import { PlayerCar } from '../gameObjects/playerCar.js';
import { CarPart } from '../gameObjects/carPart.js';
import { NavGrid } from '../../src/core/NavGrid.js';
import { rng } from '../../src/core/utils.js';
import { Rock } from '../gameObjects/rock.js';

import { PersonThatFollowsAFlowfield } from '../gameObjects/personThatFollowsAFlowfield.js';

const { Camera, Transform } = WEED;
const excludedLPCAnimations = [
    'spellcast_up',
    'spellcast_left',
    'spellcast_down',
    'spellcast_right',
    'thrust_up',
    'thrust_left',
    'thrust_down',
    'thrust_right',
    // "slash_up",
    // "slash_left",
    // "slash_down",
    // "slash_right",
    'climb',
    'emote_up',
    'emote_left',
    'emote_down',
    'emote_right',
];
export class CarScene extends WEED.Scene {
    // ========================================
    // STATIC SCENE CONFIGURATION
    // ========================================

    static config = {
        worldWidth: 10000,
        worldHeight: 5000,
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
            maxParticles: 10000,
            decals: true,
            decalsTileSize: 256,
            decalsResolution: 0.5,
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
            sleepDuration: 100000,
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
    static audios = {
        ametralladora_disparo: '/demos/audios/ametralladora_disparo.mp3',
        bala_golpea_metal: '/demos/audios/bala_golpea_metal.mp3',
        bala_golpea_metal_2: '/demos/audios/bala_golpea_metal_2.mp3',
        dolor1: '/demos/audios/dolor1.mp3',
        dolor2: '/demos/audios/dolor2.mp3',
        dolor3: '/demos/audios/dolor3.mp3',
        dolor4: '/demos/audios/dolor4.mp3',
        explosion_corta: '/demos/audios/explosion_corta.mp3',
        explosion_de_fuego: '/demos/audios/explosion_de_fuego.mp3',
        explosion_larga: '/demos/audios/explosion_larga.mp3',
        golpe: '/demos/audios/golpe.mp3',
        pistola_disparo: '/demos/audios/pistola_disparo.mp3',
    };
    static assets = {
        textures: {
            smoke: '/demos/img/smoke.png',
            rock1: '/demos/img/rock1.png',
            rock2: '/demos/img/rock2.png',
            rock3: '/demos/img/rock3.png',
            rock4: '/demos/img/rock4.png',
            blood: '/demos/img/blood.png',
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
            civil1: {
                json: '/demos/img/civil1.json',
                png: '/demos/img/civil1.png',
                excludeAnimations: excludedLPCAnimations,
            },
            civil2: {
                json: '/demos/img/civil1.json',
                png: '/demos/img/civil2.png',
                excludeAnimations: excludedLPCAnimations,
            },
            civil3: {
                json: '/demos/img/civil1.json',
                png: '/demos/img/civil3.png',
                excludeAnimations: excludedLPCAnimations,
            },
        },
        tilemaps: {
            roads_tilemap: {
                json: '/demos/map_n_flowfield/tilemap.json',
                png: '/demos/img/tilemap/2.png',
            },
        },
        flowfields: {
            sidewalks: '/demos/map_n_flowfield/sidewalks_flowfield.json',
            roads: '/demos/map_n_flowfield/roads_flowfield.json',

        },
    };

    // ========================================
    // STATIC ENTITY REGISTRATION
    // ========================================

    static entities = [
        [CarPart, 5000],   // Physics bodies (up to 8 per car, 501 cars) - must load first (Car depends on it)
        [AICar, 1000],    // NPC cars following player via flowfield - must load before PlayerCar
        [PlayerCar, 1],   // Player-controlled car (only 1)
        [Rock, 1000],
        [PersonThatFollowsAFlowfield, 5000]
    ];

    // ========================================
    // INSTANCE LIFECYCLE HOOKS
    // ========================================

    constructor(game) {
        super(game);
        this.playerCar = null;
        this._cameraInit = false;
        this._cameraSmoothedVx = 0;
        this._cameraSmoothedVy = 0;
        this._cameraSmoothedSpeed = 0;
        this._cameraPrevCenterX = 0;
        this._cameraPrevCenterY = 0;
    }

    createNavGridForTheFlowField() {
        NavGrid.updateNavGrid([
            ...Rock.getAllActive(),
        ]);
    }

    async preload() {
        console.log('🚗 CarScene: Preloading...');
        await Layer.get('BACKGROUND').setTilemapBackground('roads_tilemap', { scale: 1 });

        const centerX = this.config.worldWidth / 2;
        const centerY = this.config.worldHeight / 2;

        this.playerCar = PlayerCar.spawn({
            x: 100,
            y: 100,
            sprite: 'car_police',
        });

        const carSprites = ['red_car', 'yellow_car', 'black_car', 'white_car', 'blue_car'];
        const spawnRadius = 1000;

        for (let i = 0; i < 20; i++) {
            const offsetX = (rng() * 2 - 1) * spawnRadius;
            const offsetY = (rng() * 2 - 1) * spawnRadius;
            const sprite = carSprites[Math.floor(rng() * carSprites.length)];

            AICar.spawn({
                x: 1000 + centerX + offsetX,
                y: centerY + offsetY,
                sprite: sprite,
            });
        }

        for (let i = 0; i < 1000; i++) {
            const offsetX = (rng() * 2 - 1) * spawnRadius;
            const offsetY = (rng() * 2 - 1) * spawnRadius;
            PersonThatFollowsAFlowfield.spawn({
                x: -1000 + centerX + offsetX,
                y: centerY + offsetY,
            });
        }

        this.createNavGridForTheFlowField();

        if (this.playerCar) {
            Camera.centerOn(
                Transform.x[this.playerCar.index],
                Transform.y[this.playerCar.index]
            );
            this._cameraInit = false;
            this._cameraPrevCenterX = Transform.x[this.playerCar.index];
            this._cameraPrevCenterY = Transform.y[this.playerCar.index];
        }

        console.log('🚗 CarScene: Preloaded!');

    }

    create() {

        console.log('🚗 CarScene: Player car and AI cars spawned! Drive with WASD/Arrow keys - AI cars follow you via flowfield pathfinding.');
    }

    update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
        // if (frameNumber % 300 === 0) {
        //     this.createNavGridForTheFlowField()
        // }

    }

}
