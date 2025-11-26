import { GameObject } from './gameObject.js';
import type { SpriteConfig, RenderableConfig } from '../types/index.js';
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
export declare class RenderableGameObject extends GameObject {
    static instances: RenderableGameObject[];
    static readonly ARRAY_SCHEMA: {
        readonly animationState: Uint8ArrayConstructor;
        readonly animationFrame: Uint16ArrayConstructor;
        readonly animationSpeed: Float32ArrayConstructor;
        readonly tint: Uint32ArrayConstructor;
        readonly alpha: Float32ArrayConstructor;
        readonly flipX: Uint8ArrayConstructor;
        readonly flipY: Uint8ArrayConstructor;
        readonly scaleX: Float32ArrayConstructor;
        readonly scaleY: Float32ArrayConstructor;
        readonly spriteVariant: Uint8ArrayConstructor;
        readonly zOffset: Float32ArrayConstructor;
        readonly blendMode: Uint8ArrayConstructor;
        readonly renderVisible: Uint8ArrayConstructor;
        readonly renderDirty: Uint8ArrayConstructor;
        readonly x: Float32ArrayConstructor;
        readonly y: Float32ArrayConstructor;
        readonly vx: Float32ArrayConstructor;
        readonly vy: Float32ArrayConstructor;
        readonly ax: Float32ArrayConstructor;
        readonly ay: Float32ArrayConstructor;
        readonly rotation: Float32ArrayConstructor;
        readonly velocityAngle: Float32ArrayConstructor;
        readonly speed: Float32ArrayConstructor;
        readonly px: Float32ArrayConstructor;
        readonly py: Float32ArrayConstructor;
        readonly maxVel: Float32ArrayConstructor;
        readonly maxAcc: Float32ArrayConstructor;
        readonly minSpeed: Float32ArrayConstructor;
        readonly friction: Float32ArrayConstructor;
        readonly radius: Float32ArrayConstructor;
        readonly collisionCount: Uint8ArrayConstructor;
        readonly visualRange: Float32ArrayConstructor;
        readonly active: Uint8ArrayConstructor;
        readonly entityType: Uint8ArrayConstructor;
        readonly isItOnScreen: Uint8ArrayConstructor;
    };
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
    animationState: number;
    animationFrame: number;
    animationSpeed: number;
    tint: number;
    alpha: number;
    flipX: number;
    flipY: number;
    scaleX: number;
    scaleY: number;
    spriteVariant: number;
    zOffset: number;
    blendMode: number;
    renderVisible: number;
    renderDirty: number;
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
    static spriteConfig: SpriteConfig | null;
    /**
     * Validate spriteConfig format
     * @param EntityClass - The class to validate
     * @returns Validation result with error message if invalid
     */
    static validateSpriteConfig(EntityClass: typeof RenderableGameObject): SpriteConfigValidation;
    /**
     * Constructor - initializes rendering properties
     */
    constructor(index: number, config?: RenderableConfig, logicWorker?: Worker | null);
    /**
     * Mark this entity's visual properties as dirty (needs rendering update)
     * Call this after changing any visual properties to trigger a render update
     */
    markDirty(): void;
    /**
     * Helper setters that automatically mark entity as dirty when visual properties change
     * These provide a convenient API for changing common visual properties
     */
    setAnimationState(state: number): void;
    setAnimationSpeed(speed: number): void;
    setTint(tint: number): void;
    setAlpha(alpha: number): void;
    setFlip(flipX: boolean, flipY?: boolean): void;
    setScale(scaleX: number, scaleY?: number): void;
    setVisible(visible: boolean): void;
    /**
     * Helper method to send sprite property changes to renderer
     * For rare/complex changes that can't be done via SharedArrayBuffer
     * Uses direct MessagePort communication for better performance
     * @param prop - Property path (e.g., "tint", "scale.x")
     * @param value - Value to set
     */
    setSpriteProp(prop: string, value: any): void;
    /**
     * Helper method to call sprite methods
     * Uses direct MessagePort communication for better performance
     * @param method - Method name
     * @param args - Method arguments
     */
    callSpriteMethod(method: string, args?: any[]): void;
    /**
     * Helper method to batch multiple sprite updates
     * Uses direct MessagePort communication for better performance
     * @param updates - Object with 'set' and/or 'call' properties
     */
    updateSprite(updates: Record<string, any>): void;
}
export {};
//# sourceMappingURL=RenderableGameObject.d.ts.map