// OrientedBox - Rigid crate as ShapeType.Box (rotates with body)

import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Grab, enums } = WEED;
const { ShapeType } = enums;

export class OrientedBox extends GameObject {

    static components = [RigidBody, Collider, SpriteRenderer, Grab];

    onSpawned(spawnConfig = {}) {
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;
        const size = spawnConfig.size ?? 80;
        const width = spawnConfig.width ?? size;
        const height = spawnConfig.height ?? size;
        const texSize = 100;

        this.collider.shapeType = ShapeType.Box;
        this.collider.width = width;
        this.collider.height = height;
        this.collider.isTrigger = 0;
        this.collider.friction = 1;
        this.collider.visualRange = Math.hypot(width, height) * 0.5 + 200;

        this.rigidBody.static = 0;
        this.rigidBody.linearDamping = 0.001;
        this.rigidBody.angularDamping = 0.01;
        this.rigidBody.angularVelocity = 0;
        this.rigidBody.sleeping = 0;

        this.rotation = spawnConfig.rotation ?? 0;

        this.setSprite(spawnConfig.sprite || 'box');
        this.setScale(width / texSize, height / texSize);
        this.setAlpha(1);
        this.setTint(spawnConfig.tint ?? 0xffffff);
    }

    tick(_dtRatio) {
        // Physics owns position + rotation
    }
}

