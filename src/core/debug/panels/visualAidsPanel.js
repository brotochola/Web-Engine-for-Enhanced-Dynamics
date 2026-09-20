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

const TIP_PHYSICS = 'Requires config.physics.enabled';
const TIP_SPATIAL = 'Requires spatial.numberOfSpatialWorkers > 0';
const TIP_LIGHTING = 'Requires config.lighting.enabled';
const TIP_JOINTS = 'Requires config.physics.enabled and physics.maxJoints > 0';

const VISUAL_CAP = {
  colliders: 'physics',
  velocity: 'physics',
  acceleration: 'physics',
  sleepingEntities: 'physics',
  joints: 'joints',
  neighbors: 'spatial',
  spatialGrid: 'spatial',
  sleepingCells: 'spatial',
  entityInfo: 'spatial',
  lights: 'lighting',
};

const VISUAL_TIP = {
  physics: TIP_PHYSICS,
  spatial: TIP_SPATIAL,
  lighting: TIP_LIGHTING,
  joints: TIP_JOINTS,
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
      { key: 'colliders', label: 'Colliders' },
      { key: 'velocity', label: 'Velocity' },
      { key: 'acceleration', label: 'Accel' },
      { key: 'neighbors', label: 'Neighbors' },
      { key: 'spatialGrid', label: 'Grid' },
      { key: 'entityIndices', label: 'Indices' },
      { key: 'debugDraws', label: 'Draws' },
      { key: 'sleepingEntities', label: 'Sleeping' },
      { key: 'sleepingCells', label: 'Sleep Cells' },
      { key: 'joints', label: 'Joints' },
      { key: 'entityOrigins', label: 'Origins' },
    ];

    for (const aid of visualAids) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn';
      btn.textContent = aid.label;
      if (aid.key === 'acceleration') {
        btn.title = 'Impulse applied this step (Box2D clears ax/ay after integrate)';
      }
      btn.onclick = () => this.toggleVisualAid(aid.key);
      this.elements.visualToggles[aid.key] = btn;
      row.appendChild(btn);
    }

    const disableBtn = document.createElement('button');
    disableBtn.className = 'debug-ui-btn danger';
    disableBtn.textContent = 'Off';
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
    this.elements.inspectorBtn.textContent = 'Inspect';
    this.elements.inspectorBtn.title = 'Click an entity to inspect';
    this.elements.inspectorBtn.onclick = () => this.debugUI.tools.toggleInspector('entity');
    row2.appendChild(this.elements.inspectorBtn);
    this.panel.appendChild(row2);

    const presets = createRow('margin-top:8px');
    this.elements.presetPhysics = createButton('Physics', '', () => this._preset('physics'));
    this.elements.presetAI = createButton('AI', '', () => this._preset('ai'));
    this.elements.presetPerf = createButton('Perf', '', () => this._preset('perf'));
    presets.appendChild(this.elements.presetPhysics);
    presets.appendChild(this.elements.presetAI);
    presets.appendChild(this.elements.presetPerf);
    this.panel.appendChild(presets);

    return this.panel;
  }

  attach() {
    this._applyCaps();
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

  _applyCaps() {
    const caps = this.debugUI.caps || {};
    const toggles = this.elements.visualToggles;
    for (const key in VISUAL_CAP) {
      const btn = toggles[key];
      if (!btn) continue;
      const cap = VISUAL_CAP[key];
      const on = !!caps[cap];
      btn.disabled = !on;
      if (!on) {
        btn.title = VISUAL_TIP[cap];
        btn.classList.remove('active');
      } else if (key === 'acceleration') {
        btn.title = 'Impulse applied this step (Box2D clears ax/ay after integrate)';
      } else {
        btn.title = '';
      }
    }

    if (this.elements.presetPhysics) {
      this.elements.presetPhysics.disabled = !caps.physics;
      this.elements.presetPhysics.title = caps.physics ? '' : TIP_PHYSICS;
    }
    if (this.elements.presetAI) {
      this.elements.presetAI.disabled = !caps.spatial;
      this.elements.presetAI.title = caps.spatial ? '' : TIP_SPATIAL;
    }
  }

  _aidEnabled(key) {
    const cap = VISUAL_CAP[key];
    if (!cap) return true;
    return !!(this.debugUI.caps && this.debugUI.caps[cap]);
  }

  _preset(name) {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;
    const caps = this.debugUI.caps || {};
    if (name === 'physics') {
      if (!caps.physics) return;
      flags.enablePhysicsDebug();
    } else if (name === 'ai') {
      if (!caps.spatial) return;
      flags.enableAIDebug();
    } else {
      flags.enable({
        fpsGraph: true,
        spatialGrid: !!caps.spatial,
      });
    }
    flags.showDebugDraws(true);
    this.updateState();
    this.debugUI.canvas.syncLoop();
    if (name === 'perf') this.debugUI._toggleSection('performance');
  }

  toggleVisualAid(key) {
    if (!this._aidEnabled(key)) return;
    const flags = this.debugUI.debugFlags;
    if (!flags) return;

    const method = VISUAL_METHOD[key];
    if (!method || !flags[method]) return;

    flags[method](!flags.isEnabled(VISUAL_FLAG[key]));
    this.updateState();
    this.debugUI.canvas.syncLoop();
  }
}
