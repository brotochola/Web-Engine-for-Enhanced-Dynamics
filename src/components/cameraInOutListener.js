import { Component } from '../core/component.js';

/**
 * Marker component that enables onScreenEnter() / onScreenExit() callbacks.
 *
 * This component has no SharedArrayBuffer schema. The logic worker reads it once
 * per entity type, then checks Camera.isOnScreen on that entity's pose.
 * Pre-render does not publish a visibility byte for every entity.
 */
export class CameraInOutListener extends Component { }

/** Enter when the camera box newly contains the entity. Exit when it leaves. */
export function noteScreenVisibility(currentlyOn, wasOn, obj) {
  if (currentlyOn && !wasOn) obj.onScreenEnter();
  else if (!currentlyOn && wasOn) obj.onScreenExit();
}
