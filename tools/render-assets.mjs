#!/usr/bin/env node
// Writes the pixel-art favicon/app icon SVGs, renders the PNG icons, and the 1200x630
// og.jpg (a posed frame of the real 3D scene) with headless Chromium.
//
//   npm i --no-save playwright-core && node tools/render-assets.mjs
//
// Set CHROMIUM=/path/to/chrome if Playwright's bundled browser isn't found.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
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
// A 16x16 boxing-glove sprite. K outline, R red, D shade, W shine, C cuff, G cuff shade.
const GLOVE = `
................
.....KKKKKK.....
....KRRRRRRKK...
...KRWWRRRRRRK..
..KRWWRRRRRRRRK.
..KRWRRRRRRRRRK.
.KKKRRRRRRRRRRK.
KRRRKRRRRRRRRDK.
KRWRRKRRRRRRRDK.
KRRRRKRRRRRRDDK.
.KRRRKRRRRRDDDK.
..KKKRRRRRDDDK..
...KKCCCCCCCK...
...KCCCCCCCGK...
...KKKKKKKKKK...
................`.trim().split('\n');
const PAL = { K: '#000000', R: '#e82818', D: '#901008', W: '#f8f8f8', C: '#f8f8f8', G: '#a0a0c0', Y: '#f8d830' };

function spriteRects(rows, ox = 0, oy = 0) {
  let out = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (PAL[ch]) {
        let e = x;
        while (row[e] === ch) e++;
        out += `<rect x="${x + ox}" y="${y + oy}" width="${e - x}" height="1" fill="${PAL[ch]}"/>`;
        x = e;
      } else x++;
    }
  });
  return out;
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${spriteRects(GLOVE)}</svg>\n`;
const sparkle = ['..Y..', '..Y..', 'YYYYY', '..Y..', '..Y..'];
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" shape-rendering="crispEdges">`
  + '<rect width="20" height="20" fill="#182078"/><rect y="17" width="20" height="3" fill="#101058"/>'
  + '<rect y="17" width="20" height="1" fill="#e82818"/>'
  + spriteRects(GLOVE, 2, 2) + spriteRects(sparkle, 15, 1) + '</svg>\n';
await writeFile(join(root, 'icons', 'favicon.svg'), favicon);
await writeFile(join(root, 'icons', 'icon.svg'), appIcon);

const icons = [
  ['favicon-32.png', 32, favicon, 0, 'transparent'],
  ['apple-touch-icon.png', 180, appIcon, 0, '#182078'],
  ['icon-192.png', 192, appIcon, 0, '#182078'],
  ['icon-512.png', 512, appIcon, 0, '#182078'],
  ['icon-maskable-512.png', 512, appIcon, 0.1, '#182078'], // glove stays inside the safe zone
];
for (const [name, size, svg, pad, bg] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(`<body style="margin:0;background:${bg};display:grid;place-items:center;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
  await page.screenshot({ path: join(root, 'icons', name), omitBackground: bg === 'transparent' });
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
