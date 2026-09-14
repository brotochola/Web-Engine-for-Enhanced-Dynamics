// ScenePanel.js — Scene switching and play/pause controls

import { createPanel, createRow, createStat, createButton } from '../ui/DebugDOM.js';

export class ScenePanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();

    this.elements.sceneSwitchContainer = createRow('gap:8px');
    this.panel.appendChild(this.elements.sceneSwitchContainer);

    // Play / Pause controls
    const controlsRow = createRow('margin-top:8px;gap:8px');

    controlsRow.appendChild(createStat('Controls:'));

    this.elements.pauseBtn = createButton('⏸ Pause', '', () => {
      if (this.debugUI.gameEngine) {
        this.debugUI.gameEngine.pause();
        this._updatePlayPauseState();
      }
    });
    controlsRow.appendChild(this.elements.pauseBtn);

    this.elements.resumeBtn = createButton('▶ Play', '', () => {
      if (this.debugUI.gameEngine) {
        this.debugUI.gameEngine.resume();
        this._updatePlayPauseState();
      }
    });
    controlsRow.appendChild(this.elements.resumeBtn);

    this.panel.appendChild(controlsRow);
    return this.panel;
  }

  // ------- lifecycle -------

  attach() {
    this.updateSceneList();
  }

  update() { /* no-op — scene list only changes on switch */ }

  // ------- scene list -------

  updateSceneList() {
    const container = this.elements.sceneSwitchContainer;
    if (!container) return;

    container.innerHTML = '';
    container.appendChild(createStat('Scene:'));

    const registeredScenes = this.debugUI.registeredScenes;
    const scene = this.debugUI.scene;

    for (const sceneConfig of registeredScenes) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn scene-btn';
      btn.textContent = sceneConfig.name;
      if (scene && scene.constructor === sceneConfig.class) {
        btn.classList.add('active');
      }
      btn.onclick = async () => {
        if (this.debugUI.gameEngine && scene?.constructor !== sceneConfig.class) {
          await this.debugUI.gameEngine.loadScene(sceneConfig.class);
        }
      };
      container.appendChild(btn);
    }

    this._updatePlayPauseState();
  }

  // ------- internal -------

  _updatePlayPauseState() {
    const isPaused = this.debugUI.scene?.state?.pause;
    if (this.elements.pauseBtn) this.elements.pauseBtn.classList.toggle('active', isPaused);
    if (this.elements.resumeBtn) this.elements.resumeBtn.classList.toggle('active', !isPaused);
  }
}
