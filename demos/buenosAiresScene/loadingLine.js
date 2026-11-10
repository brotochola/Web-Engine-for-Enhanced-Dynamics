// The demo's loading screen: a bar over the canvas until the first frame, fed by the engine's load steps
// (Scene.onLoadProgress) and, while preload() builds the barrio, by the barrio's own.

const SCREEN_CSS =
  'position:fixed;inset:0;z-index:950;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
  'background:#15171d;color:#dde;font:14px/1.4 system-ui,sans-serif;';
const TRACK_CSS = 'width:min(420px,80vw);height:6px;border-radius:3px;background:rgba(255,255,255,0.12);overflow:hidden;';
const BAR_CSS = 'width:0;height:100%;background:#e8b04a;transition:width 120ms linear;';
const NOTE_CSS = 'color:#99a;font-size:12px;font-variant-numeric:tabular-nums;';

export class LoadingLine {
  el = document.createElement('div');
  bar = document.createElement('div');
  label = document.createElement('div');
  note = document.createElement('div');
  t0 = performance.now();

  constructor(title) {
    this.el.style.cssText = SCREEN_CSS;
    const name = document.createElement('div');
    name.style.cssText = 'font-size:18px;letter-spacing:0.02em;';
    name.textContent = title;
    const track = document.createElement('div');
    track.style.cssText = TRACK_CSS;
    this.bar.style.cssText = BAR_CSS;
    track.append(this.bar);
    this.note.style.cssText = NOTE_CSS;
    this.el.append(name, track, this.label, this.note);
    document.body.append(this.el);
  }

  /** `fraction` of the whole load, 0 to 1, and what it is doing now. */
  show(fraction, text) {
    this.bar.style.width = `${Math.round(100 * Math.max(0, Math.min(1, fraction)))}%`;
    this.label.textContent = text;
    this.note.textContent = `${((performance.now() - this.t0) / 1000).toFixed(1)} s`;
  }

  remove() {
    this.el.remove();
  }
}
