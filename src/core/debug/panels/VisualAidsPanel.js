// VisualAidsPanel.js — Toggle buttons for debug flags (colliders, velocity, etc.)

import { DEBUG_FLAGS } from '../../DebugFlags.js';
import { createPanel, createRow, createDivider } from '../ui/DebugDOM.js';

export class VisualAidsPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = { visualToggles: {} };
    this.panel = null;
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();
    const row = createRow();

    const visualAids = [
      { key: 'colliders', label: 'Colliders', shortcut: '1' },
      { key: 'velocity', label: 'Velocity', shortcut: '2' },
      { key: 'acceleration', label: 'Accel', shortcut: '3' },
      { key: 'neighbors', label: 'Neighbors', shortcut: '4' },
      { key: 'collisionCandidates', label: 'Collision', shortcut: 'C' },
      { key: 'spatialGrid', label: 'Grid', shortcut: '5' },
      { key: 'aabb', label: 'AABB', shortcut: '6' },
      { key: 'entityIndices', label: 'Indices', shortcut: '7' },
      { key: 'raycasts', label: 'Raycasts', shortcut: '8' },
      { key: 'sleepingEntities', label: 'Sleeping', shortcut: '9' },
      { key: 'sleepingCells', label: 'Sleep Cells', shortcut: 'S' },
      { key: 'constraints', label: 'Constraints', shortcut: 'K' },
      { key: 'entityOrigins', label: 'Origins', shortcut: 'O' },
    ];

    for (const aid of visualAids) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn';
      btn.textContent = `[${aid.shortcut}] ${aid.label}`;
      btn.onclick = () => this.toggleVisualAid(aid.key);
      this.elements.visualToggles[aid.key] = btn;
      row.appendChild(btn);
    }

    // Disable all
    const disableBtn = document.createElement('button');
    disableBtn.className = 'debug-ui-btn danger';
    disableBtn.textContent = '[0] Off';
    disableBtn.onclick = () => {
      const flags = this.debugUI.debugFlags;
      if (flags) {
        flags.disableAll();
        this.updateState();
        this.debugUI.canvas.syncLoop();
      }
    };
    row.appendChild(disableBtn);

    row.appendChild(createDivider());

    // Inspector toggle
    this.elements.inspectorBtn = document.createElement('button');
    this.elements.inspectorBtn.className = 'debug-ui-btn tool';
    this.elements.inspectorBtn.textContent = '[I] Inspect';
    this.elements.inspectorBtn.title = 'Click on an entity to inspect its components';
    this.elements.inspectorBtn.onclick = () => this.debugUI.tools.toggleInspector();
    row.appendChild(this.elements.inspectorBtn);

    this.panel.appendChild(row);
    return this.panel;
  }

  // ------- lifecycle -------

  attach() {
    this.updateState();
  }

  update() { /* toggles are event-driven, no per-tick work */ }

  // ------- public -------

  updateState() {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;
    const state = flags.getState();
    for (const [key, btn] of Object.entries(this.elements.visualToggles)) {
      if (btn && state[key] !== undefined) {
        btn.classList.toggle('active', state[key]);
      }
    }
  }

  updateInspectorButtonState(isActive) {
    if (this.elements.inspectorBtn) {
      this.elements.inspectorBtn.classList.toggle('active', isActive);
    }
  }

  toggleVisualAid(key) {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;

    const methodMap = {
      colliders: 'showColliders',
      velocity: 'showVelocity',
      acceleration: 'showAcceleration',
      neighbors: 'showNeighbors',
      collisionCandidates: 'showCollisionCandidates',
      spatialGrid: 'showSpatialGrid',
      aabb: 'showAABB',
      entityIndices: 'showEntityIndices',
      raycasts: 'showRaycasts',
      sleepingEntities: 'showSleepingEntities',
      sleepingCells: 'showSleepingCells',
      constraints: 'showConstraints',
      entityOrigins: 'showEntityOrigins',
    };

    const method = methodMap[key];
    if (!method || !flags[method]) return;

    let flagName = `SHOW_${key.toUpperCase().replace('GRID', '_GRID').replace('INDICES', '_INDICES')}`;
    if (key === 'sleepingEntities') flagName = 'SHOW_SLEEPING_ENTITIES';
    else if (key === 'sleepingCells') flagName = 'SHOW_SLEEPING_CELLS';
    else if (key === 'collisionCandidates') flagName = 'SHOW_COLLISION_CANDIDATES';
    else if (key === 'constraints') flagName = 'SHOW_CONSTRAINTS';
    else if (key === 'entityOrigins') flagName = 'SHOW_ENTITY_ORIGINS';

    flags[method](!flags.isEnabled(DEBUG_FLAGS[flagName]));
    this.updateState();
    this.debugUI.canvas.syncLoop();
  }
}
