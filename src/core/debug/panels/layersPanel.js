// LayersPanel.js — Per-layer controls (visible, alpha, blend, shader, uniforms, y-sort, z-index)

import { createPanel, elem } from '../ui/debugDom.js';
import { FloatingPanel } from '../ui/floatingPanel.js';
import { DEFAULT_LAYERS, LAYER_DENSITY_SOURCE, LAYER_SCALE_MODE, LIGHTING_DEFAULTS } from '../../../util/configDefaults.js';
import { Layer, RESERVED_LOOK_UNIFORMS } from '../../layer.js';
import { DebugPanel } from '../ui/debugPanel.js';

function alphaBySunText(spec) {
  if (typeof spec === 'string') return spec;
  return `${spec.from}..${spec.to}`;
}

/**
 * DBG-4: a layer's read-only details line: what it is and how it draws (its kind, its target's resolution and upsample,
 * its queue size, where a look's density comes from, sun projection, alpha by the sun, a world rect painted once or
 * every frame, GPU particle options).
 */
export function layerDetailsText(layer, meta) {
  const parts = [layer.builtIn ? `${layer.kind} (built-in)` : layer.kind];
  parts.push(`Res ${layer.resolution.toFixed(3)}x ${layer.scaleMode === LAYER_SCALE_MODE.NEAREST ? 'nearest' : 'linear'}`);
  if (meta) {
    if (meta.maxItems > 0) parts.push(`maxItems ${meta.maxItems}`);
    const liquidFun = meta.densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN;
    if (liquidFun || (!layer.builtIn && layer.hasShader)) parts.push(`Density ${liquidFun ? 'liquidFun' : 'sprites'}`);
    if (meta.sunProjected) parts.push('sunProjected');
    if (meta.volumeFloor) parts.push('volumeFloor');
    if (meta.alphaBySun) parts.push(`alphaBySun ${alphaBySunText(meta.alphaBySun)}`);
    if (meta.worldRect) parts.push(`worldRect ${meta.worldRect.width}×${meta.worldRect.height} ${meta.shaderCache ? 'cached' : 'direct'}`);
    if (meta.gpuParticles) {
      let text = 'gpuParticles';
      if (meta.gpuParticles.sortWithEntities) text += ' sortWithEntities';
      if (meta.gpuParticles.pixelSnap) text += ' pixelSnap';
      parts.push(text);
    }
  }
  return parts.join(' · ');
}

/**
 * DBG-4: why a layer's container blend does nothing, or null where it applies. It is the blend of the pieces a layer
 * draws into its render texture: built-in layers have none of their own, and a custom layer without a look draws its
 * pieces straight onto the stage, where they take the Out Blend (unless its config set shader.containerBlend, N-79).
 */
export function containerBlendBlocked(layer, meta) {
  if (layer.builtIn) return 'Built-in layers draw no pieces of their own into a render texture';
  if (!layer.hasShader && meta?.containerBlendSet !== true) {
    return 'No look shader: the layer draws in one pass onto the scene, with its Out Blend';
  }
  return null;
}

/** DBG-4: why a layer's Y-Sort box cannot change, or null where it can (Layer#ySortable). */
export function ySortBlocked(layer) {
  if (layer.ySortable) return null;
  if (!layer.hasRenderQueue) return 'This layer has no sprite queue to sort';
  return 'It started unsorted, so the scene reserved no painter for it: set ySorting: true in its config '
    + '(renderer.ySort for entities) to toggle it here';
}

function setChecked(el, v) {
  if (el.checked !== v && document.activeElement !== el) el.checked = v;
}

function setValue(el, v) {
  if (el.value !== v && document.activeElement !== el) el.value = v;
}

function setDisabled(el, v, title) {
  if (el.disabled !== v) el.disabled = v;
  if (title !== undefined && el.title !== title) el.title = title;
}

function computeSizeLabel(meta) {
  const size = meta?.compute?.size;
  if (!size) return 'canvas';
  if ((size.width | 0) > 0 && (size.height | 0) > 0) return `${size.width}×${size.height}`;
  const scale = size.scale > 0 ? size.scale : 1;
  return scale === 1 ? 'canvas' : `canvas×${scale}`;
}

function fmtUniform(n, step) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  if (step && step < 1) return Number(n).toFixed(2);
  return String(Math.round(n));
}

function fmtLive(floats, entry) {
  if (entry.size === 1) return Number(floats[entry.offset]).toFixed(2);
  const parts = [];
  for (let i = 0; i < entry.size; i++) parts.push(Number(floats[entry.offset + i]).toFixed(1));
  return parts.join(', ');
}

function hasSceneUniforms(layer, meta) {
  if (!layer.hasShader || !meta?.uniformMap) return false;
  return Object.keys(meta.uniformMap).length > 0;
}

const FLOAT_BUTTON_STYLE =
  'font-size:9px;padding:2px 6px;cursor:pointer;background:rgba(255,255,255,0.08);' +
  'color:rgba(255,255,255,0.8);border:1px solid rgba(255,255,255,0.2);border-radius:3px';

/** Default left offset per popup kind so both can open side by side without overlap. */
const FLOAT_LEFT = { uniforms: 12, compute: 326 };
const FLOAT_TITLES = { uniforms: 'Uniforms', compute: 'Compute passes' };

const CONTAINER_BLEND_TITLE = "Blend mode used between this layer's own children, inside its render container";
const Y_SORT_TITLE = 'Sort children by Y position for depth ordering';
const LIGHTING_BLEND_TITLE = "The light's blend onto the scene: multiply lights it; another blend shows the light another way";

// Fixed column widths shared by the header row and every layer row, so
// controls (and critically, Z-index) line up vertically across all layers
// regardless of how long a select's current value or the layer name is.
const ROW_GRID_TEMPLATE = '112px 40px 92px 116px 108px 108px 52px 44px 72px 82px';
const ROW_GRID_STYLE = `display:grid;grid-template-columns:${ROW_GRID_TEMPLATE};column-gap:8px;align-items:center`;

export class LayersPanel extends DebugPanel {
  constructor(debugUI) {
    super(debugUI);
    this.elements = {
      layerControls: {},
      layerRows: {},
      layerUniformInputs: {},
    };
    // DBG-4: the shader options are rebuilt when the scene's loaded sources change (they may finish after attach), not
    // every tick while a scene has none.
    this._shaderSources = null;
    this._shaderSourceCount = -1;
    this._layerOrder = [];
    // Floating popups, one per kind ('uniforms' | 'compute'), independent of each other.
    this._floats = { uniforms: null, compute: null };
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();
    this.panel.appendChild(this._createHeaderRow());
    this._syncRows();
    return this.panel;
  }

  /**
   * DBG-4: a row per layer the scene registered (built-in, engine-made such as volumeShadows, custom, SCREEN, GPU
   * particles), from Layer.getAll(); before a scene's layers exist, the built-in ones.
   */
  _rowNames() {
    if (Layer.initialized) return Layer.getAll().map((l) => l.name);
    const glowSprite = (this.debugUI.scene?.config?.lighting?.lightGlow ?? LIGHTING_DEFAULTS.lightGlow) === 'sorted';
    return Object.keys(DEFAULT_LAYERS).filter((name) => !(name === 'lightGlows' && glowSprite));
  }

  _syncRows() {
    if (!this.panel) return;
    const names = this._rowNames();
    const keep = new Set(names);
    for (const layerName of Object.keys(this.elements.layerRows)) {
      if (!keep.has(layerName)) this._removeLayerRow(layerName);
    }
    for (let i = 0; i < names.length; i++) this._createLayerRow(names[i], this.panel);
    this._sortLayerRows();
  }

  _createHeaderRow() {
    const head = document.createElement('div');
    head.style.cssText =
      `${ROW_GRID_STYLE};margin-bottom:6px;padding-bottom:4px;` +
      'border-bottom:1px solid rgba(255,255,255,0.1);font-size:9px;font-weight:600;' +
      'text-transform:uppercase;letter-spacing:0.4px;color:rgba(255,255,255,0.35)';

    for (const text of ['Layer', 'Vis', 'Alpha', 'Shader', 'Out Blend', 'Cont Blend', 'Y-Sort', 'Z']) {
      const cell = elem('span', '', text);
      head.appendChild(cell);
    }
    const panelsCell = elem('span', '', 'Panels');
    panelsCell.style.gridColumn = '9 / 11';
    head.appendChild(panelsCell);

    return head;
  }

  // ------- lifecycle -------

  attach() {
    this._shaderSources = null;
    this._shaderSourceCount = -1;
    this._closeFloat('uniforms');
    this._closeFloat('compute');
    this._updateLayersAvailability();
  }

  update() {
    this._updateLayersSection();
    // Shader assets may finish loading after attach: the options follow when the loaded set changes.
    const sources = this.debugUI.scene?._loadedShaderSources || null;
    const count = sources ? Object.keys(sources).length : 0;
    if (sources !== this._shaderSources || count !== this._shaderSourceCount) this._updateLayersAvailability();
    else this._syncControls();
  }

  // ------- layer row -------

  _removeLayerRow(layerName) {
    if (this._floats.uniforms?.layerName === layerName) this._closeFloat('uniforms');
    if (this._floats.compute?.layerName === layerName) this._closeFloat('compute');
    const wrapper = this.elements.layerRows[layerName];
    if (wrapper?.parentNode) wrapper.parentNode.removeChild(wrapper);
    delete this.elements.layerRows[layerName];
    delete this.elements.layerControls[layerName];
    delete this.elements.layerUniformInputs[layerName];
    const order = this._layerOrder;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === layerName) {
        order.splice(i, 1);
        break;
      }
    }
  }

  _createLayerRow(layerName, panel) {
    if (this.elements.layerRows[layerName]) return;

    const selectStyle =
      'width:100%;font-size:10px;padding:2px 4px;cursor:pointer;background:rgba(0,0,0,0.5);color:white;' +
      'border:1px solid rgba(255,255,255,0.3);border-radius:3px;overflow:hidden;text-overflow:ellipsis';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.04);padding-bottom:6px';

    const row = document.createElement('div');
    row.style.cssText = ROW_GRID_STYLE;

    const customLayer = Layer.initialized ? Layer.get(layerName) : null;

    // Layer name
    const label = document.createElement('span');
    label.style.cssText = 'font-weight:bold;color:rgba(255,255,255,0.85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = layerName;
    label.title = layerName;
    // DBG-1: the castedShadows layer has no picture of its own; its row stands for the shadow maps' shadows.
    if (layerName === 'castedShadows') {
      label.title = 'castedShadows: the shadows in the light pass (the sun\'s and the lamps\' shadow maps)';
    }
    row.appendChild(label);

    // Visible
    const visibleCb = document.createElement('input');
    visibleCb.type = 'checkbox';
    visibleCb.className = 'debug-ui-checkbox';
    visibleCb.checked = true;
    visibleCb.title = 'Show or hide this layer';
    visibleCb.onchange = () => {
      const l = Layer.get(layerName);
      if (l) l.visible = visibleCb.checked;
    };
    row.appendChild(visibleCb);

    // Alpha
    const alphaCont = document.createElement('div');
    alphaCont.style.cssText = 'display:flex;align-items:center;gap:4px;min-width:0';
    const alphaSlider = document.createElement('input');
    alphaSlider.type = 'range'; alphaSlider.min = '0'; alphaSlider.max = '100'; alphaSlider.value = '100';
    alphaSlider.className = 'debug-ui-range';
    alphaSlider.style.cssText = 'flex:1;min-width:0';
    alphaSlider.title = 'Layer opacity';
    const alphaVal = document.createElement('span');
    alphaVal.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.6);min-width:28px;text-align:right;flex:none';
    alphaVal.textContent = '100%';
    alphaSlider.oninput = () => {
      alphaVal.textContent = alphaSlider.value + '%';
      const l = Layer.get(layerName);
      if (l) l.alpha = parseInt(alphaSlider.value) / 100;
    };
    alphaCont.appendChild(alphaSlider);
    alphaCont.appendChild(alphaVal);
    row.appendChild(alphaCont);

    // Shader (custom layers only — runtime swap / none for live testing)
    const shaderSelect = document.createElement('select');
    shaderSelect.style.cssText = selectStyle;
    shaderSelect.disabled = true;
    shaderSelect.title = 'Fragment shader assigned to this layer (custom WebGPU layers only)';
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
    shaderSelect.appendChild(noneOpt);
    shaderSelect.onchange = () => this._setLayerShader(layerName, shaderSelect.value);
    row.appendChild(shaderSelect);

    // Output blend
    const blendSelect = this._buildBlendSelect(selectStyle, Layer._BLEND_MODE_STRINGS);
    blendSelect.title = "Blend mode used when compositing this layer's render target onto the scene";
    blendSelect.value = customLayer
      ? (Layer._BLEND_MODE_STRINGS[Layer._blendModeId[customLayer.id]] || 'normal')
      : (Layer._BLEND_MODE_STRINGS[DEFAULT_LAYERS[layerName]?.blendMode] || 'normal');
    blendSelect.onchange = () => {
      const l = Layer.get(layerName);
      if (l) l.blendMode = blendSelect.value;
    };
    if (layerName === 'lighting') blendSelect.title = LIGHTING_BLEND_TITLE;
    row.appendChild(blendSelect);

    // Container blend (DBG-4: every layer shows its own value; disabled, with the reason, where it cannot apply)
    const cBlendSelect = this._buildBlendSelect(selectStyle, Layer._BLEND_MODE_STRINGS);
    cBlendSelect.title = CONTAINER_BLEND_TITLE;
    cBlendSelect.value = customLayer ? customLayer.containerBlendMode : 'normal';
    cBlendSelect.disabled = true;
    cBlendSelect.onchange = () => {
      const l = Layer.get(layerName);
      if (l) l.containerBlendMode = cBlendSelect.value;
    };
    row.appendChild(cBlendSelect);

    // Y-Sort (DBG-4: through the Layer setter; a layer that cannot sort at run time keeps the box disabled)
    const ySortCb = document.createElement('input');
    ySortCb.type = 'checkbox';
    ySortCb.className = 'debug-ui-checkbox';
    ySortCb.checked = customLayer ? customLayer.ySorting : false;
    ySortCb.disabled = true;
    ySortCb.title = Y_SORT_TITLE;
    ySortCb.onchange = () => {
      const l = Layer.get(layerName);
      if (l && l.ySortable) l.ySorting = ySortCb.checked;
    };
    row.appendChild(ySortCb);

    // Z-Index
    const zInput = document.createElement('input');
    zInput.type = 'number';
    zInput.value = customLayer ? Layer._zIndex[customLayer.id] : (DEFAULT_LAYERS[layerName]?.zIndex ?? 0);
    zInput.style.cssText =
      'width:100%;font-size:10px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
      'border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    zInput.title = 'Z-index — draw order relative to other layers';
    zInput.onchange = () => {
      const l = Layer.get(layerName);
      const z = Number(zInput.value);
      if (l && Number.isFinite(z)) l.zIndex = z;
    };
    // DBG-4: the rows re-sort once the field loses focus; moving the row while it is edited would drop the focus.
    zInput.onblur = () => this._sortLayerRows();
    row.appendChild(zInput);

    // Uniforms popup — only shown when the layer has a shader with uniforms
    const uniformsBtn = elem('button', '', 'Uniforms');
    uniformsBtn.style.cssText = FLOAT_BUTTON_STYLE;
    uniformsBtn.style.display = 'none';
    uniformsBtn.title = 'Open the uniforms panel for this layer';
    uniformsBtn.onclick = () => this._toggleFloat('uniforms', layerName);
    row.appendChild(uniformsBtn);

    // Compute passes popup — only shown for compute layers
    const computeBtn = elem('button', '', 'Compute');
    computeBtn.style.cssText = FLOAT_BUTTON_STYLE;
    computeBtn.style.display = 'none';
    computeBtn.title = 'Open the compute passes panel for this layer';
    computeBtn.onclick = () => this._toggleFloat('compute', layerName);
    row.appendChild(computeBtn);

    wrapper.appendChild(row);

    // Read-only details line (DBG-4: kind, resolution, queue, density, sun, world rect, GPU particles; then the compute
    // source) — kept out of the grid above so it can't push Z / the panel buttons out of alignment with other rows;
    // dimmer color marks it as not editable.
    const metaRow = document.createElement('div');
    metaRow.style.cssText =
      'display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;padding-left:2px;' +
      'font-size:9px;color:rgba(255,255,255,0.35)';

    const detailsVal = document.createElement('span');
    detailsVal.title = 'What the layer is and how it draws (read-only)';
    detailsVal.textContent = customLayer
      ? layerDetailsText(customLayer, Layer._metadata?.layers?.[customLayer.id])
      : (DEFAULT_LAYERS[layerName]?.kind ?? '');
    metaRow.appendChild(detailsVal);

    let computeVal = null;
    if (customLayer?.compute) {
      computeVal = document.createElement('span');
      computeVal.title = 'Compute shader driving this layer — source · live feed / max bodies · target size · backend (read-only)';
      metaRow.appendChild(computeVal);
    }

    wrapper.appendChild(metaRow);
    panel.appendChild(wrapper);
    wrapper.dataset.layerName = layerName;

    this.elements.layerControls[layerName] = {
      available: true,
      visible: visibleCb, alpha: alphaSlider, alphaValue: alphaVal,
      blendMode: blendSelect, containerBlend: cBlendSelect,
      shader: shaderSelect, ySorting: ySortCb,
      details: detailsVal, zIndex: zInput, computeVal, uniformsBtn, computeBtn,
    };
    this.elements.layerRows[layerName] = wrapper;
    this._layerOrder.push(layerName);
  }

  // ------- floating popups (uniforms / compute, independent) -------

  _toggleFloat(kind, layerName) {
    if (this._floats[kind]?.layerName === layerName) {
      this._closeFloat(kind);
      return;
    }
    this._openFloat(kind, layerName);
  }

  _openFloat(kind, layerName) {
    this._closeFloat(kind);

    const panel = new FloatingPanel({
      title: `${layerName} — ${FLOAT_TITLES[kind]}`,
      left: FLOAT_LEFT[kind],
      top: 48,
      width: 300,
      onClose: () => {
        this._floats[kind] = null;
        if (kind === 'uniforms') delete this.elements.layerUniformInputs[layerName];
      },
    });
    panel.mount();

    this._floats[kind] = { panel, layerName };

    if (kind === 'uniforms') this._populateUniformsFloat(layerName);
    else this._populateComputeFloat(layerName);
  }

  _closeFloat(kind) {
    this._floats[kind]?.panel.close();
  }

  _sectionTitle(text) {
    const el = elem('div', '', text);
    el.style.cssText =
      'font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:0.6px;' +
      'color:rgba(255,255,255,0.35);margin:8px 0 3px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:2px';
    return el;
  }

  _populateUniformsFloat(layerName) {
    const f = this._floats.uniforms;
    if (!f || f.layerName !== layerName) return;
    const block = f.panel.body;
    const layer = Layer.initialized ? Layer.get(layerName) : null;
    if (!layer) { block.textContent = 'Layer not initialized'; return; }

    const meta = Layer._metadata?.layers?.[layer.id];
    block.innerHTML = '';
    this.elements.layerUniformInputs[layerName] = {};

    if (!hasSceneUniforms(layer, meta)) {
      block.innerHTML = '<span style="color:rgba(255,255,255,0.3)">No shader uniforms</span>';
      return;
    }
    this._buildUniformsSection(block, layer, meta, layerName);
  }

  _populateComputeFloat(layerName) {
    const f = this._floats.compute;
    if (!f || f.layerName !== layerName) return;
    const block = f.panel.body;
    const layer = Layer.initialized ? Layer.get(layerName) : null;
    if (!layer) { block.textContent = 'Layer not initialized'; return; }

    const meta = Layer._metadata?.layers?.[layer.id];
    block.innerHTML = '';
    if (!layer.compute) {
      block.innerHTML = '<span style="color:rgba(255,255,255,0.3)">Not a compute layer</span>';
      return;
    }
    this._buildComputeSection(block, meta);
  }

  _buildUniformsSection(block, layer, meta, layerName) {
    const hints = meta.uniformHints || {};
    const floats = Layer._uniformFloats[layer.id];
    const sceneNames = [];
    const engineNames = [];
    for (const uName of Object.keys(meta.uniformMap)) {
      (uName in RESERVED_LOOK_UNIFORMS ? engineNames : sceneNames).push(uName);
    }

    if (sceneNames.length) {
      for (const uName of sceneNames) {
        const entry = meta.uniformMap[uName];
        const row = this._uniformRow(layer, uName, entry, hints[uName] || {}, floats);
        block.appendChild(row.node);
        this.elements.layerUniformInputs[layerName][uName] = row;
      }
    }
    if (engineNames.length) {
      block.appendChild(this._sectionTitle('Engine (auto-fed)'));
      for (const uName of engineNames) {
        const entry = meta.uniformMap[uName];
        const row = this._engineUniformRow(uName, entry);
        block.appendChild(row.node);
        this.elements.layerUniformInputs[layerName][uName] = row;
      }
    }
  }

  _uniformRow(layer, uName, entry, hint, floats) {
    const label = hint.label || uName;

    if (hint.widget === 'check') {
      const node = document.createElement('label');
      node.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer';
      if (hint.tip) node.title = hint.tip;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'debug-ui-checkbox';
      cb.checked = (floats ? floats[entry.offset] : 0) > 0.5;
      cb.onchange = () => layer.setUniform(uName, cb.checked ? 1 : 0);
      const span = elem('span', '', label);
      node.appendChild(cb);
      node.appendChild(span);
      return { node, kind: 'check', entry, hint, input: cb };
    }

    if (typeof hint.min === 'number' && typeof hint.max === 'number' && entry.size === 1) {
      const step = hint.step || 0.01;
      const read = () => {
        let v = floats ? floats[entry.offset] : 0;
        return hint.negate ? -v : v;
      };
      const node = document.createElement('div');
      node.style.cssText = 'display:grid;grid-template-columns:110px 1fr 44px;gap:6px;align-items:center;margin:2px 0';
      if (hint.tip) node.title = hint.tip;
      const name = elem('span', '', label);
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'debug-ui-range';
      input.min = String(hint.min);
      input.max = String(hint.max);
      input.step = String(step);
      input.value = String(read());
      input.style.cssText = 'width:100%';
      const val = document.createElement('span');
      val.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;color:rgba(255,255,255,0.85)';
      val.textContent = fmtUniform(read(), step);
      input.oninput = () => {
        const n = Number(input.value);
        val.textContent = fmtUniform(n, step);
        layer.setUniform(uName, hint.negate ? -n : n);
      };
      node.appendChild(name);
      node.appendChild(input);
      node.appendChild(val);
      return { node, kind: 'slider', entry, hint, input, valEl: val };
    }

    // Fallback: one number input per component
    const node = document.createElement('div');
    node.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';
    if (hint.tip) node.title = hint.tip;
    const name = document.createElement('span');
    name.style.cssText = 'min-width:110px';
    name.textContent = label;
    node.appendChild(name);
    const inputs = [];
    for (let i = 0; i < entry.size; i++) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = String(hint.step || 0.01);
      inp.style.cssText = 'width:60px;font-size:10px;padding:1px 4px;background:rgba(0,0,0,0.5);color:#fbbf24;border:1px solid rgba(255,255,255,0.2);border-radius:3px';
      const currentVal = floats ? floats[entry.offset + i] : 0;
      inp.value = parseFloat(currentVal.toFixed(4));
      inp.onchange = () => {
        if (entry.size === 1) {
          layer.setUniform(uName, parseFloat(inp.value));
        } else {
          layer.setUniform(uName, inputs.map((x) => parseFloat(x.value)));
        }
      };
      inputs.push(inp);
      node.appendChild(inp);
    }
    return { node, kind: 'number', entry, hint, inputs };
  }

  _engineUniformRow(uName, entry) {
    const node = document.createElement('div');
    node.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;opacity:0.6';
    node.title = 'Engine-fed every frame (read-only)';
    const name = document.createElement('span');
    name.style.cssText = 'min-width:110px;color:rgba(255,255,255,0.4)';
    name.textContent = uName;
    const val = document.createElement('span');
    val.style.cssText = 'font-variant-numeric:tabular-nums;color:rgba(255,255,255,0.6)';
    node.appendChild(name);
    node.appendChild(val);
    return { node, kind: 'engine', entry, valEl: val };
  }

  _buildComputeSection(block, meta) {
    const compute = meta?.compute;
    if (!compute) return;
    const passes = compute.passes || [];
    for (const p of passes) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:baseline;margin:1px 0;font-family:monospace;font-size:10px';
      const name = document.createElement('span');
      name.style.color = 'rgba(255,255,255,0.75)';
      name.textContent = p.entry;
      row.appendChild(name);
      const tags = [];
      if (p.source) tags.push(p.source);
      if (p.swap && p.swap.length) tags.push('swap ' + p.swap.join(','));
      if (p.iterate) tags.push('×' + p.iterate);
      if (p.when) tags.push('when ' + p.when);
      if (p.workgroup) tags.push('wg ' + p.workgroup.join('x'));
      if (p.dispatchFrom) tags.push('n=' + p.dispatchFrom);
      if (tags.length) {
        const t = document.createElement('span');
        t.style.cssText = 'color:rgba(255,255,255,0.35);font-size:9px';
        t.textContent = tags.join(' · ');
        row.appendChild(t);
      }
      block.appendChild(row);
    }
  }

  // ------- tick update -------

  _updateLayersSection() {
    if (!Layer.initialized || !this.panel) return;

    for (const [layerName, inputMap] of Object.entries(this.elements.layerUniformInputs)) {
      const layer = Layer.get(layerName);
      if (!layer || !Layer._uniformFloats[layer.id]) continue;
      const floats = Layer._uniformFloats[layer.id];

      for (const row of Object.values(inputMap)) {
        const entry = row.entry;
        if (!entry) continue;

        if (row.kind === 'engine') {
          row.valEl.textContent = fmtLive(floats, entry);
          continue;
        }
        if (row.kind === 'check') {
          if (document.activeElement !== row.input) {
            row.input.checked = floats[entry.offset] > 0.5;
          }
          continue;
        }
        if (row.kind === 'slider') {
          if (document.activeElement === row.input) continue;
          let v = floats[entry.offset];
          if (row.hint.negate) v = -v;
          row.input.value = String(v);
          row.valEl.textContent = fmtUniform(v, row.hint.step || 0.01);
          continue;
        }
        for (let i = 0; i < row.inputs.length; i++) {
          if (document.activeElement === row.inputs[i]) continue;
          const display = parseFloat(floats[entry.offset + i].toFixed(4));
          if (parseFloat(row.inputs[i].value) !== display) row.inputs[i].value = display;
        }
      }
    }
  }

  /**
   * The rows, which ones show, and the shader options: on attach and when the scene's loaded shader sources change.
   * The controls' values follow the layers every tick in _syncControls.
   */
  _updateLayersAvailability() {
    const scene = this.debugUI.scene;
    if (!scene || !this.elements.layerRows) return;
    const sources = scene._loadedShaderSources || null;
    this._shaderSources = sources;
    this._shaderSourceCount = sources ? Object.keys(sources).length : 0;
    const available = this._getAvailableLayers(scene.config);

    this._syncRows();

    // Tag-at-load: compute-only WGSL assets never appear as look-shader choices.
    const computeNames = scene._computeShaderNames || null;
    const shaderNames = sources ? Object.keys(sources).filter((n) => !computeNames?.has(n)) : [];

    for (const [layerName, wrapper] of Object.entries(this.elements.layerRows)) {
      const isAvailable = available.has(layerName);
      const controls = this.elements.layerControls[layerName];
      controls.available = isAvailable;

      // DECALS / LIGHTING / CASTED_SHADOWS don't exist at all unless the scene
      // config enables them — hide the row instead of just graying it out.
      wrapper.style.display = isAvailable ? '' : 'none';
      controls.uniformsBtn.disabled = !isAvailable;
      controls.computeBtn.disabled = !isAvailable;

      const layer = Layer.initialized ? Layer.get(layerName) : null;
      // Shader RT layers (incl. liquidFun density, no sprite queue) stay editable.
      const canEditShader = !!(isAvailable && layer && !layer.builtIn && (layer.hasRenderQueue || layer.hasShader));
      const shaderSelect = controls.shader;
      shaderSelect.disabled = !canEditShader;
      this._syncShaderOptions(shaderSelect, shaderNames);

      if (layer) {
        const meta = Layer._metadata?.layers?.[layer.id];
        if (document.activeElement !== shaderSelect) {
          shaderSelect.value = meta?.shaderName || '';
        }
        // DX-LAYERPASSES: a look in several passes has no one fragment to swap.
        const inPasses = !!meta?.shaderEarlier;
        if (shaderSelect.disabled !== inPasses) shaderSelect.disabled = inPasses;
        controls.uniformsBtn.style.display = (isAvailable && hasSceneUniforms(layer, meta)) ? '' : 'none';
        controls.computeBtn.style.display = (isAvailable && !!layer.compute) ? '' : 'none';
        if (controls.computeVal && layer.compute) {
          const srcName = meta?.compute?.passes?.[0]?.source || meta?.shaderName || 'wgsl';
          const maxB = meta?.maxBodies || 0;
          controls.computeVal.textContent = `${srcName} · maxBodies ${maxB} · ${computeSizeLabel(meta)} · WebGPU`;
        }
      } else {
        controls.uniformsBtn.style.display = 'none';
        controls.computeBtn.style.display = 'none';
      }
    }
    this._syncControls();
  }

  /**
   * DBG-4: every control shows its layer's value, so a change made by game code (layer.alpha, visible, blendMode,
   * containerBlendMode, ySorting, zIndex, resolution) shows in the panel. Each write is compared first, and a control
   * being edited (focused) is left alone.
   */
  _syncControls() {
    if (!Layer.initialized || !this.panel) return;
    let zMoved = false;
    for (const [layerName, controls] of Object.entries(this.elements.layerControls)) {
      const layer = Layer.get(layerName);
      if (!layer) continue;
      const meta = Layer._metadata?.layers?.[layer.id];
      const isAvailable = controls.available !== false;

      setDisabled(controls.visible, !isAvailable);
      setChecked(controls.visible, layer.visible);

      setDisabled(controls.alpha, !isAvailable);
      if (document.activeElement !== controls.alpha) {
        const pct = String(Math.round(layer.alpha * 100));
        if (controls.alpha.value !== pct) controls.alpha.value = pct;
        const text = pct + '%';
        if (controls.alphaValue.textContent !== text) controls.alphaValue.textContent = text;
      }

      setDisabled(controls.blendMode, !isAvailable, layerName === 'lighting' ? LIGHTING_BLEND_TITLE : undefined);
      setValue(controls.blendMode, layer.blendMode);

      const cBlocked = containerBlendBlocked(layer, meta);
      setDisabled(controls.containerBlend, !isAvailable || cBlocked !== null, cBlocked ?? CONTAINER_BLEND_TITLE);
      setValue(controls.containerBlend, layer.containerBlendMode);

      const yBlocked = ySortBlocked(layer);
      setDisabled(controls.ySorting, !isAvailable || yBlocked !== null, yBlocked ?? Y_SORT_TITLE);
      setChecked(controls.ySorting, layer.ySorting);

      setDisabled(controls.zIndex, !isAvailable);
      const z = String(layer.zIndex);
      if (controls.zIndex.value !== z && document.activeElement !== controls.zIndex) {
        controls.zIndex.value = z;
        zMoved = true;
      }

      const details = layerDetailsText(layer, meta);
      if (controls.details.textContent !== details) controls.details.textContent = details;
    }
    if (zMoved && !this._editingZ()) this._sortLayerRows();
  }

  _editingZ() {
    const active = document.activeElement;
    if (!active) return false;
    for (const controls of Object.values(this.elements.layerControls)) {
      if (controls.zIndex === active) return true;
    }
    return false;
  }

  _syncShaderOptions(shaderSelect, shaderNames) {
    if (!shaderSelect) return;
    const prev = shaderSelect.value;
    const expected = 1 + shaderNames.length;
    let needsRebuild = shaderSelect.options.length !== expected;
    if (!needsRebuild) {
      for (let i = 0; i < shaderNames.length; i++) {
        if (shaderSelect.options[i + 1]?.value !== shaderNames[i]) {
          needsRebuild = true;
          break;
        }
      }
    }
    if (!needsRebuild) return;

    shaderSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    shaderSelect.appendChild(noneOpt);
    for (let i = 0; i < shaderNames.length; i++) {
      const opt = document.createElement('option');
      opt.value = shaderNames[i];
      opt.textContent = shaderNames[i];
      shaderSelect.appendChild(opt);
    }
    shaderSelect.value = prev;
  }

  _getAvailableLayers(config) {
    const available = new Set(['entities']);
    if (Layer.initialized && Layer.get('lightGlows')) available.add('lightGlows');
    if (config.particle?.decals) available.add('decals');
    if (config.lighting?.enabled) {
      available.add('lighting');
      if (config.lighting?.shadowsEnabled) available.add('castedShadows');
    }
    if (Layer.initialized) {
      for (const l of Layer.getCustomLayers()) available.add(l.name);
    }
    return available;
  }

  /** A row's z: its layer's (the setter wrote what the field holds), else the built-in default before a scene loads. */
  _layerZ(name) {
    const layer = Layer.initialized ? Layer.get(name) : null;
    if (layer && Layer._zIndex) return Layer._zIndex[layer.id];
    return DEFAULT_LAYERS[name]?.zIndex ?? 0;
  }

  /** Photoshop-style: highest z-index at the top of the list. */
  _sortLayerRows() {
    const panel = this.panel;
    if (!panel) return;
    const header = panel.firstChild;
    const names = this._layerOrder;
    names.sort((a, b) => {
      const dz = this._layerZ(b) - this._layerZ(a);
      return dz !== 0 ? dz : (a < b ? -1 : a > b ? 1 : 0);
    });
    let child = header ? header.nextSibling : panel.firstChild;
    let dirty = false;
    for (let i = 0; i < names.length; i++) {
      if (this.elements.layerRows[names[i]] !== child) {
        dirty = true;
        break;
      }
      child = child ? child.nextSibling : null;
    }
    if (!dirty) return;
    for (let i = 0; i < names.length; i++) {
      const el = this.elements.layerRows[names[i]];
      if (el) panel.appendChild(el);
    }
  }

  _setLayerShader(layerName, shaderName) {
    const scene = this.debugUI.scene;
    if (!scene?.workers?.renderer) return;
    const layer = Layer.get(layerName);
    if (!layer || layer.builtIn || (!layer.hasRenderQueue && !layer.hasShader)) return;

    const name = shaderName || '';
    const source = name ? scene._loadedShaderSources?.[name] : null;
    if (name && !source) {
      console.warn(`LayersPanel: shader "${name}" not loaded`);
      return;
    }

    const meta = Layer._metadata?.layers?.[layer.id];
    if (meta) {
      meta.shaderName = name || null;
      meta.shaderFragment = source || null;
      // Keep hasShader / uniforms UI — (none) is RT bypass, not "no layer shader pipeline".
      if (source) meta.hasShader = true;
    }
    if (source && Layer._hasShader) Layer._hasShader[layer.id] = 1;

    scene.workers.renderer.postMessage({
      msg: 'setLayerProps',
      layer: layerName,
      shader: name,
      shaderFragment: source || null,
    });

    if (this._floats.uniforms?.layerName === layerName) this._populateUniformsFloat(layerName);
  }

  _buildBlendSelect(style, modes) {
    const sel = document.createElement('select'); sel.style.cssText = style;
    for (const mode of modes) {
      const opt = document.createElement('option'); opt.value = mode; opt.textContent = mode;
      sel.appendChild(opt);
    }
    return sel;
  }
}
