// Destination.js - The soldiers' rally point: a target marker the player moves with a click
// Clicking moves it under the mouse and sends every soldier walking to it (MySoldier.startFollowingDestination).
//
// ECS-style (E-530): its hook and its tick are statics that take entity indices; no instance is made for it.

import WEED from '/src/index.js';

import { containerRadius } from '/src/index.js';
import { MySoldier } from './mySoldier.js';

const {
  GameObject,
  Transform,
  Collider,
  SpriteRenderer,
  Mouse,
} = WEED;

export class Destination extends GameObject {
  // Auto-detected by GameEngine
  static serializable = true;
  // Components: a trigger circle (the soldiers arrive when inside it) and its marker sprite
  static components = [Collider, SpriteRenderer];

  /** LIFECYCLE: each spawn of destination i: a 100 px trigger at the world's centre, drawn as the target marker. */
  static onSpawned(i, spawnConfig = {}) {
    // Collision/perception: a sensor nobody bumps into, with no neighbour list (it reads none)
    Collider.setRadius(i, 100);
    Collider.visualRange[i] = 0;
    Collider.setIsTrigger(i, 1);

    // Sprite setup: the marker centred on the point
    SpriteRenderer.setAnchor(i, 0.5, 0.5);
    Transform.setPosition(i, this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);

    SpriteRenderer.setSprite(i, 'target');
  }

  /**
   * Each frame, for the destinations this worker ticks (the scene has one): on a click it moves under the mouse, grows
   * to hold every soldier, and orders them all there.
   */
  static tickAll(list, count, dtRatio) {
    if (count === 0 || !Mouse.isButton0Pressed) return;

    // Big enough for the whole squad packed around the point, so they stop on arriving instead of crowding its centre.
    const radius = containerRadius(MySoldier.activeCount, 12, 1);
    for (let k = 0; k < count; k++) {
      const i = list[k];
      Transform.setPosition(i, Mouse.x, Mouse.y);
      Collider.setRadius(i, radius);
    }

    const soldiers = MySoldier.getAllActive();
    for (let s = 0; s < soldiers.length; s++) {
      MySoldier.startFollowingDestination(soldiers[s]);
    }
  }
}
