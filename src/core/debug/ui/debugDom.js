// DebugDOM.js — Shared DOM creation helpers used by all debug panels

let cssPromise = null;

/**
 * The DebugUI's CSS text, loaded once: embedded in a bundle (WEED.DebugUICSS), fetched from its file from source.
 * @returns {Promise<string|null>}
 */
export function loadDebugCss() {
  if (cssPromise === null) cssPromise = readDebugCss();
  return cssPromise;
}

async function readDebugCss() {
  if (typeof globalThis.WEED?.ensureEmbeddedSources === 'function') {
    await globalThis.WEED.ensureEmbeddedSources();
  }
  if (typeof globalThis.WEED !== 'undefined' && globalThis.WEED.DebugUICSS) return globalThis.WEED.DebugUICSS;
  try {
    const response = await fetch(new URL('../debugUi.css', import.meta.url).href);
    return await response.text();
  } catch (error) {
    console.error('Failed to load DebugUI.css:', error);
    return null;
  }
}

/**
 * Inject DebugUI CSS styles into <head>.
 * Supports both bundled mode (WEED.DebugUICSS) and dev-mode (fetch from file).
 */
export async function injectStyles() {
  if (document.getElementById('debug-ui-styles')) return;

  const cssText = await loadDebugCss();

  if (cssText) {
    const style = document.createElement('style');
    style.id = 'debug-ui-styles';
    style.textContent = cssText;
    document.head.appendChild(style);
  }
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
