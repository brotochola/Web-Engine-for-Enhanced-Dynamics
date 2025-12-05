// Mouse.js - Mouse entity with Transform for spatial tracking
// Extends GameObject so it can be tracked in the spatial grid
// Position is written directly to Transform by main thread
// Button state is stored in MouseComponent (SharedArrayBuffer)

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { MouseComponent } from "../components/MouseComponent.js";

export class Mouse extends GameObject {
  static entityType = 255; // Special entity type for mouse
  static components = [Collider, MouseComponent]; // Collider for spatial queries, MouseComponent for input state

  // Default visual range for mouse (how far it "sees" neighbors)
  static defaultVisualRange = 150;

  // Indices for direct array access (set by main thread before spawning)
  static _entityIndex = -1;
  static _componentIndex = -1;

  // Singleton instance reference (set by worker after spawning)
  static _instance = null;

  // Canvas position for world coordinate calculation
  static _canvasX = 0;
  static _canvasY = 0;

  /**
   * Configure Mouse for main thread use (set indices for direct array access)
   * Called by GameEngine after buffer creation, before spawning
   * @param {number} entityIndex - Entity index in Transform arrays
   * @param {number} componentIndex - Component index in MouseComponent arrays
   */
  static configure(entityIndex, componentIndex) {
    this._entityIndex = entityIndex;
    this._componentIndex = componentIndex;
  }

  /**
   * Set the singleton mouse instance (called after spawning in worker)
   * @param {Mouse} instance - The spawned mouse entity
   */
  static setInstance(instance) {
    this._instance = instance;
  }

  /**
   * Get the singleton mouse instance
   * @returns {Mouse|null} The mouse instance
   */
  static getInstance() {
    return this._instance;
  }

  // ============================================
  // POSITION - getters and setters
  // ============================================

  static get x() {
    const idx = this._instance?.index ?? this._entityIndex;
    return idx >= 0 ? Transform.x[idx] : 0;
  }

  static set x(value) {
    const idx = this._instance?.index ?? this._entityIndex;
    if (idx >= 0 && Transform.x) Transform.x[idx] = value;
  }

  static get y() {
    const idx = this._instance?.index ?? this._entityIndex;
    return idx >= 0 ? Transform.y[idx] : 0;
  }

  static set y(value) {
    const idx = this._instance?.index ?? this._entityIndex;
    if (idx >= 0 && Transform.y) Transform.y[idx] = value;
  }

  // ============================================
  // BUTTON STATE - getters and setters
  // ============================================

  static get _compIdx() {
    return (
      this._instance?._componentIndices?.mouseComponent ?? this._componentIndex
    );
  }

  static get isButton0Down() {
    const idx = this._compIdx;
    return idx >= 0 ? MouseComponent.button0Down[idx] === 1 : false;
  }

  static set isButton0Down(value) {
    const idx = this._compIdx;
    if (idx >= 0) MouseComponent.button0Down[idx] = value ? 1 : 0;
  }

  static get isButton1Down() {
    const idx = this._compIdx;
    return idx >= 0 ? MouseComponent.button1Down[idx] === 1 : false;
  }

  static set isButton1Down(value) {
    const idx = this._compIdx;
    if (idx >= 0) MouseComponent.button1Down[idx] = value ? 1 : 0;
  }

  static get isButton2Down() {
    const idx = this._compIdx;
    return idx >= 0 ? MouseComponent.button2Down[idx] === 1 : false;
  }

  static set isButton2Down(value) {
    const idx = this._compIdx;
    if (idx >= 0) MouseComponent.button2Down[idx] = value ? 1 : 0;
  }

  static get isPresent() {
    const idx = this._compIdx;
    return idx >= 0 ? MouseComponent.isPresent[idx] === 1 : false;
  }

  static set isPresent(value) {
    const idx = this._compIdx;
    if (idx >= 0) MouseComponent.isPresent[idx] = value ? 1 : 0;
  }

  // ============================================
  // ALIASES (getters only)
  // ============================================

  static get isInWorld() {
    return this.isPresent;
  }

  static get isDown() {
    return this.isButton0Down;
  }

  static get isLeftButtonDown() {
    return this.isButton0Down;
  }

  static get isMiddleButtonDown() {
    return this.isButton1Down;
  }

  static get isRightButtonDown() {
    return this.isButton2Down;
  }

  // ============================================
  // WORLD POSITION CALCULATION (for main thread)
  // ============================================

  /**
   * Update world position from canvas coordinates
   * Call this when mouse moves or camera changes
   * @param {Object} camera - Camera object with zoom, x, y
   */
  static updateWorldPosition(camera) {
    if (this._canvasX !== undefined) {
      this.x = this._canvasX / camera.zoom + camera.x;
      this.y = this._canvasY / camera.zoom + camera.y;
    }
  }

  /**
   * Set canvas coordinates and update world position
   * @param {number} canvasX - X position on canvas
   * @param {number} canvasY - Y position on canvas
   * @param {Object} camera - Camera object with zoom, x, y
   */
  static setCanvasPosition(canvasX, canvasY, camera) {
    this._canvasX = canvasX;
    this._canvasY = canvasY;
    this.updateWorldPosition(camera);
  }

  // ============================================
  // INSTANCE METHODS (for worker-side access)
  // ============================================

  // Setup - configure collider for spatial queries
  setup() {
    if (this.collider) {
      this.collider.visualRange = Mouse.defaultVisualRange;
      this.collider.radius = 0;
      this.collider.isTrigger = 1; // Trigger only - no physical push, just detection
    }
  }

  // Instance getters for convenience (read from components)
  get isButton0Down() {
    return this.mouseComponent ? this.mouseComponent.button0Down === 1 : false;
  }

  get isButton1Down() {
    return this.mouseComponent ? this.mouseComponent.button1Down === 1 : false;
  }

  get isButton2Down() {
    return this.mouseComponent ? this.mouseComponent.button2Down === 1 : false;
  }

  get isPresent() {
    return this.mouseComponent ? this.mouseComponent.isPresent === 1 : false;
  }

  get isDown() {
    return this.isButton0Down;
  }

  // tick() is optional - position is updated by main thread directly
  tick(dtRatio) {
    // console.log(this.neighborCount);
    // Mouse position is already updated by main thread writing to Transform
  }
}
