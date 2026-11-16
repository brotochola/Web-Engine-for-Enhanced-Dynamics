import { RigidBody } from '/src/index.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { Lootable } from './lootable.js';
import WEED from '/src/index.js';
import { LIGHT3D } from '../light3d.js';

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
    static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LootableComponent];
    static serializable = true;
    static resistance = 0.5

    onSpawned(spawnConfig = {}) {
        this.setSprite('trash');
        this.setScale(rng() > 0.5 ? 1 : -1, 1);

        this.spriteRenderer.anchorY = 0.66
        this.spriteRenderer.anchorX = 0.5

        this.collider.shapeType = ShapeType.Circle;
        this.rigidBody.linearDamping = 0.8;
        this.collider.radius = 30

        this.collider.visualRange = this.collider.radius * 2
        // this.collider.offsetY = -15;

        // The silhouette 1.5 times as long, its foot 0.1 of the sprite above the anchor. With ?light3d=1 the camera gives
        // its height and the engine measures its base: the ShadowCaster's default.
        if (!LIGHT3D) this.shadowCaster.setSprite({ heightScale: 1.5, anchorY: -0.1 });

        this.lootableComponent.health = 1;
        this.lootableComponent.dropMoney = 100;
        this.setFixedRotation(1);
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
}
