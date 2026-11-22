// cameraSection.js — DBG-9: the camera in the Scene tab. What the logic camera is doing (zoom, place, turn, what it
// follows, free camera), controls over Camera's own setters, and the projection the scene's config.camera resolves to
// (pitch, yaw, the floor's and heights' scales, flat or oblique). Main thread only: no worker change.

import { createRow, createStat, createButton } from '../ui/debugDom.js';
import { Camera } from '../../camera.js';
import { resolveCamera } from '../../../util/cameraView.js';

const DEG = 180 / Math.PI;

/** The live read-out: zoom, the view's centre, the turn, what it follows, free or not. */
export function cameraReadoutText(cam) {
  if (!cam.isInitialized) return 'not initialized';
  const slot = cam._data[cam.IDX_FOLLOW_ENTITY] | 0;
  const target = cam.getFollowTarget();
  const follow = slot > 0 ? `entity #${slot - 1}` : target ? `point ${Math.round(target.x)}, ${Math.round(target.y)}` : 'nothing';
  return `zoom ${cam.zoom.toFixed(3)} · centre ${Math.round(cam.centerX)}, ${Math.round(cam.centerY)} · `
    + `turn ${(cam.rotation * DEG).toFixed(1)}° · follows ${follow}${cam._free ? ' · free camera' : ''}`;
}

/** The projection config.camera resolves to (cameraView.js), read-only. */
export function cameraProjectionText(cameraConfig) {
  const c = resolveCamera(cameraConfig);
  const pitch = c.pitch === null ? 'unset' : `${c.pitch}°`;
  let view = c.oblique ? 'oblique: the floor foreshortened, heights shown' : 'flat';
  if (!c.oblique && (c.pitch === 90 || c.pitch === 0)) view = `flat (pitch ${c.pitch}): lit as any other view`;
  else if (!c.oblique && c.pitch === null && c.heightScaleY > 0) view = 'classic: the floor as drawn, heights as measured';
  return `pitch ${pitch} · yaw ${c.yaw}° · floorScaleY ${c.floorScaleY.toFixed(3)} · heightScaleY ${c.heightScaleY.toFixed(3)} · ${view}`;
}

/** Slider position (0..1000) for a zoom, on a log scale between the camera's min and max zoom, and back. */
export function zoomToSlider(zoom, min, max) {
  if (!(max > min)) return 0;
  const t = (Math.log(zoom) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return Math.round(Math.max(0, Math.min(1, t)) * 1000);
}

export function sliderToZoom(value, min, max) {
  return Math.exp(Math.log(min) + (Number(value) / 1000) * (Math.log(max) - Math.log(min)));
}

export class CameraSection {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.root = null;
    this.readout = null;
    this.projection = null;
    this.zoom = null;
    this.turn = null;
    this.free = null;
  }

  create() {
    const root = document.createElement('div');
    root.style.cssText = 'margin-top:8px';

    const head = createRow('gap:8px');
    head.appendChild(createStat('Camera:'));
    this.readout = createStat('—');
    head.appendChild(this.readout);
    root.appendChild(head);

    const controls = createRow('margin-top:4px;gap:8px;align-items:center');
    controls.appendChild(createStat('Zoom'));
    this.zoom = document.createElement('input');
    this.zoom.type = 'range';
    this.zoom.min = '0';
    this.zoom.max = '1000';
    this.zoom.className = 'debug-ui-range';
    this.zoom.title = 'Camera.setZoom (eased), between minZoom and maxZoom on a log scale';
    this.zoom.oninput = () => {
      if (Camera.isInitialized) Camera.setZoom(sliderToZoom(this.zoom.value, Camera.minZoom, Camera.maxZoom));
    };
    controls.appendChild(this.zoom);

    controls.appendChild(createStat('Turn°'));
    this.turn = document.createElement('input');
    this.turn.type = 'number';
    this.turn.step = '1';
    this.turn.style.cssText = 'width:56px;font-size:10px;padding:1px 4px;background:rgba(0,0,0,0.5);color:white;'
      + 'border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    this.turn.title = 'Camera.setRotation, degrees';
    this.turn.onchange = () => {
      const deg = Number(this.turn.value);
      if (Camera.isInitialized && Number.isFinite(deg)) Camera.setRotation(deg / DEG);
    };
    controls.appendChild(this.turn);

    const freeLabel = document.createElement('label');
    freeLabel.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer';
    freeLabel.title = 'Camera.setFree: WASD pans, the wheel zooms (a game that moves the camera itself still does)';
    this.free = document.createElement('input');
    this.free.type = 'checkbox';
    this.free.className = 'debug-ui-checkbox';
    this.free.onchange = () => Camera.setFree(this.free.checked);
    freeLabel.appendChild(this.free);
    freeLabel.appendChild(createStat('Free camera'));
    controls.appendChild(freeLabel);

    controls.appendChild(createButton('Shake', '', () => {
      if (Camera.isInitialized) Camera.shake(8, 300);
    }));
    root.appendChild(controls);

    this.projection = createStat('—');
    this.projection.style.cssText = 'display:block;margin-top:4px;font-size:9px;color:rgba(255,255,255,0.45)';
    this.projection.title = "config.camera as the scene resolved it (cameraView.js); read-only";
    root.appendChild(this.projection);

    this.root = root;
    return root;
  }

  attach() {
    if (this.projection) this.projection.textContent = cameraProjectionText(this.debugUI.scene?.config?.camera);
  }

  update() {
    if (!this.root) return;
    const text = cameraReadoutText(Camera);
    if (this.readout.textContent !== text) this.readout.textContent = text;
    if (!Camera.isInitialized) return;
    if (document.activeElement !== this.zoom) {
      const v = String(zoomToSlider(Camera.zoom, Camera.minZoom, Camera.maxZoom));
      if (this.zoom.value !== v) this.zoom.value = v;
    }
    if (document.activeElement !== this.turn) {
      const deg = String(Math.round(Camera.rotation * DEG));
      if (this.turn.value !== deg) this.turn.value = deg;
    }
    if (this.free.checked !== !!Camera._free) this.free.checked = !!Camera._free;
  }
}
