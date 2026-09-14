// PixiJS 8 Web Worker Bundle
// ===========================
// Builds a worker-safe ESM bundle from deep pixi.js modules (not the barrel).
//
// Why this exists:
//   The stock pixi.min.mjs includes browser-only extensions (Accessibility,
//   EventSystem) that reference `document` and crash in a Web Worker.
//   `from 'pixi.js'` is worse: package.json sideEffects includes `./lib/index.*`,
//   so esbuild keeps the whole barrel (~570KB) including Graphics / ParticleContainer.
//
// Upgrade workflow:
//   npm install pixi.js@<version>
//   npm run build:pixi
//
// Outfile stays src/vendor/pixi.min.js (import paths). Packed version is package.json pixi.js.
// WebGPURenderer is bundled (compute layers + GpuProgram). CanvasRenderer stays stubbed.

import { ExtensionType, extensions } from '../node_modules/pixi.js/lib/extensions/Extensions.mjs';

// Texture sources / masks. Never import the barrel (pulls accessibility, events, text, …).
import '../node_modules/pixi.js/lib/rendering/init.mjs';
// Shader compile in workers (skips unsafe-eval check; also patches UBO sync).
import '../node_modules/pixi.js/lib/unsafe-eval/init.mjs';

import { Application } from '../node_modules/pixi.js/lib/app/Application.mjs';
import { Container } from '../node_modules/pixi.js/lib/scene/container/Container.mjs';
import { Sprite } from '../node_modules/pixi.js/lib/scene/sprite/Sprite.mjs';
import { Texture } from '../node_modules/pixi.js/lib/rendering/renderers/shared/texture/Texture.mjs';
import { Rectangle } from '../node_modules/pixi.js/lib/maths/shapes/Rectangle.mjs';
import { TilingSprite } from '../node_modules/pixi.js/lib/scene/sprite-tiling/TilingSprite.mjs';
import { TextureSource } from '../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.mjs';
import { ImageSource } from '../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/ImageSource.mjs';
import { Ticker } from '../node_modules/pixi.js/lib/ticker/Ticker.mjs';
import { Matrix } from '../node_modules/pixi.js/lib/maths/matrix/Matrix.mjs';
import { Geometry } from '../node_modules/pixi.js/lib/rendering/renderers/shared/geometry/Geometry.mjs';
import { Mesh } from '../node_modules/pixi.js/lib/scene/mesh/shared/Mesh.mjs';
import { Shader } from '../node_modules/pixi.js/lib/rendering/renderers/shared/shader/Shader.mjs';
import { GlProgram } from '../node_modules/pixi.js/lib/rendering/renderers/gl/shader/GlProgram.mjs';
import { GpuProgram } from '../node_modules/pixi.js/lib/rendering/renderers/gpu/shader/GpuProgram.mjs';
import { BindGroup } from '../node_modules/pixi.js/lib/rendering/renderers/gpu/shader/BindGroup.mjs';
import { RendererType } from '../node_modules/pixi.js/lib/rendering/renderers/types.mjs';
import { RenderTexture } from '../node_modules/pixi.js/lib/rendering/renderers/shared/texture/RenderTexture.mjs';
import { DOMAdapter } from '../node_modules/pixi.js/lib/environment/adapter.mjs';
import { WebWorkerAdapter } from '../node_modules/pixi.js/lib/environment-webworker/WebWorkerAdapter.mjs';
import { Buffer } from '../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/Buffer.mjs';
import { BufferUsage } from '../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/const.mjs';
import { UniformGroup } from '../node_modules/pixi.js/lib/rendering/renderers/shared/shader/UniformGroup.mjs';
import { NOOP } from '../node_modules/pixi.js/lib/utils/misc/NOOP.mjs';
import { ViewContainer } from '../node_modules/pixi.js/lib/scene/view/ViewContainer.mjs';
import { State } from '../node_modules/pixi.js/lib/rendering/renderers/shared/state/State.mjs';
import { Bounds } from '../node_modules/pixi.js/lib/scene/container/bounds/Bounds.mjs';
import { groupD8 } from '../node_modules/pixi.js/lib/maths/matrix/groupD8.mjs';

export {
  extensions,
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  Matrix,
  Geometry,
  Mesh,
  Shader,
  GlProgram,
  GpuProgram,
  BindGroup,
  RendererType,
  RenderTexture,
  DOMAdapter,
  WebWorkerAdapter,
  Buffer,
  BufferUsage,
  UniformGroup,
  NOOP,
  ExtensionType,
  ViewContainer,
  State,
  Bounds,
  groupD8,
};
