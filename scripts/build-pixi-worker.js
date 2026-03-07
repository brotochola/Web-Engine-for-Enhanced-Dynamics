// PixiJS 8.16 Web Worker Bundle
// ===========================
// Builds a worker-safe ESM bundle from the pixi.js npm package.
//
// Why this exists:
//   The stock pixi.min.mjs includes browser-only extensions (Accessibility,
//   EventSystem) that reference `document` and crash in a Web Worker.
//   This entry file imports only what the engine needs and removes
//   browserExt before any renderer initialization.
//
// Upgrade workflow:
//   npm install pixi.js@<version>
//   npm run build:pixi
//
// PixiJS 8.16 changes vs 8.5.2:
//   - Colors are now standard RGB throughout the API. The old internal BGR
//     byte order (Particle.color, Container tint) has been fixed — the
//     convertRGBtoBGR() workaround is no longer needed.
//   - Blend mode 'normal-npm' → use 'normal' instead. PixiJS 8.16 handles
//     non-premultiplied alpha internally.

import {
  extensions,
  browserExt,
  // Used by pixi_worker.js
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  Graphics,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  ParticleContainer,
  Particle,
  Matrix,
  Geometry,
  Mesh,
  Shader,
  GlProgram,
  RendererType,
  RenderTexture,
  DOMAdapter,
  WebWorkerAdapter,
  // Used by pixi-tilemap-module.js
  Buffer,
  BufferUsage,
  UniformGroup,
  NOOP,
  ExtensionType,
  BindGroup,
  GpuProgram,
  ViewContainer,
  State,
  Bounds,
  groupD8,
} from 'pixi.js';

// Remove the browser environment extension so that AccessibilitySystem,
// EventSystem, and other DOM-dependent pipes never get loaded in a worker.
extensions.remove(browserExt);

export {
  extensions,
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  Graphics,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  ParticleContainer,
  Particle,
  Matrix,
  Geometry,
  Mesh,
  Shader,
  GlProgram,
  RendererType,
  RenderTexture,
  DOMAdapter,
  WebWorkerAdapter,
  Buffer,
  BufferUsage,
  UniformGroup,
  NOOP,
  ExtensionType,
  BindGroup,
  GpuProgram,
  ViewContainer,
  State,
  Bounds,
  groupD8,
};
