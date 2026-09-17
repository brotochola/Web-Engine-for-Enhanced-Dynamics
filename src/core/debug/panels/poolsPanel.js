// PoolsPanel.js — Decorations inspect; particles / bullets paint + erase + clear

import { createPanel, createRow, createStat, createButton } from '../ui/debugDom.js';
import { formatNumber } from '../../../util/utils.js';
import { DecorationPool } from '../../decorationPool.js';
import { BulletPool } from '../../bulletPool.js';
import { ParticleEmitter } from '../../particleEmitter.js';
import { PARTICLE_STATS, RENDERER_STATS } from '../stats/statsCollector.js';

export class PoolsPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  create() {
    this.panel = createPanel();

    this.elements.decoBlock = this._makeBlock('Decorations', 'decoration', {
      inspect: true,
      erase: true,
      clear: true,
    });
    this.elements.particleBlock = this._makeBlock('Particles', 'particle', {
      paint: true,
      erase: true,
      clear: true,
    });
    this.elements.bulletBlock = this._makeBlock('Bullets', 'bullet', {
      paint: true,
      erase: true,
      clear: true,
    });

    return this.panel;
  }

  _makeBlock(title, kind, opts) {
    const wrap = document.createElement('div');
    wrap.className = 'debug-ui-pool-block';

    const head = createRow();
    const titleEl = createStat(title);
    titleEl.style.fontWeight = 'bold';
    head.appendChild(titleEl);
    const countEl = createStat('-- / --');
    head.appendChild(countEl);
    const extraEl = createStat('');
    head.appendChild(extraEl);
    wrap.appendChild(head);

    const tools = createRow('margin-top:6px;gap:8px');
    let inspectBtn = null;
    let paintBtn = null;
    let eraseBtn = null;
    let clearBtn = null;

    if (opts.inspect) {
      inspectBtn = createButton('Inspect', 'tool', () => this.debugUI.tools.toggleInspector(kind));
      tools.appendChild(inspectBtn);
    }
    if (opts.paint) {
      paintBtn = createButton('Paint', 'tool', () => this.debugUI.tools.togglePoolPaint(kind));
      tools.appendChild(paintBtn);
    }
    if (opts.erase) {
      eraseBtn = createButton('Eraser', 'danger', () => this.debugUI.tools.togglePoolEraser(kind));
      tools.appendChild(eraseBtn);
    }
    if (opts.clear) {
      clearBtn = createButton('Clear all', 'danger', () => this.debugUI.tools.clearPool(kind));
      tools.appendChild(clearBtn);
    }

    wrap.appendChild(tools);
    this.panel.appendChild(wrap);

    return { wrap, countEl, extraEl, inspectBtn, paintBtn, eraseBtn, clearBtn, kind };
  }

  attach() {
    this.updateInspectButtons();
  }

  updateInspectButtons() {
    const tools = this.debugUI.tools;
    const e = this.elements;
    if (e.decoBlock?.inspectBtn) {
      e.decoBlock.inspectBtn.classList.toggle('active', tools.inspectorActive && tools.inspectKind === 'decoration');
    }
    if (e.decoBlock?.eraseBtn) {
      e.decoBlock.eraseBtn.classList.toggle('active', tools.poolEraserKind === 'decoration');
    }
    if (e.particleBlock?.paintBtn) {
      e.particleBlock.paintBtn.classList.toggle('active', tools.poolPaintKind === 'particle');
    }
    if (e.particleBlock?.eraseBtn) {
      e.particleBlock.eraseBtn.classList.toggle('active', tools.poolEraserKind === 'particle');
    }
    if (e.bulletBlock?.paintBtn) {
      e.bulletBlock.paintBtn.classList.toggle('active', tools.poolPaintKind === 'bullet');
    }
    if (e.bulletBlock?.eraseBtn) {
      e.bulletBlock.eraseBtn.classList.toggle('active', tools.poolEraserKind === 'bullet');
    }
  }

  update() {
    const stats = this.debugUI.stats;
    const pv = stats.prev;
    const particleView = stats.workerStatViews?.particle;
    const rendererView = stats.workerStatViews?.renderer;
    const e = this.elements;

    const decoMax = (DecorationPool.maxCount || 0) | 0;
    e.decoBlock.wrap.style.display = decoMax > 0 ? '' : 'none';
    if (decoMax > 0) {
      const active = rendererView ? (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0 : 0;
      const visible = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0 : 0;
      const sprites = rendererView ? (rendererView[RENDERER_STATS.DECORATION_SPRITES] || 0) | 0 : 0;
      if (active !== pv.decorationActive || decoMax !== pv.decorationTotal) {
        pv.decorationActive = active;
        pv.decorationTotal = decoMax;
        e.decoBlock.countEl.textContent = formatNumber(active) + ' / ' + formatNumber(decoMax);
      }
      if (visible !== pv.decorationVisible || sprites !== pv.decorationSprites) {
        pv.decorationVisible = visible;
        pv.decorationSprites = sprites;
        e.decoBlock.extraEl.textContent = 'vis ' + formatNumber(visible) + ' · sprites ' + formatNumber(sprites);
      }
    }

    const pMax = (ParticleEmitter.maxCount || 0) | 0;
    e.particleBlock.wrap.style.display = pMax > 0 ? '' : 'none';
    if (pMax > 0 && particleView) {
      const aP = (particleView[PARTICLE_STATS.ACTIVE_PARTICLES] || 0) | 0;
      const tP = (particleView[PARTICLE_STATS.TOTAL_PARTICLES] || 0) | 0;
      const vP = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0) | 0 : 0;
      if (aP !== pv.activeP || tP !== pv.totalP) {
        pv.activeP = aP;
        pv.totalP = tP;
        e.particleBlock.countEl.textContent = formatNumber(aP) + ' / ' + formatNumber(tP || pMax);
      }
      if (vP !== pv.visibleP) {
        pv.visibleP = vP;
        e.particleBlock.extraEl.textContent = 'vis ' + formatNumber(vP);
      }
    }

    const bMax = (BulletPool.maxCount || 0) | 0;
    e.bulletBlock.wrap.style.display = bMax > 0 ? '' : 'none';
    if (bMax > 0 && particleView) {
      const aB = (particleView[PARTICLE_STATS.ACTIVE_BULLETS] || 0) | 0;
      if (aB !== pv.bulletActive || bMax !== pv.bulletTotal) {
        pv.bulletActive = aB;
        pv.bulletTotal = bMax;
        e.bulletBlock.countEl.textContent = formatNumber(aB) + ' / ' + formatNumber(bMax);
      }
    }
  }
}
