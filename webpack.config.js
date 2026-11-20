import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import TerserPlugin from 'terser-webpack-plugin';
import { MINIFY_RESERVED_NAMES } from './scripts/minifyReservedNames.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// After Terser and the obfuscator. An earlier stage is stripped (comments: false)
// or rewritten when OBFUSCATE=true.
const authorBanner = new webpack.BannerPlugin({
    banner: 'WeedJS by Facundo Saiegh — https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics',
    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
});

// Worker files that need to be bundled separately
const workerEntries = {
    'workers/logicWorker': './src/workers/logicWorker.js',
    'workers/pixiWorker': './src/workers/pixiWorker.js',
    'workers/spatialWorker': './src/workers/spatialWorker.js',
    'workers/particleWorker': './src/workers/particleWorker.js',
    'workers/preRenderWorker': './src/workers/preRenderWorker.js',
    // The asset workers (src/core/assetWorkerClient.js): short-lived, each one file of its own (see workerCommon).
    'workers/atlasWorker': './src/workers/atlasWorker.js',
    'workers/tilemapWorker': './src/workers/tilemapWorker.js',
};
const ASSET_WORKER_CHUNKS = new Set(['workers/atlasWorker', 'workers/tilemapWorker']);

// Check if we should obfuscate
const shouldObfuscate = process.env.OBFUSCATE === 'true';
// The build's input hash (scripts/buildBundle.js sets it): the atlas cache's key names the bundle's code by it.
const buildInputsDefine = new webpack.DefinePlugin({
    __WEED_BUILD_INPUTS__: JSON.stringify(process.env.WEED_BUILD_INPUTS || ''),
});
// N-250: webpack-obfuscator's import alone took about 46 s of every build; load it only for an obfuscated one.
// Required, not awaited at the top: webpack-cli 5 require()s a .js config, and Node 22 refuses to require() an
// ES module with a top-level await (ERR_REQUIRE_ASYNC_MODULE), so no bundle built at all.
const WebpackObfuscator = shouldObfuscate ? createRequire(import.meta.url)('webpack-obfuscator') : null;

// Production mode: swap debug modules with no-op stubs
const isProd = process.env.WEED_PROD === 'true';
const debugStubAliases = isProd ? {
    [path.resolve(__dirname, 'src/core/debug/debugDraw.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugDraw.js'),
    [path.resolve(__dirname, 'src/core/debug/debugUi.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugUi.js'),
    [path.resolve(__dirname, 'src/core/debug/debugFlags.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugFlags.js'),
    [path.resolve(__dirname, 'src/core/debug/hotSwap.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/hotSwap.js'),
    [path.resolve(__dirname, 'src/core/debug/devChecks.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/devChecks.js'),
} : {};

// Obfuscator options
const obfuscatorOptions = {
    rotateStringArray: true,
    stringArray: true,
    stringArrayThreshold: 0.75,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    transformObjectKeys: true,
    unicodeEscapeSequence: false
};

// Cap terser worker_threads parallelism. The default (cpus-1) can spawn 15+
// worker threads on big machines; each one gets V8's default ~2GB heap and
// can OOM ("Worker terminated due to reaching memory limit") while minifying
// the worker bundles that inline pixi + the whole src/ tree. A small fixed
// cap keeps build speed reasonable while bounding peak memory.
const TERSER_PARALLEL = Math.max(
    1,
    Math.min(4, (os.cpus().length || 2) - 1)
);

// Common optimization
const optimization = {
    minimize: true,
    minimizer: [
        new TerserPlugin({
            parallel: TERSER_PARALLEL,
            terserOptions: {
                keep_classnames: true,
                compress: {
                    // The debug build's workers keep console.warn and console.error: the engine's warnings and
                    // DX-GUARDS' run-time checks speak from the workers. Production drops every console call.
                    drop_console: isProd,
                    drop_debugger: true,
                    // E-469: terser writes a function with one caller in another scope into that caller as a function
                    // expression called on the spot: a closure made at each call. reduce_funcs: false keeps it a function
                    // (terser 5 still reads this "legacy" option for exactly that); one whose body is an expression is still inlined.
                    reduce_funcs: false,
                    pure_funcs: ['console.debug', 'console.log']
                },
                mangle: {
                    reserved: MINIFY_RESERVED_NAMES,
                },
                format: {
                    comments: false
                }
            },
            extractComments: false
        })
    ]
};

// Babel loader config
const babelLoader = {
    test: /\.js$/,
    exclude: [/node_modules/, /src[\\/]vendor[\\/]/],
    use: {
        loader: 'babel-loader',
        options: {
            compact: true,
            presets: [
                ['@babel/preset-env', {
                    targets: { browsers: ['> 1%', 'last 2 versions', 'not dead'] },
                    modules: false
                }]
            ]
        }
    }
};

// Main UMD bundle configuration
const mainConfig = {
    mode: 'production',
    devtool: false,
    entry: {
        'weed': './src/index.js'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].min.js',
        library: {
            name: 'WEED',
            type: 'umd',
            export: 'default'
        },
        globalObject: 'typeof self !== "undefined" ? self : this',
        clean: false
    },
    module: {
        rules: [
            babelLoader,
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    optimization,
    plugins: [
        ...(shouldObfuscate ? [new WebpackObfuscator(obfuscatorOptions, [])] : []),
        authorBanner,
        buildInputsDefine,
        // One file: a dynamic import (the debug overlay, the save code) is inlined, never a chunk of its own.
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
    resolve: {
        extensions: ['.js'],
        alias: debugStubAliases,
        symlinks: false,
    },
    // N-251: modules and loaders by the path they were found at, not through a symlink (and Node's own resolution the
    // same way: buildBundle.js runs webpack with --preserve-symlinks). A worktree whose node_modules is a junction to
    // the main folder's resolved babel-loader and style-loader's runtime into the main folder, and those paths went
    // into module identifiers and assets, so its bundles differed from the main folder's build of the same sources.
    resolveLoader: { symlinks: false },
};

// Workers bundle configuration.
// Shared AbstractWorker graph is extracted once into workers/worker_common.min.js
// (import-scripts). buildBundle.js embeds that chunk once and rewrites the
// importScripts URL to a blob URL at createWorker() time.
const workersConfig = {
    mode: 'production',
    devtool: false,
    entry: workerEntries,
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].min.js',
        chunkFilename: '[name].min.js',
        globalObject: 'self',
        chunkLoading: 'import-scripts',
        enabledChunkLoadingTypes: ['import-scripts'],
    },
    target: 'webworker',
    module: {
        rules: [babelLoader]
    },
    optimization: {
        ...optimization,
        runtimeChunk: false,
        splitChunks: {
            chunks: 'all',
            minSize: 0,
            cacheGroups: {
                default: false,
                defaultVendors: false,
                workerCommon: {
                    name: 'workers/worker_common',
                    test: /[\\/]src[\\/]/,
                    // The asset workers stay whole: an atlas pack or a tilemap parse should not start by loading
                    // the scene workers' 600 KB of common code for the few modules it shares with them.
                    chunks: (chunk) => !ASSET_WORKER_CHUNKS.has(chunk.name),
                    minChunks: 2,
                    priority: 10,
                    reuseExistingChunk: true,
                    enforce: true,
                },
            },
        },
    },
    plugins: [
        ...(shouldObfuscate ? [new WebpackObfuscator(obfuscatorOptions, [])] : []),
        authorBanner,
        buildInputsDefine,
    ],
    resolve: {
        extensions: ['.js'],
        alias: debugStubAliases,
        symlinks: false,
    },
    // N-251: modules and loaders by the path they were found at, not through a symlink (and Node's own resolution the
    // same way: buildBundle.js runs webpack with --preserve-symlinks). A worktree whose node_modules is a junction to
    // the main folder's resolved babel-loader and style-loader's runtime into the main folder, and those paths went
    // into module identifiers and assets, so its bundles differed from the main folder's build of the same sources.
    resolveLoader: { symlinks: false },
};

// Export main and workers configs
export default [mainConfig, workersConfig];
