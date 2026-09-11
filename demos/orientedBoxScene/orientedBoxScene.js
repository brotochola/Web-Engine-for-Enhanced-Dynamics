// OrientedBoxScene - Validate OBB colliders + angular dynamics (spin, stack, toss)

import { OrientedBox } from './gameObjects/orientedBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Ball } from '/demos/ballsScene/gameObjects/ball.js';
import { Camera } from '/src/core/Camera.js';
import WEED from '/src/index.js';

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

        const cx = this.config.worldWidth / 2;
        const cy = this.config.worldHeight / 2;
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
