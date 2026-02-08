import WEED from '/src/index.js';

const { Mouse, distanceSq2D, GameObject, Collider, SpriteRenderer, rng, RigidBody, ShadowCaster } = WEED;

// Speed threshold for animation

// 8-directional mapping for bicho spritesheet (n, ne, e, se, s, sw, w, nw)
// Angles: 0° = right (e), 90° = down (s), 180° = left (w), 270° = up (n)
const DIRECTIONS_8 = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];

function getDirection8(angleRadians) {
    // Normalize angle to 0-2π
    let angle = (angleRadians + Math.PI * 0.5) % (Math.PI * 2);
    if (angle < 0) angle += Math.PI * 2;

    // Each sector is 45° (π/4 radians), offset by half a sector (22.5°) for centering
    const sector = Math.floor((angle + Math.PI / 8) / (Math.PI / 4)) % 8;
    return DIRECTIONS_8[sector];
}

export class Bug extends GameObject {
    static ANIMATION_SPEED_MULTIPLIER = 0.5
    static MOVE_SPEED_THRESHOLD = 0.1;
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

        this.rigidBody.maxVel = 5;
        this.rigidBody.maxAcc = 0.1;
        this.rigidBody.minSpeed = 0;
        this.rigidBody.friction = 0.04;

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
    }

    tick(dtRatio) {
        const i = this.index;
        const speed = RigidBody.speed[i];
        const velocityAngle = RigidBody.velocityAngle[i];

        this.followMouse();

        // Only update animation if moving

        // Get direction from velocity angle (returns: n, ne, e, se, s, sw, w, nw)
        const direction = getDirection8(velocityAngle);

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
                this.accelerateTowards(Mouse.x, Mouse.y, 1);
            }
        }
    }
}
