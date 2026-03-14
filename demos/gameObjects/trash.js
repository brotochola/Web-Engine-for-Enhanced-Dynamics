import { RigidBody } from '../../src/index.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { Lootable } from './lootable.js';
import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
    GameObject,

    Collider,
    SpriteRenderer,
    LightEmitter,
    rng,
    randomColor,
    ShadowCaster,
    enums,
} = WEED;
const { ShapeType } = enums;

export class Trash extends Lootable {
    static scriptUrl = import.meta.url;
    static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LootableComponent];

    static resistance = 0.5

    setup() {
        this.setSprite('trash');
        this.setScale(Math.random() > 0.5 ? 1 : -1, 1);

        this.spriteRenderer.anchorY = 0.66
        this.spriteRenderer.anchorX = 0.5

        this.collider.shapeType = ShapeType.Circle;
        this.rigidBody.friction = 0.8;
        this.collider.radius = 30

        this.collider.visualRange = this.collider.radius * 2
        // this.collider.offsetY = -15;

        // Shadow uses default heightMultiplier = 1 (matches sprite scale)
        this.shadowCaster.heightMultiplier = 1.5

        this.shadowCaster.anchorOffsetY = -0.1
        // this.shadowCaster.anchorOffsetX = 0.5

        this.lootableComponent.health = 1;
        this.lootableComponent.dropMoney = 100;
    }

    recieveDamage(damage) {
        super.recieveDamage(damage)
        this.emitSparks()
    }

    die() {
        super.die()
        this.despawn()
        this.emitSparks()
    }

    // onSpawned(spawnConfig = {}) { }
}
