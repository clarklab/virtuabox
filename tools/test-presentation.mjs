#!/usr/bin/env node
// Fast UI/motion checks, independent of the full fight integration suite.
// CHROMIUM=/path/to/chrome NODE_PATH=/path/to/node_modules node tools/test-presentation.mjs
// SCREENSHOTS defaults to /tmp/vb-polish. TEST_ROOT supports a staged script.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.TEST_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
let chromium;
for (const module of ['playwright-core', ...(process.env.NODE_PATH || '').split(delimiter).filter(Boolean).map((p) => join(p, 'playwright-core'))]) {
  try { ({ chromium } = require(module)); break; } catch { /* try the next module location */ }
}
if (!chromium) throw new Error('Install playwright-core, or set NODE_PATH to its node_modules directory.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}/?dtcap=0.25`;
  const output = resolve(process.env.SCREENSHOTS || '/tmp/vb-polish');
  await mkdir(output, { recursive: true });
  async function boot() {
    await page.goto(url);
    await page.waitForFunction(() => window.__vb?.stage && window.__vb.screen === 'start');
  }
  async function mode(expected) {
    await page.waitForFunction((expected) => document.querySelector('#app').dataset.motion === expected, expected);
    assert.equal(await page.evaluate(() => window.__vb.stage.reducedMotion), expected === 'reduced', 'WebGL follows the same motion setting as the UI');
  }
  async function menu() {
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vb.screen === 'menu');
  }
  async function toggleMotion() {
    await page.locator('#main-menu [data-mi="motion"]').focus();
    await page.keyboard.press('Enter');
  }
  async function visibleFocus(label) {
    const box = await page.evaluate(() => {
      const panel = document.querySelector('#sub').getBoundingClientRect();
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      return { id: el.dataset.mi, top: r.top, bottom: r.bottom, left: r.left, right: r.right, panelTop: Math.max(0, panel.top), panelBottom: Math.min(innerHeight, panel.bottom), width: innerWidth };
    });
    assert.ok(box.id, `${label}: focus remains on a menu item`);
    assert.ok(box.top >= box.panelTop - 2 && box.bottom <= box.panelBottom + 2, `${label}: focused ${box.id} is not vertically clipped (${JSON.stringify(box)})`);
    assert.ok(box.left >= -2 && box.right <= box.width + 2, `${label}: focused ${box.id} is not horizontally clipped`);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot();
  await mode('reduced');
  assert.equal(await page.evaluate(() => localStorage.getItem('virtuabox.motion')), null, 'the OS default does not create a user preference');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mode('full');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mode('reduced');
  await menu();
  await toggleMotion();
  await mode('full');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('virtuabox.motion'))), 'full');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mode('full');
  await boot();
  await mode('full');
  await menu();
  await toggleMotion();
  await mode('reduced');
  await boot();
  await mode('reduced');
  console.log('PASS motion: OS default and live changes, explicit toggle, persisted full/reduced settings, and shared UI/WebGL state');

  for (const [width, height] of [[390, 844], [320, 568], [844, 390], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const start = page.locator('[data-view="start"] [data-mi="start"]');
    await start.waitFor({ state: 'visible' });
    const hit = await start.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { hittable: at === el || el.contains(at), width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    });
    assert.ok(hit.hittable, `title CTA can be tapped at ${width}x${height}`);
    assert.ok(hit.width >= 44 && hit.height >= 44, 'title CTA has a useful touch target');
    assert.ok(hit.right <= width && hit.bottom <= height, 'title CTA fits the viewport');
    await page.screenshot({ path: join(output, `ui-title-${width}x${height}.png`), animations: 'disabled' });
    if (width === 390) await page.keyboard.press('Enter');
    else await start.tap();
    await page.waitForFunction(() => window.__vb.screen === 'menu');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mi), 'fight', 'opening the main menu focuses Fight');
    await visibleFocus(`${width}x${height} first item`);
    const visited = [];
    for (let i = 0; i < 4; i++) {
      visited.push(await page.evaluate(() => document.activeElement.dataset.mi));
      await visibleFocus(`${width}x${height} item ${i}`);
      await page.keyboard.press('Tab');
    }
    assert.deepEqual(visited, ['fight', 'gym', 'sound', 'motion'], 'Tab visits every menu option and keeps the focused item visible');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mi), 'fight', 'Tab wraps inside the active menu');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mi), 'motion', 'reverse Tab wraps correctly');
    await visibleFocus(`${width}x${height} last item`);
    await page.screenshot({ path: join(output, `ui-menu-${width}x${height}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__vb.screen === 'start');
  }
  console.log('PASS responsive UI: title touch/Enter activation, four menu options, focus and scrolling at all four viewport sizes');

  await page.setViewportSize({ width: 320, height: 568 });
  await menu();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__vb.screen === 'book');
  // A long training menu must bring its bottom actions into view by keyboard.
  await page.locator('#lessons [data-mi]').first().focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.mi), 'exit');
  await visibleFocus('320x568 training book exit');
  const bookletFits = await page.locator('[data-view="book"] .win-h, #lessons li').evaluateAll((els) => els.every((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth;
  }));
  assert.ok(bookletFits, 'training title and all lesson columns fit a 320px screen');
  await page.screenshot({ path: join(output, 'ui-book-320x568.png'), animations: 'disabled' });
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log(`All presentation checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
