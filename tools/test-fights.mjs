#!/usr/bin/env node
// Browser integration checks for the real fight loop. No app bundling required.
// npm install --no-save playwright-core
// CHROMIUM=/path/to/chrome node tools/test-fights.mjs
// NODE_PATH may point at an existing installation of playwright-core.
// SCREENSHOTS=/tmp/vb-polish also saves title, referee, venues and gym frames
// at 390x844, 320x568, 844x390 and 1280x720 for responsive visual review.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
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
  // Keep accelerated frames below the shortest input window, including when
  // software rendering slows down. A 1-second jump can skip an entire tell.
  await page.goto(`http://127.0.0.1:${server.address().port}/?dtcap=0.025&ts=4`);
  await page.waitForFunction(() => window.__vb?.stage);

  async function capture(name) {
    if (!process.env.SCREENSHOTS) return;
    const directory = resolve(process.env.SCREENSHOTS);
    await mkdir(directory, { recursive: true });
    const viewport = page.viewportSize();
    const paused = await page.evaluate(() => {
      const wasPaused = window.__vb.G.paused;
      window.__vb.G.paused = true;
      return wasPaused;
    });
    for (const [width, height] of [[390, 844], [320, 568], [844, 390], [1280, 720]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: join(directory, `${name}-${width}x${height}.png`), animations: 'disabled' });
      const bounds = await page.evaluate(() => document.querySelector('#app').getBoundingClientRect().toJSON());
      assert.ok(bounds.left >= -1 && bounds.right <= width + 1, `${name}: cabinet fits ${width}px width`);
      assert.ok(bounds.top >= -1 && bounds.bottom <= height + 1, `${name}: cabinet fits ${height}px height`);
    }
    await page.setViewportSize(viewport);
    await page.evaluate((paused) => { window.__vb.G.paused = paused; }, paused);
  }

  await page.waitForTimeout(400);
  await capture('title');

  await page.evaluate(async () => {
    const R = await import('/js/rules.js');
    // Only HP and stars are shortened. Keyboard events enter the normal input
    // handlers; attack damage, fightLoop, countdown and match flow run unchanged.
    const state = () => {
      const g = window.__vb.G;
      return { ...Object.fromEntries(['scene', 'mode', 'clock', 'clockOn', 'paused', 'hp', 'oppHp', 'oppMax', 'playerDowns', 'oppDowns', 'count', 'fight', 'kos', 'score', 'reason'].map((k) => [k, g[k]])), venue: window.__vb.stage.venueName, refereeVisible: document.querySelector('#referee').getAttribute('aria-hidden') === 'false' };
    };
    const key = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const test = window.__fightTest = { R, state, key, frames: [], sounds: [], goal: null, autoDefend: true, autoAttack: false, captureBouts: false, capturedBouts: [], captureReady: null };
    // Record calls on the actual audio instance, retaining playback. This checks
    // the fight-loop wiring rather than calling the sound methods ourselves.
    for (const method of ['count', 'cancelCount', 'pauseCount', 'resumeCount', 'whoosh', 'hit', 'clash', 'voice', 'play']) {
      const original = window.__vb.sound[method];
      if (typeof original !== 'function') throw new Error(`Missing sound.${method}()`);
      window.__vb.sound[method] = function (...args) {
        const event = { method, args: args.map((arg) => typeof arg === 'object' ? undefined : arg), ...state(), read: window.__vb.G.lastRead?.res };
        test.sounds.push(event);
        const result = original.apply(this, args);
        if (method === 'play') event.played = !!result;
        return result;
      };
    }
    function frame() {
      const g = window.__vb.G;
      test.frames.push(state());
      if (test.captureBouts && g.scene === 'fight' && g.mode === 'defend' && !test.capturedBouts.includes(g.fight)) {
        test.capturedBouts.push(g.fight);
        test.captureReady = g.fight;
        g.paused = true;
      }
      if (g.scene === 'fight' && !g.paused) {
        if (g.mode === 'defend' && g.def?.total && !g.def.action) {
          if (test.goal === 'blocked') {
            key('ArrowUp');
          } else if (test.goal === 'player' || (test.goal === 'chip' && g.def.key !== 'body')) {
            g.hp = 1;
            if (test.goal === 'chip') key('ArrowUp');
            test.goal = null;
            test.autoDefend = false;
          } else if (test.autoDefend && (!test.autoAttack || (g.gameTime - g.def.start) / g.def.total >= 0.6)) {
            const answer = R.ATTACKS[g.def.key].answer;
            key({ L: 'ArrowLeft', R: 'ArrowRight', SLIP: 'ArrowLeft', DUCK: 'ArrowDown', BLOCK: 'ArrowUp' }[answer]);
          }
        }
        if (g.mode === 'attack' && g.punchWait && test.goal === 'blocked' && R.GUARDS[g.guard].length) {
          key(R.QUADS[R.GUARDS[g.guard][0]].keys[0]);
          test.goal = null;
        } else if (g.mode === 'attack' && g.punchWait && ['opponent', 'super'].includes(test.goal)) {
          g.oppHp = 1;
          if (test.goal === 'super') { g.stars = 1; key(' '); }
          else key(R.QUADS.find((q) => !R.GUARDS[g.guard].includes(q.id)).keys[0]);
          test.goal = null;
        } else if (g.mode === 'attack' && g.punchWait && test.autoAttack) {
          if (g.stars === R.MAX_STARS) key(' ');
          else key(R.QUADS.find((q) => !R.GUARDS[g.guard].includes(q.id)).keys[0]);
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
      window.__fightTest.autoAttack = false;
      window.__fightTest.captureBouts = false;
      void window.__vb.startGame();
    });
    await page.waitForFunction(() => window.__vb.G.scene === 'fight' && window.__vb.G.mode === 'intro');
    const intro = await snapshot();
    assert.equal(intro.clockOn, false, 'the bout intro must stop the match clock');
    assert.equal(intro.playerDowns, 0);
    assert.equal(intro.oppDowns, 0);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vb.G.mode === 'defend');
    await page.evaluate(() => window.__vb.sound.ready);
  }

  async function down(victim, number, attack = victim === 'player' ? 'player' : 'opponent') {
    const { startIndex, soundIndex } = await page.evaluate((goal) => {
      window.__fightTest.autoDefend = true;
      window.__fightTest.goal = goal;
      return { startIndex: window.__fightTest.frames.length, soundIndex: window.__fightTest.sounds.length };
    }, attack);
    await page.waitForFunction(({ victim, number }) => {
      const g = window.__vb.G;
      return g.mode === (number < 3 ? 'count' : 'ko') && g[victim === 'player' ? 'playerDowns' : 'oppDowns'] === number;
    }, { victim, number });
    await page.evaluate(() => { window.__fightTest.autoDefend = true; });
    return { victim, number, startIndex, soundIndex, entry: await snapshot() };
  }

  async function checkCount(run) {
    const { victim, number, entry, startIndex, soundIndex } = run;
    assert.ok(number < 3, 'only the first two knockdowns have referee counts');
    await page.waitForFunction(() => window.__vb.G.mode !== 'count');
    const end = await snapshot();
    const frames = await page.evaluate((i) => window.__fightTest.frames.slice(i), startIndex);
    const counts = frames.filter((f) => f.mode === 'count');
    const last = number === 1 ? 6 : 8;
    const seen = [...new Set(counts.map((f) => f.count).filter((n) => n > 0))];
    const expectedCount = Array.from({ length: last }, (_, i) => i + 1);
    assert.deepEqual(seen, expectedCount, `${victim} knockdown ${number}: count each number in order`);
    const soundEvents = await page.evaluate((i) => window.__fightTest.sounds.slice(i), soundIndex);
    const spoken = soundEvents.filter((e) => e.method === 'count');
    assert.deepEqual(spoken.map((e) => e.args[0]), expectedCount, `${victim} knockdown ${number}: referee says each count once in order`);
    for (const event of spoken) {
      assert.equal(event.count, event.args[0], 'spoken count matches the displayed count');
      assert.equal(event.refereeVisible, true, 'count voice accompanies the referee card');
      assert.equal(event.paused, false, 'no new count is spoken while paused');
      assert.ok(soundEvents.some((e) => e.method === 'play' && e.args[0] === `vo-count-${event.args[0]}` && e.played), `count ${event.args[0]} plays its recorded referee voice`);
    }
    const hpKey = victim === 'player' ? 'hp' : 'oppHp';
    for (const f of counts) {
      assert.equal(f.clockOn, false, 'clock must stay stopped throughout the count');
      assert.equal(f.clock, entry.clock, 'the referee must not consume fight time');
      assert.equal(f.kos, entry.kos, 'no KO awarded during the count');
      assert.equal(f.score, entry.score, 'no KO bonus awarded during the count');
      assert.equal(f.fight, entry.fight, 'no opponent advance during the count');
      assert.equal(f.reason, null, 'no result before the count completes');
      if (f.count > 0 && f.count < last) assert.equal(f[hpKey], 0, 'a boxer must remain down until recovery');
    }
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
    return end;
  }

  async function checkKO(run) {
    const { victim, number, entry, startIndex, soundIndex } = run;
    assert.equal(number, 3);
    assert.equal(entry.mode, 'ko', 'the third knockdown goes straight to KO');
    assert.equal(entry[victim === 'player' ? 'hp' : 'oppHp'], 0, 'the third knockdown must not restore HP');
    assert.equal(entry.count, 0, 'no count starts on the third knockdown');
    assert.equal(entry.refereeVisible, false, 'the third knockdown never shows the referee card');
    await page.waitForFunction(() => window.__vb.G.mode !== 'ko');
    const frames = await page.evaluate((i) => window.__fightTest.frames.slice(i), startIndex);
    const events = await page.evaluate((i) => window.__fightTest.sounds.slice(i), soundIndex);
    assert.ok(!frames.some((f) => f.mode === 'count' || f.count > 0 || f.refereeVisible), 'no count or referee animation delays the third-fall KO');
    assert.deepEqual(events.filter((e) => e.method === 'count' || (e.method === 'play' && /^vo-count-/.test(e.args[0]))), [], 'the referee does not count aloud after a third knockdown');
    assert.ok(events.some((e) => e.method === 'voice' && e.args[0] === 'ko'), 'the third fall announces KO');
    for (const f of frames.filter((f) => f.mode === 'ko')) {
      assert.equal(f.clockOn, false);
      assert.equal(f.clock, entry.clock, 'the KO must not consume fight time');
    }
  }

  await start();
  const first = await down('opponent', 1, 'super');
  await page.waitForFunction(() => window.__vb.G.count >= 3);
  await capture('referee');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__vb.G.paused);
  const paused = await snapshot();
  const pausedVoices = await page.evaluate(() => window.__fightTest.sounds.filter((e) => e.method === 'count').length);
  await page.keyboard.press('q');
  await page.waitForTimeout(400);
  assert.deepEqual(await snapshot(), paused, 'pause must freeze count, health, score, and clock');
  assert.equal(await page.evaluate(() => window.__fightTest.sounds.filter((e) => e.method === 'count').length), pausedVoices, 'pause must stop future spoken count numbers');
  assert.ok(await page.evaluate(() => window.__fightTest.sounds.some((e) => e.method === 'pauseCount')), 'pausing suspends the current count voice');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.mi), 'resume', 'pause focuses its first menu item');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.mi), 'restart', 'Tab moves focus within the pause menu');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__vb.G.paused);
  await checkCount(first);
  await checkCount(await down('opponent', 2));
  const third = await down('opponent', 3);
  await checkKO(third);
  await page.waitForFunction(() => window.__vb.G.fight === 1 && window.__vb.G.mode === 'intro');
  const nextBout = await snapshot();
  assert.equal(nextBout.kos, 1, 'only the third fall awards a KO');
  assert.equal(nextBout.playerDowns, 0, 'player knockdowns reset per bout');
  assert.equal(nextBout.oppDowns, 0, 'opponent knockdowns reset per bout');
  assert.equal(nextBout.clockOn, false, 'next-opponent intro must stop the clock');
  assert.equal(nextBout.clock, third.entry.clock, 'KO animation and bout transition must not consume fight time');
  console.log('PASS opponent: super, spoken 6/8 counts, pause/resume, instant third-fall KO, and next bout');

  await start();
  await checkCount(await down('player', 1, 'chip'));
  await checkCount(await down('player', 2));
  const playerThird = await down('player', 3);
  await checkKO(playerThird);
  await page.waitForFunction(() => window.__vb.G.reason === 'ko');
  const defeat = await snapshot();
  assert.equal(defeat.playerDowns, 3);
  assert.equal(defeat.kos, 0);
  assert.equal(defeat.clock, playerThird.entry.clock, 'player KO animation must not consume fight time');
  console.log('PASS player: blocked chip, spoken 6/8 counts, recovery, and instant third-fall defeat');

  await start();
  await down('opponent', 1);
  await page.keyboard.press('Escape');
  const restartSoundIndex = await page.evaluate(() => window.__fightTest.sounds.length);
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
  assert.deepEqual(await page.evaluate((i) => window.__fightTest.sounds.slice(i).filter((e) => e.method === 'count' || (e.method === 'play' && /^vo-count-/.test(e.args[0]))), restartSoundIndex), [], 'an abandoned countdown must not speak over the new match');
  console.log('PASS restart: an interrupted count cannot alter the new match');

  const blockedIndex = await page.evaluate(() => {
    window.__fightTest.goal = 'blocked';
    return window.__fightTest.sounds.length;
  });
  await page.waitForFunction((i) => window.__fightTest.sounds.slice(i).some((e) => e.method === 'clash' && e.mode === 'attack'), blockedIndex);
  const punchSounds = await page.evaluate(() => window.__fightTest.sounds);
  for (const [mode, method, label] of [
    ['attack', 'whoosh', 'player punch swing'], ['attack', 'hit', 'player landed punch'], ['attack', 'clash', 'player blocked punch'],
    ['defend', 'whoosh', 'opponent punch swing'], ['defend', 'hit', 'opponent landed punch'], ['defend', 'clash', 'opponent blocked punch'],
  ]) assert.ok(punchSounds.some((e) => e.mode === mode && e.method === method), `${label} dispatches its sound`);
  assert.ok(punchSounds.some((e) => e.mode === 'defend' && e.method === 'whoosh' && e.read === 'perfect'), 'an evaded opponent punch has a whoosh');
  console.log('PASS punch audio: player/opponent swings, landed hits, blocked hits, and evaded punches');

  // Keep a real mouse pointer active so capture works for the synchronous
  // cancellation probes; the events still enter the normal arena listeners.
  await page.evaluate(() => document.addEventListener('pointerdown', (e) => { window.__testPointer = e.pointerId; }, { once: true }));
  await page.mouse.move(5, 5);
  await page.mouse.down();
  await page.waitForFunction(() => {
    const { G: g } = window.__vb;
    if (window.__inputProbe) return true;
    if (g.mode !== 'attack' || !g.punchWait) return false;
    const arena = document.querySelector('#arena');
    const r = arena.getBoundingClientRect();
    const id = window.__testPointer;
    const send = (type, options = {}) => arena.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id, isPrimary: true,
      button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...options,
    }));
    const original = g.punchWait;
    const unchanged = (label, expected = original) => { if (g.punchWait !== expected) throw new Error(`${label} submitted an unwanted punch`); };
    send('pointerdown'); send('pointercancel'); send('pointerup'); unchanged('Canceled gesture');
    send('pointerdown', { isPrimary: false, pointerId: id + 1 });
    send('pointerup', { isPrimary: false, pointerId: id + 1 }); unchanged('Secondary pointer');
    send('pointerdown'); send('pointerup', { pointerId: id + 1 }); unchanged('Mismatched pointer'); send('pointercancel');
    send('pointerdown'); g.mode = 'defend'; send('pointerup'); g.mode = 'attack'; unchanged('Gesture crossing a turn');
    send('pointerdown'); const nextWindow = { ...original }; g.punchWait = nextWindow;
    send('pointerup'); unchanged('Gesture crossing a punch window', nextWindow); g.punchWait = original;
    for (const b of document.querySelectorAll('.dp[data-d]')) {
      if (b.getAttribute('aria-disabled') !== 'true') throw new Error('Defense controls should be announced unavailable during attack');
    }
    for (const b of document.querySelectorAll('.pb')) {
      if (b.getAttribute('aria-disabled') !== 'false') throw new Error('Punch controls should be announced available during attack');
    }
    const { R } = window.__fightTest;
    const q = R.QUADS.find((q) => !R.GUARDS[g.guard].includes(q.id)).id;
    document.querySelector(`.pb[data-q="${q}"]`).click();
    if (g.punchWait !== null) throw new Error('A native keyboard/assistive click must submit a punch');
    window.__inputProbe = true;
    return true;
  });
  await page.mouse.up();
  console.log('PASS input: canceled/secondary/stale gestures, accessible controls, and native button activation');

  // Let the bell occur immediately after a punch is submitted, before impact.
  await start();
  await page.waitForFunction(() => {
    const g = window.__vb.G;
    if (window.__bellProbe) return true;
    if (g.mode !== 'attack' || !g.punchWait) return false;
    const { R, key } = window.__fightTest;
    window.__bellProbe = { hp: g.hp, oppHp: g.oppHp, landed: g.landed, score: g.score };
    key(R.QUADS.find((q) => !R.GUARDS[g.guard].includes(q.id)).keys[0]);
    g.clock = 0;
    g.clockOn = false;
    key(' '); key('q'); key('ArrowUp');
    return true;
  });
  await page.waitForFunction(() => window.__vb.G.reason === 'time');
  const bell = await page.evaluate(() => {
    const g = window.__vb.G;
    return { before: window.__bellProbe, after: { hp: g.hp, oppHp: g.oppHp, landed: g.landed, score: g.score } };
  });
  assert.deepEqual(bell.after, bell.before, 'a pending punch and further inputs must not deal damage or award score after the bell');
  assert.equal((await snapshot()).kos, 0);
  console.log('PASS timeout: no late punch damage, score, or knockout after the bell');

  await start();
  const circuitIndex = await page.evaluate(() => {
    const t = window.__fightTest;
    t.autoAttack = true;
    t.captureBouts = true;
    t.capturedBouts = [];
    return t.frames.length;
  });
  for (const [fight, venue] of ['pete', 'nova', 'volt'].entries()) {
    await page.waitForFunction((i) => window.__fightTest.captureReady === i || window.__vb.G.reason !== null, fight, { timeout: 90_000 });
    const state = await snapshot();
    assert.equal(state.reason, null, `the circuit reaches bout ${fight + 1} before the clock expires`);
    assert.equal(state.venue, venue, `bout ${fight + 1} has its own venue`);
    assert.equal(state.oppHp, state.oppMax, 'the circuit uses the full opponent health pool');
    assert.equal(state.playerDowns, 0);
    assert.equal(state.oppDowns, 0);
    await capture(venue);
    await page.evaluate(() => { window.__fightTest.captureReady = null; window.__vb.G.paused = false; });
  }
  await page.waitForFunction(() => window.__vb.G.reason !== null, undefined, { timeout: 90_000 });
  const champion = await snapshot();
  assert.equal(champion.reason, 'champ', `a perfect player can finish all three bouts within the match clock: ${JSON.stringify(champion)}`);
  assert.equal(champion.kos, 3);
  assert.equal(champion.playerDowns, 0);
  assert.ok(champion.clock > 0, 'the two-minute circuit must remain winnable');
  const circuit = await page.evaluate((i) => window.__fightTest.frames.slice(i), circuitIndex);
  for (const fight of [0, 1, 2]) {
    assert.deepEqual([...new Set(circuit.filter((s) => s.fight === fight && s.mode === 'count').map((s) => s.oppDowns))], [1, 2], `bout ${fight + 1} counts only its first two knockdowns`);
    assert.ok(circuit.some((s) => s.fight === fight && s.mode === 'ko' && s.oppDowns === 3 && s.count === 0 && !s.refereeVisible), `bout ${fight + 1} finishes on the third knockdown`);
  }
  console.log(`PASS full circuit: three real-health bouts, nine knockdowns, ${champion.clock.toFixed(1)}s remaining`);

  await page.evaluate(() => { window.__fightTest.autoAttack = false; window.__fightTest.captureBouts = false; void window.__vb.enterGym(); });
  await page.waitForFunction(() => window.__vb.G.scene === 'gym' && window.__vb.stage.venueName === 'gym');
  await page.waitForTimeout(500);
  await capture('gym');
  await page.evaluate(() => { void window.__vb.toTitle(); });
  await page.waitForFunction(() => window.__vb.G.scene === 'title');
  assert.notEqual((await snapshot()).venue, 'gym', 'leaving the gym restores an arena');
  console.log('PASS venues: Pete gym, Nova rooftop, Volt dome, and Coach Pops gym');

  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('All fight integration checks passed.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
