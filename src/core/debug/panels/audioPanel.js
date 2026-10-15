// AudioPanel.js — Mixer debug: device, output graph, playing voices, loaded assets.

import { createPanel, createRow, createStat, createButton } from '../ui/debugDom.js';
import { SoundManager } from '../../soundManager.js';
import { formatBytes } from '../../../util/sceneBufferMemory.js';

const HISTORY = 150;
const DB_FLOOR = -60;
const CLIP_HOLD_MS = 1000;

function linToDb(lin) {
  if (!(lin > 0)) return DB_FLOOR;
  const db = 20 * Math.log10(lin);
  if (db < DB_FLOOR) return DB_FLOOR;
  if (db > 0) return 0;
  return db;
}

function fmtDb(lin) {
  if (!(lin > 0)) return '-inf';
  const db = 20 * Math.log10(lin);
  if (db < DB_FLOOR) return '-60';
  return db.toFixed(1);
}

function meterPct(lin) {
  return ((linToDb(lin) - DB_FLOOR) / -DB_FLOOR) * 100;
}

function dbToY(db, height) {
  const t = (db - DB_FLOOR) / -DB_FLOOR;
  return height - 1 - t * (height - 2);
}

function setText(el, text) {
  if (el._t === text) return;
  el._t = text;
  el.textContent = text;
}

function fmtRate(rate) {
  if (!(rate > 0)) return '—';
  return rate >= 1000 ? rate / 1000 + ' kHz' : rate + ' Hz';
}

function fmtDuration(asset) {
  if (asset.state !== 'ready' || !(asset.duration > 0)) return '—';
  return asset.duration.toFixed(2) + 's';
}

export class AudioPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
    this._voices = [];
    this._voiceRows = [];
    this._assetCache = [];
    this._matched = [];
    this._assetRows = [];
    this._lenById = new Map();
    this._useCount = new Map();
    this._assetRev = -1;
    this._filter = '';
    this._peakHist = new Float32Array(HISTORY);
    this._rmsHist = new Float32Array(HISTORY);
    this._histHead = 0;
    this._histCount = 0;
    this._clipUntil = 0;
    this._gctx = null;
    this._channelRev = -1;
    this._busStrips = [];
    this._busCounts = new Map();
  }

  create() {
    this.panel = createPanel();
    const root = document.createElement('div');
    root.className = 'debug-ui-audio';

    const stats = createRow('gap:8px');
    this.elements.state = createStat('Context —', 'audio');
    this.elements.resume = createButton('Resume', '', () => SoundManager.resume());
    this.elements.resume.style.display = 'none';
    this.elements.unlock = createStat('—');
    this.elements.rate = createStat('—');
    this.elements.latency = createStat('—');
    this.elements.process = createStat('—');
    stats.append(
      this.elements.state,
      this.elements.resume,
      this.elements.unlock,
      this.elements.rate,
      this.elements.latency,
      this.elements.process,
    );
    root.appendChild(stats);

    const budget = createRow('gap:8px');
    this.elements.voices = createStat('Voices —');
    this.elements.dropped = createStat('Dropped —');
    budget.append(
      this.elements.voices,
      this.elements.dropped,
      createButton('Clear dropped', '', () => SoundManager.clearDropped()),
      createButton('Stop all', 'danger', () => SoundManager.stopAll()),
    );
    root.appendChild(budget);

    this.elements.busRow = document.createElement('div');
    this.elements.busRow.className = 'debug-ui-audio-buses';
    root.appendChild(this.elements.busRow);

    const output = document.createElement('div');
    output.className = 'debug-ui-audio-out';
    const meters = document.createElement('div');
    meters.className = 'debug-ui-audio-meters';
    const left = this._meter('L');
    const right = this._meter('R');
    this.elements.meterL = left.fill;
    this.elements.dbL = left.db;
    this.elements.meterR = right.fill;
    this.elements.dbR = right.db;
    this.elements.clip = document.createElement('span');
    this.elements.clip.className = 'debug-ui-audio-clip';
    this.elements.clip.textContent = 'CLIP';
    meters.append(left.root, right.root, this.elements.clip);
    this.elements.readout = createStat('Peak — · RMS —');
    const canvas = document.createElement('canvas');
    canvas.className = 'debug-ui-audio-graph';
    this.elements.graph = canvas;
    output.append(meters, this.elements.readout, canvas);
    root.appendChild(output);

    const columns = document.createElement('div');
    columns.className = 'debug-ui-audio-columns';

    const voiceCol = document.createElement('div');
    voiceCol.className = 'debug-ui-audio-col';
    voiceCol.appendChild(this._title('Playing'));
    const voiceScroll = document.createElement('div');
    voiceScroll.className = 'debug-ui-audio-scroll';
    this.elements.voiceEmpty = this._empty('No voices playing');
    this.elements.voiceHead = this._head(
      ['#', 'Name', 'Bus', 'Vol', 'Progress', ''],
      'debug-ui-audio-voice',
    );
    this.elements.voiceHead.style.display = 'none';
    this.elements.voiceList = document.createElement('div');
    voiceScroll.append(this.elements.voiceEmpty, this.elements.voiceHead, this.elements.voiceList);
    voiceCol.appendChild(voiceScroll);

    const assetCol = document.createElement('div');
    assetCol.className = 'debug-ui-audio-col';
    const assetTitle = createRow('gap:8px');
    assetTitle.appendChild(this._title('Loaded assets'));
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'debug-ui-audio-filter';
    filter.placeholder = 'Filter';
    filter.addEventListener('input', () => {
      this._filter = filter.value.trim().toLowerCase();
      this._syncAssets();
    });
    filter.addEventListener('keydown', (event) => event.stopPropagation());
    filter.addEventListener('keyup', (event) => event.stopPropagation());
    assetTitle.appendChild(filter);
    assetCol.appendChild(assetTitle);

    const assetScroll = document.createElement('div');
    assetScroll.className = 'debug-ui-audio-scroll';
    this.elements.assetEmpty = this._empty('No audio assets loaded');
    this.elements.assetHead = this._head(
      ['Name', 'State', 'Time', 'Ch', 'Rate', 'Size', 'Use', ''],
      'debug-ui-audio-asset',
    );
    this.elements.assetHead.style.display = 'none';
    this.elements.assetList = document.createElement('div');
    assetScroll.append(this.elements.assetEmpty, this.elements.assetHead, this.elements.assetList);
    assetCol.appendChild(assetScroll);
    this.elements.assetFoot = createStat('0 assets · 0 B PCM');
    this.elements.assetFoot.classList.add('debug-ui-audio-foot');
    assetCol.appendChild(this.elements.assetFoot);
    columns.append(voiceCol, assetCol);
    root.appendChild(columns);

    this.panel.appendChild(root);
    return this.panel;
  }

  attach() {}

  update() {
    const metrics = this.debugUI.scene?.audioMetrics;
    if (!metrics) return;

    this._updateStrip(metrics);
    const levels = SoundManager.sampleOutputLevels();
    this._updateMeters(levels);
    this._pushHistory(Math.max(levels.peakL, levels.peakR), levels.rms);
    this._drawGraph();

    const rev = SoundManager.getAssetRevision();
    if (rev !== this._assetRev) {
      this._assetRev = rev;
      this._recacheAssets();
    }
    this._syncVoices();
    this._syncBuses(metrics);
    this._syncAssets();
  }

  _title(text) {
    const el = document.createElement('div');
    el.className = 'debug-ui-audio-title';
    el.textContent = text;
    return el;
  }

  _empty(text) {
    const el = document.createElement('div');
    el.className = 'debug-ui-audio-empty';
    el.textContent = text;
    return el;
  }

  _head(labels, gridClass) {
    const row = document.createElement('div');
    row.className = `debug-ui-audio-head ${gridClass}`;
    for (let i = 0; i < labels.length; i++) {
      const cell = document.createElement('span');
      cell.textContent = labels[i];
      row.appendChild(cell);
    }
    return row;
  }

  _meter(label) {
    const root = document.createElement('div');
    root.className = 'debug-ui-audio-meter';
    const name = document.createElement('span');
    name.textContent = label;
    const track = document.createElement('div');
    track.className = 'debug-ui-audio-meter-track';
    const fill = document.createElement('div');
    fill.className = 'debug-ui-audio-meter-fill';
    track.appendChild(fill);
    const db = document.createElement('span');
    db.className = 'debug-ui-audio-meter-db';
    db.textContent = '-inf';
    root.append(name, track, db);
    return { root, fill, db };
  }

  _updateStrip(metrics) {
    const state = metrics.state || 'closed';
    setText(this.elements.state, 'Context ' + state);
    this.elements.resume.style.display = state === 'suspended' ? '' : 'none';
    setText(
      this.elements.unlock,
      SoundManager.isAudioUnlocked() ? 'unlocked' : 'waiting for gesture',
    );
    setText(this.elements.rate, fmtRate(metrics.sampleRate | 0));
    const latencyMs = ((metrics.baseLatency || 0) + (metrics.outputLatency || 0)) * 1000;
    setText(this.elements.latency, 'Latency ' + latencyMs.toFixed(2) + ' ms');
    setText(this.elements.process, 'Process ' + (metrics.processMs || 0).toFixed(2) + ' ms');

    const active = metrics.activeSlots | 0;
    const max = metrics.maxSlots | 0;
    setText(this.elements.voices, `Voices ${active}/${max}`);
    this.elements.voices.classList.toggle('is-cap', max > 0 && active >= max);
    setText(this.elements.dropped, 'Dropped ' + ((metrics.dropped || 0) | 0));
  }

  _updateMeters(levels) {
    const now = performance.now();
    if (levels.clip) this._clipUntil = now + CLIP_HOLD_MS;
    this.elements.clip.classList.toggle('is-on', now < this._clipUntil);

    this.elements.meterL.style.width = meterPct(levels.peakL).toFixed(1) + '%';
    this.elements.meterR.style.width = meterPct(levels.peakR).toFixed(1) + '%';
    setText(this.elements.dbL, fmtDb(levels.peakL));
    setText(this.elements.dbR, fmtDb(levels.peakR));
    setText(
      this.elements.readout,
      `Peak ${fmtDb(Math.max(levels.peakL, levels.peakR))} dB · RMS ${fmtDb(levels.rms)} dB`,
    );
  }

  _pushHistory(peak, rms) {
    this._peakHist[this._histHead] = peak > 0 ? peak : 0;
    this._rmsHist[this._histHead] = rms > 0 ? rms : 0;
    this._histHead = (this._histHead + 1) % HISTORY;
    if (this._histCount < HISTORY) this._histCount++;
  }

  _drawGraph() {
    const canvas = this.elements.graph;
    const cssW = canvas.clientWidth | 0;
    const cssH = 56;
    if (cssW <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bufW = Math.max(1, Math.floor(cssW * dpr));
    const bufH = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW;
      canvas.height = bufH;
    }
    const ctx = this._gctx || (this._gctx = canvas.getContext('2d'));
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const grid = [0, -12, -24, -48];
    for (let g = 0; g < grid.length; g++) {
      const y = dbToY(grid[g], cssH);
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = '10px sans-serif';
    ctx.fillText('0', 4, 11);
    ctx.fillText('-60', 4, cssH - 3);

    const n = this._histCount;
    if (n < 1) return;
    const start = n < HISTORY ? 0 : this._histHead;
    const denom = Math.max(1, n - 1);
    const peak = this._peakHist;
    const rms = this._rmsHist;

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % HISTORY;
      const x = (i / denom) * (cssW - 1);
      const y = dbToY(linToDb(rms[idx]), cssH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(cssW - 1, cssH - 1);
    ctx.lineTo(0, cssH - 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % HISTORY;
      const x = (i / denom) * (cssW - 1);
      const y = dbToY(linToDb(peak[idx]), cssH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _recacheAssets() {
    const src = SoundManager.getAssetCatalog();
    const cache = this._assetCache;
    cache.length = 0;
    this._lenById.clear();
    for (let i = 0; i < src.length; i++) {
      const entry = src[i];
      cache.push(entry);
      this._lenById.set(entry.id, entry.length | 0);
    }
    cache.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  _syncBuses(metrics) {
    const rev = SoundManager.getChannelRevision();
    if (rev !== this._channelRev) {
      this._channelRev = rev;
      this._rebuildBuses();
    }
    for (let i = 0; i < this._busStrips.length; i++) {
      this._patchBus(this._busStrips[i], metrics);
    }
  }

  _rebuildBuses() {
    const row = this.elements.busRow;
    row.textContent = '';
    this._busStrips.length = 0;
    const names = SoundManager.listChannels();
    for (let i = 0; i < names.length; i++) {
      const strip = this._createBusStrip(names[i], i);
      this._busStrips.push(strip);
      row.appendChild(strip.root);
    }
    const gap = document.createElement('div');
    gap.className = 'debug-ui-audio-bus-gap';
    row.appendChild(gap);
    const master = this._createMasterStrip();
    this._busStrips.push(master);
    row.appendChild(master.root);
  }

  _createBusStrip(name, index) {
    const root = document.createElement('div');
    root.className = 'debug-ui-audio-strip';
    const title = document.createElement('div');
    title.className = 'debug-ui-audio-strip-name';
    title.textContent = name;
    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'debug-ui-audio-fader';
    fader.min = '0';
    fader.max = '100';
    fader.step = '1';
    fader.value = '100';
    this._bindFader(fader, (value) => {
      SoundManager.channel(name).volume = value / 100;
      setText(pct, value + '%');
    });
    const pct = document.createElement('div');
    pct.className = 'debug-ui-audio-strip-pct';
    pct.textContent = '100%';
    const pan = document.createElement('input');
    pan.type = 'range';
    pan.className = 'debug-ui-range debug-ui-audio-pan-slider';
    pan.min = '-100';
    pan.max = '100';
    pan.step = '1';
    pan.value = '0';
    this._bindFader(pan, (value) => {
      const p = value / 100;
      SoundManager.channel(name).pan = p;
      setText(panLabel, p.toFixed(2));
    });
    const panLabel = document.createElement('div');
    panLabel.className = 'debug-ui-audio-strip-pan';
    panLabel.textContent = '0.00';
    const mute = createButton('M', '', () => {
      const bus = SoundManager.channel(name);
      bus.muted = !bus.muted;
    });
    mute.title = 'Mute';
    const count = document.createElement('div');
    count.className = 'debug-ui-audio-strip-count';
    count.textContent = '0';
    root.append(title, fader, pct, pan, panLabel, mute, count);
    return { root, name, index, fader, pct, pan, panLabel, mute, count, master: false };
  }

  _createMasterStrip() {
    const root = document.createElement('div');
    root.className = 'debug-ui-audio-strip debug-ui-audio-strip-master';
    const title = document.createElement('div');
    title.className = 'debug-ui-audio-strip-name';
    title.textContent = 'Master';
    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'debug-ui-audio-fader';
    fader.min = '0';
    fader.max = '100';
    fader.step = '1';
    fader.value = '100';
    this._bindFader(fader, (value) => {
      SoundManager.setMasterVolume(value / 100);
      setText(pct, value + '%');
    });
    const pct = document.createElement('div');
    pct.className = 'debug-ui-audio-strip-pct';
    pct.textContent = '100%';
    const mixLabel = document.createElement('div');
    mixLabel.className = 'debug-ui-audio-strip-pan';
    mixLabel.textContent = 'Mix';
    const mix = document.createElement('input');
    mix.type = 'range';
    mix.className = 'debug-ui-range debug-ui-audio-pan-slider';
    mix.min = '0';
    mix.max = '100';
    mix.step = '1';
    mix.value = '50';
    this._bindFader(mix, (value) => {
      SoundManager.setMixGain(value / 100);
      setText(mixLabel, 'Mix ' + value + '%');
    });
    const mute = createButton('M', '', () => SoundManager.setMuted(!SoundManager.isMuted()));
    mute.title = 'Mute master';
    root.append(title, fader, pct, mixLabel, mix, mute);
    return { root, fader, pct, pan: mix, panLabel: mixLabel, mute, master: true };
  }

  _bindFader(input, write) {
    input.addEventListener('pointerdown', (event) => {
      input._drag = true;
      input.setPointerCapture(event.pointerId);
    });
    const endDrag = () => {
      input._drag = false;
    };
    input.addEventListener('pointerup', endDrag);
    input.addEventListener('pointercancel', endDrag);
    input.addEventListener('input', () => write(input.value | 0));
  }

  _patchBus(strip, metrics) {
    if (strip.master) {
      this._pullRange(strip.fader, strip.pct, metrics.masterVolume || 0, false);
      this._pullRange(strip.pan, null, metrics.mixGain || 0, false);
      setText(strip.panLabel, 'Mix ' + (((metrics.mixGain || 0) * 100 + 0.5) | 0) + '%');
      const muted = !!metrics.muted;
      strip.mute.classList.toggle('active', muted);
      return;
    }
    const bus = SoundManager.channel(strip.name);
    this._pullRange(strip.fader, strip.pct, bus.volume, false);
    if (!strip.pan._drag) {
      const panPct = (bus.pan * 100 + (bus.pan >= 0 ? 0.5 : -0.5)) | 0;
      if ((strip.pan.value | 0) !== panPct) strip.pan.value = String(panPct);
      setText(strip.panLabel, bus.pan.toFixed(2));
    }
    strip.mute.classList.toggle('active', bus.muted);
    setText(strip.count, String(this._busCounts.get(strip.index) | 0));
  }

  _pullRange(input, label, linear, signed) {
    if (input._drag) return;
    const pct = signed
      ? (linear * 100 + (linear >= 0 ? 0.5 : -0.5)) | 0
      : (linear * 100 + 0.5) | 0;
    if ((input.value | 0) !== pct) input.value = String(pct);
    if (label) setText(label, pct + '%');
  }

  _syncVoices() {
    const voices = SoundManager.readPlayingVoices(this._voices);
    const counts = this._useCount;
    const buses = this._busCounts;
    counts.clear();
    buses.clear();
    for (let i = 0; i < voices.length; i++) {
      const id = voices[i].audioId;
      counts.set(id, (counts.get(id) | 0) + 1);
      const bus = voices[i].channel | 0;
      buses.set(bus, (buses.get(bus) | 0) + 1);
    }

    const n = voices.length;
    this.elements.voiceEmpty.style.display = n ? 'none' : '';
    this.elements.voiceHead.style.display = n ? '' : 'none';
    const list = this.elements.voiceList;
    while (this._voiceRows.length < n) {
      const row = this._createVoiceRow();
      this._voiceRows.push(row);
      list.appendChild(row.root);
    }
    for (let i = 0; i < this._voiceRows.length; i++) {
      const row = this._voiceRows[i];
      if (i >= n) {
        row.root.style.display = 'none';
        continue;
      }
      row.root.style.display = '';
      this._patchVoice(row, voices[i]);
    }
  }

  _createVoiceRow() {
    const root = document.createElement('div');
    root.className = 'debug-ui-audio-row debug-ui-audio-voice';
    const slot = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'debug-ui-audio-name';
    const bus = document.createElement('span');
    const vol = document.createElement('span');
    const progress = this._bar();
    const stop = createButton('Stop', '', () => SoundManager.stopSlot(stop._slot));
    root.append(slot, name, bus, vol, progress.root, stop);
    return { root, slot, name, bus, vol, progress, stop };
  }

  _patchVoice(row, voice) {
    setText(row.slot, String(voice.slot));
    setText(row.name, voice.name);
    setText(row.bus, voice.channelName || '—');
    const vol = voice.volume > 0 ? voice.volume : 0;
    setText(row.vol, vol.toFixed(2));
    const len = this._lenById.get(voice.audioId) | 0;
    let progress = 0;
    if (len > 0) {
      progress = voice.cursor / len;
      if (progress < 0) progress = 0;
      else if (progress > 1) progress = 1;
    }
    row.progress.fill.style.width = (progress * 100).toFixed(1) + '%';
    setText(row.progress.label, len > 0 ? Math.round(progress * 100) + '%' : '—');
    row.stop._slot = voice.slot;
  }

  _syncAssets() {
    const cache = this._assetCache;
    const matched = this._matched;
    const q = this._filter;
    matched.length = 0;
    let bytes = 0;
    let loading = 0;
    for (let i = 0; i < cache.length; i++) {
      const asset = cache[i];
      if (asset.state === 'ready') bytes += asset.bytes | 0;
      else if (asset.state === 'loading') loading++;
      if (q && asset.name.toLowerCase().indexOf(q) === -1) continue;
      matched.push(asset);
    }

    const n = matched.length;
    const empty = this.elements.assetEmpty;
    if (cache.length === 0) {
      setText(empty, 'No audio assets loaded');
      empty.style.display = '';
    } else if (n === 0) {
      setText(empty, 'No assets match');
      empty.style.display = '';
    } else {
      empty.style.display = 'none';
    }
    this.elements.assetHead.style.display = n ? '' : 'none';

    const list = this.elements.assetList;
    while (this._assetRows.length < n) {
      const row = this._createAssetRow();
      this._assetRows.push(row);
      list.appendChild(row.root);
    }
    for (let i = 0; i < this._assetRows.length; i++) {
      const row = this._assetRows[i];
      if (i >= n) {
        row.root.style.display = 'none';
        continue;
      }
      row.root.style.display = '';
      this._patchAsset(row, matched[i]);
    }

    let foot = `${cache.length} assets · ${formatBytes(bytes)} PCM`;
    if (loading) foot += ` · ${loading} loading`;
    setText(this.elements.assetFoot, foot);
  }

  _createAssetRow() {
    const root = document.createElement('div');
    root.className = 'debug-ui-audio-row debug-ui-audio-asset';
    const name = document.createElement('span');
    name.className = 'debug-ui-audio-name';
    const state = document.createElement('span');
    const time = document.createElement('span');
    const channels = document.createElement('span');
    const rate = document.createElement('span');
    const size = document.createElement('span');
    const uses = document.createElement('span');
    const actions = document.createElement('span');
    actions.className = 'debug-ui-audio-actions';
    const play = createButton('Play', '', () => {
      if (play._name) SoundManager.play(play._name, 1);
    });
    const stop = createButton('Stop', '', () => {
      if (stop._name) SoundManager.stop(stop._name);
    });
    actions.append(play, stop);
    root.append(name, state, time, channels, rate, size, uses, actions);
    return { root, name, state, time, channels, rate, size, uses, play, stop };
  }

  _patchAsset(row, asset) {
    setText(row.name, asset.name);
    row.name.title = asset.error ? asset.src + '\n' + asset.error : asset.src || '';
    setText(row.state, asset.state);
    row.state.classList.toggle('is-error', asset.state === 'error');
    row.state.title = asset.error || '';
    setText(row.time, fmtDuration(asset));
    setText(row.channels, asset.channels > 0 ? String(asset.channels) : '—');
    setText(row.rate, fmtRate(asset.sampleRate | 0));
    setText(row.size, asset.bytes > 0 ? formatBytes(asset.bytes) : '—');
    setText(row.uses, String(this._useCount.get(asset.id) | 0));
    row.play.disabled = asset.state !== 'ready';
    row.play._name = asset.name;
    row.stop._name = asset.name;
  }

  _bar() {
    const root = document.createElement('span');
    root.className = 'debug-ui-audio-bar';
    const track = document.createElement('span');
    track.className = 'debug-ui-audio-bar-track';
    const fill = document.createElement('span');
    fill.className = 'debug-ui-audio-bar-fill';
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'debug-ui-audio-bar-label';
    root.append(track, label);
    return { root, fill, label };
  }
}
