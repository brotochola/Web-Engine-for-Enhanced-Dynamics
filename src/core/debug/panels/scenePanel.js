// ScenePanel.js — Scene switching, play/pause/step, restart, game speed and edit mode

import { createPanel, createRow, createStat, createButton } from '../ui/debugDom.js';
import { MAX_TIME_SCALE } from '../../timeScale.js';
import { editorPageUrl, editorPageFor } from '../editorPage.js';

function sceneEntryIsActive(scene, entry) {
  if (!scene) return false;
  if (entry.class && scene.constructor === entry.class) return true;
  if (entry.url && scene.sceneScriptUrl) {
    return scene.sceneScriptUrl.includes(entry.url) || entry.url.includes(scene.sceneScriptUrl);
  }
  return false;
}

async function loadRegisteredScene(gameEngine, entry) {
  if (entry.url) {
    await gameEngine.loadScene(entry.url, { export: entry.export });
    entry.class = gameEngine.currentScene && gameEngine.currentScene.constructor;
    return;
  }
  if (entry.class) {
    await gameEngine.loadScene(entry.class);
    return;
  }
  if (typeof entry.load === 'function') {
    entry.class = await entry.load();
    await gameEngine.loadScene(entry.class);
    return;
  }
  throw new Error(`registerScenes: "${entry.name}" needs url, class, or load()`);
}

export class ScenePanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
    /** The speed the slider shows, so a tick writes the DOM only when it changed. */
    this._shownSpeed = NaN;
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

    // One frame of the paused game (ED-14).
    this.elements.stepBtn = createButton('⏭ Step', '', () => this.debugUI.scene?.stepPaused());
    this.elements.stepBtn.title = 'One frame, while paused';
    controlsRow.appendChild(this.elements.stepBtn);

    this.elements.editBtn = createButton('✏ Edit', '', () => this.debugUI.toggleEditMode());
    this.elements.editBtn.title =
      'Edit mode (Shift+E): the game stops, back to the level’s start, and the view is yours; again, it plays from there';
    controlsRow.appendChild(this.elements.editBtn);

    // Stop (ED-16): the level as its scene file's document has it, in edit mode.
    this.elements.stopBtn = createButton('■ Stop', '', () => this.debugUI.stopPlaying());
    this.elements.stopBtn.title = 'Back to the level as its scene file’s document has it, in edit mode';
    controlsRow.appendChild(this.elements.stopBtn);

    // This page in the editor page (D9, ED-15): the dev server's /editor, else the page beside the engine's source.
    const editorPage = this.debugUI._host ? null : editorPageUrl();
    if (editorPage !== null) {
      const open = createButton('🧩 Editor page', '', async () => {
        location.href = await editorPageFor(location.pathname + location.search + location.hash, editorPage);
      });
      open.title = 'This game in the editor page: the scene list, the inspector and the assets docked around it';
      controlsRow.appendChild(open);
    }

    // Restart: the scene loads again, fresh, with the data it was loaded with
    this.elements.restartBtn = createButton('↻ Restart', '', () => this._restartScene());
    controlsRow.appendChild(this.elements.restartBtn);

    this.panel.appendChild(controlsRow);

    // Game speed (Time.scale; while editing, the speed leaving edit mode plays at).
    const speedRow = createRow('margin-top:8px;gap:8px;align-items:center');
    speedRow.appendChild(createStat('Speed:'));
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'debug-ui-range';
    slider.min = '0';
    slider.max = String(MAX_TIME_SCALE);
    slider.step = '0.05';
    slider.value = '1';
    slider.style.cssText = 'flex:1;min-width:0';
    slider.title = 'Time.scale: 1 is real time, 0 holds still';
    slider.oninput = () => {
      this.debugUI.playSpeed = Number(slider.value);
      this._showSpeed();
    };
    const speedText = createStat('1.00×');
    const realTime = createButton('1×', '', () => {
      this.debugUI.playSpeed = 1;
      this._showSpeed();
    });
    realTime.title = 'Real time';
    speedRow.appendChild(slider);
    speedRow.appendChild(speedText);
    speedRow.appendChild(realTime);
    this.elements.speedSlider = slider;
    this.elements.speedText = speedText;
    this.panel.appendChild(speedRow);
    return this.panel;
  }

  /** The speed slider and its number, when the speed changed (from here, a game's hitstop, edit mode). */
  _showSpeed() {
    const speed = this.debugUI.playSpeed;
    if (speed === this._shownSpeed) return;
    this._shownSpeed = speed;
    if (this.elements.speedSlider) this.elements.speedSlider.value = String(speed);
    if (this.elements.speedText) this.elements.speedText.textContent = `${speed.toFixed(2)}×`;
  }

  /** The Edit button shows whether edit mode is on (EditMode calls it on every change), and Step and the speed follow. */
  updateEditButton() {
    if (this.elements.editBtn) this.elements.editBtn.classList.toggle('active', this.debugUI.editing);
    if (this.elements.stopBtn) {
      this.elements.stopBtn.disabled = !this.debugUI.scene?.sceneFileUrl;
      this.elements.stopBtn.classList.toggle('active', this.debugUI.editMode?.playing === true);
    }
    this._updatePlayPauseState();
    this._showSpeed();
  }

  // ------- lifecycle -------

  attach() {
    this.updateSceneList();
  }

  update() {
    this._updatePlayPauseState();
    this._showSpeed();
  }

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
      if (sceneEntryIsActive(scene, sceneConfig)) {
        btn.classList.add('active');
      }
      btn.onclick = async () => {
        if (!this.debugUI.gameEngine) return;
        if (sceneEntryIsActive(this.debugUI.scene, sceneConfig)) return;
        await loadRegisteredScene(this.debugUI.gameEngine, sceneConfig);
      };
      container.appendChild(btn);
    }

    this._updatePlayPauseState();
  }

  // ------- internal -------

  async _restartScene() {
    const gameEngine = this.debugUI.gameEngine;
    const scene = this.debugUI.scene;
    if (!gameEngine || !scene) return;
    await gameEngine.loadScene(scene.constructor, {
      data: scene.data,
      scriptUrl: scene.sceneScriptUrl || undefined,
    });
  }

  _updatePlayPauseState() {
    const isPaused = this.debugUI.scene?.state?.pause;
    if (this.elements.pauseBtn) this.elements.pauseBtn.classList.toggle('active', isPaused);
    if (this.elements.resumeBtn) this.elements.resumeBtn.classList.toggle('active', !isPaused);
    // Step runs a frame of the paused game; edit mode holds the world at speed 0.
    if (this.elements.stepBtn) this.elements.stepBtn.disabled = !isPaused || this.debugUI.editing;
  }
}
