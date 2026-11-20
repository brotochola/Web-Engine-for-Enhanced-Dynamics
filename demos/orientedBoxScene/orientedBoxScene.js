// OrientedBoxScene - Validate OBB colliders + angular dynamics (spin, stack, toss)

import { OrientedBox } from './gameObjects/orientedBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Ball } from '/demos/ballsScene/gameObjects/ball.js';
import WEED from '/src/index.js';

const { Camera } = WEED;

export class OrientedBoxScene extends WEED.Scene {
    static config = {
        worldWidth: 5000,
        worldHeight: 6000,

        spatial: {
            cellSize: 100,
            maxNeighbors: 512,
            noLimitFPS: false,
        },

        logic: {
            noLimitFPS: false,
        },

        particle: {
            noLimitFPS: false,
            maxParticles: 0,
            decals: false,
        },

        physics: {
            subStepCount: 5,
            // The spawn burst queues about 5 200 commands at once: 8 192 holds them.
            commandRingCapacity: 8192,
            noLimitFPS: false,
            gravity: { x: 0, y: 1980 },
            sleeping: false,
        },

        renderer: {
            backend: 'webgl',
            noLimitFPS: false,
        },

        lighting: {
            enabled: false,
        },
    };

    static assets = {
        textures: {
            box: '/demos/img/box_100_100.png',
            ball: '/demos/img/bola.png',
        },
    };

    static entities = [
        [OrientedBox, 10000],
        [Ball, 1000],
        [Floor, 16],
    ];

    constructor(game) {
        super(game);
        this.numberOfBoxes = 1040;
    }

    create() {
        this.spawnFloorAndWalls();

        // N-166: the boxes fall to the floor at the world's bottom; the first view shows it (the view's bottom on it).
        const cx = this.config.worldWidth / 2;
        const viewHeight = (Camera.canvasHeight || 640) / (Camera.zoom || 1);
        const cy = this.config.worldHeight - viewHeight / 2;
        Camera.setFree(true, { panSpeed: 10 });
        Camera.setFreeTarget(cx, cy);
        Camera.centerOn(cx, cy);

    }

    

    createNewGame() {
        for (let i = 0; i < this.numberOfBoxes; i++) {
            const width = 10 + this.rng() * 10;
            const height = 100 + this.rng() * 100;
            OrientedBox.spawn({
                x: 500 + this.rng() * (this.config.worldWidth - 1000),
                y: 150 + this.rng() * (this.config.worldHeight * 0.45),
                width: width,
                height: height,
                rotation: this.rng() * Math.PI * 2,
                angularVelocity: (this.rng() - 0.5) * 0.15,
            });
        }

    }

    spawnFloorAndWalls() {
        const wallThickness = 150;
        const worldWidth = this.config.worldWidth;
        const worldHeight = this.config.worldHeight;

        Floor.spawn({
            x: worldWidth / 2,
            y: worldHeight - wallThickness / 2,
            width: worldWidth,
            height: wallThickness,
        });

        Floor.spawn({
            x: worldWidth / 2,
            y: wallThickness / 2,
            width: worldWidth,
            height: wallThickness,
        });

        Floor.spawn({
            x: wallThickness / 2,
            y: worldHeight / 2,
            width: wallThickness,
            height: worldHeight,
        });

        Floor.spawn({
            x: worldWidth - wallThickness / 2,
            y: worldHeight / 2,
            width: wallThickness,
            height: worldHeight,
        });
    }
}
