#!/usr/bin/env node
// Browser integration checks for the real fight loop. No app bundling required.
// npm install --no-save playwright-core
// CHROMIUM=/path/to/chrome node tools/test-fights.mjs
// NODE_PATH may point at an existing installation of playwright-core.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.setDefaultTimeout(45_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?dtcap=0.25&ts=4`);
  await page.waitForFunction(() => window.__vb?.stage);

  await page.evaluate(async () => {
    const R = await import('/js/rules.js');
    // Only HP and stars are shortened. Keyboard events enter the normal input
    // handlers; attack damage, fightLoop, countdown and match flow run unchanged.
    const state = () => {
      const g = window.__vb.G;
      return Object.fromEntries(['scene', 'mode', 'clock', 'clockOn', 'paused', 'hp', 'oppHp', 'oppMax', 'playerDowns', 'oppDowns', 'count', 'fight', 'kos', 'score', 'reason'].map((k) => [k, g[k]]));
    };
    const key = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const test = window.__fightTest = { R, state, key, frames: [], goal: null, autoDefend: true };
    function frame() {
      const g = window.__vb.G;
      test.frames.push(state());
      if (g.scene === 'fight' && !g.paused) {
        if (g.mode === 'defend' && g.def?.total && !g.def.action) {
          if (test.goal === 'player' || (test.goal === 'chip' && g.def.key !== 'body')) {
            g.hp = 1;
            if (test.goal === 'chip') key('ArrowUp');
            test.goal = null;
            test.autoDefend = false;
          } else if (test.autoDefend) {
            const answer = R.ATTACKS[g.def.key].answer;
            key({ L: 'ArrowLeft', R: 'ArrowRight', SLIP: 'ArrowLeft', DUCK: 'ArrowDown', BLOCK: 'ArrowUp' }[answer]);
          }
        }
        if (g.mode === 'attack' && g.punchWait && ['opponent', 'super'].includes(test.goal)) {
          g.oppHp = 1;
          if (test.goal === 'super') { g.stars = 1; key(' '); }
          else key(R.QUADS.find((q) => !R.GUARDS[g.guard].includes(q.id)).keys[0]);
          test.goal = null;
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });

  async function snapshot() { return page.evaluate(() => window.__fightTest.state()); }
  async function start() {
    await page.evaluate(() => {
      window.__fightTest.goal = null;
      window.__fightTest.autoDefend = true;
      void window.__vb.startGame();
    });
    await page.waitForFunction(() => window.__vb.G.scene === 'fight' && window.__vb.G.mode === 'intro');
    const intro = await snapshot();
    assert.equal(intro.clockOn, false, 'the bout intro must stop the match clock');
    assert.equal(intro.playerDowns, 0);
    assert.equal(intro.oppDowns, 0);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vb.G.mode === 'defend');
  }

  async function down(victim, number, attack = victim === 'player' ? 'player' : 'opponent') {
    const startIndex = await page.evaluate((goal) => {
      window.__fightTest.autoDefend = true;
      window.__fightTest.goal = goal;
      return window.__fightTest.frames.length;
    }, attack);
    await page.waitForFunction(({ victim, number }) => {
      const g = window.__vb.G;
      return g.mode === 'count' && g[victim === 'player' ? 'playerDowns' : 'oppDowns'] === number;
    }, { victim, number });
    await page.evaluate(() => { window.__fightTest.autoDefend = true; });
    return { victim, number, startIndex, entry: await snapshot() };
  }

  async function checkCount(run) {
    const { victim, number, entry, startIndex } = run;
    await page.waitForFunction(() => window.__vb.G.mode !== 'count');
    const end = await snapshot();
    const frames = await page.evaluate((i) => window.__fightTest.frames.slice(i), startIndex);
    const counts = frames.filter((f) => f.mode === 'count');
    const last = number === 1 ? 6 : number === 2 ? 8 : 10;
    const seen = [...new Set(counts.map((f) => f.count).filter((n) => n > 0))];
    assert.deepEqual(seen, Array.from({ length: last }, (_, i) => i + 1), `${victim} knockdown ${number}: count each number in order`);
    const hpKey = victim === 'player' ? 'hp' : 'oppHp';
    for (const f of counts) {
      assert.equal(f.clockOn, false, 'clock must stay stopped throughout the count');
      assert.equal(f.clock, entry.clock, 'the referee must not consume fight time');
      assert.equal(f.kos, entry.kos, 'no KO awarded during the count');
      assert.equal(f.score, entry.score, 'no KO bonus awarded during the count');
      assert.equal(f.fight, entry.fight, 'no opponent advance during the count');
      assert.equal(f.reason, null, 'no result before the count completes');
      if ((f.count > 0 && f.count < last) || number === 3) assert.equal(f[hpKey], 0, 'a boxer must remain down until recovery');
    }
    if (number < 3) {
      const recovery = frames.find((f) => f.mode !== 'count' && f[hpKey] > 0 && f[victim === 'player' ? 'playerDowns' : 'oppDowns'] === number);
      assert.ok(recovery, 'the same bout resumes after the first two knockdowns');
      const expected = await page.evaluate(({ victim, number }) => {
        const { R } = window.__fightTest;
        return R.recoveryHp(victim === 'player' ? R.PLAYER_HP : window.__vb.G.oppMax, number);
      }, { victim, number });
      assert.equal(recovery[hpKey], expected, 'restore the intended recovery HP');
      assert.equal(end.kos, entry.kos);
      assert.equal(end.fight, entry.fight);
      assert.equal(end.reason, null);
    } else {
      assert.equal(end[hpKey], 0, 'third knockdown must not restore HP');
      assert.ok(['ko', 'over', 'intro'].includes(end.mode), 'third knockdown leads to a KO');
    }
    return end;
  }

  await start();
  const first = await down('opponent', 1, 'super');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__vb.G.paused);
  const paused = await snapshot();
  await page.keyboard.press('q');
  await page.waitForTimeout(400);
  assert.deepEqual(await snapshot(), paused, 'pause must freeze count, health, score, and clock');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__vb.G.paused);
  await checkCount(first);
  await checkCount(await down('opponent', 2));
  const third = await down('opponent', 3);
  await checkCount(third);
  await page.waitForFunction(() => window.__vb.G.fight === 1 && window.__vb.G.mode === 'intro');
  const nextBout = await snapshot();
  assert.equal(nextBout.kos, 1, 'only the third fall awards a KO');
  assert.equal(nextBout.playerDowns, 0, 'player knockdowns reset per bout');
  assert.equal(nextBout.oppDowns, 0, 'opponent knockdowns reset per bout');
  assert.equal(nextBout.clockOn, false, 'next-opponent intro must stop the clock');
  assert.equal(nextBout.clock, third.entry.clock, 'KO animation and bout transition must not consume fight time');
  console.log('PASS opponent: super, 6/8/10 counts, pause/resume, recovery, and next bout');

  await start();
  await checkCount(await down('player', 1, 'chip'));
  await checkCount(await down('player', 2));
  const playerThird = await down('player', 3);
  await checkCount(playerThird);
  await page.waitForFunction(() => window.__vb.G.reason === 'ko');
  const defeat = await snapshot();
  assert.equal(defeat.playerDowns, 3);
  assert.equal(defeat.kos, 0);
  assert.equal(defeat.clock, playerThird.entry.clock, 'player KO animation must not consume fight time');
  console.log('PASS player: blocked chip, 6/8/10 counts, recovery, and third-fall defeat');

  await start();
  await down('opponent', 1);
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu [data-mi="restart"]').click();
  await page.waitForFunction(() => window.__vb.G.mode === 'intro' && window.__vb.G.oppDowns === 0);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__vb.G.mode === 'defend');
  // Wait beyond the abandoned countdown; its async continuation must be inert.
  await page.waitForTimeout(3000);
  const restarted = await snapshot();
  assert.equal(restarted.oppDowns, 0);
  assert.equal(restarted.playerDowns, 0);
  assert.equal(restarted.kos, 0);
  assert.equal(restarted.fight, 0);
  assert.equal(restarted.reason, null);
  assert.ok(restarted.oppHp > 0);
  assert.notEqual(restarted.mode, 'count');
  assert.notEqual(restarted.mode, 'ko');
  console.log('PASS restart: an interrupted count cannot alter the new match');

  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('All fight integration checks passed.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
