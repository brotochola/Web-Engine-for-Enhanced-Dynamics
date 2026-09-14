// MemoryPanel.js — Scene SharedArrayBuffer usage + WASM HEAP / JS heap

import { createPanel, createStat } from '../ui/DebugDOM.js';
import { formatBytes } from '../../sceneBufferMemory.js';

const TOP_BUFFERS = 12;
const TOP_WASTE = 8;

export class MemoryPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  create() {
    this.panel = createPanel();

    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;gap:10px';

    const totals = document.createElement('div');
    totals.style.cssText =
      'display:flex;flex-direction:column;gap:4px;padding:8px;background:rgba(0,0,0,0.3);border-radius:4px';
    this.elements.total = createStat('SAB total: --');
    this.elements.bufferCount = createStat('Buffers: --');
    this.elements.wasmHeap = createStat('Box2D WASM HEAP: --');
    this.elements.wasmHeapHigh = createStat('Box2D WASM HEAP high-water: --');
    this.elements.wasmChannels = createStat('Box2D body channels: --');
    this.elements.jsHeap = createStat('JS heap: --');
    this.elements.jsHeap.style.display = 'none';
    totals.appendChild(this.elements.total);
    totals.appendChild(this.elements.bufferCount);
    totals.appendChild(this.elements.wasmHeap);
    totals.appendChild(this.elements.wasmHeapHigh);
    totals.appendChild(this.elements.wasmChannels);
    totals.appendChild(this.elements.jsHeap);
    container.appendChild(totals);

    container.appendChild(this._sectionTitle('Capacity insights'));
    this.elements.insights = document.createElement('div');
    this.elements.insights.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:120px;overflow:auto';
    container.appendChild(this.elements.insights);

    container.appendChild(this._sectionTitle('Categories'));
    this.elements.categories = document.createElement('div');
    this.elements.categories.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:140px;overflow:auto';
    container.appendChild(this.elements.categories);

    container.appendChild(this._sectionTitle('Top buffers'));
    this.elements.topBuffers = document.createElement('div');
    this.elements.topBuffers.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:160px;overflow:auto';
    container.appendChild(this.elements.topBuffers);

    container.appendChild(this._sectionTitle('Component waste'));
    this.elements.waste = document.createElement('div');
    this.elements.waste.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:140px;overflow:auto';
    container.appendChild(this.elements.waste);

    this.panel.appendChild(container);
    return this.panel;
  }

  attach() {}

  update() {
    const scene = this.debugUI.scene;
    if (!scene?.getMemoryUsageReport) return;

    const report = scene.getMemoryUsageReport();
    this.elements.total.textContent = `SAB total: ${report.totalFormatted || '--'}`;
    this.elements.bufferCount.textContent = `Buffers: ${report.bufferCount ?? '--'}`;

    const heap = report.box2dHeap;
    if (heap?.ready) {
      const usedLabel = heap.usedBytes > 0 ? heap.usedFormatted : '?';
      this.elements.wasmHeap.textContent = `Box2D WASM HEAP: ${usedLabel} used / ${heap.reservedFormatted} reserved`;
      this.elements.wasmHeapHigh.textContent = `Box2D WASM HEAP high-water: ${
        heap.highWaterBytes > 0 ? heap.highWaterFormatted : '--'
      }`;
      this.elements.wasmChannels.textContent = `Box2D body channels: ${heap.bodyChannelFormatted} (${heap.bodyCapacity} bodies)`;
    } else {
      this.elements.wasmHeap.textContent = 'Box2D WASM HEAP: (not ready)';
      this.elements.wasmHeapHigh.textContent = 'Box2D WASM HEAP high-water: (not ready)';
      this.elements.wasmChannels.textContent = 'Box2D body channels: (not ready)';
    }

    const mem = typeof performance !== 'undefined' ? performance.memory : null;
    if (mem && typeof mem.usedJSHeapSize === 'number') {
      this.elements.jsHeap.style.display = '';
      this.elements.jsHeap.textContent = `JS heap: ${formatBytes(mem.usedJSHeapSize)} / ${formatBytes(mem.jsHeapSizeLimit)}`;
    } else {
      this.elements.jsHeap.style.display = 'none';
    }

    this._fillSortedList(
      this.elements.insights,
      (report.capacityInsights || []).map((row) => ({
        key: row.key,
        bytes: row.bytes || 0,
        label: `${row.key}: ${row.formatted} — ${row.detail}`,
      })),
      8,
    );

    this._fillSortedList(
      this.elements.categories,
      Object.entries(report.categories || {}).map(([key, cat]) => ({
        key,
        bytes: cat.totalBytes || 0,
        label: `${key}: ${cat.totalFormatted || formatBytes(cat.totalBytes || 0)}`,
      })),
      32,
    );

    this._fillSortedList(
      this.elements.topBuffers,
      Object.entries(report.flatBreakdown || {}).map(([key, bytes]) => ({
        key,
        bytes: bytes || 0,
        label: `${key}: ${formatBytes(bytes || 0)}`,
      })),
      TOP_BUFFERS,
    );

    const wasteEntries = Object.entries(report.componentAllocations || {})
      .map(([key, alloc]) => ({
        key,
        bytes: alloc.estimatedUnusedBytes || 0,
        label: `${key}: unused ${alloc.estimatedUnusedFormatted || formatBytes(alloc.estimatedUnusedBytes || 0)} (${alloc.estimatedUnusedSlots}/${alloc.capacity})`,
      }))
      .filter((e) => e.bytes > 0);
    this._fillSortedList(this.elements.waste, wasteEntries, TOP_WASTE);
  }

  _sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'debug-ui-stat';
    el.style.cssText =
      'font-weight:bold;font-size:12px;color:rgba(255,255,255,0.9)';
    el.textContent = text;
    return el;
  }

  _fillSortedList(container, entries, limit) {
    if (!container) return;
    entries.sort((a, b) => b.bytes - a.bytes);
    const slice = entries.slice(0, limit);
    while (container.childElementCount > slice.length) {
      container.removeChild(container.lastChild);
    }
    for (let i = 0; i < slice.length; i++) {
      let row = container.children[i];
      if (!row) {
        row = createStat('--');
        row.style.cssText = 'font-size:11px;opacity:0.9';
        container.appendChild(row);
      }
      row.textContent = slice[i].label;
    }
    if (slice.length === 0) {
      let empty = container.children[0];
      if (!empty) {
        empty = createStat('--');
        empty.style.cssText = 'font-size:11px;opacity:0.6';
        container.appendChild(empty);
      }
      empty.textContent = '(none)';
      while (container.childElementCount > 1) {
        container.removeChild(container.lastChild);
      }
    }
  }
}
