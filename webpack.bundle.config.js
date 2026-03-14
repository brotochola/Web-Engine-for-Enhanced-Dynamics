/**
 * Webpack config for SINGLE FILE bundle
 * Workers are loaded as raw strings and embedded in WEED.WorkerSources
 */
import path from 'path';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';
import WebpackObfuscator from 'webpack-obfuscator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const shouldObfuscate = process.env.OBFUSCATE === 'true';

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

// UMD build (for <script> tags and CommonJS)
const umdConfig = {
    mode: 'production',
    devtool: false,
    entry: './src/index.bundle.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'weed.bundle.min.js',
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
                exclude: [/node_modules/, /src[\\/]lib[\\/]/, /\.worker\.bundled\.js$/],
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
    plugins: [
        ...(shouldObfuscate ? [new WebpackObfuscator(obfuscatorOptions, [])] : [])
    ],
    resolve: {
        extensions: ['.js']
    }
};

// ESM build (for import statements)
const esmConfig = {
    mode: 'production',
    devtool: false,
    entry: './src/index.bundle.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'weed.bundle.esm.min.js',
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
