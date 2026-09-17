/**
 * Webpack config for SINGLE FILE bundle
 * Workers are loaded as raw strings and embedded in WEED.WorkerSources
 *
 * Note: Obfuscation is NOT applied here. When OBFUSCATE=true, workers are
 * already obfuscated in Step 1 (webpack.config.js). Running the obfuscator
 * on this bundle would process the entire file (main + ~4MB of worker strings),
 * which is too heavy and causes Step 4 to hang. So the final bundle gets
 * minification only; embedded worker strings remain obfuscated from Step 1.
 */
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cap terser worker_threads parallelism. See webpack.config.js for context —
// each worker thread gets V8's default ~2GB heap, and the embedded ~4MB worker
// strings make the AST heavy. A small cap prevents OOM in the minifier pool.
const TERSER_PARALLEL = Math.max(
    1,
    Math.min(2, (os.cpus().length || 2) - 1)
);

// Production mode: swap debug modules with no-op stubs
const isProd = process.env.WEED_PROD === 'true';
const isCompressed = process.env.WEED_COMPRESSED === 'true';

function bundleFileName(esm) {
    const parts = ['weed'];
    if (isProd) parts.push('prod');
    parts.push('bundle');
    if (esm) parts.push('esm');
    if (isCompressed) parts.push('compressed');
    parts.push('min.js');
    return parts.join('.');
}

const debugStubAliases = isProd ? {
    [path.resolve(__dirname, 'src/core/debug/debugDraw.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugDraw.js'),
    [path.resolve(__dirname, 'src/core/debug/debugUi.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugUi.js'),
    [path.resolve(__dirname, 'src/core/debug/debugFlags.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugFlags.js'),
} : {};

// UMD build (for <script> tags and CommonJS)
const umdConfig = {
    mode: 'production',
    devtool: false,
    entry: './src/index.bundle.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: bundleFileName(false),
        library: {
            name: 'WEED',
            type: 'umd',
            export: 'default'
        },
        globalObject: 'typeof self !== "undefined" ? self : this',
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: [/node_modules/, /src[\\/]vendor[\\/]/, /\.worker\.bundled\.js$/],
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
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            },
            // Load pre-compiled worker files as raw strings
            {
                test: /\.worker\.bundled\.js$/,
                type: 'asset/source'
            }
        ]
    },
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                parallel: TERSER_PARALLEL,
                terserOptions: {
                    keep_classnames: true,
                    compress: {
                        drop_console: false,
                        drop_debugger: true,
                        pure_funcs: ['console.debug']
                    },
                    mangle: {
                        reserved: [
                            // Core
                            'WEED', 'GameEngine', 'Scene', 'GameObject', 'Component',
                            'FSM', 'FSMState', 'DebugFlags', 'DebugUI', 'DebugDraw', 'Mouse', 'Camera',
                            'Ray', 'NavGrid', 'Keyboard', 'SpriteSheetRegistry', 'BigAtlasInspector',
                            // Components - CRITICAL: these names are used for identification
                            'Transform', 'RigidBody', 'Collider', 'SpriteRenderer',
                            'ParticleComponent', 'DecorationComponent', 'LightEmitter',
                            'ShadowCaster', 'FlashComponent',
                            // Systems
                            'ParticleEmitter', 'DecorationPool', 'Flash', 'QuerySystem',
                            'Box2d', 'Decal', 'Query', 'LiquidFun', 'Decoration',
                            // Workers
                            'AbstractWorker',
                            // Enums
                            'ShapeType'
                        ]
                    },
                    format: {
                        comments: false
                    }
                },
                extractComments: false
            })
        ]
    },
    plugins: [],
    resolve: {
        extensions: ['.js'],
        alias: debugStubAliases
    }
};

// ESM build (for import statements)
const esmConfig = {
    mode: 'production',
    devtool: false,
    entry: './src/index.bundle.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: bundleFileName(true),
        library: {
            type: 'module'
        },
    },
    experiments: {
        outputModule: true,
    },
    module: umdConfig.module,
    optimization: umdConfig.optimization,
    plugins: umdConfig.plugins,
    resolve: umdConfig.resolve,
};

export default [umdConfig, esmConfig];
