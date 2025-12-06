// BigAtlasInspector.js - Visual inspector for the generated bigAtlas

/**
 * BigAtlasInspector - Shows the generated atlas with frame overlays
 * Usage: BigAtlasInspector.show(gameEngine.bigAtlasCanvas, bigAtlasJson)
 */
class BigAtlasInspector {
  static panel = null;

  /**
   * Show the bigAtlas in an overlay panel
   * @param {HTMLCanvasElement} atlasCanvas - The generated atlas canvas
   * @param {Object} atlasJson - The atlas metadata (frames, animations)
   */
  static show(atlasCanvas, atlasJson) {
    if (this.panel) {
      this.panel.remove();
    }

    // Create overlay panel
    this.panel = document.createElement("div");
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
    const header = document.createElement("div");
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #eee;
    `;

    const title = document.createElement("h2");
    title.textContent = "🎨 BigAtlas Inspector";
    title.style.margin = "0";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕ Close";
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
    const info = document.createElement("div");
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
    const controls = document.createElement("div");
    controls.style.cssText = `
      margin-bottom: 15px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    `;

    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "📥 Download PNG";
    downloadBtn.style.cssText = `
      padding: 8px 16px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;
    downloadBtn.onclick = () => {
      const link = document.createElement("a");
      link.download = `bigAtlas_${w}x${h}.png`;
      link.href = atlasCanvas.toDataURL();
      link.click();
    };

    const downloadJsonBtn = document.createElement("button");
    downloadJsonBtn.textContent = "📄 Download JSON";
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
        type: "application/json",
      });
      const link = document.createElement("a");
      link.download = `bigAtlas.json`;
      link.href = URL.createObjectURL(blob);
      link.click();
    };

    const toggleGridBtn = document.createElement("button");
    toggleGridBtn.textContent = "🔲 Toggle Frame Borders";
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
    const canvasContainer = document.createElement("div");
    canvasContainer.style.cssText = `
      position: relative;
      overflow: auto;
      max-height: 60vh;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: repeating-conic-gradient(#f0f0f0 0% 25%, #e0e0e0 0% 50%) 50% / 20px 20px;
    `;

    // Clone the canvas for display
    const displayCanvas = document.createElement("canvas");
    displayCanvas.width = atlasCanvas.width;
    displayCanvas.height = atlasCanvas.height;
    const ctx = displayCanvas.getContext("2d");
    ctx.drawImage(atlasCanvas, 0, 0);

    // Overlay canvas for frame borders
    const overlayCanvas = document.createElement("canvas");
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
      const overlayCtx = overlayCanvas.getContext("2d");
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

      if (showFrames) {
        overlayCtx.strokeStyle = "rgba(255, 0, 0, 0.5)";
        overlayCtx.lineWidth = 1;

        for (const [frameName, frameData] of Object.entries(atlasJson.frames)) {
          const { x, y, w, h } = frameData.frame;
          overlayCtx.strokeRect(x, y, w, h);
        }
      }
    };

    toggleGridBtn.onclick = () => {
      showFrames = !showFrames;
      drawFrameOverlays();
    };

    canvasContainer.appendChild(displayCanvas);
    canvasContainer.appendChild(overlayCanvas);

    // Assemble panel
    this.panel.appendChild(header);
    this.panel.appendChild(info);
    this.panel.appendChild(controls);
    this.panel.appendChild(canvasContainer);

    document.body.appendChild(this.panel);
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
