#!/usr/bin/env node
/**
 * Kernel (E-335): decorationVisibilityMicrobench's --grid case (Predator's view over its grass, DecorationSpatial's grid
 * and the list header's counters in place), as a script of its own for the kernel catalog, which runs a script with
 * --output alone. Options as that script's.
 *
 *   node tests/bench/decorationVisibilityGridMicrobench.mjs [--output path]
 *   node tests/bench/runKernelsVsRev.mjs --vs <rev> --only decorationVisibilityGrid
 */
process.argv.push('--grid');
await import('./decorationVisibilityMicrobench.mjs');
