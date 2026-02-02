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
    ShapeType,
} = WEED;

export class Trash extends Lootable {
    static scriptUrl = import.meta.url;
    static components = [Collider, SpriteRenderer, ShadowCaster, LootableComponent];

    static resistance = 0.5

    setup() {
        this.setSprite('trash');
        this.setScale(Math.random() > 0.5 ? 1 : -1, 1);

        this.collider.shapeType = ShapeType.Circle;
        this.collider.radius = 30

        this.collider.visualRange = 0;
        this.collider.offsetY = -15;

        this.shadowCaster.shadowRadius = this.collider.radius * 2;
        this.shadowCaster.height = 60

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
