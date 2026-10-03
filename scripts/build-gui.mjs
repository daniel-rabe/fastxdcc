/**
 * Builds the Electron app with esbuild.
 *
 * Three bundles, because they run in three different places:
 *  - main    -> Node inside Electron's main process (CJS; `electron` stays external)
 *  - preload -> Node in the isolated preload context (CJS, same reason)
 *  - renderer-> the browser context, with no Node access at all
 *
 * The main and preload bundles are emitted as `.cjs` because package.json says
 * `"type": "module"`, and Electron loads preload scripts most reliably as CommonJS.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-gui');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  minify: !dev,
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/electron/main.ts')],
    outfile: path.join(outDir, 'electron/main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Provided by the Electron runtime, never bundled.
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/electron/preload.ts')],
    outfile: path.join(outDir, 'electron/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/renderer/main.tsx')],
    outfile: path.join(outDir, 'renderer/index.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
  },
];

async function copyStatic() {
  await mkdir(path.join(outDir, 'renderer'), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    await cp(path.join(root, 'src/renderer', file), path.join(outDir, 'renderer', file));
  }
}

await rm(outDir, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  process.stdout.write('watching for changes; press ctrl-c to stop\n');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  process.stdout.write(`built ${path.relative(root, outDir)}\n`);
}
