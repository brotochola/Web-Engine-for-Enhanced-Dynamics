import { LootableComponent } from '../components/lootableComponent.js';
import { Lootable } from './lootable.js';
import WEED from '/src/index.js';
import { LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
    Collider,
    SpriteRenderer,
    RigidBody,
    rng,
    ShadowCaster,
    enums,
} = WEED;
const { ShapeType } = enums;

// A wheelie bin that drops money when it breaks. Written ECS-style (E-530), as Lootable is: every hook is static and
// takes the bin's index, so the logic workers make no instance for a bin.
export class Trash extends Lootable {
    static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LootableComponent];
    static serializable = true;
    static resistance = 0.5

    /** Bin i spawned: the bin's sprite, facing either way, on a round body that slides and never turns; one hit's health, 100 of money. */
    static onSpawned(i, spawnConfig) {
        SpriteRenderer.setSprite(i, 'trash');
        SpriteRenderer.setScale(i, rng() > 0.5 ? 1 : -1, 1);

        SpriteRenderer.setAnchor(i, 0.5, 0.66);

        Collider.setShapeType(i, ShapeType.Circle);
        RigidBody.setLinearDamping(i, 0.8);
        Collider.setRadius(i, 30);

        // Reads no neighbours: no visualRange (a visualRange gives an entity its neighbour list, SST-21).
        Collider.visualRange[i] = 0;

        // The silhouette's foot at the wheels: the sprite is anchored at 0.66 of its 80 rows (row 53) and the wheels touch
        // the ground at its last row, 0.34 of it lower. The foot 0.1 above the anchor (row 45, mid-bin) with a silhouette
        // 1.5 times as tall threw a shadow from inside the bin, which the bin covered. With ?light3d=1 the camera gives its
        // height and the engine measures its base: the ShadowCaster's default.
        if (!LIGHT3D) ShadowCaster.setSprite(i, { heightScale: 1, anchorY: 0.34 });

        LootableComponent.health[i] = 1;
        LootableComponent.dropMoney[i] = 100;
        RigidBody.setFixedRotation(i, 1);
    }

    /** A hit on bin i: Lootable's damage, and sparks. */
    static recieveDamage(i, damage, sourceX, sourceY) {
        super.recieveDamage(i, damage, sourceX, sourceY)
        this.emitSparks(i)
    }

    /** Bin i is broken: its loot drops, sparks fly, it goes. The sparks first: they start from its columns while it is alive. */
    static die(i) {
        super.die(i)
        this.emitSparks(i)
        this.despawn(i)
    }
}
