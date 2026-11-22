// VisualAidsPanel.js — Toggle buttons for debug flags (colliders, velocity, etc.)

import { DEBUG_FLAG_KEYS } from '../debugFlags.js';
import { createPanel, createRow, createDivider, createButton, elem } from '../ui/debugDom.js';
import { DebugPanel } from '../ui/debugPanel.js';

const TIP_PHYSICS = 'Requires config.physics.enabled';
const TIP_SPATIAL = 'Requires spatial.numberOfSpatialWorkers > 0';
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
};

const AID_TITLE = {
  acceleration: 'Impulse applied this step (Box2D clears ax/ay after integrate)',
  meshes: 'Triangle edges. Magenta = authored mesh, cyan = per-vertex UVs, orange = collider fill',
};

const VISUAL_TIP = {
  physics: TIP_PHYSICS,
  spatial: TIP_SPATIAL,
  joints: TIP_JOINTS,
};

export class VisualAidsPanel extends DebugPanel {
  constructor(debugUI) {
    super(debugUI);
    this.elements = { visualToggles: {} };
  }

  create() {
    this.panel = createPanel();

    const row = createRow();
    const visualAids = [
      { key: 'colliders', label: 'Colliders' },
      { key: 'meshes', label: 'Meshes' },
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

    for (const aid of visualAids) row.appendChild(this._toggleButton(aid));

    const disableBtn = elem('button', 'debug-ui-btn danger', 'Off');
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
      { key: 'fpsGraph', label: 'FPS graph' },
    ];
    for (const aid of extras) row2.appendChild(this._toggleButton(aid));
    row2.appendChild(createDivider());
    this.elements.inspectorBtn = elem('button', 'debug-ui-btn tool', 'Inspect');
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

  /** A flag's toggle button, kept in elements.visualToggles by its key. */
  _toggleButton(aid) {
    const btn = createButton(aid.label, '', () => this.toggleVisualAid(aid.key));
    const title = AID_TITLE[aid.key];
    if (title) btn.title = title;
    this.elements.visualToggles[aid.key] = btn;
    return btn;
  }

  attach() {
    this._applyCaps();
    this.updateState();
  }


  updateState() {
    const flags = this.debugUI.debugFlags;
    if (!flags) return;
    const toggles = this.elements.visualToggles;
    for (const key in DEBUG_FLAG_KEYS) {
      const btn = toggles[key];
      if (btn) btn.classList.toggle('active', flags.isEnabled(DEBUG_FLAG_KEYS[key]));
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
      } else {
        btn.title = AID_TITLE[key] || '';
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

    const flag = DEBUG_FLAG_KEYS[key];
    if (flag === undefined) return;

    flags.setFlag(flag, !flags.isEnabled(flag));
    this.updateState();
    this.debugUI.canvas.syncLoop();
  }
}
