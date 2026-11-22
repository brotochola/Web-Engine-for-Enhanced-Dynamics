// BigAtlasInspector.js - Visual inspector for the generated bigAtlas

import { ATLAS_MAP_MODES, atlasMapsAt, atlasMapsImage } from './atlasMapsView.js';

/**
 * BigAtlasInspector - Shows the generated atlas with frame overlays
 * Usage: BigAtlasInspector.show(await scene.bigAtlasInspect(), scene.bigAtlasJson)
 */
class BigAtlasInspector {
  static panel = null;
  /** DBG-6: the twin page read for the maps modes, and the json it belongs to (read once per atlas). */
  static _mapsPage = null;
  static _mapsJson = null;
  /** DBG-6: the atlas made into a canvas for the entity inspector, and the json it belongs to. */
  static _atlasCanvas = null;
  static _atlasJson = null;

  /** DBG-6: a scene's atlas as a canvas, made once per atlas json (the page keeps none: SST-5). */
  static async atlasCanvas(scene) {
    if (typeof scene?.bigAtlasInspect !== 'function') return null;
    if (this._atlasJson !== scene.bigAtlasJson) {
      this._atlasCanvas = await scene.bigAtlasInspect();
      this._atlasJson = scene.bigAtlasJson;
    }
    return this._atlasCanvas;
  }

  /** DBG-6: a scene's twin page, read once per atlas json (null: no sheet has maps). */
  static async mapsPage(scene) {
    if (typeof scene?.bigAtlasInspectMaps !== 'function') return null;
    return this._readMaps(scene.bigAtlasInspectMaps, scene.bigAtlasJson);
  }

  /**
   * Show the bigAtlas in an overlay panel
   * @param {HTMLCanvasElement} atlasCanvas - The generated atlas canvas
   * @param {Object} atlasJson - The atlas metadata (frames, animations)
   * @param {(() => Promise<{ texels: Uint8ClampedArray, width: number, height: number } | null>) | null} [inspectMaps]
   *   DBG-6: the twin page's texels on demand; with it, and a sheet with maps, a mode select shows the maps
   */
  static show(atlasCanvas, atlasJson, inspectMaps = null) {
    if (this.panel) {
      this.panel.remove();
    }

    // Create overlay panel
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      border: 2px solid #333;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 10000;
      max-width: 90vw;
      max-height: 90vh;
      overflow: auto;
      padding: 20px;
    `;

    // Create header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #eee;
    `;

    const title = document.createElement('h2');
    title.textContent = '🎨 BigAtlas Inspector';
    title.style.margin = '0';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = `
      padding: 8px 16px;
      background: #f44336;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    closeBtn.onclick = () => this.hide();

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Create info panel
    const info = document.createElement('div');
    info.style.cssText = `
      background: #f5f5f5;
      padding: 15px;
      border-radius: 4px;
      margin-bottom: 15px;
      font-family: monospace;
      font-size: 12px;
    `;

    const frameCount = Object.keys(atlasJson.frames).length;
    const animCount = Object.keys(atlasJson.animations).length;
    const { w, h } = atlasJson.meta.size;

    info.innerHTML = `
      <strong>Atlas Size:</strong> ${w}x${h}px<br>
      <strong>Total Frames:</strong> ${frameCount}<br>
      <strong>Total Animations:</strong> ${animCount}<br>
      <strong>Format:</strong> ${atlasJson.meta.format}<br>
    `;

    // Create controls
    const controls = document.createElement('div');
    controls.style.cssText = `
      margin-bottom: 15px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    `;

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = '📥 Download PNG';
    downloadBtn.style.cssText = `
      padding: 8px 16px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;
    downloadBtn.onclick = () => {
      const link = document.createElement('a');
      link.download = `bigAtlas_${w}x${h}.png`;
      link.href = atlasCanvas.toDataURL();
      link.click();
    };

    const downloadJsonBtn = document.createElement('button');
    downloadJsonBtn.textContent = '📄 Download JSON';
    downloadJsonBtn.style.cssText = `
      padding: 8px 16px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;
    downloadJsonBtn.onclick = () => {
      const blob = new Blob([JSON.stringify(atlasJson, null, 2)], {
        type: 'application/json',
      });
      const link = document.createElement('a');
      link.download = `bigAtlas.json`;
      link.href = URL.createObjectURL(blob);
      link.click();
    };

    const toggleGridBtn = document.createElement('button');
    toggleGridBtn.textContent = '🔲 Toggle Frame Borders + Names';
    toggleGridBtn.style.cssText = `
      padding: 8px 16px;
      background: #FF9800;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;

    controls.appendChild(downloadBtn);
    controls.appendChild(downloadJsonBtn);
    controls.appendChild(toggleGridBtn);

    // Create canvas container
    const canvasContainer = document.createElement('div');
    canvasContainer.style.cssText = `
      position: relative;
      overflow: auto;
      max-height: 60vh;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: repeating-conic-gradient(#f0f0f0 0% 25%, #e0e0e0 0% 50%) 50% / 20px 20px;
    `;

    // Clone the canvas for display
    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = atlasCanvas.width;
    displayCanvas.height = atlasCanvas.height;
    const ctx = displayCanvas.getContext('2d');
    ctx.drawImage(atlasCanvas, 0, 0);

    // Overlay canvas for frame borders
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = atlasCanvas.width;
    overlayCanvas.height = atlasCanvas.height;
    overlayCanvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    `;

    let showFrames = false;
    const drawFrameOverlays = () => {
      const overlayCtx = overlayCanvas.getContext('2d');
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

      if (showFrames) {
        overlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
        overlayCtx.lineWidth = 1;
        overlayCtx.font = '11px monospace';
        overlayCtx.textBaseline = 'top';

        for (const [frameName, frameData] of Object.entries(atlasJson.frames)) {
          const { x, y, w, h } = frameData.frame;
          overlayCtx.strokeRect(x, y, w, h);

          const textPadding = 2;
          const textHeight = 14;
          const textWidth = overlayCtx.measureText(frameName).width + textPadding * 2;
          const labelWidth = textWidth;
          const labelX = Math.min(x, overlayCanvas.width - labelWidth);
          const labelY = Math.min(y, overlayCanvas.height - textHeight);

          overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.75)';
          overlayCtx.fillRect(labelX, labelY, labelWidth, textHeight);
          overlayCtx.fillStyle = '#fff';
          overlayCtx.fillText(frameName, labelX + textPadding, labelY + textPadding);
        }
      }
    };

    toggleGridBtn.onclick = () => {
      showFrames = !showFrames;
      drawFrameOverlays();
    };

    canvasContainer.appendChild(displayCanvas);
    canvasContainer.appendChild(overlayCanvas);

    // DBG-6: the maps modes and the readout under the pointer.
    const readout = document.createElement('div');
    readout.style.cssText = 'font-family: monospace; font-size: 12px; margin: 6px 0; min-height: 16px; color: #333;';
    let mode = 'colour';
    if (typeof inspectMaps === 'function' && atlasJson.meta?.maps === true) {
      const select = document.createElement('select');
      select.style.cssText = 'margin-left: 10px; padding: 6px; font-size: 14px;';
      for (const m of ATLAS_MAP_MODES) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
      }
      select.onchange = async () => {
        mode = select.value;
        if (mode === 'colour') {
          ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
          ctx.drawImage(atlasCanvas, 0, 0);
          readout.textContent = '';
          return;
        }
        readout.textContent = 'reading the twin page...';
        const page = await this._readMaps(inspectMaps, atlasJson);
        if (!page) {
          readout.textContent = 'no twin page: no sheet of this atlas has maps';
          return;
        }
        const img = atlasMapsImage(page, atlasJson, mode);
        ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        ctx.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
        readout.textContent = `${mode}: ${img.frames} frames with maps${img.maxZ > 0 ? `, highest ${img.maxZ.toFixed(1)} px` : ''}`;
      };
      controls.appendChild(select);
    }
    displayCanvas.onmousemove = (e) => {
      const r = displayCanvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) * displayCanvas.width) / r.width);
      const y = Math.floor(((e.clientY - r.top) * displayCanvas.height) / r.height);
      const page = this._mapsJson === atlasJson ? this._mapsPage : null;
      const at = atlasMapsAt(page, atlasJson, x, y);
      if (!at) {
        readout.textContent = '';
        return;
      }
      const m = at.marks;
      const marks = [m.twin && 'maps', m.heights && 'height map', m.relief && 'relief', m.unshaded && 'unshaded'].filter(Boolean).join(', ') || 'no maps';
      let text = `${at.name} (${at.frame.w}x${at.frame.h} at ${at.frame.x}, ${at.frame.y}): ${marks}`;
      if (at.texel) {
        const n = at.texel.normal;
        text += `; height ${at.texel.z.toFixed(2)} px${n ? `, normal (${n[0].toFixed(2)}, ${n[1].toFixed(2)}, ${n[2].toFixed(2)})` : ''}`;
      }
      readout.textContent = text;
    };

    // Assemble panel
    this.panel.appendChild(header);
    this.panel.appendChild(info);
    this.panel.appendChild(controls);
    this.panel.appendChild(readout);
    this.panel.appendChild(canvasContainer);

    document.body.appendChild(this.panel);
  }

  /** DBG-6: the twin page's texels, read once per atlas json. */
  static async _readMaps(inspectMaps, atlasJson) {
    if (this._mapsJson !== atlasJson) {
      this._mapsPage = await inspectMaps();
      this._mapsJson = atlasJson;
    }
    return this._mapsPage;
  }

  /**
   * Hide the inspector panel
   */
  static hide() {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }

  /**
   * Toggle the inspector panel
   */
  static toggle(atlasCanvas, atlasJson) {
    if (this.panel) {
      this.hide();
    } else {
      this.show(atlasCanvas, atlasJson);
    }
  }
}

export { BigAtlasInspector };
