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

  // Mouse is ALWAYS registered first, so its entity index is ALWAYS 0
  // Mouse component index is also 0 (only one Mouse exists)
  // No configuration needed - just use index 0 everywhere!

  // Canvas position for world coordinate calculation (main thread only)
  static _canvasX = 0;
  static _canvasY = 0;

  // ============================================
  // POSITION - getters and setters
  // ============================================

  static get x() {
    return Transform.x[0];
  }

  static set x(value) {
    Transform.x[0] = value;
  }

  static get y() {
    return Transform.y[0];
  }

  static set y(value) {
    Transform.y[0] = value;
  }

  // ============================================
  // BUTTON STATE - getters and setters
  // ============================================

  static get isButton0Down() {
    return MouseComponent.button0Down[0] === 1;
  }

  static set isButton0Down(value) {
    MouseComponent.button0Down[0] = value ? 1 : 0;
  }

  static get isButton1Down() {
    return MouseComponent.button1Down[0] === 1;
  }

  static set isButton1Down(value) {
    MouseComponent.button1Down[0] = value ? 1 : 0;
  }

  static get isButton2Down() {
    return MouseComponent.button2Down[0] === 1;
  }

  static set isButton2Down(value) {
    MouseComponent.button2Down[0] = value ? 1 : 0;
  }

  static get isPresent() {
    return MouseComponent.isPresent[0] === 1;
  }

  static set isPresent(value) {
    MouseComponent.isPresent[0] = value ? 1 : 0;
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
