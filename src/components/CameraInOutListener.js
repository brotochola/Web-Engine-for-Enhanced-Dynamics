import { Component } from '../core/Component.js';

/**
 * Marker component that enables onScreenEnter() / onScreenExit() callbacks.
 *
 * This component has no SharedArrayBuffer schema. The logic worker reads it once
 * per entity type, then checks Transform.isItOnScreen only for those types.
 * The pre-render worker publishes that canonical entity visibility flag after
 * combining all renderable components for the entity.
 */
export class CameraInOutListener extends Component { }
