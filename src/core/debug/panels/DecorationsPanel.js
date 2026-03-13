// DecorationsPanel.js — Decoration pool counts (total, active, visible, sprites)

import { createPanel, createRow, createStat, createDivider } from '../ui/DebugDOM.js';
import { formatNumber } from '../../utils.js';
import { DecorationPool } from '../../DecorationPool.js';
import { RENDERER_STATS } from '../stats/StatsCollector.js';

export class DecorationsPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  create() {
    this.panel = createPanel();

    const statsRow = createRow();
    this.elements.decorationTotal = createStat('Total: --');
    this.elements.decorationActive = createStat('Active: --');
    this.elements.decorationVisible = createStat('Visible: --');
    this.elements.decorationSprites = createStat('Sprites: --', 'renderer');

    statsRow.appendChild(this.elements.decorationTotal);
    statsRow.appendChild(this.elements.decorationActive);
    statsRow.appendChild(this.elements.decorationVisible);
    statsRow.appendChild(createDivider());
    statsRow.appendChild(this.elements.decorationSprites);

    this.panel.appendChild(statsRow);
    return this.panel;
  }

  attach() {}

  update() {
    const stats = this.debugUI.stats;
    const pv = stats.prev;
    const rendererView = stats.workerStatViews?.renderer;

    if (this.elements.decorationTotal) {
      const total = (DecorationPool.maxDecorations || 0) | 0;
      if (total !== pv.decorationTotal) {
        pv.decorationTotal = total;
        this.elements.decorationTotal.textContent = 'Total: ' + formatNumber(total);
      }
    }

    if (this.elements.decorationActive && rendererView) {
      const active = (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      if (active !== pv.decorationActive) {
        pv.decorationActive = active;
        this.elements.decorationActive.textContent = 'Active: ' + formatNumber(active);
      }
    }

    if (this.elements.decorationVisible && rendererView) {
      const visible = (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      if (visible !== pv.decorationVisible) {
        pv.decorationVisible = visible;
        this.elements.decorationVisible.textContent = 'Visible: ' + formatNumber(visible);
      }
    }

    if (this.elements.decorationSprites && rendererView) {
      const sprites = (rendererView[RENDERER_STATS.DECORATION_SPRITES] || 0) | 0;
      if (sprites !== pv.decorationSprites) {
        pv.decorationSprites = sprites;
        this.elements.decorationSprites.textContent = 'Sprites: ' + formatNumber(sprites);
      }
    }
  }
}
