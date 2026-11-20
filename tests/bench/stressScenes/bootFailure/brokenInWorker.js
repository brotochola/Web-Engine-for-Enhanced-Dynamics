import WEED from '/src/index.js';

const { GameObject } = WEED;

// N-254's fixture: this module loads on the page; where an engine worker loads it, it never finishes loading and throws
// outside every handler of the engine's (an uncaught error), as a worker that dies while booting does. The scene never
// reports ready, and the page itself throws nothing.
if (typeof window === 'undefined') {
  await new Promise(() => {
    setTimeout(() => {
      throw new Error('bootFailureScene: this worker died while booting (N-254 fixture)');
    }, 0);
  });
}

export class BrokenInWorker extends GameObject {
  static components = [];
}
