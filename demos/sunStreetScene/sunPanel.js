// The demo's panel: live readouts and one button per option, each with the key that does the same.

const PANEL_CSS =
  'position:fixed;right:12px;bottom:12px;z-index:940;width:340px;color:#eee;' +
  'font:13px/1.35 system-ui,sans-serif;background:rgba(10,12,20,0.78);padding:10px 12px;border-radius:8px;';
const BUTTON_CSS =
  'display:block;width:100%;text-align:left;margin-top:5px;padding:4px 8px;border:1px solid #556;border-radius:5px;' +
  'color:#eee;background:rgba(255,255,255,0.06);font:inherit;cursor:pointer;';
const NOTE_CSS = 'display:block;color:#aab;font-size:11px;line-height:1.25;';

export class SunPanel {
  el = document.createElement('div');
  readout = document.createElement('div');
  labels = new Map();

  /** @param {{ key: string, keyName: string, label: string, note: string, press: () => void }[]} rows */
  constructor(rows) {
    this.el.style.cssText = PANEL_CSS;
    this.readout.style.whiteSpace = 'pre';
    this.readout.style.fontVariantNumeric = 'tabular-nums';
    this.el.append(this.readout);
    for (const row of rows) {
      const button = document.createElement('button');
      button.style.cssText = BUTTON_CSS;
      // No focus: Space would press the button again.
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', row.press);
      const label = document.createElement('span');
      const note = document.createElement('span');
      note.style.cssText = NOTE_CSS;
      note.textContent = row.note;
      button.append(label, note);
      this.el.append(button);
      this.labels.set(row.key, { label, keyName: row.keyName, text: row.label });
    }
    document.body.append(this.el);
  }

  /** `state` goes after the row's name. */
  show(key, state) {
    const row = this.labels.get(key);
    row.label.textContent = `[${row.keyName}] ${row.text}: ${state}`;
  }

  toggle() {
    this.el.style.display = this.el.style.display === 'none' ? '' : 'none';
  }

  remove() {
    this.el.remove();
  }
}
