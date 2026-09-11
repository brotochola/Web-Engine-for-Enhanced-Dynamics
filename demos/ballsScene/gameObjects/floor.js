import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

class Floor extends GameObject {
    static scriptUrl = import.meta.url;
    static instances = [];
    static components = [RigidBody, Collider, SpriteRenderer];

    setup() {
        this.spriteRenderer.active = 1;
        this.collider.visualRange = 0;
    }

    onSpawned(spawnConfig = {}) {
        const config = spawnConfig || {};

        const width = config.width || 100;
        const height = config.height || 100;

        this.collider.width = width;
        this.collider.height = height;
        this.collider.radius = 0;
        this.collider.shapeType = ShapeType.Box;
        this.rigidBody.static = 1;
        this.collider.friction = config.friction ?? 0.6;
        this.rotation = config.rotation ?? 0;

        const halfDiagonal = Math.hypot(width, height) / 2;
        this.collider.visualRange = halfDiagonal + 200;

        const sprite = config.sprite || '_white';
        this.setSprite(sprite);
        const origW = this.spriteRenderer.originalWidth || (sprite === '_white' ? 8 : 554);
        const origH = this.spriteRenderer.originalHeight || origW;
        this.setScale(width / origW, height / origH);
        this.setAnchor(0.5, 0.5);
        this.setTint(config.tint ?? (sprite === '_white' ? 0x666666 : 0xffffff));
        this.setAlpha(config.alpha ?? (sprite === '_white' ? 0.8 : 1));

        const rx = config.repeatX != null ? config.repeatX : sprite === '_white' ? 0 : origW;
        const ry = config.repeatY != null ? config.repeatY : sprite === '_white' ? 0 : origH;
        this.spriteRenderer.repeatX = rx | 0;
        this.spriteRenderer.repeatY = ry | 0;
    }

    tick() { }
}

export { Floor };
