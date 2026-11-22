// DebugDOM.js — Shared DOM creation helpers used by all debug panels

/**
 * Inject DebugUI CSS styles into <head>.
 * Supports both bundled mode (WEED.DebugUICSS) and dev-mode (fetch from file).
 */
export async function injectStyles() {
  if (document.getElementById('debug-ui-styles')) return;

  let cssText = null;

  if (typeof globalThis.WEED?.ensureEmbeddedSources === 'function') {
    await globalThis.WEED.ensureEmbeddedSources();
  }

  if (typeof globalThis.WEED !== 'undefined' && globalThis.WEED.DebugUICSS) {
    cssText = globalThis.WEED.DebugUICSS;
  } else {
    try {
      const cssPath = new URL('../debugUi.css', import.meta.url).href;
      // Revalidated: a server that lets the browser keep CSS an hour showed an old stylesheet under new panels.
      const response = await fetch(cssPath, { cache: 'no-cache' });
      cssText = await response.text();
    } catch (error) {
      console.error('Failed to load DebugUI.css:', error);
    }
  }

  if (cssText) {
    const style = document.createElement('style');
    style.id = 'debug-ui-styles';
    style.textContent = cssText;
    document.head.appendChild(style);
  }
}

/**
 * An element with its class and text (CR-23: the panels' three-line create, class, text). An empty class sets none;
 * text, when given, is set after the class, as the lines it replaces did.
 * @param {string} tag
 * @param {string} [className]
 * @param {string|number} [text]
 */
export function elem(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Create a <span class="debug-ui-stat …"> element */
export function createStat(text, className = '') {
  const span = document.createElement('span');
  span.className = `debug-ui-stat ${className}`;
  span.textContent = text;
  return span;
}

/** Create a vertical divider element */
export function createDivider() {
  const div = document.createElement('div');
  div.className = 'debug-ui-divider';
  return div;
}

/** Create a header tab (icon + label + arrow) */
export function createTab(icon, label, sectionId, onClick) {
  const tab = document.createElement('div');
  tab.className = 'debug-ui-tab';
  tab.innerHTML = `<span class="icon">${icon}</span><span>${label}</span><span class="arrow">▼</span>`;
  tab.onclick = () => onClick(sectionId);
  return tab;
}

/** Create a standard debug-ui-panel div */
export function createPanel() {
  const panel = document.createElement('div');
  panel.className = 'debug-ui-panel';
  return panel;
}

/** Create a debug-ui-row div with optional inline styles */
export function createRow(styles = '') {
  const row = document.createElement('div');
  row.className = 'debug-ui-row';
  if (styles) row.style.cssText = styles;
  return row;
}

/** Create a <button class="debug-ui-btn …"> */
export function createButton(text, extraClass = '', onClick = null) {
  const btn = document.createElement('button');
  btn.className = `debug-ui-btn ${extraClass}`.trim();
  btn.textContent = text;
  if (onClick) btn.onclick = onClick;
  return btn;
}
