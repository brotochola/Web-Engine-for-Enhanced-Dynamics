import WEED from '/src/index.js';

const { GameObject, Keyboard, Mouse, SpriteRenderer, rng } = WEED;

export class Cloud extends GameObject {
    static scriptUrl = import.meta.url;

    static components = [SpriteRenderer];

    setup() {

    }

    onSpawned(spawnConfig = {}) {

        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;

        this.setAlpha(rng() * 0.5 + 0.2);

        this.setSprite('cloud');

        this.spriteRenderer.scaleX = 4 + rng() * 6;
        this.spriteRenderer.scaleY = 4 + rng() * 6;
        this.rotation = rng() * Math.PI * 2;
        this.spriteRenderer.layerId = Layer.getId('clouds');

        this.setTint(0x000000);
    }

    /**
     * LIFECYCLE: Called when ball is despawned (returned to pool)
     * Cleanup and save state if needed
     */
    onDespawned() {
        // console.log(`Ball ${this.index} despawned`);
    }

    tick(dtRatio) {
        this.x += 0.3
        if (this.x > this.config.worldWidth + this.spriteRenderer.width) {
            this.onSpawned();
            this.x = -this.spriteRenderer.width * 2;

        }
    }
}
