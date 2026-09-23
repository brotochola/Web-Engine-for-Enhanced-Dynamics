// PersonWithFSM.js - Example entity using the FSM system
// Demonstrates civilian behavior with IDLE and FLEEING states

import WEED from '/src/index.js';

import { Mouse } from '/src/core/mouse.js';
import { containerRadius } from '/src/index.js';
import { MySoldier } from './mySoldier.js';

const {
  GameObject,

  Collider,
  SpriteRenderer,
} = WEED;

export class Destination extends GameObject {
  // Auto-detected by GameEngine
  static serializable = true;
  // Components: basic physics + rendering + our FSM
  static components = [Collider, SpriteRenderer];

  onSpawned(spawnConfig = {}) {
    // Collision/perception
    this.collider.radius = 100;
    this.collider.visualRange = 0;
    this.collider.isTrigger = 1;

    // Sprite setup
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    this.x = this.config.worldWidth * 0.5;
    this.y = this.config.worldHeight * 0.5;

    this.setSprite('target');
  
  }

  /**
   * LIFECYCLE: Main update loop
   */
  tick(dt) {

    if (Mouse.isButton0Pressed) {

      this.x = Mouse.x;
      this.y = Mouse.y;
      this.collider.radius = containerRadius(MySoldier.activeCount, 12, 1);
      const allActiveSoldiers = MySoldier.getAllActiveInstances();
      for (const soldier of allActiveSoldiers) {
        soldier.startFollowingDestination();
      }
    }
  }
}
