// chapters.js – the landing page's tour (page only): one chapter per screen width, left to right. The wheel, the
// arrow keys, PageUp/PageDown and the page's dots and arrows move to the next or previous chapter; the camera eases
// there. The time of day follows the camera: dawn on the title, noon at the lake, sunset on the ropes, night at the
// camp, dawn again under the hood.

const { Mouse, Keyboard, Camera } = WEED;

/** The chapters, left to right: the page's copy panel for each (data-chapter) and its time of day (0 = midnight,
 *  0.25 = dawn, 0.5 = noon, 0.75 = dusk; past 1 wraps). */
export const CHAPTERS = [
  { id: 'hero', day: 0.27 },
  { id: 'fluids', day: 0.48 },
  { id: 'soft', day: 0.6 },
  { id: 'ropes', day: 0.735 },
  { id: 'fire', day: 0.93 },
  { id: 'hood', day: 1.28 },
];

/** Wheel distance (raw deltaY) that turns the page, and the pause after a turn (ms) so one flick turns one page. */
const WHEEL_STEP = 90;
const TURN_COOLDOWN_MS = 650;
/** How fast the camera eases toward the chapter (Camera.follow's smoothing per 1/60 s). */
const FOLLOW = 0.055;

export class ChapterTour {
  /**
   * @param {number} width - one chapter, in world px (the screen's width)
   * @param {number} height - the world's height
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.index = 0;
    this.wheel = 0;
    this.cooldownMs = 0;
    this.dots = Array.from(document.querySelectorAll('[data-go]'));
    this.onGo = (e) => {
      const to = e.currentTarget.dataset.go;
      if (to === 'next') this.go(this.index + 1);
      else if (to === 'prev') this.go(this.index - 1);
      else this.go(Number(to));
    };
    for (const el of this.dots) el.addEventListener('click', this.onGo);
    this.show();
  }

  /** Turns to chapter i (clamped). */
  go(i) {
    const next = Math.max(0, Math.min(CHAPTERS.length - 1, i | 0));
    if (next === this.index) return;
    this.index = next;
    this.cooldownMs = TURN_COOLDOWN_MS;
    this.wheel = 0;
    this.show();
  }

  /** The page shows this chapter's panel and marks its dot. */
  show() {
    const id = CHAPTERS[this.index].id;
    document.body.dataset.chapter = id;
    for (const el of this.dots) el.classList.toggle('active', el.dataset.go === String(this.index));
  }

  /** Reads the wheel and keys, eases the camera. Call from Scene.update. */
  update(dtRatio, deltaMs) {
    this.cooldownMs = Math.max(0, this.cooldownMs - deltaMs);
    // Trackpads send many small deltas: they add up, and fade if the hand stops.
    this.wheel = this.wheel * 0.9 + Mouse.wheel;
    if (this.cooldownMs === 0) {
      if (this.wheel > WHEEL_STEP) this.go(this.index + 1);
      else if (this.wheel < -WHEEL_STEP) this.go(this.index - 1);
    }
    if (Keyboard.isPressed('arrowright') || Keyboard.isPressed('pagedown') || Keyboard.isPressed('arrowdown')) {
      this.go(this.index + 1);
    }
    if (Keyboard.isPressed('arrowleft') || Keyboard.isPressed('pageup') || Keyboard.isPressed('arrowup')) {
      this.go(this.index - 1);
    }
    Camera.follow((this.index + 0.5) * this.width, this.height / 2, FOLLOW, dtRatio);
  }

  /** The time of day at the camera: the chapters' times, blended across the pan. */
  day() {
    const c = Math.max(0, Math.min(CHAPTERS.length - 1, Camera.centerX / this.width - 0.5));
    const k = Math.min(CHAPTERS.length - 2, Math.floor(c));
    const t = c - k;
    const s = t * t * (3 - 2 * t);
    return CHAPTERS[k].day + (CHAPTERS[k + 1].day - CHAPTERS[k].day) * s;
  }

  destroy() {
    for (const el of this.dots) el.removeEventListener('click', this.onGo);
  }
}
