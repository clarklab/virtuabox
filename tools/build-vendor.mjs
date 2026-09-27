#!/usr/bin/env node
// Builds js/vendor/three.js: a single tree-shaken ES module containing only
// the three.js symbols (core + addons) referenced as `THREE.X` in js/*.js.
//
//   npm i --no-save three@0.186.1 esbuild && node tools/build-vendor.mjs

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(process.cwd(), 'noop.js'));
const esbuild = require('esbuild');

const ADDONS = {
  EffectComposer: 'three/examples/jsm/postprocessing/EffectComposer.js',
  RenderPass: 'three/examples/jsm/postprocessing/RenderPass.js',
  UnrealBloomPass: 'three/examples/jsm/postprocessing/UnrealBloomPass.js',
  ShaderPass: 'three/examples/jsm/postprocessing/ShaderPass.js',
  OutputPass: 'three/examples/jsm/postprocessing/OutputPass.js',
  Pass: 'three/examples/jsm/postprocessing/Pass.js',
  FullScreenQuad: 'three/examples/jsm/postprocessing/Pass.js',
  LineSegments2: 'three/examples/jsm/lines/LineSegments2.js',
  LineSegmentsGeometry: 'three/examples/jsm/lines/LineSegmentsGeometry.js',
  LineMaterial: 'three/examples/jsm/lines/LineMaterial.js',
  Line2: 'three/examples/jsm/lines/Line2.js',
  LineGeometry: 'three/examples/jsm/lines/LineGeometry.js',
};

const names = new Set();
for (const f of await readdir(join(root, 'js'))) {
  if (!f.endsWith('.js')) continue;
  const src = await readFile(join(root, 'js', f), 'utf8');
  for (const m of src.matchAll(/THREE\.([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/const \{([^}]+)\} = THREE/g)) {
    for (const n of m[1].split(',')) names.add(n.trim());
  }
}

const core = [...names].filter((n) => !ADDONS[n]).sort();
const addons = [...names].filter((n) => ADDONS[n]).sort();
const entry = [
  `export { ${core.join(', ')} } from 'three';`,
  ...addons.map((n) => `export { ${n} } from '${ADDONS[n]}';`),
].join('\n');

await mkdir(join(root, 'js', 'vendor'), { recursive: true });
await esbuild.build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  banner: { js: '/* three.js r186 (MIT) — tree-shaken build for VIRTUABOX. Regenerate with tools/build-vendor.mjs */' },
  outfile: join(root, 'js', 'vendor', 'three.js'),
});
console.log(`bundled ${core.length} core + ${addons.length} addon symbols`);
