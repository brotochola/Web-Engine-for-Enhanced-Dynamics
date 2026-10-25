// The particle worker's JS integrate and list build, as its updateParticlePhysics and buildActiveAndVisibleParticleLists
// ran them with wasm.particleIntegrate and wasm.particleLists off, before the kernels became its only ones (E-79,
// E-80). installParticleJs puts them on a worker booted on the particle memory (the only way it boots now), for the
// parity tests: the JS side runs on the same memory, lists and columns as the kernels.
import { ParticleComponent } from '../../src/components/particleComponent.js';
import {
  buildActiveAndVisibleListBuffers,
  buildActiveAndVisibleListBuffersTurned,
  buildActiveListBuffers,
  particleClassifyLists,
  updateParticlePhysicsBuffers,
} from './particleIntegrate.mjs';

/** Replace the worker's integrate and/or list build with the JS ones. */
export function installParticleJs(worker, { integrate = true, lists = true } = {}) {
  const [classifyFlat, classifyHeighted] = particleClassifyLists(worker.maxParticles);
  if (integrate) {
    worker.updateParticlePhysics = function updateParticlePhysicsJs(deltaTime, dtRatio) {
      if (this.maxParticles === 0) return 0;
      const { activeCount, stampedCount } = updateParticlePhysicsBuffers(
        ParticleComponent,
        this.activeParticleIndices,
        this.activeParticleCount,
        deltaTime,
        dtRatio,
        this.decalsEnabled,
        this.particlesToStamp,
        classifyFlat,
        classifyHeighted,
      );
      this.particlesToStampCount = stampedCount;
      return activeCount;
    };
  }
  if (lists) {
    worker.buildActiveAndVisibleParticleLists = function buildActiveAndVisibleParticleListsJs() {
      if (this.maxParticles === 0) return;
      const active = ParticleComponent.active;
      const localIndices = this.activeParticleIndices;
      const activeData = this.activeParticlesData;
      const visibleData = this.visibleParticlesData;
      const maxParticles = this.maxParticles;
      const expectedActive = maxParticles;
      if (!this.cameraData) {
        this.activeParticleCount = buildActiveListBuffers(maxParticles, active, localIndices, activeData, expectedActive);
        if (visibleData) visibleData[0] = 0;
        return;
      }
      const cameraBounds = this._frameCameraBounds();
      if (!cameraBounds) return;
      const rotation = this._drawnCam.rotation;
      const { activeCount } = rotation
        ? buildActiveAndVisibleListBuffersTurned(
          ParticleComponent,
          maxParticles,
          localIndices,
          activeData,
          visibleData,
          expectedActive,
          cameraBounds,
          rotation,
          this.canvasWidth,
          this.canvasHeight,
          this.cullingRatio,
        )
        : buildActiveAndVisibleListBuffers(
          ParticleComponent,
          maxParticles,
          localIndices,
          activeData,
          visibleData,
          expectedActive,
          cameraBounds,
        );
      this.activeParticleCount = activeCount;
    };
  }
}
