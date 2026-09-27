#!/usr/bin/env node
// Renders the PNG icons (from icons/favicon.svg) and the 1200x630
// og.jpg (a posed frame of the real 3D scene) with headless Chromium.
//
//   npm i --no-save playwright-core && node tools/render-assets.mjs
//
// Set CHROMIUM=/path/to/chrome if Playwright's bundled browser isn't found.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(process.cwd(), 'noop.js'));
const { chromium } = require('playwright-core');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean)],
});

// ---- icons -------------------------------------------------------------------
const svg = await readFile(join(root, 'icons', 'favicon.svg'), 'utf8');
const icons = [
  ['favicon-32.png', 32, 0],
  ['apple-touch-icon.png', 180, 0],
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.12], // keep the glove inside the safe zone
];
for (const [name, size, pad] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(`<body style="margin:0;background:#05010c;display:grid;place-items:center;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
  await page.screenshot({ path: join(root, 'icons', name) });
  await page.close();
  console.log('icon', name);
}

// ---- og image ----------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error', e.message));
  await page.goto(`${base}/?dtcap=0.2`);
  await page.waitForFunction(() => window.__vb?.stage);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__vb.ogPose());
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(root, 'og.jpg'), type: 'jpeg', quality: 88 });
  console.log('og.jpg');
}

await browser.close();
server.close();
