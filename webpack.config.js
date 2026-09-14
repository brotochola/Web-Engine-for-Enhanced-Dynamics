import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';
import WebpackObfuscator from 'webpack-obfuscator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker files that need to be bundled separately
const workerEntries = {
    'workers/logicWorker': './src/workers/logicWorker.js',
    'workers/pixiWorker': './src/workers/pixiWorker.js',
    'workers/spatialWorker': './src/workers/spatialWorker.js',
    'workers/particleWorker': './src/workers/particleWorker.js',
    'workers/preRenderWorker': './src/workers/preRenderWorker.js',
};

// Check if we should obfuscate
const shouldObfuscate = process.env.OBFUSCATE === 'true';

// Production mode: swap debug modules with no-op stubs
const isProd = process.env.WEED_PROD === 'true';
const debugStubAliases = isProd ? {
    [path.resolve(__dirname, 'src/core/debug/debugDraw.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugDraw.js'),
    [path.resolve(__dirname, 'src/core/debug/debugUi.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugUi.js'),
    [path.resolve(__dirname, 'src/core/debug/debugFlags.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/debugFlags.js'),
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
                    drop_console: true,
                    drop_debugger: true,
                    pure_funcs: ['console.debug', 'console.log']
                },
                mangle: false,
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
    plugins: shouldObfuscate ? [new WebpackObfuscator(obfuscatorOptions, [])] : [],
    resolve: {
        extensions: ['.js'],
        alias: debugStubAliases
    }
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
                    minChunks: 2,
                    priority: 10,
                    reuseExistingChunk: true,
                    enforce: true,
                },
            },
        },
    },
    plugins: shouldObfuscate ? [new WebpackObfuscator(obfuscatorOptions, [])] : [],
    resolve: {
        extensions: ['.js'],
        alias: debugStubAliases
    }
};

// Export main and workers configs
export default [mainConfig, workersConfig];
