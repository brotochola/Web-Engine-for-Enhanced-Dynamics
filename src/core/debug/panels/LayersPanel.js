// LayersPanel.js — Per-layer controls (visible, alpha, blend, shader, uniforms, y-sort, z-index)

import { createPanel } from '../ui/DebugDOM.js';
import { DEFAULT_LAYERS } from '../../ConfigDefaults.js';
import { Layer } from '../../Layer.js';

function computeGridLabel(meta) {
  const grid = meta?.computeGrid;
  if (!grid) return '—';
  const nx = grid.numX;
  const ny = grid.numY;
  if (nx && ny) return `${nx}×${ny}`;
  const cell = grid.cellSize || 8;
  const fit = grid.fit === 'canvas' ? 'canvas' : 'view';
  return `${cell}px ${fit}`;
}

export class LayersPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {
      layerControls: {},
      layerRows: {},
      layerDetails: {},
      layerUniformInputs: {},
    };
    this.panel = null;
    this._shaderOptionsSynced = false;
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
    const wrapper = this.elements.layerRows[layerName];
    if (wrapper?.parentNode) wrapper.parentNode.removeChild(wrapper);
    delete this.elements.layerRows[layerName];
    delete this.elements.layerControls[layerName];
    delete this.elements.layerDetails[layerName];
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
      computeVal.textContent = `${srcName} · ${feedN}/${maxB} feed · ${computeGridLabel(meta)} · WebGPU`;
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

    wrapper.appendChild(row);

    // Uniforms expandable
    const uniformsBlock = document.createElement('div');
    uniformsBlock.style.cssText = 'display:none;padding:4px 0 4px 16px;font-size:10px;color:rgba(255,255,255,0.55);line-height:1.6';
    wrapper.appendChild(uniformsBlock);

    label.style.cursor = 'pointer';
    label.title = 'Click to expand uniforms';
    label.onclick = () => {
      const open = uniformsBlock.style.display === 'none';
      uniformsBlock.style.display = open ? 'block' : 'none';
      if (open) this._populateLayerUniforms(layerName);
    };

    panel.appendChild(wrapper);

    this.elements.layerControls[layerName] = {
      visible: visibleCb, alpha: alphaSlider, alphaValue: alphaVal,
      blendMode: blendSelect, containerBlend: cBlendSelect,
      shader: shaderSelect, ySorting: ySortCb,
      resolution: resVal, zIndex: zInput, computeVal,
    };
    this.elements.layerRows[layerName] = wrapper;
    this.elements.layerDetails[layerName] = uniformsBlock;
  }

  // ------- uniforms -------

  _populateLayerUniforms(layerName) {
    const block = this.elements.layerDetails[layerName];
    if (!block) return;
    const layer = Layer.initialized ? Layer.get(layerName) : null;
    if (!layer) { block.textContent = 'Layer not initialized'; return; }

    const meta = Layer._metadata?.layers?.[layer.id];
    block.innerHTML = '';
    this.elements.layerUniformInputs[layerName] = {};

    if (!layer.hasShader || !meta?.uniformMap) {
      block.innerHTML = '<span style="color:rgba(255,255,255,0.3)">No shader uniforms</span>';
      return;
    }

    const dimStyle = 'color:rgba(255,255,255,0.4)';

    for (const [uName, entry] of Object.entries(meta.uniformMap)) {
      const uType = meta.uniformTypes?.[uName] || 'f32';
      const uRow = document.createElement('div');
      uRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px';

      const uLabel = document.createElement('span');
      uLabel.style.cssText = `${dimStyle};min-width:120px`; uLabel.textContent = uName;
      uRow.appendChild(uLabel);

      const uTypeSpan = document.createElement('span');
      uTypeSpan.style.cssText = 'color:rgba(255,255,255,0.3);font-size:9px;min-width:55px';
      uTypeSpan.textContent = uType;
      uRow.appendChild(uTypeSpan);

      const inputs = [];
      for (let i = 0; i < entry.size; i++) {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '0.01';
        inp.style.cssText = 'width:60px;font-size:10px;padding:1px 4px;background:rgba(0,0,0,0.5);color:#fbbf24;border:1px solid rgba(255,255,255,0.2);border-radius:3px';
        const currentVal = Layer._uniformFloats[layer.id] ? Layer._uniformFloats[layer.id][entry.offset + i] : 0;
        inp.value = parseFloat(currentVal.toFixed(4));
        inp.onchange = () => {
          if (entry.size === 1) {
            layer.setUniform(uName, parseFloat(inp.value));
          } else {
            const arr = [];
            for (let j = 0; j < inputs.length; j++) arr.push(parseFloat(inputs[j].value));
            layer.setUniform(uName, arr);
          }
        };
        inputs.push(inp);
        uRow.appendChild(inp);
      }

      block.appendChild(uRow);
      this.elements.layerUniformInputs[layerName][uName] = inputs;
    }
  }

  // ------- tick update -------

  _updateLayersSection() {
    if (!Layer.initialized || !this.panel) return;

    for (const [layerName, inputMap] of Object.entries(this.elements.layerUniformInputs)) {
      const layer = Layer.get(layerName);
      if (!layer || !Layer._uniformFloats[layer.id]) continue;
      const meta = Layer._metadata?.layers?.[layer.id];
      if (!meta?.uniformMap) continue;

      for (const [uName, inputs] of Object.entries(inputMap)) {
        const entry = meta.uniformMap[uName];
        if (!entry) continue;
        for (let i = 0; i < inputs.length; i++) {
          if (document.activeElement === inputs[i]) continue;
          const live = Layer._uniformFloats[layer.id][entry.offset + i];
          const display = parseFloat(live.toFixed(4));
          if (parseFloat(inputs[i].value) !== display) inputs[i].value = display;
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
          controls.computeVal.textContent = `${srcName} · ${feedN}/${maxB} feed · ${computeGridLabel(meta)} · WebGPU`;
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

    const block = this.elements.layerDetails[layerName];
    if (block && block.style.display !== 'none') this._populateLayerUniforms(layerName);
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
