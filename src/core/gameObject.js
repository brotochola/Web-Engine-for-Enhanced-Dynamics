// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { Grid } from './Grid.js';
import { collectComponents, cantorPair, updateMassFromCircle, updateMassFromBox, distanceSq2D, convertRGBtoBGR } from './utils.js';
import Keyboard from './Keyboard.js';
// Export Keyboard for easy access (Mouse imported separately to avoid circular dep)
// Note: SpriteSheetRegistry is registered globally in AbstractWorker.registerCoreClasses()
export { Keyboard, SpriteSheetRegistry };

export class GameObject {
  // Entity class metadata (for spawning system)
  static startIndex = 0; // Starting index in arrays for this entity type
  static poolSize = 0; // Allocated count for this entity type

  // Component composition - define which components this entity type has
  // Override in subclasses, e.g.: static components = [RigidBody, Collider, SpriteRenderer]
  static components = []; // By default, only Transform (added automatically)

  // Tick decimation - override in subclasses to reduce tick frequency
  // tickInterval = 10 means entity ticks every 10 frames (spread across frames via index offset)
  static tickInterval = 1; // Default: tick every frame (no decimation)

  // Neighbor data (from spatial worker)
  static neighborData = null;
  static distanceData = null; // Squared distances for each neighbor

  // Active entities list (built by particle_worker each frame)
  // Layout: [count, entityIdx0, entityIdx1, ...]
  static activeEntitiesData = null;

  // Tick decimation countdown (Uint8Array, one byte per entity)
  // Decremented each frame; entity ticks when it reaches 0, then resets to tickInterval
  static nextTick = null;

  // Camera data (shared with main thread)
  static cameraData = null; // Float32Array [zoom, x, y]

  // Entity type ID (auto-assigned during registration)
  // Note: entityType moved to Transform component for pure ECS architecture
  static entityType = null; // Numeric ID assigned by GameEngine

  static globalEntityCount = 0;

  static instances = [];

  static get(entityIndex) {
    return this.instances[entityIndex];
  }

  /**
   * Initialize GameObject static arrays and neighbor data buffers
   *
   * @param {SharedArrayBuffer} buffer - Unused (kept for API compatibility)
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Neighbor data buffer from spatial worker
   * @param {SharedArrayBuffer} [distanceBuffer] - Distance data buffer from spatial worker
   * @param {SharedArrayBuffer} [nextTickBuffer] - Tick decimation countdown buffer (1 byte per entity)
   */
  static initializeArrays(
    buffer,
    count,
    neighborBuffer = null,
    distanceBuffer = null,
    nextTickBuffer = null
  ) {
    this.globalEntityCount = count;

    // Initialize neighbor data if provided
    if (neighborBuffer) {
      this.neighborData = new Int32Array(neighborBuffer);
    }

    // Initialize distance data if provided
    if (distanceBuffer) {
      this.distanceData = new Float32Array(distanceBuffer);
    }

    // Initialize tick decimation buffer if provided (staggeredUpdates enabled)
    if (nextTickBuffer) {
      this.nextTick = new Uint8Array(nextTickBuffer);
    }
  }

  /**
   * Calculate buffer size needed for GameObject metadata
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes (0 - no dedicated buffer needed)
   */
  static getBufferSize(count) {
    return 0;
  }

  /**
   * Collect all components from class hierarchy (delegates to utils.js)
   * Walks up the prototype chain and collects all unique components
   * @param {Class} EntityClass - The entity class to collect components from
   * @returns {Array<Component>} Array of unique component classes
   */
  static _collectComponents(EntityClass) {
    return collectComponents(EntityClass, GameObject, Transform);
  }

  /**
   * Constructor - stores entity index
   * @param {number} index - Entity index (unique across all entities)
   * @param {Object} config - Configuration object from GameEngine
   * @param {Object} logicWorker - Logic worker reference
   *
   * DENSE COMPONENT ALLOCATION:
   * All components are allocated for all entities. Entity index === component index.
   * This simplifies code: just use SpriteRenderer.property[entityIndex] directly.
   * Unused slots have default values (0/false).
   */
  constructor(index, config = {}, logicWorker = null) {
    this.index = index;
    this.config = config;
    this.logicWorker = logicWorker;

    // DENSE ALLOCATION: entityIndex === componentIndex for all components
    // Store which components this entity TYPE has (for validation)
    // Keys are stored in BOTH PascalCase and camelCase for easy lookup
    this._hasComponents = {};
    const entityComponents = collectComponents(this.constructor, GameObject, Transform);
    for (const ComponentClass of entityComponents) {
      const name = ComponentClass.name;
      const camelCaseName = name.charAt(0).toLowerCase() + name.slice(1);
      this._hasComponents[name] = true; // PascalCase: "RigidBody"
      this._hasComponents[camelCaseName] = true; // camelCase: "rigidBody"
    }

    // Set entityType in Transform component (auto-assigned during registration)
    Transform.entityType[index] = this.constructor.entityType || 0;

    // Set INACTIVE in Transform (entities start in pool, spawn() activates them)
    // Note: Transform is always present at entity index
    Transform.active[index] = 0;

    GameObject.instances.push(this);
    this.constructor.instances.push(this);

    // Neighbor properties (updated each frame before tick)
    this.neighborCount = 0;
    // this.neighbors = null; // REMOVED: Subarray allocation causes GC stutter
    // this.neighborDistances = null; // REMOVED: GC stutter
    this._neighborOffset = 0; // Pointer-like offset into shared buffer

    // Component instance cache (lazy-loaded on first access)
    this._componentCache = {};

    // Ensure component accessors are defined on prototype (done once per class)
    this.constructor._ensureComponentAccessors();

    // LIFECYCLE: Call setup() at the end of constructor
    // This allows subclasses to configure entity type properties
    // All components are now initialized and accessible
    if (this.setup) {
      this.setup();
    }
  }

  /**
   * Ensure component accessors are defined on the class prototype (called once per class)
   * This makes both core and custom components accessible via this.componentName
   */
  static _ensureComponentAccessors() {
    // Skip if already created for THIS SPECIFIC class (not inherited from parent)
    if (this.prototype.hasOwnProperty('_componentAccessorsCreated')) {
      return;
    }

    // Core component class map
    const coreComponents = {
      transform: Transform,
      rigidBody: RigidBody,
      collider: Collider,
      spriteRenderer: SpriteRenderer,
    };

    // Get component class map from entity class (set during registration)
    const entityComponentMap = this._componentClassMap || {};

    // Define getters for all components this entity class uses
    for (const componentName of Object.keys(entityComponentMap)) {
      // Skip if getter already exists
      if (Object.getOwnPropertyDescriptor(this.prototype, componentName)) {
        continue;
      }

      const ComponentClass = entityComponentMap[componentName] || coreComponents[componentName];

      if (!ComponentClass) {
        continue;
      }

      // Define getter on prototype (shared by all instances)
      Object.defineProperty(this.prototype, componentName, {
        get: function () {
          // Return cached instance if exists
          if (this._componentCache[componentName]) {
            return this._componentCache[componentName];
          }

          // Check if this entity TYPE has this component
          if (!this._hasComponents[componentName]) {
            return null;
          }

          // DENSE ALLOCATION: entityIndex === componentIndex
          // Create and cache the component instance using entity index directly
          const instance = new ComponentClass(this.index);
          instance.owner = this; // Store owner reference for instance methods
          this._componentCache[componentName] = instance;
          return instance;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Mark as created
    this.prototype._componentAccessorsCreated = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROPERTY ACCESSORS (GETTERS & SETTERS)
  // Grouped by component: Transform → RigidBody → SpriteRenderer → Collider
  // ═══════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSFORM PROPERTIES
  // ─────────────────────────────────────────────────────────────────────────────

  /** Active state - whether entity is spawned and processing */
  get active() {
    return Transform.active[this.index];
  }
  set active(value) {
    Transform.active[this.index] = value;
  }

  /** Entity type ID (read-only, set during registration) */
  get entityType() {
    return Transform.entityType[this.index];
  }

  /**
   * Position X - forwards to Transform
   * NOTE: Setting position also updates RigidBody.px to prevent Verlet velocity
   */
  get x() {
    return Transform.x[this.index];
  }
  set x(value) {
    Transform.x[this.index] = value;
    if (this._hasComponents.RigidBody) {
      RigidBody.px[this.index] = value;
    }
  }

  /**
   * Position Y - forwards to Transform
   * NOTE: Setting position also updates RigidBody.py to prevent Verlet velocity
   */
  get y() {
    return Transform.y[this.index];
  }
  set y(value) {
    Transform.y[this.index] = value;
    if (this._hasComponents.RigidBody) {
      RigidBody.py[this.index] = value;
    }
  }

  /** Rotation in radians */
  get rotation() {
    return Transform.rotation[this.index];
  }
  set rotation(value) {
    Transform.rotation[this.index] = value;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RIGIDBODY PROPERTIES
  // ─────────────────────────────────────────────────────────────────────────────

  /** Velocity X - returns 0 if entity has no RigidBody */
  get vx() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vx[this.index];
  }
  set vx(value) {
    if (this._hasComponents.RigidBody) {
      RigidBody.vx[this.index] = value;
      // Sync previous position for Verlet: physics computes velocity as (x - px)
      RigidBody.px[this.index] = Transform.x[this.index] - value;
    }
  }

  /** Velocity Y - returns 0 if entity has no RigidBody */
  get vy() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vy[this.index];
  }
  set vy(value) {
    if (this._hasComponents.RigidBody) {
      RigidBody.vy[this.index] = value;
      // Sync previous position for Verlet: physics computes velocity as (y - py)
      RigidBody.py[this.index] = Transform.y[this.index] - value;
    }
  }

  /** Speed (magnitude of velocity) - read-only, computed by physics worker */
  get speed() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.speed[this.index];
  }

  /** Velocity angle in radians - read-only, computed by physics worker */
  get velocityAngle() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.velocityAngle[this.index];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SPRITERENDERER PROPERTIES
  // Setters mark dirty for re-rendering. Both setter and method provided.
  // ─────────────────────────────────────────────────────────────────────────────

  /** Alpha (opacity) 0-1 */
  get alpha() {
    if (!this._hasComponents.SpriteRenderer) return 1;
    return SpriteRenderer.alpha[this.index];
  }
  set alpha(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    if (SpriteRenderer.alpha[this.index] !== value) {
      SpriteRenderer.alpha[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Tint color (0xRRGGBB) */
  get tint() {
    if (!this._hasComponents.SpriteRenderer) return 0xffffff;
    return SpriteRenderer.baseTint[this.index]; // Return user-facing RGB value
  }
  set tint(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    SpriteRenderer.baseTint[this.index] = value; // Store RGB for lighting/user access
    const bgrValue = convertRGBtoBGR(value); // Convert RGB→BGR for PixiJS
    if (SpriteRenderer.tint[this.index] !== bgrValue) {
      SpriteRenderer.tint[this.index] = bgrValue;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Visibility flag */
  get visible() {
    if (!this._hasComponents.SpriteRenderer) return false;
    return SpriteRenderer.renderVisible[this.index] === 1;
  }
  set visible(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    const v = value ? 1 : 0;
    if (SpriteRenderer.renderVisible[this.index] !== v) {
      SpriteRenderer.renderVisible[this.index] = v;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Scale X */
  get scaleX() {
    if (!this._hasComponents.SpriteRenderer) return 1;
    return SpriteRenderer.scaleX[this.index];
  }
  set scaleX(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    if (SpriteRenderer.scaleX[this.index] !== value) {
      SpriteRenderer.scaleX[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Scale Y */
  get scaleY() {
    if (!this._hasComponents.SpriteRenderer) return 1;
    return SpriteRenderer.scaleY[this.index];
  }
  set scaleY(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    if (SpriteRenderer.scaleY[this.index] !== value) {
      SpriteRenderer.scaleY[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Is entity currently on screen? Read-only, set by culling system */
  get isOnScreen() {
    if (!this._hasComponents.SpriteRenderer) return false;
    return SpriteRenderer.isItOnScreen[this.index] === 1;
  }

  /** Anchor X (0-1, 0.5 = center) - read-only, use setAnchor() */
  get anchorX() {
    if (!this._hasComponents.SpriteRenderer) return 0.5;
    return SpriteRenderer.anchorX[this.index];
  }

  /** Anchor Y (0-1, 1.0 = bottom) - read-only, use setAnchor() */
  get anchorY() {
    if (!this._hasComponents.SpriteRenderer) return 1.0;
    return SpriteRenderer.anchorY[this.index];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COLLIDER PROPERTIES
  // ─────────────────────────────────────────────────────────────────────────────

  /** Collision radius - also auto-computes mass from area (π * r²) */
  get radius() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.radius[this.index];
  }

  set radius(value) {
    if (!this._hasComponents.Collider) return;
    Collider.radius[this.index] = value;
    if (this._hasComponents.RigidBody) {
      updateMassFromCircle(this.index, value, RigidBody);
    }
  }

  /** Collider width - also auto-computes mass from area (width * height) */
  get width() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.width[this.index];
  }
  set width(value) {
    if (!this._hasComponents.Collider) return;
    Collider.width[this.index] = value;
    if (this._hasComponents.RigidBody) {
      const h = Collider.height[this.index] || 1;
      updateMassFromBox(this.index, value, h, RigidBody);
    }
  }

  /** Collider height - also auto-computes mass from area (width * height) */
  get height() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.height[this.index];
  }
  set height(value) {
    if (!this._hasComponents.Collider) return;
    Collider.height[this.index] = value;
    if (this._hasComponents.RigidBody) {
      const w = Collider.width[this.index] || 1;
      updateMassFromBox(this.index, w, value, RigidBody);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METHODS - RENDERING (mark dirty)
  // Methods duplicate setter logic for zero-overhead when using method syntax
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark sprite as needing re-render
   */
  markDirty() {
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /**
   * Set alpha (opacity)
   * @param {number} value - Alpha 0-1
   * @returns {this} For chaining
   */
  setAlpha(value) {
    if (!this._hasComponents.SpriteRenderer) return this;
    if (SpriteRenderer.alpha[this.index] !== value) {
      SpriteRenderer.alpha[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set tint color
   * @param {number} value - Color as 0xRRGGBB
   * @returns {this} For chaining
   */
  setTint(value) {
    if (!this._hasComponents.SpriteRenderer) return this;
    SpriteRenderer.baseTint[this.index] = value; // Store RGB for lighting/user access
    const bgrValue = convertRGBtoBGR(value); // Convert RGB→BGR for PixiJS
    if (SpriteRenderer.tint[this.index] !== bgrValue) {
      SpriteRenderer.tint[this.index] = bgrValue;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set visibility
   * @param {boolean} value - Visible or not
   * @returns {this} For chaining
   */
  setVisible(value) {
    if (!this._hasComponents.SpriteRenderer) return this;
    const v = value ? 1 : 0;
    if (SpriteRenderer.renderVisible[this.index] !== v) {
      SpriteRenderer.renderVisible[this.index] = v;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set scale (uniform or non-uniform)
   * @param {number} x - Scale X
   * @param {number} [y] - Scale Y (defaults to x for uniform scale)
   * @returns {this} For chaining
   */
  setScale(x, y) {
    if (!this._hasComponents.SpriteRenderer) return this;
    const yVal = y !== undefined ? y : x;
    let changed = false;
    if (SpriteRenderer.scaleX[this.index] !== x) {
      SpriteRenderer.scaleX[this.index] = x;
      changed = true;
    }
    if (SpriteRenderer.scaleY[this.index] !== yVal) {
      SpriteRenderer.scaleY[this.index] = yVal;
      changed = true;
    }
    if (changed) {
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set anchor point
   * @param {number} x - Anchor X (0-1)
   * @param {number} y - Anchor Y (0-1)
   * @returns {this} For chaining
   */
  setAnchor(x, y) {
    if (!this._hasComponents.SpriteRenderer) return this;
    SpriteRenderer.anchorX[this.index] = x;
    SpriteRenderer.anchorY[this.index] = y;
    SpriteRenderer.renderDirty[this.index] = 1;
    return this;
  }

  /**
   * Set animation state index
   * @param {number} state - Animation state index
   * @returns {this} For chaining
   */
  setAnimationState(state) {
    if (!this._hasComponents.SpriteRenderer) return this;
    if (SpriteRenderer.animationState[this.index] !== state) {
      SpriteRenderer.animationState[this.index] = state;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set animation speed multiplier
   * @param {number} speed - Animation speed (1.0 = normal)
   * @returns {this} For chaining
   */
  setAnimationSpeed(speed) {
    if (!this._hasComponents.SpriteRenderer) return this;
    if (SpriteRenderer.animationSpeed[this.index] !== speed) {
      SpriteRenderer.animationSpeed[this.index] = speed;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METHODS - PHYSICS (batch operations)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set position (batch update, syncs previous position for Verlet)
   * @param {number} x - Position X
   * @param {number} y - Position Y
   * @returns {this} For chaining
   */
  setPosition(x, y) {
    Transform.x[this.index] = x;
    Transform.y[this.index] = y;
    if (this._hasComponents.RigidBody) {
      RigidBody.px[this.index] = x;
      RigidBody.py[this.index] = y;
    }
    return this;
  }

  /**
   * Set velocity (absolute)
   * Syncs previous position for Verlet integration (physics computes vel from x - px)
   * @param {number} vx - Velocity X
   * @param {number} vy - Velocity Y
   * @returns {this} For chaining
   */
  setVelocity(vx, vy) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      RigidBody.vx[i] = vx;
      RigidBody.vy[i] = vy;
      // Sync previous position for Verlet: physics computes velocity as (pos - prev)
      RigidBody.px[i] = Transform.x[i] - vx;
      RigidBody.py[i] = Transform.y[i] - vy;
    }
    return this;
  }

  accelerateTowards(x, y, acc) {
    if (!this._hasComponents.RigidBody) return this;
    const i = this.index;
    const dx = x - Transform.x[i];
    const dy = y - Transform.y[i];
    const distSq = dx * dx + dy * dy; // OPTIMIZED: Inline calculation (already have dx, dy)
    if (distSq > 0) {
      const invDist = acc / Math.sqrt(distSq);
      return this.addAcceleration(dx * invDist, dy * invDist);
    }
    return this;
  }

  /**
   * Add to velocity (additive)
   * Syncs previous position for Verlet integration
   * @param {number} dvx - Velocity X to add
   * @param {number} dvy - Velocity Y to add
   * @returns {this} For chaining
   */
  addVelocity(dvx, dvy) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      const newVx = RigidBody.vx[i] + dvx;
      const newVy = RigidBody.vy[i] + dvy;
      RigidBody.vx[i] = newVx;
      RigidBody.vy[i] = newVy;
      // Sync previous position for Verlet
      RigidBody.px[i] = Transform.x[i] - newVx;
      RigidBody.py[i] = Transform.y[i] - newVy;
    }
    return this;
  }

  /**
   * Scale velocity (multiplicative) - useful for friction/drag
   * Syncs previous position for Verlet integration
   * @param {number} factor - Multiplier (0.95 = 5% friction)
   * @returns {this} For chaining
   */
  scaleVelocity(factor) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      const newVx = RigidBody.vx[i] * factor;
      const newVy = RigidBody.vy[i] * factor;
      RigidBody.vx[i] = newVx;
      RigidBody.vy[i] = newVy;
      // Sync previous position for Verlet
      RigidBody.px[i] = Transform.x[i] - newVx;
      RigidBody.py[i] = Transform.y[i] - newVy;
    }
    return this;
  }

  /**
   * Add acceleration (additive) - applied by physics integration
   * @param {number} x - Acceleration X
   * @param {number} y - Acceleration Y
   * @returns {this} For chaining
   */
  addAcceleration(x, y) {
    if (this._hasComponents.RigidBody) {
      RigidBody.ax[this.index] += x;
      RigidBody.ay[this.index] += y;
    }
    return this;
  }

  /**
   * Set the spritesheet for this entity (for ANIMATED sprites)
   * After calling this, use setAnimation() to switch between animations
   *
   * @param {string} spritesheetName - Spritesheet name (e.g., "civil1", "civil2")
   *
   * @example
   * this.setSpritesheet("civil1");
   * this.setAnimation("walk_right");  // Uses civil1's walk_right animation
   * this.setAnimation("idle_down");   // Uses civil1's idle_down animation
   */
  setSpritesheet(spritesheetName) {
    if (!this.spriteRenderer) return;

    // Verify the spritesheet exists
    if (!SpriteSheetRegistry.spritesheets.has(spritesheetName)) {
      console.error(
        `❌ ${this.constructor.name}: Spritesheet "${spritesheetName}" not found. ` +
        `Available: ${Array.from(SpriteSheetRegistry.spritesheets.keys()).join(', ')}`
      );
      return;
    }

    // Store which spritesheet to use (proxy sheet like civil1, civil2, etc.)
    const spritesheetId = SpriteSheetRegistry.getSpritesheetId(spritesheetName);
    if (spritesheetId === 0) {
      console.error(`${this.constructor.name}: Spritesheet "${spritesheetName}" not registered`);
      return;
    }
    this.spriteRenderer.spritesheetId = spritesheetId;

    // Mark as animated
    this.spriteRenderer.isAnimated = 1;

    this.markDirty();
  }

  /**
   * Set animation within the current spritesheet
   * Must call setSpritesheet() first to set the spritesheet
   *
   * PERFORMANCE: Uses global cache to avoid repeated lookups
   *
   * @param {string} animationName - Animation name (e.g., "walk_right", "idle_down")
   *
   * @example
   * this.setSpritesheet("civil1");
   * this.setAnimation("walk_right");  // Uses civil1's walk_right animation
   */
  setAnimation(animationName, loop = true) {
    if (!this.spriteRenderer) return;

    // Get which spritesheet is currently set
    const spritesheetId = this.spriteRenderer.spritesheetId;
    if (!spritesheetId || spritesheetId === 0) {
      console.error(
        `❌ ${this.constructor.name}: Call setSpritesheet() before setAnimation(). ` +
        `Or use setSprite() for static sprites.`
      );
      return;
    }

    const spritesheet = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
    if (!spritesheet) {
      console.error(`❌ ${this.constructor.name}: Invalid spritesheetId ${spritesheetId}`);
      return;
    }

    // PERFORMANCE: Global cache keyed by "sheet:animName"
    if (!GameObject._globalAnimationCache) {
      GameObject._globalAnimationCache = {};
    }

    const cacheKey = `${spritesheet}:${animationName}`;
    let animIndex = GameObject._globalAnimationCache[cacheKey];

    if (animIndex === undefined) {
      // First time this animation is used - look it up via proxy
      animIndex = SpriteSheetRegistry.getAnimationIndex(spritesheet, animationName);

      if (animIndex === undefined) {
        // Animation not found
        const availableAnims = Object.keys(
          SpriteSheetRegistry.spritesheets.get(spritesheet)?.animations || {}
        );

        console.error(
          `❌ ${this.constructor.name}: Animation "${animationName}" not found in "${spritesheet}". ` +
          `Available: ${availableAnims.slice(0, 10).join(', ')}${availableAnims.length > 10 ? '...' : ''
          }`
        );
        return;
      }

      // Cache it globally
      GameObject._globalAnimationCache[cacheKey] = animIndex;
    }

    // Set the animation and loop flag
    this.setAnimationState(animIndex);
    SpriteRenderer.loop[this.index] = loop ? 1 : 0;
  }

  /**
   * Set animation loop behavior
   * @param {boolean} loop - Whether the animation should loop (true) or play once (false)
   * @returns {this} For chaining
   */
  setAnimationLoop(loop) {
    if (!this._hasComponents.SpriteRenderer) return this;
    SpriteRenderer.loop[this.index] = loop ? 1 : 0;
    return this;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATIC SPRITE METHODS
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Use setSprite() to display a STATIC (non-animated) texture on an entity.
  // This is different from setSpritesheet() + setAnimation() which is for animated sprites.
  //
  // WHAT CAN BE DISPLAYED:
  // 1. Static textures from assets.textures: "rock1", "blood", "smoke"
  // 2. Prefixed animation names: "civil1_hurt" (displays first frame)
  // 3. Specific animation frames: "civil1_hurt_5" (displays exact frame)
  // 4. Resolved frame names: Use helper params (spritesheet, animation, frameIndex)
  //
  // All of these are entries in the bigAtlas - they're treated uniformly.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set the sprite for this entity (for STATIC/non-animated display).
   *
   * USAGE PATTERNS:
   *
   * 1. Static texture (from assets.textures):
   *    ```js
   *    this.setSprite("rock1");
   *    this.setSprite("blood");
   *    ```
   *
   * 2. Specific frame by name (if you know the exact frame name):
   *    ```js
   *    this.setSprite("civil1_hurt_5");  // Last frame of hurt animation
   *    ```
   *
   * 3. Specific frame by parameters (recommended for animation frames):
   *    ```js
   *    this.setSprite("civil1", "hurt", -1);  // -1 = last frame
   *    this.setSprite("civil1", "walk_down", 0);  // 0 = first frame
   *    ```
   *
   * PERFORMANCE: Uses global cache to avoid repeated lookups.
   * String resolution happens ONCE per unique sprite, then cached.
   *
   * @param {string} spriteNameOrSheet - Sprite/frame name OR spritesheet name (if using params)
   * @param {string} [animation] - Animation name (only when using spritesheet param)
   * @param {number} [frameIndex=0] - Frame index within animation (0 = first, -1 = last)
   * @returns {this} For chaining
   *
   * @example
   * // Static texture
   * this.setSprite("rock1");
   *
   * @example
   * // Specific frame of an animation (for dead body decal, etc.)
   * this.setSprite("civil1", "hurt", -1);  // Last frame of hurt animation
   *
   * @example
   * // Direct frame name (if you already have it)
   * this.setSprite("civil1_hurt_5");
   */
  setSprite(spriteNameOrSheet, animation, frameIndex) {
    if (!this.spriteRenderer) return this;

    // Resolve the sprite name based on which parameters were provided
    let spriteName;

    if (animation !== undefined) {
      // Parameters provided: (spritesheet, animation, frameIndex)
      // Resolve to the actual frame name in bigAtlas
      spriteName = SpriteSheetRegistry.getFrameName(spriteNameOrSheet, animation, frameIndex ?? 0);

      if (!spriteName) {
        console.error(
          `❌ ${this.constructor.name}: Could not resolve frame for ` +
          `spritesheet="${spriteNameOrSheet}", animation="${animation}", frameIndex=${frameIndex ?? 0}`
        );
        return this;
      }
    } else {
      // Single parameter: direct sprite/frame name
      spriteName = spriteNameOrSheet;
    }

    // Static sprites use bigAtlas directly
    const sheetName = 'bigAtlas';

    // PERFORMANCE: Global cache keyed by "bigAtlas:spriteName"
    // Avoids repeated registry lookups for the same sprite
    if (!GameObject._globalAnimationCache) {
      GameObject._globalAnimationCache = {};
    }

    const cacheKey = `${sheetName}:${spriteName}`;
    let animIndex = GameObject._globalAnimationCache[cacheKey];

    if (animIndex === undefined) {
      // First time this sprite is used - look it up in bigAtlas
      animIndex = SpriteSheetRegistry.getAnimationIndex(sheetName, spriteName);

      if (animIndex === undefined) {
        // Sprite not found - provide helpful error message
        console.error(
          `❌ ${this.constructor.name}: Sprite "${spriteName}" not found in bigAtlas. ` +
          `Make sure it's included in your assets config (textures or spritesheets).`
        );
        return this;
      }

      // Cache it globally for future use
      GameObject._globalAnimationCache[cacheKey] = animIndex;
    }

    // Store which spritesheet to use (bigAtlas for static sprites)
    const bigAtlasId = SpriteSheetRegistry.getSpritesheetId('bigAtlas');
    if (bigAtlasId === 0) {
      console.error(`❌ ${this.constructor.name}: bigAtlas not loaded yet`);
      return this;
    }
    this.spriteRenderer.spritesheetId = bigAtlasId;

    // Mark as NOT animated (static sprite - displays single frame)
    this.spriteRenderer.isAnimated = 0;
    this.spriteRenderer.active = 1;
    this.spriteRenderer.renderVisible = 1;

    // Set the sprite (as a single-frame "animation")
    this.setAnimationState(animIndex); // This calls markDirty() internally

    return this;
  }
  /**
   * Helper method to send sprite property changes to renderer
   */
  setSpriteProp(prop, value) {
    if (this.logicWorker) {
      this.logicWorker.sendDataToWorker('renderer', {
        cmd: 'setProp',
        entityId: this.index,
        prop: prop,
        value: value,
      });
    }
  }

  /**
   * LIFECYCLE: Called at the END of constructor - runs ONCE per entity lifetime
   * Override in subclasses to configure entity TYPE properties
   * (physics params, flocking behavior, collision settings, sprite config, etc.)
   * All components are guaranteed to be initialized at this point
   *
   * Example:
   *   setup() {
   *     this.rigidBody.maxVel = 10;
   *     this.collider.radius = 15;
   *     this.flocking.centeringFactor = 0.001;
   *   }
   */
  setup() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called EVERY time entity is spawned from pool (or first spawn)
   * Override in subclasses to reset/initialize instance-specific state
   * (position, velocity, health, etc.)
   *
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   *
   * Example:
   *   onSpawned(spawnConfig) {
   *     this.x = spawnConfig.x ?? Math.random() * 800;
   *     this.y = spawnConfig.y ?? Math.random() * 600;
   *     this.health = 100;
   *     this.rigidBody.vx = 0;
   *     this.rigidBody.vy = 0;
   *   }
   */
  onSpawned(spawnConfig = {}) {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity is despawned (returned to pool)
   * Override in subclasses for cleanup, saving state, triggering effects, etc.
   *
   * Example:
   *   onDespawned() {
   *     this.saveStats();
   *     this.playDeathEffect();
   *     this.clearReferences();
   *   }
   */
  onDespawned() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity enters screen (becomes visible)
   * Override in subclasses to enable expensive behaviors only for visible entities
   *
   * Example:
   *   onScreenEnter() {
   *     this.enableParticles();
   *     this.startAnimations();
   *   }
   */
  onScreenEnter() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity exits screen (becomes invisible)
   * Override in subclasses to disable expensive calculations for off-screen entities
   *
   * Example:
   *   onScreenExit() {
   *     this.disableParticles();
   *     this.pauseAnimations();
   *   }
   */
  onScreenExit() {
    // Override in subclasses
  }

  /**
   * Check if this entity is currently colliding with another entity
   * Only works in logic worker context where collision tracking is available.
   *
   * @param {number|GameObject} other - Entity index or GameObject instance to check
   * @returns {boolean} True if currently colliding, false otherwise
   *
   * @example
   *   if (this.isCollidingWith(playerIndex)) {
   *     this.takeDamage(10);
   *   }
   *
   *   // Or with an instance:
   *   if (this.isCollidingWith(player)) {
   *     player.collectItem(this);
   *   }
   */
  isCollidingWith(other) {
    // Get the other entity's index
    const otherIndex = typeof other === 'number' ? other : other.index;

    // Access collision tracking from logic worker context
    // self.logicWorker is the LogicWorker instance in logic_worker.js
    const logicWorker = typeof self !== 'undefined' ? self.logicWorker : null;
    if (!logicWorker || !logicWorker.currentCollisions) {
      return false;
    }

    // Use Cantor pairing function to generate collision key
    // Note: Both directions (A,B) and (B,A) are stored in currentCollisions
    const key = cantorPair(this.index, otherIndex);

    return logicWorker.currentCollisions.has(key);
  }

  /**
   * Despawn this entity (return it to the inactive pool)
   * This is the proper way to deactivate an entity
   */
  despawn() {
    // Prevent double-despawn which corrupts the free list
    if (Transform.active[this.index] === 0) return;

    // WORKER ROUTING: If we're in a logic worker that's not worker 0,
    // route the despawn request to worker 0 to keep freeList synchronized
    if (typeof self !== 'undefined' && self.logicWorker) {
      if (self.logicWorker.workerIndex !== 0) {
        // LIFECYCLE: Call onDespawned() BEFORE deactivating
        if (this.onDespawned) {
          this.onDespawned();
        }

        // Immediately deactivate so entity stops being processed
        // (the active flag is in SharedArrayBuffer, visible to all workers)
        Transform.active[this.index] = 0;
        if (this.rigidBody) RigidBody.active[this.index] = 0;
        if (this.collider) Collider.active[this.index] = 0;
        if (this.spriteRenderer) SpriteRenderer.active[this.index] = 0;
        if (this.lightEmitter) LightEmitter.active[this.index] = 0;
        if (this.shadowCaster) ShadowCaster.active[this.index] = 0;

        // Route to worker 0 to update the freeList
        self.logicWorker.sendDataToWorker('logic0', {
          msg: 'despawnRequest',
          entityIndex: this.index,
          className: this.constructor.name,
        });
        return;
      }
    }

    // LIFECYCLE: Call onDespawned() BEFORE deactivating
    // This allows cleanup, saving state, triggering effects, etc.
    if (this.onDespawned) {
      this.onDespawned();
    }

    // Deactivate all component active flags
    Transform.active[this.index] = 0;
    if (this.rigidBody) RigidBody.active[this.index] = 0;
    if (this.collider) Collider.active[this.index] = 0;
    if (this.spriteRenderer) SpriteRenderer.active[this.index] = 0;
    if (this.lightEmitter) LightEmitter.active[this.index] = 0;
    if (this.shadowCaster) ShadowCaster.active[this.index] = 0;

    // Return to free list if exists (O(1))
    const EntityClass = this.constructor;
    if (EntityClass.freeList) {
      EntityClass.freeList[++EntityClass.freeListTop] = this.index;
    }
  }

  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker (deprecated, uses Grid)
   * @param {Float32Array} distanceData - Precomputed squared distances from spatial worker (deprecated, uses Grid)
   */
  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * OPTIMIZED: Receives pre-cached arrays from caller to avoid property lookups
   * @param {Int32Array} neighborData - Cached Grid.neighborData
   * @param {Float32Array} distanceData - Cached Grid.distanceData
   * @param {number} stride - Cached Grid._stride
   */
  updateNeighbors(neighborData, distanceData, stride) {
    // Fast path: arrays passed directly from caller (logic_worker caches them once)
    // distanceData parameter is deprecated (no longer used, kept for API compatibility)
    if (neighborData) {
      this._neighborData = neighborData;
      this._neighborOffset = this.index * stride;
      this.neighborCount = neighborData[this._neighborOffset];
      return;
    }

    // Fallback to static arrays if no params passed
    if (GameObject.neighborData) {
      this._neighborData = GameObject.neighborData;
      const maxNeighbors = this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
      this._neighborOffset = this.index * (1 + maxNeighbors);
      this.neighborCount = this._neighborData[this._neighborOffset];
      return;
    }

    this._neighborData = null;
    this.neighborCount = 0;
  }

  /**
   * Get neighbor index at specific position
   * Zero-allocation replacement for this.neighbors[i]
   * Uses direct array access for performance (Grid data cached in updateNeighbors)
   * @param {number} i - Index (0 to this.neighborCount - 1)
   * @returns {number} Entity index of the neighbor
   */
  getNeighbor(i) {
    // Direct array access using cached offset (no method call overhead)
    if (this._neighborData) {
      return this._neighborData[this._neighborOffset + 1 + i];
    }
    // Fallback to static arrays
    if (GameObject.neighborData) {
      return GameObject.neighborData[this._neighborOffset + 1 + i];
    }
    return -1;
  }

  /**
   * Get neighbor distance squared at specific position
   * Calculates distance on-the-fly from collider positions
   *
   * WARNING: This distance is calculated from COLLIDER positions (Transform + Collider.offset).
   * If you need to compute direction vectors (dx/dy), calculate distSq manually from the same
   * positions you use for dx/dy, otherwise the unit vector will be incorrect.
   *
   * @param {number} i - Index (0 to this.neighborCount - 1)
   * @returns {number} Squared distance to the neighbor (based on collider positions)
   */
  getNeighborDistanceSq(i) {
    const neighborIdx = this.getNeighbor(i);
    if (neighborIdx < 0) return 0;

    // Calculate distance on-the-fly (collider positions)
    const myX = Transform.x[this.index] + (Collider.offsetX[this.index] || 0);
    const myY = Transform.y[this.index] + (Collider.offsetY[this.index] || 0);
    const neighborX = Transform.x[neighborIdx] + (Collider.offsetX[neighborIdx] || 0);
    const neighborY = Transform.y[neighborIdx] + (Collider.offsetY[neighborIdx] || 0);
    return distanceSq2D(myX, myY, neighborX, neighborY);
  }

  /**
   * Get all neighbor IDs as an array
   * @returns {Int32Array} Typed array of neighbor entity indices (view into internal buffer)
   *
   * NOTE: Uses Grid.neighborData (live getter) to always read from the current stable
   * read buffer. This is safe for debugging/inspection from Chrome console.
   * For hot-path access during tick(), use getNeighborId(i) which uses cached pointers.
   */
  getAllNeighborIds() {
    // Use Grid.neighborData getter (not cached this._neighborData) to get current read buffer
    // This ensures we always read stable data, even when called from Chrome console
    const neighborData = Grid.neighborData;
    if (!neighborData) {
      return new Int32Array(0);
    }

    const stride = Grid._stride;
    const neighborOffset = this.index * stride;
    const count = neighborData[neighborOffset]; // Read count from current read buffer

    // Return a typed array view (zero-copy slice of the neighbor buffer)
    // Note: Int32Array elements are 4 bytes each
    return new Int32Array(
      neighborData.buffer,
      neighborData.byteOffset + (neighborOffset + 1) * 4,
      count
    );
  }

  /**
   * Get all neighbor instances as an array
   * @returns {GameObject[]} Array of neighbor GameObject instances
   *
   * NOTE: Uses Grid.neighborData (live getter) to always read from the current stable
   * read buffer. This is safe for debugging/inspection from Chrome console.
   */
  getAllNeighborInstances() {
    // Use Grid.neighborData getter (not cached this._neighborData) to get current read buffer
    const neighborData = Grid.neighborData;
    if (!neighborData) {
      return [];
    }

    const stride = Grid._stride;
    const neighborOffset = this.index * stride;
    const count = neighborData[neighborOffset]; // Read count from current read buffer

    const neighbors = new Array(count);
    const entities = GameObject.instances;

    let validCount = 0;
    for (let i = 0; i < count; i++) {
      const neighborId = neighborData[neighborOffset + 1 + i];
      if (neighborId >= 0 && neighborId < entities.length) {
        neighbors[validCount++] = entities[neighborId];
      }
    }

    // Trim array if some neighbors were invalid
    if (validCount < count) {
      neighbors.length = validCount;
    }

    return neighbors;
  }

  /**
   * ITERATION: Iterate over all neighbors of this entity
   * ZERO ALLOCATIONS - uses getNeighbor/getNeighborDistance directly
   *
   * @param {Function} callback - callback(neighborInstance, distance, neighborIndex)
   *   - neighborInstance: The neighbor's GameObject instance (or undefined if not in logic worker)
   *   - distance: Squared distance to the neighbor
   *   - neighborIndex: Entity index of the neighbor
   *
   * @example
   *   this.forEachNeighbor((neighbor, dist, idx) => {
   *     if (dist < 10000) { // within 100 units
   *       neighbor.takeDamage(10);
   *     }
   *   });
   */
  forEachNeighbor(callback) {
    const count = this.neighborCount;
    const instances = GameObject.instances;
    const neighborData = GameObject.neighborData;
    const distanceData = GameObject.distanceData;
    const offset = this._neighborOffset;

    for (let i = 0; i < count; i++) {
      const neighborIndex = neighborData[offset + 2 + i];
      const distance = distanceData ? distanceData[offset + 2 + i] : 0;
      const neighbor = instances ? instances[neighborIndex] : undefined;

      callback(neighbor, distance, neighborIndex);
    }
  }

  /**
   * LIFECYCLE: Main update - called EVERY frame while entity is active
   * Override this in subclasses to define entity behavior
   * (AI, physics forces, animations, input handling, etc.)
   *
   * Note: this.neighbors and this.neighborCount are updated before this is called
   * Input is available via this.mouse and this.keyboard
   *
   * @param {number} dtRatio - Delta time ratio normalized to 60fps (1.0 = 16.67ms frame)
   * @param {number} deltaTime - Actual time since last frame in milliseconds
   * @param {number} accumulatedTime - Total time elapsed since game start in seconds
   * @param {number} frameNumber - Current frame number (starts at 1)
   *
   * Example:
   *   tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
   *     // Use dtRatio for frame-rate independent movement
   *     this.x += this.speed * dtRatio;
   *
   *     // Use deltaTime (ms) for precise timing calculations
   *     this.elapsedMs += deltaTime;
   *
   *     // Use accumulatedTime (seconds) for animations synced to game time
   *     this.alpha = Math.sin(accumulatedTime * 2) * 0.5 + 0.5;
   *
   *     // Use frameNumber for frame-based logic
   *     if (frameNumber % 60 === 0) this.doSomethingEverySecond();
   *   }
   */
  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity collides with another
   * Override in subclasses to handle collision start events
   *
   * @param {number} otherIndex - Index of the other entity in collision
   */
  onCollisionEnter(otherIndex) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called every frame while this entity is colliding with another
   * Override in subclasses to handle continuous collision
   *
   * @param {number} otherIndex - Index of the other entity in collision
   */
  onCollisionStay(otherIndex) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
   * Override in subclasses to handle collision end events
   *
   * @param {number} otherIndex - Index of the other entity that was in collision
   */
  onCollisionExit(otherIndex) {
    // Override in subclasses
  }

  /**
   * SPAWNING SYSTEM: Initialize free list for O(1) spawning
   * Must be called after registration and before any spawning
   *
   * Uses interleaved index ordering to reduce CPU cache contention between
   * logic workers. See inline comments for details.
   *
   * @param {Class} EntityClass - The entity class to initialize
   */
  static initializeFreeList(EntityClass) {
    const count = EntityClass.poolSize;
    const startIndex = EntityClass.startIndex;

    // Create free list stack (LIFO - last written index is first to spawn)
    EntityClass.freeList = new Int32Array(count);
    EntityClass.freeListTop = count - 1;

    // INTERLEAVED SPAWNING: Scatter entity indices to reduce multi-core cache contention
    //
    // Problem with sequential ordering [0,1,2,3,4,5...]:
    //   - First N spawns cluster at indices 0 to N-1
    //   - Multiple workers process adjacent memory regions simultaneously
    //   - Causes L3 cache thrashing and memory bus contention between cores
    //   - Benchmarked: ~10% FPS loss with 4 logic workers
    //
    // Solution - interleaved ordering [0,8,16,24..., 1,9,17,25..., 2,10,18,26...]:
    //   - Spawned entities scatter across the full index range
    //   - Workers access different cache lines, reducing contention
    //   - Each job's active entities are spread out in memory
    //
    // Note: This is counter to single-threaded cache locality intuition.
    // For multi-threaded workloads, scattered access patterns reduce
    // inter-core contention on shared L3 cache and memory controller.
    const interleaveFactor = 8;

    // Build interleaved free list:
    // First loop (offset=0): writes indices 0, 8, 16, 24...
    // Second loop (offset=1): writes indices 1, 9, 17, 25...
    // etc.
    // Result: popping from stack yields 7, 15, 23... then 6, 14, 22... etc.
    let writeIndex = 0;
    for (let offset = 0; offset < interleaveFactor; offset++) {
      for (let i = offset; i < count; i += interleaveFactor) {
        EntityClass.freeList[writeIndex++] = startIndex + i;
      }
    }
  }

  /**
   * SPAWNING SYSTEM: Spawn an entity from the pool (activate an inactive entity)
   *
   * @param {Class} EntityClass - The entity class to spawn (e.g., Ball, Car)
   * @param {Object} spawnConfig - Initial configuration (position, velocity, etc.)
   * @returns {GameObject|null} - The spawned entity instance, or null if pool exhausted or routed to worker 0
   */
  static spawn(EntityClassOrConfig, spawnConfig = {}) {
    // Support two calling conventions:
    // 1. GameObject.spawn(EntityClass, config) - for dynamic class spawning
    // 2. Prey.spawn(config) - cleaner API when calling on the class directly
    let EntityClass;
    if (typeof EntityClassOrConfig === 'function') {
      // Traditional: GameObject.spawn(EntityClass, config)
      EntityClass = EntityClassOrConfig;
    } else {
      // New: Prey.spawn(config) - use `this` as the EntityClass
      EntityClass = this;
      spawnConfig = EntityClassOrConfig || {};
    }

    // Validate EntityClass has required metadata
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      console.error(
        `Cannot spawn ${EntityClass.name}: missing startIndex/poolSize metadata. Was it registered with GameEngine?`
      );
      return null;
    }

    // WORKER ROUTING: If we're in a logic worker that's not worker 0,
    // route the spawn request to worker 0 to keep freeList synchronized
    if (typeof self !== 'undefined' && self.logicWorker) {
      if (self.logicWorker.workerIndex !== 0) {
        // Route to worker 0 via MessagePort
        self.logicWorker.sendDataToWorker('logic0', {
          msg: 'spawnRequest',
          className: EntityClass.name,
          spawnConfig: spawnConfig,
        });
        return null; // Async spawn - no instance returned immediately
      }
    }

    // Initialize free list if not exists (lazy init)
    // BUGFIX: Use hasOwnProperty to prevent inheriting parent class's freeList
    // (e.g., Prey extends Boid - Prey should have its own freeList, not inherit Boid's)
    if (!EntityClass.hasOwnProperty('freeList')) {
      GameObject.initializeFreeList(EntityClass);
    }

    // Check if pool is exhausted
    if (EntityClass.freeListTop < 0) {
      // console.warn(
      //   `No inactive ${EntityClass.name} available in pool! All ${EntityClass.poolSize} entities are active.`
      // );
      return null;
    }

    // Pop index from free list (O(1))
    const i = EntityClass.freeList[EntityClass.freeListTop--];

    // Get the instance (already created during initialization)
    const instance = EntityClass.instances[i - EntityClass.startIndex];

    if (!instance) {
      console.error(`No instance found at index ${i} for ${EntityClass.name}`);
      return null;
    }

    // Reset component values to sensible defaults using direct array access (faster)
    // Check _hasComponents which is set in constructor based on entity's component list
    const has = instance._hasComponents;

    if (has.RigidBody) {
      RigidBody.active[i] = 1;
      RigidBody.ax[i] = 0;
      RigidBody.ay[i] = 0;
      RigidBody.vx[i] = 0;
      RigidBody.vy[i] = 0;
      RigidBody.speed[i] = 0;
      RigidBody.velocityAngle[i] = 0;
      RigidBody.px[i] = 0;
      RigidBody.py[i] = 0;
    }

    // Transform is always present
    Transform.x[i] = 0;
    Transform.y[i] = 0;
    Transform.rotation[i] = 0;

    if (has.Collider) {
      Collider.active[i] = 1;
    }

    if (has.LightEmitter) {
      LightEmitter.active[i] = 1;
    }

    if (has.ShadowCaster) {
      ShadowCaster.active[i] = 1;
    }

    if (has.SpriteRenderer) {
      SpriteRenderer.active[i] = 1;
      SpriteRenderer.tint[i] = 0xffffff;
      SpriteRenderer.baseTint[i] = 0xffffff;
      SpriteRenderer.alpha[i] = 1.0;
      SpriteRenderer.scaleX[i] = 1;
      SpriteRenderer.scaleY[i] = 1;
      SpriteRenderer.anchorX[i] = 0.5;
      SpriteRenderer.anchorY[i] = 1.0;
      SpriteRenderer.renderVisible[i] = 1;
      SpriteRenderer.isItOnScreen[i] = 0;
      SpriteRenderer.animationState[i] = -1;
      SpriteRenderer.spritesheetId[i] = 0;
      SpriteRenderer.loop[i] = 1; // Default: animations loop
      SpriteRenderer.renderDirty[i] = 1;
    }

    // Apply spawn config (x, y, vx, vy, rotation, etc.)
    for (const key in spawnConfig) {
      if (instance[key] !== undefined) {
        instance[key] = spawnConfig[key];
      }
    }

    // Initialize previous positions for Verlet integration
    if (has.RigidBody) {
      RigidBody.px[i] = Transform.x[i] - RigidBody.vx[i];
      RigidBody.py[i] = Transform.y[i] - RigidBody.vy[i];
    }

    // LIFECYCLE: Call setup() to restore TYPE-level config after defaults were applied
    // setup() defines "what this entity type IS" (physics params, collision, render config)
    if (instance.setup) {
      instance.setup();
    }

    // Ensure mass is calculated after setup() if it's still 0 and entity is not static
    // This handles cases where collider properties were set but mass wasn't calculated
    if (has.RigidBody && has.Collider && RigidBody.active[i] && Collider.active[i]) {
      const isStatic = RigidBody.static[i];
      const currentMass = RigidBody.mass[i];

      // If mass is 0 and entity is not static, recalculate from collider
      if (!isStatic && currentMass === 0) {
        const shapeType = Collider.shapeType[i];
        if (shapeType === 0) {
          // Circle
          const radius = Collider.radius[i];
          if (radius > 0) {
            updateMassFromCircle(i, radius, RigidBody);
          }
        } else if (shapeType === 1) {
          // Box
          const width = Collider.width[i];
          const height = Collider.height[i];
          if (width > 0 && height > 0) {
            updateMassFromBox(i, width, height, RigidBody);
          }
        }
      }
      // If static, ensure invMass is 0
      else if (isStatic) {
        RigidBody.invMass[i] = 0;
      }
    }

    // LIFECYCLE: Call onSpawned() for INSTANCE-level initialization
    // onSpawned() defines "this specific instance" (position, random variations, health)
    if (instance.onSpawned) {
      instance.onSpawned(spawnConfig);
    }

    // AUTOMATION: Automatically initialize any FSM components AFTER onSpawned()
    // This ensures FSM's onEnter() has access to fully configured entity state
    // Developers don't need to manually call initializeEntity() anymore
    const entityComponentMap = EntityClass._componentClassMap || {};
    for (const name in entityComponentMap) {
      const ComponentClass = entityComponentMap[name];
      if (ComponentClass && ComponentClass.isFSM) {
        ComponentClass.initializeEntity(i, instance);
      }
    }

    // Initialize tick decimation countdown (if staggeredUpdates enabled)
    // Stagger entities across frames using index offset: (index % tickInterval) + 1
    // This spreads the load so not all entities tick on the same frame
    if (GameObject.nextTick) {
      const tickInterval = EntityClass.tickInterval || 1;
      if (tickInterval > 1) {
        GameObject.nextTick[i] = (i % tickInterval) + 1;
      } else {
        GameObject.nextTick[i] = 1; // No decimation: always tick
      }
    }

    // NOW activate the entity
    Transform.active[i] = 1;

    return instance;
  }

  /**
   * SPAWNING SYSTEM: Get pool statistics for an entity class
   *
   * @param {Class} EntityClass - The entity class to check
   * @returns {Object} - { total, active, available }
   */
  static getPoolStats(EntityClass) {
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return { total: 0, active: 0, available: 0 };
    }

    // If free list exists, use it for O(1) stats
    if (EntityClass.freeList) {
      const available = EntityClass.freeListTop + 1;
      return {
        total: EntityClass.poolSize,
        active: EntityClass.poolSize - available,
        available: available,
      };
    }

    // Fallback to linear search if free list not initialized
    const startIndex = EntityClass.startIndex;
    const total = EntityClass.poolSize;
    let activeCount = 0;

    for (let i = startIndex; i < EntityClass.endIndex; i++) {
      if (Transform.active[i]) {
        activeCount++;
      }
    }

    return {
      total: total,
      active: activeCount,
      available: total - activeCount,
    };
  }

  /**
   * SPAWNING SYSTEM: Despawn all entities of a specific type
   *
   * @param {Class} EntityClass - The entity class to despawn
   * @returns {number} - Number of entities despawned
   */
  static despawnAll(EntityClass) {
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = EntityClass.endIndex;
    let despawnedCount = 0;

    for (let i = startIndex; i < endIndex; i++) {
      if (Transform.active[i]) {
        const instance = EntityClass.instances[i - startIndex];
        if (instance && instance.despawn) {
          instance.despawn();
          despawnedCount++;
        } else {
          // Manual despawn if instance missing
          Transform.active[i] = 0;

          // Return to free list if exists
          if (EntityClass.freeList) {
            EntityClass.freeList[++EntityClass.freeListTop] = i;
          }

          despawnedCount++;
        }
      }
    }

    return despawnedCount;
  }

  /**
   * ITERATION: Iterate over all ACTIVE entities of this class (index only)
   * Called on the entity class itself: Prey.forEachActive(i => ...)
   *
   * This is the FASTEST iteration method - no instance lookup, no conditionals.
   * Uses pre-computed entityIndices typed array for cache-friendly access.
   *
   * @example
   *   Prey.forEachActive(i => {
   *     Transform.x[i] += RigidBody.vx[i];
   *   });
   *
   * @param {Function} callback - callback(index) called for each active entity
   */
  static forEachActive(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const active = Transform.active;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      const i = indices[j];
      if (active[i]) callback(i);
    }
  }

  /**
   * ITERATION: Iterate over ALL entities of this class (active or not)
   * Called on the entity class itself: Prey.forEachAll(i => ...)
   *
   * Useful for reset/cleanup operations where you need to touch every slot.
   * No active check - iterates the entire pool.
   *
   * @example
   *   // Reset all entities of this type
   *   Prey.forEachAll(i => {
   *     Transform.x[i] = 0;
   *     Transform.y[i] = 0;
   *   });
   *
   * @param {Function} callback - callback(index) called for each entity
   */
  static forEachAll(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const len = indices.length;
    for (let j = 0; j < len; j++) {
      callback(indices[j]);
    }
  }

  /**
   * ITERATION: Iterate over ACTIVE entities with instance access (LOGIC WORKER ONLY)
   * Called on the entity class itself: Prey.forEachInstanceActive((prey, i) => ...)
   *
   * NOTE: Instances only exist in logic_worker.js. Use forEachActive() in other contexts.
   * ZERO ALLOCATIONS - inline loop, no closures.
   *
   * @example
   *   Prey.forEachInstanceActive((prey, i) => {
   *     prey.flee();
   *   });
   *
   * @param {Function} callback - callback(instance, index) for each active entity
   */
  static forEachInstanceActive(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const active = Transform.active;
    const instances = this.instances;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      const i = indices[j];
      if (active[i]) {
        callback(instances ? instances[j] : undefined, i);
      }
    }
  }

  static getFirstActiveIndex() {
    const indices = this.entityIndices;
    if (!indices) return null;

    const active = Transform.active;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      const idx = indices[j];
      if (active[idx]) {
        return idx;
      }
    }
    return null;
  }

  static getFirstActiveInstance() {
    const index = this.getFirstActiveIndex();
    if (index === null) return null;
    return this.instances[index - this.startIndex];
  }

  static getAllActiveIndices() {
    const indices = this.entityIndices;
    if (!indices) return null;

    const active = Transform.active;
    const len = indices.length;
    const activeIndices = new Uint32Array(len); // Pre-allocate max size
    let count = 0;

    for (let j = 0; j < len; j++) {
      const idx = indices[j];
      if (active[idx]) {
        activeIndices[count++] = idx;
      }
    }

    return activeIndices.subarray(0, count); // Return view of used portion
  }

  /**
   * Get active entity indices from the pre-built activeEntitiesData buffer.
   *
   * When called on GameObject: returns ALL active entities.
   * When called on a subclass (e.g., Tree.getAllActive()): returns only active entities of that type.
   *
   * @returns {Uint32Array|number[]} Active entity indices (sorted ascending)
   *
   * PERFORMANCE NOTE: Hybrid approach for optimal performance:
   * - O(1) when called on GameObject (subarray view, no allocation)
   * - Small pools (<100): iteration (lower overhead)
   * - Large pools (>=100): binary search (better scaling)
   */
  static getAllActive() {
    const data = GameObject.activeEntitiesData;
    if (!data) return null;
    const totalCount = data[0];
    if (totalCount === 0) return data.subarray(1, 1);

    // If called on GameObject itself, return all active entities
    if (this === GameObject) {
      return data.subarray(1, 1 + totalCount);
    }

    // Called on a subclass - use hybrid approach based on pool size
    const poolSize = this.poolSize;

    // For small pools, simple iteration is faster (less overhead)
    if (poolSize < 100) {
      return this.getAllActiveIndices();
    }

    // For large pools, binary search scales better
    const startIndex = this.startIndex;
    const endIndex = startIndex + poolSize;

    // Binary search to find first index >= startIndex
    let lo = 1,
      hi = 1 + totalCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (data[mid] < startIndex) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;

    // Binary search to find first index >= endIndex
    hi = 1 + totalCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (data[mid] < endIndex) lo = mid + 1;
      else hi = mid;
    }
    const last = lo;

    return data.subarray(first, last);
  }

  static getAllActiveInstances() {
    const indices = this.entityIndices;
    if (!indices) return;

    const active = Transform.active;
    const instances = this.instances;
    const len = indices.length;
    const activeInstances = [];
    for (let j = 0; j < len; j++) {
      const i = indices[j];
      if (active[i]) {
        activeInstances.push(instances ? instances[j] : undefined);
      }
    }
    return activeInstances;
  }

  /**
   * ITERATION: Iterate over ALL entities with instance access (LOGIC WORKER ONLY)
   * Called on the entity class itself: Prey.forEachInstanceAll((prey, i) => ...)
   *
   * Useful for reset/cleanup operations where you need instance access.
   * No active check - iterates the entire pool.
   *
   * NOTE: Instances only exist in logic_worker.js. Use forEachAll() in other contexts.
   * ZERO ALLOCATIONS - inline loop, no closures.
   *
   * @example
   *   Prey.forEachInstanceAll((prey, i) => {
   *     prey.reset();
   *   });
   *
   * @param {Function} callback - callback(instance, index) for each entity
   */
  static forEachInstanceAll(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const instances = this.instances;

    const len = indices.length;

    for (let j = 0; j < len; j++) {
      callback(instances ? instances[j] : undefined, indices[j]);
    }
  }

  /**
   * ITERATION: Get count of active entities of this class
   * Called on the entity class itself: Prey.activeCount
   *
   * @returns {number} Number of currently active entities
   */
  static get activeCount() {
    const EntityClass = this;

    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return 0;
    }

    // If free list exists, calculate from it (O(1))
    if (EntityClass.hasOwnProperty('freeList')) {
      return EntityClass.poolSize - (EntityClass.freeListTop + 1);
    }

    // Fallback: count active entities (O(n))
    const startIndex = EntityClass.startIndex;
    const endIndex = EntityClass.endIndex;
    let count = 0;

    for (let i = startIndex; i < endIndex; i++) {
      if (Transform.active[i]) {
        count++;
      }
    }

    return count;
  }
}
