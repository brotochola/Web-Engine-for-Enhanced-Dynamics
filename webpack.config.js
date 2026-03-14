import path from 'path';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';
import WebpackObfuscator from 'webpack-obfuscator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker files that need to be bundled separately
const workerEntries = {
    'workers/logic_worker': './src/workers/logic_worker.js',
    'workers/physics_worker': './src/workers/physics_worker.js',
    'workers/pixi_worker': './src/workers/pixi_worker.js',
    'workers/spatial_worker': './src/workers/spatial_worker.js',
    'workers/particle_worker': './src/workers/particle_worker.js',
    'workers/pre_render_worker': './src/workers/pre_render_worker.js',
};

// Check if we should obfuscate
const shouldObfuscate = process.env.OBFUSCATE === 'true';

// Production mode: swap debug modules with no-op stubs
const isProd = process.env.WEED_PROD === 'true';
const debugStubAliases = isProd ? {
    [path.resolve(__dirname, 'src/core/debug/DebugDraw.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/DebugDraw.js'),
    [path.resolve(__dirname, 'src/core/debug/DebugUI.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/DebugUI.js'),
    [path.resolve(__dirname, 'src/core/debug/DebugFlags.js')]:
        path.resolve(__dirname, 'src/core/debug/stubs/DebugFlags.js'),
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

// Common optimization
const optimization = {
    minimize: true,
    minimizer: [
        new TerserPlugin({
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
    exclude: [/node_modules/, /src[\\/]lib[\\/]/],
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

// Workers bundle configuration
const workersConfig = {
    mode: 'production',
    devtool: false,
    entry: workerEntries,
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].min.js',
        globalObject: 'self'
    },
    target: 'webworker',
    module: {
        rules: [babelLoader]
    },
    optimization,
    plugins: shouldObfuscate ? [new WebpackObfuscator(obfuscatorOptions, [])] : [],
    resolve: {
        extensions: ['.js'],
        alias: debugStubAliases
    }
};

// Export main and workers configs
export default [mainConfig, workersConfig];
