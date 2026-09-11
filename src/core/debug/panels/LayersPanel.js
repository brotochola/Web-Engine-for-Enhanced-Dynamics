// LayersPanel.js — Per-layer controls (visible, alpha, blend, shader, uniforms, y-sort, z-index)

import { createPanel } from '../ui/DebugDOM.js';
import { DEFAULT_LAYERS } from '../../ConfigDefaults.js';
import { Layer, RESERVED_LOOK_UNIFORMS } from '../../Layer.js';

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

export class LayersPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {
      layerControls: {},
      layerRows: {},
      layerUniformInputs: {},
    };
    this.panel = null;
    this._shaderOptionsSynced = false;
    // Floating details popup (uniforms + compute passes), one at a time.
    this._float = null;
    this._floatBody = null;
    this._floatLayer = null;
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();

    for (const layerName of Object.keys(DEFAULT_LAYERS)) {
      this._createLayerRow(layerName, this.panel);
    }

    return this.panel;
  }

  // ------- lifecycle -------

  attach() {
    this._shaderOptionsSynced = false;
    this._closeLayerFloat();
    this._updateLayersAvailability();
  }

  update() {
    this._updateLayersSection();
    // Shader assets may finish loading after first attach — refresh options once ready.
    const sources = this.debugUI.scene?._loadedShaderSources;
    if (sources && !this._shaderOptionsSynced) {
      this._updateLayersAvailability();
      if (Object.keys(sources).length > 0) this._shaderOptionsSynced = true;
    }
  }

  // ------- layer row -------

  _removeLayerRow(layerName) {
    if (this._floatLayer === layerName) this._closeLayerFloat();
    const wrapper = this.elements.layerRows[layerName];
    if (wrapper?.parentNode) wrapper.parentNode.removeChild(wrapper);
    delete this.elements.layerRows[layerName];
    delete this.elements.layerControls[layerName];
    delete this.elements.layerUniformInputs[layerName];
  }

  _createLayerRow(layerName, panel) {
    if (this.elements.layerRows[layerName]) return;

    const selectStyle = 'font-size:10px;padding:2px 4px;cursor:pointer;background:rgba(0,0,0,0.5);color:white;border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    const lblStyle = 'font-size:10px;color:rgba(255,255,255,0.7)';
    const cellStyle = 'display:flex;align-items:center;gap:4px';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.04);padding-bottom:4px';

    const row = document.createElement('div');
    row.className = 'debug-ui-row';
    row.style.cssText = 'gap:10px;align-items:center;margin-bottom:2px';

    const label = document.createElement('span');
    label.className = 'debug-ui-stat';
    label.style.cssText = 'min-width:110px;font-weight:bold';
    label.textContent = layerName;
    row.appendChild(label);

    // Visible
    const visibleLabel = document.createElement('label');
    visibleLabel.style.cssText = `${cellStyle};cursor:pointer;${lblStyle}`;
    const visibleCb = document.createElement('input');
    visibleCb.type = 'checkbox'; visibleCb.checked = true; visibleCb.style.cursor = 'pointer';
    visibleCb.onchange = () => this._setLayerProp(layerName, 'visible', visibleCb.checked);
    visibleLabel.appendChild(visibleCb);
    visibleLabel.appendChild(document.createTextNode('Visible'));
    row.appendChild(visibleLabel);

    // Alpha
    const alphaCont = document.createElement('div'); alphaCont.style.cssText = cellStyle;
    const alphaLbl = document.createElement('span'); alphaLbl.style.cssText = lblStyle; alphaLbl.textContent = 'Alpha:';
    alphaCont.appendChild(alphaLbl);
    const alphaSlider = document.createElement('input');
    alphaSlider.type = 'range'; alphaSlider.min = '0'; alphaSlider.max = '100'; alphaSlider.value = '100';
    alphaSlider.style.cssText = 'width:60px;cursor:pointer';
    const alphaVal = document.createElement('span'); alphaVal.style.cssText = `${lblStyle};min-width:30px`; alphaVal.textContent = '100%';
    alphaSlider.oninput = () => {
      alphaVal.textContent = alphaSlider.value + '%';
      const l = Layer.get(layerName);
      if (l) l.alpha = parseInt(alphaSlider.value) / 100;
    };
    alphaCont.appendChild(alphaSlider); alphaCont.appendChild(alphaVal);
    row.appendChild(alphaCont);

    // Shader (custom layers only — runtime swap / none for live testing)
    const shaderCont = document.createElement('div'); shaderCont.style.cssText = cellStyle;
    const shaderLbl = document.createElement('span'); shaderLbl.style.cssText = lblStyle; shaderLbl.textContent = 'Shader:';
    shaderCont.appendChild(shaderLbl);
    const shaderSelect = document.createElement('select'); shaderSelect.style.cssText = selectStyle; shaderSelect.disabled = true;
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
    shaderSelect.appendChild(noneOpt);
    shaderSelect.onchange = () => this._setLayerShader(layerName, shaderSelect.value);
    shaderCont.appendChild(shaderSelect);
    row.appendChild(shaderCont);

    // Output blend
    const blendCont = document.createElement('div'); blendCont.style.cssText = cellStyle;
    const blendLbl = document.createElement('span'); blendLbl.style.cssText = lblStyle; blendLbl.textContent = 'Output Blend:';
    blendCont.appendChild(blendLbl);
    const blendSelect = this._buildBlendSelect(selectStyle, Layer._BLEND_MODE_STRINGS);
    const customLayer = Layer.initialized ? Layer.get(layerName) : null;
    blendSelect.value = customLayer
      ? (Layer._BLEND_MODE_STRINGS[Layer._blendModeId[customLayer.id]] || 'normal')
      : (Layer._BLEND_MODE_STRINGS[DEFAULT_LAYERS[layerName]?.blendMode] || 'normal');
    blendSelect.onchange = () => this._setLayerProp(layerName, 'blendMode', blendSelect.value);
    blendCont.appendChild(blendSelect);
    row.appendChild(blendCont);

    // Container blend
    const cBlendCont = document.createElement('div'); cBlendCont.style.cssText = cellStyle;
    const cBlendLbl = document.createElement('span'); cBlendLbl.style.cssText = lblStyle; cBlendLbl.textContent = 'Container Blend:';
    cBlendCont.appendChild(cBlendLbl);
    const cBlendSelect = this._buildBlendSelect(selectStyle, Layer._BLEND_MODE_STRINGS);
    if (customLayer) cBlendSelect.value = Layer._BLEND_MODE_STRINGS[Layer._containerBlendId[customLayer.id]] || 'normal';
    cBlendSelect.onchange = () => this._setLayerProp(layerName, 'containerBlendMode', cBlendSelect.value);
    cBlendCont.appendChild(cBlendSelect);
    row.appendChild(cBlendCont);

    // Y-Sort
    const ySortLabel = document.createElement('label');
    ySortLabel.style.cssText = `${cellStyle};cursor:pointer;${lblStyle}`;
    const ySortCb = document.createElement('input');
    ySortCb.type = 'checkbox'; ySortCb.style.cursor = 'pointer';
    ySortCb.checked = customLayer ? customLayer.ySorting : true;
    ySortCb.onchange = () => {
      const l = Layer.get(layerName);
      if (l && Layer._ySorting) Layer._ySorting[l.id] = ySortCb.checked ? 1 : 0;
    };
    ySortLabel.appendChild(ySortCb);
    ySortLabel.appendChild(document.createTextNode('Y-Sort'));
    row.appendChild(ySortLabel);

    // Resolution
    const resCont = document.createElement('div'); resCont.style.cssText = cellStyle;
    const resLbl = document.createElement('span'); resLbl.style.cssText = lblStyle; resLbl.textContent = 'Res:';
    resCont.appendChild(resLbl);
    const resVal = document.createElement('span'); resVal.style.cssText = `${lblStyle};color:rgba(255,255,255,0.8)`;
    resVal.textContent = customLayer ? customLayer.resolution + 'x' : '1x';
    resCont.appendChild(resVal);
    row.appendChild(resCont);

    // Density source (sprite queue vs LiquidFun HEAP splat)
    if (customLayer) {
      const densCont = document.createElement('div'); densCont.style.cssText = cellStyle;
      const densLbl = document.createElement('span'); densLbl.style.cssText = lblStyle; densLbl.textContent = 'Density:';
      densCont.appendChild(densLbl);
      const densVal = document.createElement('span');
      densVal.style.cssText = `${lblStyle};color:rgba(255,255,255,0.8)`;
      densVal.textContent = customLayer.densitySource === 'liquidFun'
        ? 'liquidFun'
        : 'sprites';
      densCont.appendChild(densVal);
      row.appendChild(densCont);
    }

    let computeVal = null;
    if (customLayer?.compute) {
      const meta = Layer._metadata?.layers?.[customLayer.id];
      const computeCont = document.createElement('div'); computeCont.style.cssText = cellStyle;
      const computeLbl = document.createElement('span'); computeLbl.style.cssText = lblStyle; computeLbl.textContent = 'Compute:';
      computeCont.appendChild(computeLbl);
      computeVal = document.createElement('span');
      computeVal.style.cssText = `${lblStyle};color:rgba(255,255,255,0.8)`;
      const srcName = meta?.compute?.passes?.[0]?.source || meta?.shaderName || 'wgsl';
      const feedN = Layer._feedCount ? Atomics.load(Layer._feedCount, customLayer.id) : 0;
      const maxB = meta?.maxBodies || 0;
      computeVal.textContent = `${srcName} · ${feedN}/${maxB} feed · ${computeSizeLabel(meta)} · WebGPU`;
      computeCont.appendChild(computeVal);
      row.appendChild(computeCont);
    }

    // Z-Index
    const zCont = document.createElement('div'); zCont.style.cssText = cellStyle;
    const zLbl = document.createElement('span'); zLbl.style.cssText = lblStyle; zLbl.textContent = 'Z:';
    zCont.appendChild(zLbl);
    const zInput = document.createElement('input');
    zInput.type = 'number';
    zInput.value = customLayer ? Layer._zIndex[customLayer.id] : (DEFAULT_LAYERS[layerName]?.zIndex ?? 0);
    zInput.style.cssText = 'width:50px;font-size:10px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    zInput.onchange = () => this._setLayerProp(layerName, 'zIndex', parseInt(zInput.value));
    zCont.appendChild(zInput);
    row.appendChild(zCont);

    // Details popup button (uniforms + compute passes)
    const tuneBtn = document.createElement('button');
    tuneBtn.textContent = 'Tune';
    tuneBtn.style.cssText = 'font-size:9px;padding:2px 6px;cursor:pointer;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.8);border:1px solid rgba(255,255,255,0.2);border-radius:3px';
    tuneBtn.title = 'Open uniforms / compute panel';
    tuneBtn.onclick = () => this._toggleLayerFloat(layerName);
    row.appendChild(tuneBtn);

    wrapper.appendChild(row);

    panel.appendChild(wrapper);

    this.elements.layerControls[layerName] = {
      visible: visibleCb, alpha: alphaSlider, alphaValue: alphaVal,
      blendMode: blendSelect, containerBlend: cBlendSelect,
      shader: shaderSelect, ySorting: ySortCb,
      resolution: resVal, zIndex: zInput, computeVal, tune: tuneBtn,
    };
    this.elements.layerRows[layerName] = wrapper;
  }

  // ------- floating details popup (uniforms + compute) -------

  _toggleLayerFloat(layerName) {
    if (this._floatLayer === layerName) {
      this._closeLayerFloat();
      return;
    }
    this._openLayerFloat(layerName);
  }

  _openLayerFloat(layerName) {
    this._closeLayerFloat();

    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:12px;top:48px;width:300px;max-height:calc(100vh - 60px);z-index:950;' +
      'overflow:auto;color:#e8e8e8;font:12px/1.35 system-ui,sans-serif;' +
      'background:rgba(12,14,20,0.92);border:1px solid #3a4254;border-radius:10px;' +
      'padding:10px 12px 14px;box-shadow:0 8px 28px rgba(0,0,0,0.45);';
    // Keep wheel/drag from reaching the canvas (free camera zoom/pan).
    el.addEventListener('wheel', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px';
    const title = document.createElement('span');
    title.textContent = layerName;
    title.style.cssText = 'font-weight:600;font-size:13px;color:#fff';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.6);font-size:14px;cursor:pointer;padding:0 2px;line-height:1';
    closeBtn.onclick = () => this._closeLayerFloat();
    head.appendChild(title);
    head.appendChild(closeBtn);
    el.appendChild(head);

    const body = document.createElement('div');
    el.appendChild(body);
    document.body.appendChild(el);

    this._float = el;
    this._floatBody = body;
    this._floatLayer = layerName;

    this._populateLayerDetails(layerName);
  }

  _closeLayerFloat() {
    if (this._float?.parentNode) this._float.parentNode.removeChild(this._float);
    if (this._floatLayer) delete this.elements.layerUniformInputs[this._floatLayer];
    this._float = null;
    this._floatBody = null;
    this._floatLayer = null;
  }

  _sectionTitle(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:0.6px;' +
      'color:rgba(255,255,255,0.35);margin:8px 0 3px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:2px';
    return el;
  }

  _populateLayerDetails(layerName) {
    const block = this._floatBody;
    if (!block || this._floatLayer !== layerName) return;
    const layer = Layer.initialized ? Layer.get(layerName) : null;
    if (!layer) { block.textContent = 'Layer not initialized'; return; }

    const meta = Layer._metadata?.layers?.[layer.id];
    block.innerHTML = '';
    this.elements.layerUniformInputs[layerName] = {};

    const hasUniforms = layer.hasShader && meta?.uniformMap && Object.keys(meta.uniformMap).length;
    if (!hasUniforms && !layer.compute) {
      block.innerHTML = '<span style="color:rgba(255,255,255,0.3)">No shader uniforms</span>';
      return;
    }

    if (hasUniforms) this._buildUniformsSection(block, layer, meta, layerName);
    if (layer.compute) this._buildComputeSection(block, meta);
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
      block.appendChild(this._sectionTitle('Uniforms'));
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
      cb.checked = (floats ? floats[entry.offset] : 0) > 0.5;
      cb.style.cursor = 'pointer';
      cb.onchange = () => layer.setUniform(uName, cb.checked ? 1 : 0);
      const span = document.createElement('span');
      span.textContent = label;
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
      const name = document.createElement('span');
      name.textContent = label;
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(hint.min);
      input.max = String(hint.max);
      input.step = String(step);
      input.value = String(read());
      input.style.cssText = 'width:100%;cursor:pointer';
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
    block.appendChild(this._sectionTitle('Compute passes'));
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

  _updateLayersAvailability() {
    const scene = this.debugUI.scene;
    if (!scene || !this.elements.layerRows) return;
    const config = scene.config;
    const available = this._getAvailableLayers(config);

    // Remove rows for custom layers that no longer exist in the current scene
    const defaultLayerNames = new Set(Object.keys(DEFAULT_LAYERS));
    const currentCustomNames = Layer.initialized
      ? new Set(Layer.getCustomLayers().map((l) => l.name))
      : new Set();
    for (const layerName of Object.keys(this.elements.layerRows)) {
      if (defaultLayerNames.has(layerName)) continue;
      if (currentCustomNames.has(layerName)) continue;
      this._removeLayerRow(layerName);
    }

    if (Layer.initialized) {
      for (const l of Layer.getCustomLayers()) {
        if (!this.elements.layerRows[l.name]) {
          this._createLayerRow(l.name, this.panel);
        }
      }
    }

    const shaderNames = scene._loadedShaderSources ? Object.keys(scene._loadedShaderSources) : [];

    for (const [layerName, wrapper] of Object.entries(this.elements.layerRows)) {
      const isAvailable = available.has(layerName);
      const controls = this.elements.layerControls[layerName];

      wrapper.style.opacity = isAvailable ? '1' : '0.4';
      wrapper.style.pointerEvents = isAvailable ? 'auto' : 'none';
      controls.visible.disabled = !isAvailable;
      controls.alpha.disabled = !isAvailable;
      controls.blendMode.disabled = !isAvailable;
      controls.zIndex.disabled = !isAvailable;
      controls.tune.disabled = !isAvailable;

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
        controls.ySorting.checked = layer.ySorting;
        controls.resolution.textContent = layer.resolution.toFixed(3) + 'x';
        if (document.activeElement !== controls.alpha) {
          const pct = Math.round(layer.alpha * 100);
          controls.alpha.value = pct;
          controls.alphaValue.textContent = pct + '%';
        }
        if (layer.hasShader) controls.containerBlend.value = Layer._BLEND_MODE_STRINGS[Layer._containerBlendId[layer.id]] || 'normal';
        if (controls.computeVal && layer.compute) {
          const meta = Layer._metadata?.layers?.[layer.id];
          const srcName = meta?.compute?.passes?.[0]?.source || meta?.shaderName || 'wgsl';
          const feedN = Layer._feedCount ? Atomics.load(Layer._feedCount, layer.id) : 0;
          const maxB = meta?.maxBodies || 0;
          controls.computeVal.textContent = `${srcName} · ${feedN}/${maxB} feed · ${computeSizeLabel(meta)} · WebGPU`;
        }
      }
    }
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
    const available = new Set(['ENTITIES', 'BACKGROUND']);
    if (config.particle?.decals) available.add('DECALS');
    if (config.lighting?.enabled) {
      available.add('LIGHTING');
      if (config.lighting?.shadowsEnabled) available.add('CASTED_SHADOWS');
    }
    if (Layer.initialized) {
      for (const l of Layer.getCustomLayers()) available.add(l.name);
    }
    return available;
  }

  _setLayerProp(layer, prop, value) {
    const scene = this.debugUI.scene;
    if (!scene?.workers?.renderer) return;
    const msg = { msg: 'setLayerProps', layer };
    msg[prop] = value;
    scene.workers.renderer.postMessage(msg);
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

    if (this._floatLayer === layerName) this._populateLayerDetails(layerName);
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
