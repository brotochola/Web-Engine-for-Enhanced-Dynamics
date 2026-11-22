// debugUiCoverage.js — DBG-12: where the debug UI shows each lighting, sun and camera config key and each layer kind,
// or why it does not. tests/node/debugUiCoverage.test.js fails when a key of LIGHTING_DEFAULTS, SUN_DEFAULTS or
// CAMERA_DEFAULTS, or a LAYER_KIND, is in neither table, so a new option cannot land without a line in the UI or a reason.
//
// Render views (DBG-5, not built yet): a new render target in the Pixi worker that a view could show goes in DBG-5's
// view table or gets a line here once that table exists. That one is a convention: render targets are in no table.

/**
 * SUN_DEFAULTS keys the Light tab shows, and the Sun property its control drives (the test checks the property has a
 * setter or, for the hour, that setTimeOfDay exists).
 */
export const SUN_SHOWN = Object.freeze({
  angle: 'angle',
  elevation: 'elevation',
  intensity: 'intensity',
  color: 'color',
  shadowAlpha: 'shadowAlpha',
  skyLight: 'skyLight',
  startHour: 'hour',
  night: 'nightIntensity',
  dayCycle: 'dayCycle',
  enabled: 'enabled',
});

/** Config keys and layer kinds the debug UI does not show, each with its reason. */
export const NOT_SHOWN = Object.freeze({
  sun: Object.freeze({
    maxElevation: 'a day cycle bound, set once from config; the elevation slider shows where the sun is',
    shadowAngleOffset: 'set once from config (the hemisphere); the dial shows the shadows\' direction it gives',
    shadowMinLengthRatio: 'set once from config; shadows\' length follows the elevation slider',
    shadowMaxLengthRatio: 'set once from config; shadows\' length follows the elevation slider',
    shadowStretchAlphaFactor: 'set once from config, a fade of stretched shadows',
    colors: 'the hour\'s colour table, a list of stops: the colour input shows the colour it gives',
  }),
  lighting: Object.freeze({
    sun: 'the Light tab\'s sun section shows it live',
  }),
  camera: Object.freeze({}),
  layerKinds: Object.freeze({}),
});
