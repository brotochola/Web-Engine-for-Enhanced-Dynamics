import WEED from '/src/index.js';

const { Component } = WEED;

export const LEAF_TIP = 0;
export const LEAF_SIDES = 1;

export const LAYER_GROUND = 1;
export const LAYER_BRANCH = 2;
export const LAYER_LEAF = 3;
export const LAYER_DEAD = 4;

export const PRESETS = {
  tree: {
    rootShoots: 1,
    maxChildren: 3,
    maxGeneration: 5,
    segmentLength: 180,
    segmentWidth: 22,
    lengthDecay: 0.5,
    spreadDeg: 90,
    leavesPerSegment: 4,
    leafScale: 1,
    leafLayout: LEAF_TIP,
    growth: 1,
    matureGrowth: 0.05,
    maxAgeYears: 5,
    dieFromGeneration: 3,
    dieChance: 0.08,
    upright: 1,
    flexDeg: 28,
  },
  bush: {
    rootShoots: 4,
    maxChildren: 2,
    maxGeneration: 3,
    segmentLength: 70,
    segmentWidth: 10,
    lengthDecay: 0.45,
    spreadDeg: 110,
    leavesPerSegment: 3,
    leafScale: 0.85,
    leafLayout: LEAF_TIP,
    growth: 1,
    matureGrowth: 0.04,
    maxAgeYears: 4,
    dieFromGeneration: 2,
    dieChance: 0.1,
    upright: 0.7,
    flexDeg: 24,
  },
  fern: {
    rootShoots: 5,
    maxChildren: 1,
    maxGeneration: 8,
    segmentLength: 26,
    segmentWidth: 3.5,
    lengthDecay: 0.08,
    spreadDeg: 60,
    leavesPerSegment: 2,
    leafScale: 0.55,
    leafLayout: LEAF_SIDES,
    growth: 1.2,
    matureGrowth: 0.04,
    maxAgeYears: 0,
    dieFromGeneration: 3,
    dieChance: 0,
    upright: 1,
    flexDeg: 12,
  },
};

export class TreeComponent extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    seed: Int32Array,
    rootShoots: Uint8Array,
    maxChildren: Uint8Array,
    maxGeneration: Uint8Array,
    segmentLength: Float32Array,
    segmentWidth: Float32Array,
    lengthDecay: Float32Array,
    spreadDeg: Float32Array,
    leavesPerSegment: Uint8Array,
    leafScale: Float32Array,
    leafLayout: Uint8Array,
    growth: Float32Array,
    matureGrowth: Float32Array,
    maxAgeYears: Float32Array,
    dieFromGeneration: Uint8Array,
    dieChance: Float32Array,
    upright: Float32Array,
    flexDeg: Float32Array,
  };
}

export function applyGenome(tree, presetName, seed) {
  const spec = PRESETS[presetName] || PRESETS.tree;
  const gene = tree.treeComponent;
  gene.active = 1;
  gene.seed = seed | 0;
  gene.rootShoots = spec.rootShoots;
  gene.maxChildren = spec.maxChildren;
  gene.maxGeneration = spec.maxGeneration;
  gene.segmentLength = spec.segmentLength;
  gene.segmentWidth = spec.segmentWidth;
  gene.lengthDecay = spec.lengthDecay;
  gene.spreadDeg = spec.spreadDeg;
  gene.leavesPerSegment = spec.leavesPerSegment;
  gene.leafScale = spec.leafScale;
  gene.leafLayout = spec.leafLayout;
  gene.growth = spec.growth;
  gene.matureGrowth = spec.matureGrowth;
  gene.maxAgeYears = spec.maxAgeYears;
  gene.dieFromGeneration = spec.dieFromGeneration;
  gene.dieChance = spec.dieChance;
  gene.upright = spec.upright;
  gene.flexDeg = spec.flexDeg;
}
