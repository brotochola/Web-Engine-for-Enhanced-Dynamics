// RenderableGameObject.ts - Game object with rendering properties
// Extends GameObject to add visual/animation state for rendering

import { GameObject } from './gameObject.js';
import type { EntityConfig, SpriteConfig, RenderableConfig } from '../types/index.js';

/**
 * Sprite configuration validation result
 */
interface SpriteConfigValidation {
  valid: boolean;
  error: string | null;
}

/**
 * Extended game object with rendering capabilities
 * Adds visual properties for sprites, animations, and effects
 */
export class RenderableGameObject extends GameObject {
  static override instances: RenderableGameObject[] = []; // Instance tracking for this class

  // Define rendering-specific properties schema
  static override readonly ARRAY_SCHEMA = {
    ...GameObject.ARRAY_SCHEMA,
    // Animation control
    animationState: Uint8Array, // Current animation index (0-255)
    animationFrame: Uint16Array, // Manual frame control if needed
    animationSpeed: Float32Array, // Playback speed multiplier (1.0 = normal)

    // Visual effects
    tint: Uint32Array, // Color tint (0xFFFFFF = white/normal)
    alpha: Float32Array, // Transparency (0-1)

    // Sprite modifications
    flipX: Uint8Array, // Flip horizontally
    flipY: Uint8Array, // Flip vertically
    scaleX: Float32Array, // Separate X scale
    scaleY: Float32Array, // Separate Y scale

    // Rendering options
    spriteVariant: Uint8Array, // Texture/sprite variant (for different skins)
    zOffset: Float32Array, // Z-index offset (for layering)
    blendMode: Uint8Array, // Blend mode (0=normal, 1=add, 2=multiply, etc.)

    // Visibility
    renderVisible: Uint8Array, // Override visibility (separate from culling)

    // Performance optimization - dirty flag
    renderDirty: Uint8Array, // 1 = visual properties changed, needs update this frame
  } as const;

  // Static typed arrays for rendering properties
  static animationState: Uint8Array;
  static animationFrame: Uint16Array;
  static animationSpeed: Float32Array;
  static tint: Uint32Array;
  static alpha: Float32Array;
  static flipX: Uint8Array;
  static flipY: Uint8Array;
  static scaleX: Float32Array;
  static scaleY: Float32Array;
  static spriteVariant: Uint8Array;
  static zOffset: Float32Array;
  static blendMode: Uint8Array;
  static renderVisible: Uint8Array;
  static renderDirty: Uint8Array;

  // Dynamic instance properties (created via getters/setters)
  declare animationState: number;
  declare animationFrame: number;
  declare animationSpeed: number;
  declare tint: number;
  declare alpha: number;
  declare flipX: number;
  declare flipY: number;
  declare scaleX: number;
  declare scaleY: number;
  declare spriteVariant: number;
  declare zOffset: number;
  declare blendMode: number;
  declare renderVisible: number;
  declare renderDirty: number;

  /**
   * Sprite configuration - MUST be overridden in subclasses
   * Defines what texture or spritesheet this entity uses for rendering
   *
   * For static sprites:
   *   static spriteConfig = { type: 'static', textureName: 'bunny' }
   *
   * For animated sprites:
   *   static spriteConfig = {
   *     type: 'animated',
   *     spritesheet: 'person',
   *     defaultAnimation: 'idle',
   *     animationSpeed: 0.15,
   *     animStates: { 0: { name: 'idle', label: 'IDLE' }, ... }
   *   }
   */
  static spriteConfig: SpriteConfig | null = null; // Must be overridden in subclasses

  /**
   * Validate spriteConfig format
   * @param EntityClass - The class to validate
   * @returns Validation result with error message if invalid
   */
  static validateSpriteConfig(EntityClass: typeof RenderableGameObject): SpriteConfigValidation {
    const config = EntityClass.spriteConfig as any;
    const className = EntityClass.name;

    // Skip validation for RenderableGameObject itself (base class)
    if (EntityClass === RenderableGameObject) {
      return { valid: true, error: null };
    }

    // Must have spriteConfig
    if (!config) {
      return {
        valid: false,
        error: `${className} extends RenderableGameObject but has no spriteConfig defined!`,
      };
    }

    // Must have type field
    if (!config.type) {
      return {
        valid: false,
        error: `${className}.spriteConfig missing 'type' field! Use type: 'static' or 'animated'`,
      };
    }

    // Validate static sprite config
    if (config.type === 'static') {
      if (!config.textureName) {
        return {
          valid: false,
          error: `${className}.spriteConfig type is 'static' but missing 'textureName' field!`,
        };
      }
    }

    // Validate animated sprite config
    if (config.type === 'animated') {
      if (!config.spritesheet) {
        return {
          valid: false,
          error: `${className}.spriteConfig type is 'animated' but missing 'spritesheet' field!`,
        };
      }
      if (!config.defaultAnimation) {
        return {
          valid: false,
          error: `${className}.spriteConfig type is 'animated' but missing 'defaultAnimation' field!`,
        };
      }
      if (!config.animStates) {
        return {
          valid: false,
          error: `${className}.spriteConfig type is 'animated' but missing 'animStates' field! Use animStates instead of animations.`,
        };
      }
    }

    return { valid: true, error: null };
  }

  /**
   * Constructor - initializes rendering properties
   */
  constructor(index: number, config: RenderableConfig = {}, logicWorker: Worker | null = null) {
    super(index, config, logicWorker);

    const i = index;
    const spriteConfig = (this.constructor as typeof RenderableGameObject).spriteConfig as any;

    // Initialize rendering properties with defaults
    RenderableGameObject.animationState[i] = 0;
    RenderableGameObject.animationFrame[i] = 0;
    RenderableGameObject.animationSpeed[i] = spriteConfig?.animationSpeed || 0.2;

    RenderableGameObject.tint[i] = 0xffffff; // White (no tint)
    RenderableGameObject.alpha[i] = 1.0; // Fully opaque

    RenderableGameObject.flipX[i] = 0;
    RenderableGameObject.flipY[i] = 0;
    RenderableGameObject.scaleX[i] = 1.0;
    RenderableGameObject.scaleY[i] = 1.0;

    RenderableGameObject.spriteVariant[i] = 0;
    RenderableGameObject.zOffset[i] = 0;
    RenderableGameObject.blendMode[i] = 0; // Normal blend mode

    RenderableGameObject.renderVisible[i] = 1; // Visible by default
    RenderableGameObject.renderDirty[i] = 1; // Mark as dirty initially (needs first render)
  }

  /**
   * Mark this entity's visual properties as dirty (needs rendering update)
   * Call this after changing any visual properties to trigger a render update
   */
  markDirty(): void {
    RenderableGameObject.renderDirty[this.index] = 1;
  }

  /**
   * Helper setters that automatically mark entity as dirty when visual properties change
   * These provide a convenient API for changing common visual properties
   */

  setAnimationState(state: number): void {
    if (RenderableGameObject.animationState[this.index] !== state) {
      RenderableGameObject.animationState[this.index] = state;
      this.markDirty();
    }
  }

  setAnimationSpeed(speed: number): void {
    if (RenderableGameObject.animationSpeed[this.index] !== speed) {
      RenderableGameObject.animationSpeed[this.index] = speed;
      this.markDirty();
    }
  }

  setTint(tint: number): void {
    if (RenderableGameObject.tint[this.index] !== tint) {
      RenderableGameObject.tint[this.index] = tint;
      this.markDirty();
    }
  }

  setAlpha(alpha: number): void {
    if (RenderableGameObject.alpha[this.index] !== alpha) {
      RenderableGameObject.alpha[this.index] = alpha;
      this.markDirty();
    }
  }

  setFlip(flipX: boolean, flipY?: boolean): void {
    let changed = false;
    if (RenderableGameObject.flipX[this.index] !== (flipX ? 1 : 0)) {
      RenderableGameObject.flipX[this.index] = flipX ? 1 : 0;
      changed = true;
    }
    if (
      flipY !== undefined &&
      RenderableGameObject.flipY[this.index] !== (flipY ? 1 : 0)
    ) {
      RenderableGameObject.flipY[this.index] = flipY ? 1 : 0;
      changed = true;
    }
    if (changed) this.markDirty();
  }

  setScale(scaleX: number, scaleY?: number): void {
    let changed = false;
    if (RenderableGameObject.scaleX[this.index] !== scaleX) {
      RenderableGameObject.scaleX[this.index] = scaleX;
      changed = true;
    }
    if (
      scaleY !== undefined &&
      RenderableGameObject.scaleY[this.index] !== scaleY
    ) {
      RenderableGameObject.scaleY[this.index] = scaleY;
      changed = true;
    }
    if (changed) this.markDirty();
  }

  setVisible(visible: boolean): void {
    if (RenderableGameObject.renderVisible[this.index] !== (visible ? 1 : 0)) {
      RenderableGameObject.renderVisible[this.index] = visible ? 1 : 0;
      this.markDirty();
    }
  }

  /**
   * Helper method to send sprite property changes to renderer
   * For rare/complex changes that can't be done via SharedArrayBuffer
   * Uses direct MessagePort communication for better performance
   * @param prop - Property path (e.g., "tint", "scale.x")
   * @param value - Value to set
   */
  setSpriteProp(prop: string, value: any): void {
    if (this.logicWorker) {
      (this.logicWorker as any).sendDataToWorker('renderer', {
        cmd: 'setProp',
        entityId: this.index,
        prop: prop,
        value: value,
      });
    }
  }

  /**
   * Helper method to call sprite methods
   * Uses direct MessagePort communication for better performance
   * @param method - Method name
   * @param args - Method arguments
   */
  callSpriteMethod(method: string, args: any[] = []): void {
    if (this.logicWorker) {
      (this.logicWorker as any).sendDataToWorker('renderer', {
        cmd: 'callMethod',
        entityId: this.index,
        method: method,
        args: args,
      });
    }
  }

  /**
   * Helper method to batch multiple sprite updates
   * Uses direct MessagePort communication for better performance
   * @param updates - Object with 'set' and/or 'call' properties
   */
  updateSprite(updates: Record<string, any>): void {
    if (this.logicWorker) {
      (this.logicWorker as any).sendDataToWorker('renderer', {
        cmd: 'batchUpdate',
        entityId: this.index,
        ...updates,
      });
    }
  }

  // Static initialization block - create getters/setters for RenderableGameObject's ARRAY_SCHEMA
  static {
    GameObject._createSchemaProperties(RenderableGameObject);
  }
}
