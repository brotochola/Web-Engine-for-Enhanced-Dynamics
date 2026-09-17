// VisualAidsPanel.js — Toggle buttons for debug flags (colliders, velocity, etc.)

import { DEBUG_FLAGS } from '../debugFlags.js';
import { createPanel, createRow, createDivider, createButton } from '../ui/debugDom.js';

const VISUAL_METHOD = {
  colliders: 'showColliders',
  velocity: 'showVelocity',
  acceleration: 'showAcceleration',
  neighbors: 'showNeighbors',
  spatialGrid: 'showSpatialGrid',
  entityIndices: 'showEntityIndices',
  debugDraws: 'showDebugDraws',
  sleepingEntities: 'showSleepingEntities',
  sleepingCells: 'showSleepingCells',
  joints: 'showJoints',
  entityOrigins: 'showEntityOrigins',
  entityInfo: 'showEntityInfo',
  activeOnly: 'showActiveOnly',
  lights: 'showLights',
  fpsGraph: 'showFPSGraph',
};

const VISUAL_FLAG = {
  colliders: DEBUG_FLAGS.SHOW_COLLIDERS,
  velocity: DEBUG_FLAGS.SHOW_VELOCITY,
  acceleration: DEBUG_FLAGS.SHOW_ACCELERATION,
  neighbors: DEBUG_FLAGS.SHOW_NEIGHBORS,
  spatialGrid: DEBUG_FLAGS.SHOW_SPATIAL_GRID,
  entityIndices: DEBUG_FLAGS.SHOW_ENTITY_INDICES,
  debugDraws: DEBUG_FLAGS.SHOW_DEBUG_DRAWS,
  sleepingEntities: DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES,
  sleepingCells: DEBUG_FLAGS.SHOW_SLEEPING_CELLS,
  joints: DEBUG_FLAGS.SHOW_JOINTS,
  entityOrigins: DEBUG_FLAGS.SHOW_ENTITY_ORIGINS,
  entityInfo: DEBUG_FLAGS.SHOW_ENTITY_INFO,
  activeOnly: DEBUG_FLAGS.SHOW_ACTIVE_ONLY,
  lights: DEBUG_FLAGS.SHOW_LIGHTS,
  fpsGraph: DEBUG_FLAGS.SHOW_FPS_GRAPH,
};

export class VisualAidsPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = { visualToggles: {} };
    this.panel = null;
  }

  create() {
    this.panel = createPanel();

    const row = createRow();
    const visualAids = [
      { key: 'colliders', label: 'Colliders', shortcut: '1' },
      { key: 'velocity', label: 'Velocity', shortcut: '2' },
      { key: 'acceleration', label: 'Accel', shortcut: '3' },
      { key: 'neighbors', label: 'Neighbors', shortcut: '4' },
      { key: 'spatialGrid', label: 'Grid', shortcut: '5' },
      { key: 'entityIndices', label: 'Indices', shortcut: '6' },
      { key: 'debugDraws', label: 'Draws', shortcut: '7' },
      { key: 'sleepingEntities', label: 'Sleeping', shortcut: '8' },
      { key: 'sleepingCells', label: 'Sleep Cells', shortcut: 'S' },
      { key: 'joints', label: 'Joints', shortcut: 'K' },
      { key: 'entityOrigins', label: 'Origins', shortcut: 'O' },
    ];

    for (const aid of visualAids) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn';
      btn.textContent = `[${aid.shortcut}] ${aid.label}`;
      if (aid.key === 'acceleration') {
        btn.title = 'Impulse applied this step (Box2D clears ax/ay after integrate)';
      }
      btn.onclick = () => this.toggleVisualAid(aid.key);
      this.elements.visualToggles[aid.key] = btn;
      row.appendChild(btn);
    }

    const disableBtn = document.createElement('button');
    disableBtn.className = 'debug-ui-btn danger';
    disableBtn.textContent = '[0] Off';
    disableBtn.onclick = () => {
      const flags = this.debugUI.debugFlags;
      if (flags) {
        flags.disableAll();
        flags.showDebugDraws(true);
        this.updateState();
        this.debugUI.canvas.syncLoop();
      }
    };
    row.appendChild(disableBtn);
    this.panel.appendChild(row);

    const row2 = createRow('margin-top:8px');
    const extras = [
      { key: 'entityInfo', label: 'Hover info' },
      { key: 'activeOnly', label: 'Selected only' },
      { key: 'lights', label: 'Lights' },
      { key: 'fpsGraph', label: 'FPS graph' },
    ];
    for (const aid of extras) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn';
      btn.textContent = aid.label;
      btn.onclick = () => this.toggleVisualAid(aid.key);
      this.elements.visualToggles[aid.key] = btn;
      row2.appendChild(btn);
    }
    row2.appendChild(createDivider());
    this.elements.inspectorBtn = document.createElement('button');
    this.elements.inspectorBtn.className = 'debug-ui-btn tool';
    this.elements.inspectorBtn.textContent = '[I] Inspect';
    this.elements.inspectorBtn.title = 'Shift+I — click an entity to inspect';
    this.elements.inspectorBtn.onclick = () => this.debugUI.tools.toggleInspector('entity');
    row2.appendChild(this.elements.inspectorBtn);
    this.panel.appendChild(row2);

    const presets = createRow('margin-top:8px');
    presets.appendChild(createButton('Physics', '', () => this._preset('physics')));
    presets.appendChild(createButton('AI', '', () => this._preset('ai')));
    presets.appendChild(createButton('Perf', '', () => this._preset('perf')));
    this.panel.appendChild(presets);

    return this.panel;
  }

  attach() {
    this.updateState();
  }

  update() { /* toggles are event-driven */ }

  updateState() {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;
    const toggles = this.elements.visualToggles;
    for (const key in VISUAL_FLAG) {
      const btn = toggles[key];
      if (btn) btn.classList.toggle('active', flags.isEnabled(VISUAL_FLAG[key]));
    }
  }

  updateInspectorButtonState(isActive) {
    if (this.elements.inspectorBtn) {
      this.elements.inspectorBtn.classList.toggle('active', isActive);
    }
  }

  _preset(name) {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;
    if (name === 'physics') flags.enablePhysicsDebug();
    else if (name === 'ai') flags.enableAIDebug();
    else flags.enablePerformanceDebug();
    flags.showDebugDraws(true);
    this.updateState();
    this.debugUI.canvas.syncLoop();
    if (name === 'perf') this.debugUI._toggleSection('performance');
  }

  toggleVisualAid(key) {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;

    const method = VISUAL_METHOD[key];
    if (!method || !flags[method]) return;

    flags[method](!flags.isEnabled(VISUAL_FLAG[key]));
    this.updateState();
    this.debugUI.canvas.syncLoop();
  }
}
