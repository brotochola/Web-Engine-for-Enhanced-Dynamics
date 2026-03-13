import WEED from '/src/index.js';

// Destructure what we need from WEED
const { GameObject, RigidBody, Collider, SpriteRenderer, ShapeType } = WEED;

class Floor extends GameObject {
    // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
    static scriptUrl = import.meta.url;

    // entityType auto-assigned during registration (no manual ID needed!)
    static instances = []; // Instance tracking for this class

    // Define components this entity uses
    static components = [Collider, SpriteRenderer];

    /**
     * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
     * All components are guaranteed to be initialized at this point
     */
    setup() {
        // Floor is static - it doesn't move
        // this.rigidBody.static = 1;

        // Set collider shape type to Box
        this.collider.shapeType = ShapeType.Box;

        // Enable sprite renderer to make floor/walls visible
        this.spriteRenderer.active = 1;
        // Set visual range for spatial queries
        this.collider.visualRange = 0; // Large range to ensure collisions are detected
    }

    onScreenEnter() { }

    onScreenExit() { }

    /**
     * LIFECYCLE: Called when floor is spawned/respawned from pool
     * Initialize THIS instance - runs EVERY spawn
     * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
     */
    onSpawned(spawnConfig = {}) {
        const config = spawnConfig || {};

        // Get dimensions from spawn config
        const width = config.width || 100;
        const height = config.height || 100;

        // Set collider dimensions
        this.collider.width = width;
        this.collider.height = height;
        this.collider.radius = 0; // Not used for boxes

        // Update visual range based on size
        const halfDiagonal = Math.hypot(width, height) / 2;
        this.collider.visualRange = halfDiagonal + 200;

        // Set up visual representation using built-in white texture
        // Scale it to match the floor/wall dimensions
        this.setSprite('_white');
        this.setScale(width / 8, height / 8); // _white is 8x8, so scale to match dimensions
        this.setAnchor(0.5, 0.5); // Center anchor
        this.setTint(0x666666); // Gray color for floor/walls
        this.setAlpha(0.8); // Slightly transparent
    }

    onCollisionEnter(otherIndex) {
        // Optional: visual feedback on collision
    }

    onCollisionExit(otherIndex) {
        // Optional: restore visual state
    }

    /**
     * LIFECYCLE: Called when floor is despawned (returned to pool)
     */
    onDespawned() {
        // Cleanup if needed
    }

    /**
     * Main update - static objects don't need updates
     */
    tick(dtRatio) {
        // Static objects don't move
    }
}

// ES6 module export
export { Floor };
