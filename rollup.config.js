import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

export default [
  // Main library bundle
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.esm.js',
        format: 'esm',
        sourcemap: true,
      },
      {
        file: 'dist/index.cjs',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
    ],
    external: ['@dimforge/rapier2d-compat'],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        declaration: true,
        declarationDir: './dist',
        rootDir: './src',
      }),
      resolve(),
    ],
  },
  
  // Worker bundles (separate chunks for parallel loading)
  {
    input: {
      'workers/logic_worker': 'src/workers/logic_worker.ts',
      'workers/physics_worker': 'src/workers/physics_worker.ts',
      'workers/spatial_worker': 'src/workers/spatial_worker.ts',
      'workers/pixi_worker': 'src/workers/pixi_worker.ts',
    },
    output: {
      dir: 'dist',
      format: 'esm',
      sourcemap: true,
      chunkFileNames: 'workers/[name].js',
    },
    external: ['@dimforge/rapier2d-compat'],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false, // Workers don't need declarations
      }),
      resolve(),
    ],
  },
];
