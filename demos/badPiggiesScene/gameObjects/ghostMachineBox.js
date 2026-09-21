import { MachineBox } from './machineBox.js';

/** Cursor preview only — not included in save games. */
export class GhostMachineBox extends MachineBox {
  static serializable = false;
  static instances = [];
}
