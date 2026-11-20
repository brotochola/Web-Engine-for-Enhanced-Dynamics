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

        // Reads no neighbours: no visualRange (a visualRange gives an entity its neighbour list, SST-21).
        this.collider.visualRange = 0;
        // this.collider.offsetY = -15;

        // The silhouette's foot at the wheels: the sprite is anchored at 0.66 of its 80 rows (row 53) and the wheels touch
        // the ground at its last row, 0.34 of it lower. The foot 0.1 above the anchor (row 45, mid-bin) with a silhouette
        // 1.5 times as tall threw a shadow from inside the bin, which the bin covered. With ?light3d=1 the camera gives its
        // height and the engine measures its base: the ShadowCaster's default.
        if (!LIGHT3D) this.shadowCaster.setSprite({ heightScale: 1, anchorY: 0.34 });

        this.lootableComponent.health = 1;
        this.lootableComponent.dropMoney = 100;
        this.setFixedRotation(1);
    }

    /** A hit on bin i: Lootable's damage, and sparks. */
    static recieveDamage(i, damage, sourceX, sourceY) {
        super.recieveDamage(i, damage, sourceX, sourceY)
        this.emitSparks(i)
    }

    /** Bin i is broken: its loot drops, it goes, sparks fly. */
    static die(i) {
        super.die(i)
        this.despawn(i)
        this.emitSparks(i)
    }
}
