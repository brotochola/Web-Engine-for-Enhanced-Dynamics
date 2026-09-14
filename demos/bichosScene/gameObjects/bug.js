import WEED from '/src/index.js';

const { Mouse, distanceSq2D, GameObject, Collider, SpriteRenderer, rng, RigidBody, ShadowCaster, getDirection8FromVector } = WEED;

export class Bug extends GameObject {
    static ANIMATION_SPEED_MULTIPLIER = 0.007
    static MOVE_SPEED_THRESHOLD = 0.1;
    static deriveSpeed = true;
    // Auto-detected by GameEngine
    static scriptUrl = import.meta.url;
    static sqDistToFollow = 500 ** 2;

    // Define components this entity uses
    static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];

    setup() {
        // Initialize Collider
        this.collider.radius = 10;
        this.collider.visualRange = 100;

        // Initialize SpriteRenderer
        this.spriteRenderer.scaleX = 1;
        this.spriteRenderer.scaleY = 1;
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;

        this.rigidBody.linearDamping = 2;

        // Store current facing direction
        this._facingDirection = 's';
    }

    onSpawned(spawnConfig = {}) {
        // Set position from spawn config
        this.x = spawnConfig.x ?? 0;
        this.y = spawnConfig.y ?? 0;

        // Apply scale if provided
        const scale = spawnConfig.scale ?? 1;
        this.setScale(scale, scale);

        // Set the bicho spritesheet and default animation
        this.setSpritesheet('bicho');
        this.setAnimation('s');
        this._facingDirection = 's';
        this.setFixedRotation(1);
    }

    tick(dtRatio) {
        const i = this.index;
        const speed = RigidBody.speed[i];

        this.followMouse();

        const direction = getDirection8FromVector(RigidBody.vx[i], RigidBody.vy[i]);

        // Only change animation if direction changed
        if (direction !== this._facingDirection) {
            this._facingDirection = direction;
            this.setAnimation(direction);
        }

        // Adjust animation speed based on movement speed
        this.setAnimationSpeed(speed * Bug.ANIMATION_SPEED_MULTIPLIER);

    }

    followMouse() {
        if (Mouse.isDown && Mouse.isPresent) {
            this.rigidBody.sleeping = 0
            const sqDistToMouse = distanceSq2D(this.x, this.y, Mouse.x, Mouse.y);
            if (sqDistToMouse > Bug.sqDistToFollow) {
                this.accelerateTowards(Mouse.x, Mouse.y, 111);
            }
        }
    }
}
