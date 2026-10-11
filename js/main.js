import * as THREE from './vendor/three.js';
import { Stage, PLAYER_Z, OPP_Z, PLAYER_SCALE } from './stage.js';
import { Boxer, IMPACT, SUPER_WIND } from './boxer.js';
import { Sound } from './audio.js';
import * as R from './rules.js';
import { renderCard, canvasToBlob, shareText, systemShare, HEADLINES } from './share.js';
import { $, $$, sleep, Menu, menuKey, activeMenu, Screen2, wipe, typeText, stamp, countUp, letters, meter } from './ui.js';
import { LESSONS, praise, readAdvice, PUNCH_ADVICE } from './lessons.js';

const app = $('#app');
const deck = $('#deck');
const fx = $('#fx');
const arena = $('#arena');
const wipeEl = $('#wipe');

const sound = new Sound();
let stage;
let player;
let opp;

// ---------------------------------------------------------------------------
// game state
const G = {
  scene: 'title', // title | fight | gym | results
  mode: 'title', // title | intro | defend | attack | between | count | ko | over | gym | og
  clock: R.MATCH_SECONDS,
  clockOn: false,
  paused: false,
  timeScale: 1,
  hitstop: 0,
  gameTime: 0,
  def: null, // the attack you're reading: { key, start, total, action, at }
  punchWait: null, // your punch window: { resolve, start, total, switchAt, switched }
  guard: 'base',
  oppDef: R.OPPONENTS[0],
};

function resetMatch() {
  Object.assign(G, {
    clock: R.MATCH_SECONDS, clockOn: false, timeScale: 1, hitstop: 0,
    score: 0, hp: R.PLAYER_HP, oppHp: 0, oppMax: 1, fight: 0, stars: 0,
    playerDowns: 0, oppDowns: 0, count: 0,
    combo: 0, bestCombo: 0, kos: 0, landed: 0, reads: 0, perfects: 0, early: 0, supers: 0,
    recent: [], rounds: [], reason: null, highlight: 0, tutor: 0, tutorAttack: 0,
    def: null, punchWait: null, guard: 'base', lastRead: null,
  });
}
resetMatch();

let gen = 0; // bumps on every new flow so stale async sequences bail out
const gone = (ctx) => ctx.my !== gen;
const fightExpired = (ctx) => !ctx.demo && !ctx.train && G.clock <= 0;
const OPP = () => G.oppDef;

// timers in game time (slow-mo/hit-stop aware) and real time (pause aware)
const gameTimers = new Set();
const realTimers = new Set();
const wait = (s) => new Promise((res) => gameTimers.add({ t: s, res }));
const waitReal = (s) => new Promise((res) => realTimers.add({ t: s, res }));
function tickTimers(set, dt) {
  for (const tm of [...set]) {
    tm.t -= dt;
    if (tm.t <= 0) {
      set.delete(tm);
      tm.res();
    }
  }
}

const haptic = (p) => { try { navigator.vibrate?.(p); } catch { /* unsupported */ } };
const rand = (a) => a[Math.floor(Math.random() * a.length)];

function setScene(s) {
  cancelGesture();
  G.scene = s;
  app.dataset.scene = s;
  if (s !== 'fight') app.classList.remove('danger');
  if (s !== 'fight') hideReferee();
}

// ---------------------------------------------------------------------------
// storage
const store = {
  get(k, d) { try { const v = localStorage.getItem(`virtuabox.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`virtuabox.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};
const loadBest = () => Number(store.get('best', 0)) || 0;
const gymDone = () => new Set(store.get('gym', []).filter((id) => LESSONS.some((L) => L.id === id)));
function markDone(id) {
  const d = gymDone();
  d.add(id);
  store.set('gym', [...d]);
}

// ---------------------------------------------------------------------------
// HUD
const clockEl = $('#clock');
const clockSvg = buildSevenSeg(clockEl);
let lastClockText = '';
let lastClockRunning = null;

function setClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (text !== lastClockText) {
    lastClockText = text;
    clockSvg.set(text);
    clockEl.setAttribute('aria-label', `${Math.floor(s / 60)} minutes ${s % 60} seconds left`);
  }
  clockEl.classList.toggle('hurry', s <= 10 && G.clockOn && !G.paused);
  const running = G.clockOn && !G.paused;
  if (running !== lastClockRunning) {
    lastClockRunning = running;
    app.dataset.clock = running ? 'live' : 'stopped';
    const state = $('#clock-state');
    if (state) state.textContent = running ? 'LIVE' : 'STOPPED';
  }
}

function setBar(which, frac) {
  const bar = $(`.${which} .bar`);
  const v = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  bar.querySelector('.fill').style.setProperty('--hp', v);
  bar.querySelector('.lag').style.setProperty('--hp', v);
  bar.classList.toggle('low', frac < 0.25);
  bar.setAttribute('aria-valuenow', Math.round(Math.max(0, Math.min(1, frac)) * 100));
}

let shownScore = 0;
function updateHud() {
  setBar('p1', G.hp / R.PLAYER_HP);
  setBar('p2', G.oppHp / G.oppMax);
  for (const [side, downs] of [['p1', G.playerDowns], ['p2', G.oppDowns]]) {
    const el = $(`.${side} .knockdowns`);
    el.setAttribute('aria-label', `${downs} of ${R.KNOCKDOWNS_TO_KO} knockdowns`);
    el.querySelectorAll('i').forEach((pip, i) => pip.classList.toggle('down', i < downs));
  }
  app.classList.toggle('danger', G.scene === 'fight' && G.hp > 0 && G.hp / R.PLAYER_HP <= 0.3);
}

function setStatus(text, cls = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = cls;
}

function renderPips() {
  $('#pips').innerHTML = R.OPPONENTS.map((o, i) => {
    const cls = i < G.kos ? 'ko' : i === G.fight ? 'now' : '';
    return `<i class="${cls}" style="--c:${o.color}"></i>`;
  }).join('');
}

function setHi() {
  $('#hi').textContent = `HI ${String(loadBest()).padStart(6, '0')}`;
}

const comboEl = $('#combo');
function setCombo(n) {
  comboEl.classList.toggle('on', n >= 2);
  comboEl.classList.toggle('hot', n >= R.MAX_CHAIN);
  if (n >= 2) {
    comboEl.querySelector('b').textContent = n;
    comboEl.classList.remove('bump');
    void comboEl.offsetWidth;
    comboEl.classList.add('bump');
  }
}

function popup(text, cls = '', life = 1000) {
  const d = document.createElement('div');
  d.className = `pop ${cls}`;
  d.textContent = text;
  d.style.setProperty('--len', Math.max(5, text.length));
  fx.appendChild(d);
  setTimeout(() => d.remove(), life + 700);
  return d;
}

function floatNum(text, worldPos, cls = '') {
  if (!stage) return;
  const p = stage.project(worldPos);
  const d = document.createElement('div');
  d.className = `num ${cls}`;
  d.textContent = text;
  d.style.left = `${p.x + (Math.random() - 0.5) * 30}px`;
  d.style.top = `${p.y}px`;
  fx.appendChild(d);
  setTimeout(() => d.remove(), 1000);
}

function quake() {
  if (reducedMotion) return;
  app.classList.remove('quake');
  void app.offsetWidth;
  app.classList.add('quake');
}

// ---------------------------------------------------------------------------
// deck: whose turn it is, stars, and which controls are live
const turnEl = $('#turn');
const starsEl = $('#stars');
const starEls = $$('#stars i');
const superBtn = $('#super');
const padBtns = $$('.pb');
const dpadBtns = $$('.dp[data-d]');

function setTurn(kind, title, sub = '') {
  turnEl.className = kind;
  turnEl.querySelector('b').textContent = title;
  turnEl.querySelector('small').textContent = sub;
  app.dataset.turn = ['their', 'your', 'counter'].includes(kind) ? kind : '';
}

/** 'def' lights the D-pad, 'off' lights the punch pad, 'wait' dims both. */
function setControls(mode) {
  cancelGesture();
  deck.dataset.mode = mode;
  dpadBtns.forEach((b) => b.classList.remove('on', 'hint'));
  superBtn.classList.toggle('ready', mode === 'off' && G.stars > 0);
  if (mode === 'wait') app.dataset.turn = '';
  dpadBtns.forEach((b) => b.setAttribute('aria-disabled', mode !== 'def'));
  padBtns.forEach((b) => b.setAttribute('aria-disabled', mode !== 'off'));
  superBtn.setAttribute('aria-disabled', mode !== 'off' || G.stars === 0);
}

function setStars(n, gained = false) {
  G.stars = Math.max(0, Math.min(R.MAX_STARS, n));
  starEls.forEach((el, i) => {
    el.classList.toggle('on', i < G.stars);
    el.classList.toggle('pop', gained && i === G.stars - 1);
  });
  starsEl.classList.toggle('full', G.stars === R.MAX_STARS);
  $('#super-n').textContent = G.stars ? `x${G.stars}` : '';
  superBtn.classList.toggle('ready', G.mode === 'attack' && G.stars > 0);
  superBtn.setAttribute('aria-disabled', deck.dataset.mode !== 'off' || G.stars === 0);
  starsEl.setAttribute('aria-label', `${G.stars} of ${R.MAX_STARS} super stars`);
}

function renderPad(guard) {
  const covered = guard ? R.GUARDS[guard] || [] : [];
  padBtns.forEach((b) => {
    const q = Number(b.dataset.q);
    b.classList.toggle('guarded', covered.includes(q));
    const Q = R.QUADS[q];
    b.setAttribute('aria-label', `${Q.name.toLowerCase()}, ${Q.sx < 0 ? 'left' : 'right'}${guard ? covered.includes(q) ? ', guarded' : ', open' : ''} (${Q.keys[0].toUpperCase()})`);
  });
}

function pressFx(btn) {
  if (!btn) return;
  btn.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => btn.classList.remove('hit'), 200);
}

// ---------------------------------------------------------------------------
// arena overlays: the tell marker over the glove, and the four targets
const tellEl = $('#tell');
const targetEls = $$('#targets i');
const tell = { on: false, hand: 1 };
const targetPos = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
let targetsOn = false;
const _q = new THREE.Vector3();

function showTell(key, switched = false) {
  const a = R.ATTACKS[key];
  tell.on = true;
  tell.hand = R.attackHand(key);
  tellEl.className = `show${a.mega ? ' mega' : ''}${switched ? ' switch' : ''}`;
  tellEl.querySelector('b').textContent = a.mega ? '!!' : '!';
  tellEl.querySelector('small').textContent = '';
  opp.windup(a.move, tell.hand, { mega: a.mega });
}

function hideTell() {
  tell.on = false;
  tellEl.className = '';
}

/** Training wheels: name the answer and light its button. */
function hintTell(key) {
  const a = R.ATTACKS[key];
  tellEl.querySelector('small').textContent = a.hint;
  const answers = a.answer === 'SLIP' ? ['L', 'R'] : [a.answer];
  dpadBtns.forEach((b) => b.classList.toggle('hint', answers.includes(b.dataset.d)));
}

function showTargets(guard) {
  targetsOn = !!guard;
  const covered = guard ? R.GUARDS[guard] : [];
  targetEls.forEach((el, q) => {
    el.className = !guard ? '' : covered.includes(q) ? 'guard' : guard === 'open' ? 'open counter' : 'open';
  });
}

function quadWorld(q, out) {
  const Q = R.QUADS[q];
  if (Q.high) opp.headWorld(out);
  else opp.chestWorld(out);
  out.x += Q.sx * (Q.high ? 0.12 : 0.15) * opp.bulk;
  out.y -= Q.high ? 0.0 : 0.05;
  out.z += 0.12;
  return out;
}

function updateOverlays() {
  if (tell.on) {
    const p = stage.project(opp.gloveWorld(tell.hand, _q));
    tellEl.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  }
  if (targetsOn) {
    targetEls.forEach((el, q) => {
      const p = stage.project(quadWorld(q, _q));
      targetPos[q].x = p.x;
      targetPos[q].y = p.y;
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    });
  }
}

// ---------------------------------------------------------------------------
// input: D-pad defends, punch pad attacks; or swipe / tap right on the ring
function onDefend(action) {
  const d = G.def;
  if (G.mode !== 'defend' || !d || d.action || !d.total || G.paused || (G.scene === 'fight' && G.clock <= 0)) return;
  d.action = action;
  d.at = (G.gameTime - d.start) / d.total;
  player.defend(action);
  sound.select(action === 'BLOCK' ? 1 : action === 'DUCK' ? 2 : 3);
  haptic(10);
  const btn = document.querySelector(`.dp[data-d="${action}"]`);
  pressFx(btn);
  btn?.classList.add('on');
}

function onPunch(q) {
  if (G.mode !== 'attack' || !G.punchWait || G.paused || (G.scene === 'fight' && G.clock <= 0)) return;
  pressFx(padBtns.find((b) => Number(b.dataset.q) === q));
  const w = G.punchWait;
  G.punchWait = null;
  w.resolve(q);
}

function onSuper() {
  if (G.mode !== 'attack' || !G.punchWait || G.stars < 1 || G.paused || (G.scene === 'fight' && G.clock <= 0)) return;
  pressFx(superBtn);
  const w = G.punchWait;
  G.punchWait = null;
  w.resolve('super');
}

dpadBtns.forEach((b) => b.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0) return;
  e.preventDefault();
  onDefend(b.dataset.d);
}));
padBtns.forEach((b) => b.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0) return;
  e.preventDefault();
  onPunch(Number(b.dataset.q));
}));
superBtn.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0) return;
  e.preventDefault();
  onSuper();
});
// Native keyboard/assistive clicks don't emit pointerdown. Avoid firing twice
// for mouse/touch clicks, which have already been handled above.
dpadBtns.forEach((b) => b.addEventListener('click', (e) => { if (e.detail === 0) onDefend(b.dataset.d); }));
padBtns.forEach((b) => b.addEventListener('click', (e) => { if (e.detail === 0) onPunch(Number(b.dataset.q)); }));
superBtn.addEventListener('click', (e) => { if (e.detail === 0) onSuper(); });

// swipe to slip / duck / block, tap a target to punch it, flick up for the super
let ptr = null;
function cancelGesture() {
  if (ptr && arena.hasPointerCapture(ptr.id)) arena.releasePointerCapture(ptr.id);
  ptr = null;
}
document.addEventListener('pointerdown', (e) => { app.dataset.input = e.pointerType === 'touch' ? 'touch' : 'mouse'; }, { passive: true });
arena.addEventListener('pointerdown', (e) => {
  if (G.paused || !e.isPrimary || e.button !== 0 || ptr) return;
  if (G.scene === 'title' && screen2.next === 'start') {
    pressStart();
    return;
  }
  if (G.mode === 'intro') {
    skipIntro?.();
    return;
  }
  if (G.mode === 'defend' || G.mode === 'attack') {
    const context = G.mode === 'defend' ? G.def : G.punchWait;
    if (!context) return;
    ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: G.mode, context };
    arena.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
arena.addEventListener('pointerup', (e) => {
  if (!ptr || ptr.id !== e.pointerId) return;
  const gesture = ptr;
  cancelGesture();
  const context = G.mode === 'defend' ? G.def : G.punchWait;
  if (G.paused || gesture.mode !== G.mode || gesture.context !== context) return;
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;
  const threshold = Math.max(18, Math.min(26, arena.clientWidth * 0.06));
  const swipe = Math.hypot(dx, dy) > threshold;
  if (G.mode === 'defend' && swipe) {
    onDefend(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'L' : 'R') : dy > 0 ? 'DUCK' : 'BLOCK');
  } else if (G.mode === 'attack') {
    if (swipe && dy < -40 && Math.abs(dy) > Math.abs(dx)) {
      onSuper();
      return;
    }
    // map the tap to a target relative to the opponent's centre
    const r = arena.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const cx = targetPos.reduce((s, p) => s + p.x, 0) / 4;
    const cy = targetPos.reduce((s, p) => s + p.y, 0) / 4;
    onPunch((y > cy ? 2 : 0) + (x > cx ? 1 : 0));
  }
});
arena.addEventListener('pointercancel', (e) => { if (ptr?.id === e.pointerId) cancelGesture(); });
arena.addEventListener('lostpointercapture', (e) => { if (ptr?.id === e.pointerId) ptr = null; });

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  app.dataset.input = 'keyboard';
  const k = e.key.toLowerCase();
  if ((k === 'escape' || k === 'p') && !G.paused && canPause() && !activeMenu()) {
    e.preventDefault();
    pause();
    return;
  }
  if (menuKey(e)) {
    e.preventDefault();
    return;
  }
  const def = Object.entries(R.DEFENSES).find(([, d]) => d.keys.includes(k));
  if (def) {
    e.preventDefault();
    onDefend(def[0]);
    return;
  }
  if (k === ' ') {
    if (e.target.closest?.('#deck button')) return; // native button activation
    e.preventDefault();
    onSuper();
    return;
  }
  const q = R.QUADS.find((Q) => Q.keys.includes(k));
  if (q) onPunch(q.id);
});

// ---------------------------------------------------------------------------
// the fight
function setVenue(name) {
  stage.venue(name);
  app.dataset.venue = stage.venueName;
}

function makeOpponent(def) {
  const o = typeof def === 'number' ? R.OPPONENTS[def] : def;
  opp?.dispose();
  opp = new Boxer({ color: o.color, look: o.look, bulk: o.bulk, tall: o.tall, hair: o.hair, belt: o.belt });
  opp.root.position.set(0, 0, OPP_Z);
  stage.scene.add(opp.root);
  stage.trackFighters(player, opp);
  document.documentElement.style.setProperty('--opp', o.color);
  $('#opp-name').textContent = o.name;
  G.oppDef = o;
  return o;
}

const READ_WORDS = { L: 'SLIPPED!', R: 'SLIPPED!', DUCK: 'DUCKED!', BLOCK: 'STUFFED!' };
const answerFor = (key) => {
  const a = R.ATTACKS[key].answer;
  return a === 'SLIP' ? rand(['L', 'R']) : a;
};

/** THEIR TURN: one attack, maybe two, each read before it lands. */
async function defendTurn(ctx) {
  const o = OPP();
  const hpFrac = ctx.demo ? 1 : G.oppHp / G.oppMax;
  const earlyRate = G.reads ? G.early / G.reads : 0;
  const attacks = R.planAttacks(o, { recent: G.recent, earlyRate, hpFrac });
  if (!ctx.demo) {
    G.mode = 'defend';
    setTurn('their', 'THEIR TURN', attacks.length > 1 ? 'DOUBLE ATTACK!' : 'READ THE GLOVE');
    setControls('def');
    showTargets(null);
    renderPad(null);
    stage.shot('fight', { rate: 2.5 });
  }
  opp.setGuard('base');
  await wait(ctx.demo ? 0.35 : 0.3);
  let res = 'hit';
  for (let i = 0; i < attacks.length; i++) {
    if (gone(ctx)) return null;
    if (fightExpired(ctx)) return 'time';
    res = await defendOne(attacks[i], i > 0, ctx);
    if (fightExpired(ctx)) return 'time';
    if (res === null || (!ctx.demo && G.hp <= 0)) return res;
    if (i < attacks.length - 1) await wait(0.1);
  }
  return res;
}

/**
 * One attack. ctx.demo = the boxers play themselves (title / booklet demos);
 * ctx.show = a demo that still draws tells and call-outs; ctx.train = a gym
 * drill (ctx.hint names the answer).
 */
async function defendOne(atk, second, ctx) {
  const o = OPP();
  const live = !ctx.demo;
  const vis = live || ctx.show;
  const total = R.tellTime(o, ctx.demo ? 1 : G.oppHp / G.oppMax, second);
  const head = player.headWorld(new THREE.Vector3());
  const chest = player.chestWorld(new THREE.Vector3());
  G.def = { key: atk.key, start: G.gameTime, total, action: null, at: 0 };
  if (live) dpadBtns.forEach((b) => b.classList.remove('on', 'hint'));
  G.recent.push(atk.key);
  if (G.recent.length > 6) G.recent.shift();
  const hint = ctx.train ? ctx.hint || atk.hint : ctx.show || (live && G.fight === 0 && G.tutor < 3);
  if (vis) {
    showTell(atk.feintFrom || atk.key);
    sound.tell(R.ATTACKS[atk.key].mega);
    if (hint && !atk.feintFrom) hintTell(atk.key);
  } else {
    opp.windup(R.ATTACKS[atk.feintFrom || atk.key].move, R.attackHand(atk.feintFrom || atk.key));
  }
  if (!live) {
    // the demo boxer reads it (always right in booklet demos)
    const acc = ctx.acc ?? 0.85;
    const at = ctx.show ? 0.64 + Math.random() * 0.12 : 0.5 + Math.random() * 0.3;
    wait(total * at).then(() => {
      if (G.def && !G.def.action && !gone(ctx)) {
        G.def.action = Math.random() < acc ? answerFor(atk.key) : rand(Object.keys(R.DEFENSES));
        player.defend(G.def.action);
      }
    });
  }

  if (atk.feintFrom) {
    await wait(total * atk.feintAt);
    if (gone(ctx)) return null;
    // the switch: a second, different tell. Early readers get caught.
    if (vis) {
      showTell(atk.key, true);
      sound.tell(false, true);
      popup('FEINT!', 'sm trade', 600);
      if (ctx.show || (ctx.train && hint)) hintTell(atk.key);
    } else {
      opp.windup(R.ATTACKS[atk.key].move, R.attackHand(atk.key));
    }
    await wait(total * (1 - atk.feintAt));
  } else {
    await wait(total);
  }
  if (gone(ctx)) return null;

  if (fightExpired(ctx)) {
    G.def = null;
    hideTell();
    return 'time';
  }
  const d = G.def;
  d.total = 0; // window closed
  const action = d.action;
  const res = R.readAttack(atk.key, action);
  const A = R.ATTACKS[atk.key];
  const hand = R.attackHand(atk.key);
  if (vis) hideTell();
  if (live) {
    G.reads++;
    if (action && d.at < 0.45) G.early++;
    if (G.fight === 0 && res === 'perfect') G.tutor++;
    G.lastRead = { key: atk.key, action, at: d.at, res, feint: !!atk.feintFrom, feintAt: atk.feintAt };
  }

  // the strike: aimed where you were, at your guard, or straight through
  const opts = { hand, fromWindup: true };
  let result = 'land';
  if (res === 'perfect' && action !== 'BLOCK') {
    result = 'whiff';
    opts.target = A.high ? head : chest;
  } else if (action === 'BLOCK') {
    opts.target = player.gloveWorld(1).add(player.gloveWorld(-1, _q)).multiplyScalar(0.5);
  }
  const clip = opp.punch(A.move, result, player, null, opts);
  sound.whoosh();
  await wait(clip.impactIn);
  if (gone(ctx)) return null;
  if (fightExpired(ctx)) {
    G.def = null;
    return 'time';
  }

  const pos = opts.target || (A.high ? player.headWorld(new THREE.Vector3()) : player.chestWorld(new THREE.Vector3()));
  if (res === 'perfect') {
    opp.stumble(A.from);
    if (action === 'BLOCK') {
      stage.clash(pos);
      sound.clash();
    } else {
      stage.whiff(pos);
      sound.whoosh();
    }
    G.hitstop = 0.08;
    if (vis) popup(READ_WORDS[action], 'clash');
    if (live) {
      G.perfects++;
      G.score += R.SCORE.read;
      setStars(G.stars + 1, true);
      if (G.stars === R.MAX_STARS && !ctx.train) setTimeout(() => popup('SUPER READY!', 'sm gold', 900), 250);
      haptic(15);
      sound.cheer(0.4);
    }
  } else if (res === 'block') {
    const chip = Math.round(o.hit * A.dmg * (A.mega ? 0.5 : R.BLOCK_CHIP));
    player.recoil();
    stage.clash(pos);
    sound.clash();
    G.hitstop = 0.06;
    if (live) {
      G.hp = Math.max(0, G.hp - chip);
      G.score += R.SCORE.block;
      floatNum(`-${chip}`, pos, 'trade');
      popup('BLOCK', 'sm');
      haptic(20);
    }
  } else {
    const dmg = Math.round(o.hit * A.dmg);
    const ko = live && !ctx.train && G.hp - dmg <= 0;
    const power = ko ? 3 : A.mega ? 2.2 : 1.1;
    player.relax(true);
    player.react(A.move, Math.min(1.9, power), hand);
    stage.impact(pos, o.color, power);
    sound.hit(power, !A.high);
    G.hitstop = ko ? 0.14 : 0.07;
    if (live) {
      G.hp = Math.max(ctx.train ? 1 : 0, G.hp - dmg);
      G.combo = 0;
      setCombo(0);
      floatNum(`-${dmg}`, pos, 'lose');
      popup(!action ? 'TOO SLOW!' : action === 'BLOCK' ? 'BLOCK' : rand(['OUCH!', 'READ WRONG!', 'TAGGED!']), 'lose');
      if (G.stars > 0) {
        setStars(G.stars - 1);
        popup('-1 STAR', 'sm lose', 700);
      }
      if (A.mega) quake();
      haptic([30, 20, 40]);
    }
  }
  if (live) updateHud();
  await wait(0.2);
  player.relax();
  G.def = null;
  return res;
}

/** YOUR TURN: punch the openings, chain until a glove stops you. */
async function attackTurn(defRes, ctx) {
  if (fightExpired(ctx)) return [];
  const o = OPP();
  const live = !ctx.demo;
  const vis = live || ctx.show;
  const open = defRes === 'perfect';
  const stunned = defRes === 'hit';
  const log = [];
  if (live) {
    G.mode = 'attack';
    if (open) setTurn('counter', 'COUNTER!', 'WIDE OPEN: UNLOAD!');
    else setTurn('your', 'YOUR TURN', G.tutorAttack < 2 ? 'HIT AN OPEN TARGET' : stunned ? 'TIGHT GUARD: ONE OPENING' : 'FIND THE OPENING');
    setControls('off');
    stage.shot('fight', { rate: 3, dolly: 0.2, lift: 0.38 });
  }
  let guard = null;
  let lastQ = null;
  let chain = 0;
  for (let i = 0; i < R.MAX_CHAIN; i++) {
    if (gone(ctx) || fightExpired(ctx)) return log;
    // tagged last turn: they tighten up and leave one opening for your first shot
    guard = open ? 'open' : R.pickGuard(o, guard, lastQ, Math.random, stunned && i === 0);
    G.guard = guard;
    opp.setGuard(guard);
    if (vis) showTargets(guard);
    if (live) renderPad(guard);
    const total = o.window * Math.pow(0.85, i) * (stunned ? 0.75 : 1) * (open && i === 0 ? 1.2 : 1);
    const switchAt = !open && !guard.startsWith('tight') && Math.random() < o.guardSwitch ? 0.45 + Math.random() * 0.15 : null;
    const choice = live ? await waitPunch(total, switchAt) : await botPunch(total, ctx, switchAt);
    if (gone(ctx) || fightExpired(ctx)) return log;
    if (choice === 'timeout') {
      if (live && G.clock > 0) popup('TOO SLOW', 'sm lose', 600);
      break;
    }
    if (choice === 'super') {
      log.push('super');
      await superPunch(ctx);
      break;
    }
    const q = choice;
    const Q = R.QUADS[q];
    if (R.GUARDS[G.guard].includes(q)) {
      // straight into a glove
      const target = nearestGlove(quadWorld(q, new THREE.Vector3()));
      player.punch(Q.move, 'land', opp, null, { hand: Q.hand, target });
      sound.whoosh();
      await wait(IMPACT);
      if (gone(ctx) || fightExpired(ctx)) return log;
      opp.recoil();
      stage.clash(target);
      sound.clash();
      G.hitstop = 0.05;
      log.push('blocked');
      if (live) {
        G.combo = 0;
        setCombo(0);
        popup('BLOCKED!', 'sm');
        haptic(15);
      }
      break;
    }
    player.punch(Q.move, 'land', opp, null, { hand: Q.hand });
    sound.whoosh();
    await wait(IMPACT);
    if (gone(ctx) || fightExpired(ctx)) return log;
    chain++;
    log.push('land');
    const dmg = Math.round(R.PUNCH_DMG * R.chainMult(i) * (open ? R.COUNTER_MULT : 1));
    const ko = live && G.oppHp - dmg <= 0;
    const power = ko ? 3 : 0.8 + i * 0.3 + (open ? 0.3 : 0);
    const pos = player.gloveWorld(-Q.hand, new THREE.Vector3());
    opp.react(Q.move, Math.min(1.9, 0.85 + i * 0.25), -Q.hand);
    stage.impact(pos, '#58f858', power);
    sound.hit(power, !Q.high);
    G.hitstop = ko ? 0.14 : 0.05 + i * 0.02;
    if (vis && !ko) popup(i === 0 ? (open ? 'COUNTER!' : Q.high ? 'POW!' : 'BAM!') : ['', 'DOUBLE!', 'TRIPLE!', 'FLURRY!'][i], i >= 2 ? 'gold' : '');
    if (live) {
      G.oppHp = Math.max(0, G.oppHp - dmg);
      G.landed++;
      G.combo++;
      G.bestCombo = Math.max(G.bestCombo, G.combo);
      G.tutorAttack++;
      G.score += R.SCORE.punch * (i + 1) * (open ? R.SCORE.counter : 1);
      setCombo(G.combo);
      floatNum(`-${dmg}`, pos);
      if (G.highlight < power && !ctx.train) {
        G.highlight = power;
        stage.capture();
      }
      haptic(ko ? [40, 30, 80] : 18);
      if (i >= 2) quake();
      updateHud();
      if (G.oppHp <= 0) return log;
    }
    lastQ = q;
    await wait(0.1);
  }
  if (live && chain === R.MAX_CHAIN && G.oppHp > 0) {
    G.score += R.SCORE.flurry;
    setTimeout(() => popup(`FLURRY +${R.SCORE.flurry}`, 'sm gold'), 420);
    sound.voice('combo');
  }
  opp.setGuard('base');
  if (vis) showTargets(null);
  if (live) renderPad(null);
  return log;
}

function nearestGlove(p) {
  const a = opp.gloveWorld(1, new THREE.Vector3());
  const b = opp.gloveWorld(-1, new THREE.Vector3());
  return a.distanceTo(p) < b.distanceTo(p) ? a : b;
}

function waitPunch(total, switchAt) {
  return new Promise((resolve) => {
    G.punchWait = { resolve, start: G.gameTime, total, switchAt, switched: false };
  });
}

/** The demo boxer: mostly finds the opening (booklet demos wait out a guard switch). */
async function botPunch(total, ctx, switchAt) {
  if (switchAt && ctx.show) {
    await wait(total * switchAt);
    if (gone(ctx)) return 'timeout';
    switchGuard();
    await wait(total * 0.14);
  } else {
    await wait(total * (ctx.show ? 0.35 : 0.3 + Math.random() * 0.3));
  }
  if (ctx.botSuper) {
    ctx.botSuper = false;
    return 'super';
  }
  const open = [0, 1, 2, 3].filter((q) => !R.GUARDS[G.guard].includes(q));
  return open.length && Math.random() < (ctx.acc ?? 0.88) ? rand(open) : rand([0, 1, 2, 3]);
}

/** Champions shift their guard mid-window: re-read it. */
function switchGuard() {
  const o = OPP();
  G.guard = R.pickGuard(o, G.guard, null);
  opp.setGuard(G.guard);
  showTargets(G.guard);
  renderPad(G.guard);
  $('#targets').classList.remove('flash');
  void $('#targets').offsetWidth;
  $('#targets').classList.add('flash');
  sound.tick(true);
}

// SUPER camera: a low side angle on the coil, then a cut to look up at the hit
const SUPER_CAM = {
  coil: { pos: new THREE.Vector3(1.55, 0.8, 1.7), look: new THREE.Vector3(-0.05, 1.0, 0.25), hfov: 52 },
  push: { pos: new THREE.Vector3(1.15, 0.78, 1.3), look: new THREE.Vector3(-0.05, 1.02, 0.2), hfov: 48 },
  hit: { pos: new THREE.Vector3(-1.05, 0.55, 0.5), look: new THREE.Vector3(0.05, 1.55, OPP_Z), hfov: 56 },
};
const superFx = $('#superfx');

/**
 * The SUPER: each banked star drains out of the meter and into the glove
 * (a longer, louder charge per star), then a slow-motion uppercut that
 * launches them. Damage climbs steeply, so saving all three pays off.
 */
async function superPunch(ctx) {
  const live = !ctx.demo;
  const vis = live || ctx.show;
  const n = live ? G.stars : R.MAX_STARS;
  const clockWas = G.clockOn;
  G.clockOn = false; // the cinematic doesn't eat the fight clock
  const glove = () => player.gloveWorld(-1, new THREE.Vector3());
  showTargets(null);
  opp.setGuard('open');
  player.charge(1);
  player.glow = 0.5;
  superFx.className = 'on';
  stage.shot(reducedMotion ? 'fight' : 'custom', { ...SUPER_CAM.coil, rate: 6 });
  sound.riser();
  if (vis) popup('SUPER!', 'xl gold', 700);
  haptic(30);
  const step = (R.superCharge(n) - 0.35) / n;
  await wait(0.35);
  for (let k = 1; k <= n; k++) {
    if (gone(ctx)) return;
    if (live) setStars(G.stars - 1);
    player.glow = k;
    superFx.className = `on l${k}`;
    stage.charge(glove(), k);
    sound.charge(k);
    if (k === 2 && !reducedMotion) stage.shot('custom', { ...SUPER_CAM.push, rate: 2 });
    if (vis) popup(k === R.MAX_STARS ? 'MAX POWER!' : `POWER ${k}`, 'sm gold', 600);
    haptic(12 * k);
    await wait(step);
  }
  if (gone(ctx)) return;

  // release: cut low and slow everything down into the hit
  superFx.className = `on l${Math.max(1, n)}`;
  if (!reducedMotion) stage.shot('custom', { ...SUPER_CAM.hit, snap: true });
  G.timeScale = 0.3;
  const clip = player.punch(R.UPPER, 'land', opp, null, { hand: 1, fromWindup: true, wind: SUPER_WIND });
  sound.whoosh();
  await wait(clip.impactIn);
  if (gone(ctx)) return;
  G.timeScale = 1;
  player.glow = 0;
  superFx.className = 'flash';
  const dmg = R.SUPER_DMG[n];
  const pos = opp.headWorld(new THREE.Vector3());
  opp.react(R.UPPER, 2.2, -1);
  opp.launch(0.55 + n * 0.25);
  stage.superHit(pos, n);
  stage.confetti(60 + n * 40);
  sound.hit(3);
  sound.slam();
  sound.cheer(1);
  G.hitstop = 0.24;
  quake();
  haptic([60, 30, 90]);
  if (vis) {
    popup(n === R.MAX_STARS ? 'MEGA SUPER!' : 'SUPER UPPERCUT!', 'xl gold', 1100);
    setTimeout(() => popup(`${dmg} DAMAGE!`, 'sm gold', 900), 280);
  }
  if (live) {
    G.supers++;
    G.oppHp = Math.max(0, G.oppHp - dmg);
    G.score += R.SCORE.super * n * n;
    if (!ctx.train) {
      G.highlight = 50;
      stage.capture();
    }
    updateHud();
  }
  await wait(0.75);
  superFx.className = '';
  G.clockOn = clockWas && G.clock > 0;
  stage.shot('fight', { rate: 4 });
}

/** One fight: alternate their turn / your turn until someone drops or time runs out. */
async function fightLoop(ctx) {
  for (;;) {
    if (G.clock <= 0) return 'time';
    const d = await defendTurn(ctx);
    if (gone(ctx) || d === null) return 'abort';
    if (G.hp <= 0) {
      G.rounds.push([d]);
      const result = await knockdown(player, ctx.my);
      if (gone(ctx)) return 'abort';
      if (result === 'ko') return 'playerKO';
      continue;
    }
    if (G.clock <= 0) {
      G.rounds.push([d]);
      return 'time';
    }
    G.mode = 'between';
    setControls('wait');
    await wait(0.25);
    if (gone(ctx)) return 'abort';
    if (G.clock <= 0) {
      G.rounds.push([d]);
      return 'time';
    }
    const log = await attackTurn(d, ctx);
    if (gone(ctx)) return 'abort';
    G.rounds.push([d, ...log]);
    if (G.oppHp <= 0) {
      const result = await knockdown(opp, ctx.my);
      if (gone(ctx)) return 'abort';
      if (result === 'ko') return 'oppKO';
      continue;
    }
    G.mode = 'between';
    setControls('wait');
    await wait(0.2);
  }
}

function hideReferee() {
  $('#referee').className = '';
  $('#referee').setAttribute('aria-hidden', 'true');
  G.count = 0;
}

/** One down: suspend the exchange, count, then either a recovery or the KO. */
async function knockdown(victim, my) {
  const isOpponent = victim === opp;
  const downs = isOpponent ? ++G.oppDowns : ++G.playerDowns;
  const finalDown = downs >= R.KNOCKDOWNS_TO_KO;
  const name = isOpponent ? OPP().short : 'YOU';
  G.mode = 'count';
  G.clockOn = false;
  G.def = null;
  G.punchWait = null;
  G.combo = 0;
  setCombo(0);
  setControls('wait');
  renderPad(null);
  hideTell();
  showTargets(null);
  updateHud();
  app.classList.remove('danger');
  setTurn('idle', 'KNOCKDOWN!', `${name} · ${downs} OF ${R.KNOCKDOWNS_TO_KO}`);
  setStatus('REFEREE COUNT');
  G.timeScale = 0.55;
  sound.slowmo(true);
  sound.setIntensity(1);
  (isOpponent ? player : opp).clear();
  victim.knockout();
  const focus = new THREE.Vector3();
  victim.root.getWorldPosition(focus);
  stage.shot('ko', { focus, rate: 5, yaw: isOpponent ? 1 : -1 });
  popup('DOWN!', 'xl gold', 800);
  sound.voice('down');
  quake();
  await waitReal(0.7);
  if (my !== gen) return;
  G.timeScale = 1;
  sound.slowmo(false);
  const ref = $('#referee');
  const number = $('#ref-count');
  const message = $('#ref-message');
  ref.className = 'show';
  ref.setAttribute('aria-hidden', 'false');
  $('#ref-downs').textContent = `${name} DOWN · ${downs}/3`;
  message.textContent = finalDown ? 'LAST KNOCKDOWN' : 'STAY WITH ME!';
  for (let n = 1; n <= R.countLimit(downs); n++) {
    G.count = n;
    number.textContent = n;
    ref.classList.toggle('raised', n % 2 === 1);
    ref.classList.toggle('last-count', n >= 8);
    $('#ref-progress').style.setProperty('--count', n / R.REFEREE_COUNT);
    sound.tick(n >= 8);
    haptic(n === R.REFEREE_COUNT ? [30, 30, 90] : 12);
    // Pause-aware real seconds, independent of cinematic slow motion.
    await waitReal(1);
    if (my !== gen) return;
  }
  if (finalDown) {
    G.mode = 'ko';
    ref.classList.add('out');
    message.textContent = 'YOU\'RE OUT!';
    setTurn('idle', 'KNOCKOUT!', 'THREE KNOCKDOWNS · BOUT OVER');
    setStatus('KNOCKOUT');
    popup('K.O.!!', 'xl gold', 1500);
    sound.ko();
    sound.voice('ko', 0.1);
    sound.bell(3);
    if (isOpponent) stage.confetti();
    stage.capture();
    G.highlight = 99;
    await waitReal(1.4);
    if (my !== gen) return;
    hideReferee();
    return 'ko';
  }
  message.textContent = 'BACK ON YOUR FEET!';
  ref.classList.add('recovered');
  if (isOpponent) G.oppHp = R.recoveryHp(G.oppMax, downs);
  else G.hp = R.recoveryHp(R.PLAYER_HP, downs);
  victim.recover();
  updateHud();
  await waitReal(0.9);
  if (my !== gen) return;
  hideReferee();
  stage.shot('fight', { rate: 4 });
  setStatus(`BOUT ${G.fight + 1} · ${OPP().short}`);
  setTurn('idle', 'BOX!', 'THIRD KNOCKDOWN IS THE K.O.');
  sound.voice('fight');
  popup('BOX!', 'good', 700);
  await waitReal(0.6);
  if (my !== gen) return;
  G.clockOn = G.clock > 0;
  sound.setIntensity(2);
  return 'recovered';
}

// ---------------------------------------------------------------------------
// pre-fight: VS plates over the ring, tale of the tape on the bottom screen
let skipIntro = null;

function fillTape(i) {
  const o = R.OPPONENTS[i];
  $('#vs-n').textContent = i + 1;
  $('#vs-name').textContent = o.name;
  $('#vs-title').textContent = o.title;
  $('#venue-name').textContent = o.venueName;
  setFace($('#tape-face'), faces.opp[i]);
  $('#tape-from').textContent = o.from;
  $('#tape-record').textContent = o.record;
  meter($('#tape-speed'), o.stats.speed);
  meter($('#tape-power'), o.stats.power);
  meter($('#tape-tricks'), o.stats.tricks);
  $('#tape-tip').textContent = o.tip;
  $('#ladder').innerHTML = R.OPPONENTS.map((p, k) => {
    const cls = k < i ? 'ko' : k === i ? 'now' : 'next';
    const img = faces.opp[k] ? `<img class="face" src="${faces.opp[k]}" alt="">` : '<span class="face"></span>';
    return `${k ? '<span class="sep"></span>' : ''}<span class="rung ${cls}">${img}${k === i ? 'NEXT' : k < i ? p.short : '???'}</span>`;
  }).join('');
}

async function introFight(i, my) {
  G.mode = 'intro';
  G.clockOn = false;
  G.playerDowns = 0;
  G.oppDowns = 0;
  setControls('wait');
  G.fight = i;
  const o = makeOpponent(i);
  setVenue(o.venue);
  G.oppHp = G.oppMax = o.hp;
  G.combo = 0;
  G.recent = [];
  setCombo(0);
  updateHud();
  renderPips();
  setStatus(`BOUT ${i + 1} · ${o.short}`);
  setTurn('idle', 'GET READY', o.tip);

  player.clear();
  opp.dropIn(6);
  stage.shot('intro', { focus: new THREE.Vector3(0, 1.62 * o.tall, OPP_Z), rate: 6, snap: i === 0 });
  sound.riser();
  fillTape(i);
  showTop('vs');
  screen2.show('vs', { menu: vsMenu });
  const skipped = new Promise((res) => { skipIntro = res; });
  await wait(0.45);
  if (my !== gen) return;
  stage.impact(new THREE.Vector3(0, 0.05, OPP_Z), '#f0f0f0', 1.4);
  sound.slam();
  sound.voice(['pete', 'nova', 'volt'][i], 0.15);
  haptic(40);
  await Promise.race([waitReal(i === 0 ? 3.4 : 2.6), skipped]);
  skipIntro = null;
  if (my !== gen) return;
  showTop(null);
  await screen2.show(null);
  if (my !== gen) return;
  stage.shot('fight', { rate: 3 });
  sound.bell(1);
  sound.voice('fight', 0.05);
  popup('FIGHT!', '', 900);
  G.clockOn = true;
  await waitReal(0.5);
}

const vsMenu = new Menu($('[data-view="vs"]'), {
  sound,
  onPick: () => { sound.ui('ok'); skipIntro?.(); },
  onBack: () => skipIntro?.(),
});

// ---------------------------------------------------------------------------
// match flow
let busy = false; // a screen wipe is running

async function startGame() {
  if (busy) return;
  busy = true;
  sound.init();
  const my = ++gen;
  G.paused = false;
  $('#paused').classList.remove('show');
  await wipe(wipeEl, () => {
    gameTimers.clear();
    realTimers.clear();
    resetMatch();
    hideReferee();
    sound.slowmo(false);
    superFx.className = '';
    setStars(0);
    setCombo(0);
    setScene('fight');
    showTop(null);
    screen2.hideNow();
    $('#sub').inert = false;
    $('#sharebox').classList.remove('show');
    setVenue(R.OPPONENTS[0].venue);
    hideTell();
    showTargets(null);
    player.clear();
    player.root.position.set(0, 0, PLAYER_Z);
    $('#score').textContent = '000000';
    shownScore = 0;
    setClock(G.clock);
    sound.setIntensity(1);
  }, sound);
  busy = false;
  if (my !== gen) return;

  const ctx = { my, demo: false };
  for (let f = 0; f < 3; f++) {
    await introFight(f, my);
    if (my !== gen) return;
    sound.setIntensity(2);
    const r = await fightLoop(ctx);
    if (my !== gen || r === 'abort') return;
    if (r === 'oppKO') {
      G.kos++;
      renderPips();
      const bonus = R.SCORE.ko * (f + 1) + G.hp * R.SCORE.hpBonus;
      G.score += bonus;
      player.victory();
      sound.cheer(1);
      popup(`KO BONUS +${bonus.toLocaleString()}`, 'gold sm');
      await waitReal(1.1);
      if (my !== gen) return;
      if (f < 2) {
        const heal = Math.min(R.KO_HEAL, R.PLAYER_HP - G.hp);
        G.hp += heal;
        if (heal > 0) popup(`+${heal} HP`, 'sm good');
        updateHud();
        await waitReal(0.5);
      }
      continue;
    }
    if (r === 'playerKO') {
      opp.victory();
      return endGame('ko', my);
    }
    return endGame('time', my);
  }
  endGame('champ', my);
}

async function endGame(reason, my) {
  if (my !== gen) return;
  G.mode = 'over';
  G.clockOn = false;
  hideReferee();
  G.reason = reason;
  G.punchWait = null;
  G.def = null;
  setControls('wait');
  hideTell();
  showTargets(null);
  app.classList.remove('danger');
  sound.setIntensity(0);
  if (reason === 'champ') {
    const bonus = Math.ceil(G.clock) * R.SCORE.timeBonus;
    G.score += bonus;
    player.victory();
    popup('CHAMPION!', 'xl gold', 1500);
    sound.voice('champion');
    sound.fanfare();
    sound.cheer(1);
    setStatus('WORLD CHAMPION', 'go');
  } else if (reason === 'time') {
    popup('TIME!', 'xl clash', 1400);
    sound.bell(3);
    sound.voice('time', 0.3);
    setStatus('TIME UP');
  } else {
    sound.voice('down', 0.2);
    setStatus('DOWN AND OUT', 'bad');
  }
  setTurn('idle', reason === 'champ' ? 'CHAMPION!' : reason === 'time' ? 'TIME!' : 'DOWN!', '');
  if (!stage.hasCapture) stage.capture();
  await waitReal(reason === 'ko' ? 1.2 : 1.8);
  if (my !== gen) return;
  stage.shot('results', { rate: 1.5 });
  showResults(my);
}

// ---------------------------------------------------------------------------
// results: headline + score over the ring, fight report on the bottom screen
let shareBlob = null;
let shareUrl = null;

function stats() {
  return {
    score: G.score, reason: G.reason, rank: R.rankFor(G.score), kos: G.kos, landed: G.landed,
    bestCombo: G.bestCombo, readPct: G.reads ? Math.round((G.perfects / G.reads) * 100) : 0,
    supers: G.supers, rounds: G.rounds.filter((r) => r.length),
  };
}

const resMenu = new Menu($('[data-view="results"]'), {
  sound,
  onPick: (id) => {
    if (id === 'share') { sound.ui('ok'); share(); }
    if (id === 'again') { sound.ui('ok'); startGame(); }
    if (id === 'menu') { sound.ui('back'); toTitle(); }
  },
  onBack: () => { sound.ui('back'); toTitle(); },
});

async function showResults(my) {
  setScene('results');
  G.mode = 'over';
  const s = stats();
  const head = $('#res-head');
  head.textContent = HEADLINES[s.reason];
  head.className = `res-head ${s.reason}`;
  const scoreEl = $('#res-score');
  scoreEl.textContent = '0';
  $('#res-rank').innerHTML = '';
  const rb = $('#res-best');
  rb.textContent = '';
  rb.className = '';
  showTop('res');
  setStatus('FIGHT REPORT');

  const tiles = [['KOs', `${s.kos}/3`], ['READS', `${s.readPct}%`], ['BEST', `x${s.bestCombo}`], ['SUPERS', s.supers]];
  $('#res-stats').innerHTML = tiles.map(([l, v]) => `<div><b>${v}</b><small>${l}</small></div>`).join('');
  $('#res-grid').innerHTML = s.rounds
    .map((r) => `<div class="rd">${r.map((x) => `<i class="${x}"></i>`).join('')}</div>`)
    .join('');
  screen2.show('results', { menu: resMenu, focus: 'again' });

  // pre-render the share card so the share tap stays inside the user gesture
  shareBlob = null;
  const card = renderCard(s, stage.hasCapture ? stage.captureCanvas : null);
  canvasToBlob(card).then((blob) => {
    shareBlob = blob;
    if (shareUrl) URL.revokeObjectURL(shareUrl);
    shareUrl = blob ? URL.createObjectURL(blob) : card.toDataURL('image/png');
  });

  // staged reveal: score ticks up, rank stamps down, tiles pop in
  const best = loadBest();
  if (s.score > best) store.set('best', s.score);
  await sleep(350);
  if (my !== gen) return;
  await countUp(scoreEl, s.score, { dur: 1100, sound });
  if (my !== gen) return;
  stamp($('#res-rank'), s.rank, { life: 0, sound });
  for (const el of $$('#res-stats div')) {
    await sleep(140);
    if (my !== gen) return;
    el.classList.add('in');
    sound.ui('tile');
  }
  await sleep(200);
  if (my !== gen) return;
  if (s.score > best) {
    rb.textContent = 'NEW RECORD!';
    rb.className = 'new';
    sound.ui('clear');
  } else if (best) {
    rb.textContent = `BEST ${best.toLocaleString()}`;
  }
  setHi();
}

const shareMenu = new Menu($('#sharebox'), {
  sound,
  onPick: (id, el, viaClick) => {
    if (id === 'save' && !viaClick) el.click();
    if (id === 'copy') copyShareText();
    if (id === 'close') closeShare();
  },
  onBack: () => closeShare(),
});

async function share() {
  const s = stats();
  const text = shareText(s);
  if (!shareBlob) {
    shareBlob = await canvasToBlob(renderCard(s, stage.hasCapture ? stage.captureCanvas : null));
    shareUrl = URL.createObjectURL(shareBlob);
  }
  const how = await systemShare(shareBlob, text);
  if (how !== 'fallback') return;
  $('#share-img').src = shareUrl;
  $('#share-dl').href = shareUrl;
  $('#sharebox').classList.add('show');
  shareMenu.activate(0);
}

async function copyShareText() {
  const btn = $('#share-copy');
  try {
    await navigator.clipboard.writeText(shareText(stats()));
    btn.lastChild.textContent = 'COPIED!';
    sound.ui('ok');
  } catch {
    btn.lastChild.textContent = 'COPY FAILED';
    sound.buzz();
  }
  setTimeout(() => { btn.lastChild.textContent = 'COPY TEXT'; }, 1500);
}

function closeShare() {
  sound.ui('back');
  $('#sharebox').classList.remove('show');
  resMenu.activate(resMenu.i);
}

// ---------------------------------------------------------------------------
// title: logo over the attract demo, PRESS START, then the main menu
const topEls = { title: $('#title'), vs: $('#vs-top'), coach: $('#coach'), res: $('#res-top') };
function showTop(name) {
  for (const [k, el] of Object.entries(topEls)) el.classList.toggle('show', k === name);
}

const screen2 = new Screen2($('#sub'), deck, sound);

const startMenu = new Menu($('[data-view="start"]'), { sound, onPick: () => pressStart() });
$('[data-view="start"]').addEventListener('pointerdown', () => pressStart());

const mainMenu = new Menu($('[data-view="menu"]'), {
  sound,
  onPick: (id) => {
    if (id === 'fight') { sound.ui('ok'); startGame(); }
    if (id === 'gym') { sound.ui('ok'); enterGym(); }
    if (id === 'sound') toggleMute();
    if (id === 'motion') toggleMotion();
  },
  onBack: () => {
    sound.ui('back');
    screen2.show('start', { menu: startMenu });
  },
});

function renderRecords() {
  const best = loadBest();
  const done = gymDone().size;
  const lines = [];
  if (best) lines.push(`<span>HI-SCORE <b>${best.toLocaleString()}</b></span><span><b>${R.rankFor(best)}</b></span>`);
  if (done) lines.push(`<span>GYM <b>${done}/${LESSONS.length}</b> LESSONS CLEAR</span>`);
  $('#records').innerHTML = lines.join('');
  $('#gym-badge').hidden = !!(best || done);
}

function pressStart() {
  if (screen2.next !== 'start' || busy) return;
  sound.init();
  sound.ui('ok');
  sound.voice('title', 0.05);
  screen2.show('menu', { menu: mainMenu });
}

async function toTitle() {
  if (busy) return;
  busy = true;
  const my = ++gen;
  await wipe(wipeEl, () => {
    gameTimers.clear();
    realTimers.clear();
    G.paused = false;
    $('#paused').classList.remove('show');
    $('#sharebox').classList.remove('show');
    resetMatch();
    sound.slowmo(false);
    superFx.className = '';
    setStars(0);
    setCombo(0);
    hideTell();
    showTargets(null);
    setControls('wait');
    setVenue(R.OPPONENTS[0].venue);
    makeOpponent(0);
    G.oppHp = G.oppMax = R.OPPONENTS[0].hp;
    player.clear();
    screen2.hideNow();
    $('#sub').inert = false;
    titleScreen(true);
  }, sound);
  busy = false;
  if (my !== gen) return;
}

function titleScreen(menu = false) {
  setScene('title');
  G.mode = 'title';
  showTop('title');
  setStatus('FREE PLAY', 'blink');
  setTurn('idle', 'GET READY', '');
  setHi();
  renderRecords();
  sound.setIntensity(0);
  screen2.show(menu ? 'menu' : 'start', { menu: menu ? mainMenu : startMenu });
  attract();
}

// Glints follow the illustrated logo rather than the hidden semantic heading.
setInterval(() => {
  if (!topEls.title.classList.contains('show') || reducedMotion) return;
  const box = topEls.title.getBoundingClientRect();
  const r = $('#title .logo-art').getBoundingClientRect();
  const g = document.createElement('i');
  g.className = 'glint';
  g.style.left = `${r.left - box.left + r.width * (0.2 + Math.random() * 0.6)}px`;
  g.style.top = `${r.top - box.top + r.height * (0.25 + Math.random() * 0.5)}px`;
  topEls.title.appendChild(g);
  setTimeout(() => g.remove(), 500);
}, 1300);

// ---------------------------------------------------------------------------
// sound toggle
let muted = !!store.get('muted', false);
function applyMute() {
  sound.setMuted(muted);
  const label = muted ? 'SOUND: OFF' : 'SOUND: ON';
  $('#sound-label').textContent = label;
  $$('.sound-label').forEach((el) => { el.textContent = label; });
}
function toggleMute() {
  muted = !muted;
  store.set('muted', muted);
  applyMute();
  sound.init();
  sound.ui('move');
}
applyMute();

// Follow the OS preference until a player explicitly chooses a motion setting.
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let motionPreference = store.get('motion', null);
let reducedMotion = motionPreference === null ? motionQuery.matches : motionPreference === 'reduced';
function applyMotion() {
  app.dataset.motion = reducedMotion ? 'reduced' : 'full';
  const label = reducedMotion ? 'MOTION: REDUCED' : 'MOTION: FULL';
  $$('#motion-label, .motion-label').forEach((el) => { el.textContent = label; });
  stage?.setMotion(reducedMotion);
  if (reducedMotion) app.classList.remove('quake');
}
function toggleMotion() {
  reducedMotion = !reducedMotion;
  motionPreference = reducedMotion ? 'reduced' : 'full';
  store.set('motion', motionPreference);
  applyMotion();
  sound.ui('move');
}
motionQuery.addEventListener('change', () => {
  if (motionPreference !== null) return;
  reducedMotion = motionQuery.matches;
  applyMotion();
});
applyMotion();

// ---------------------------------------------------------------------------
// pause
const canPause = () => (G.scene === 'fight' || G.scene === 'gym') && G.mode !== 'over' && !busy && screen2.cur === screen2.next;
let menuBeforePause = null;

const pauseMenu = new Menu($('#paused'), {
  sound,
  onPick: (id) => {
    const gym = G.scene === 'gym';
    if (id === 'resume') resume();
    if (id === 'sound') toggleMute();
    if (id === 'motion') toggleMotion();
    if (id === 'restart') {
      sound.ui('ok');
      closePause();
      if (gym) gymBook();
      else startGame();
    }
    if (id === 'quit') {
      sound.ui('back');
      closePause();
      if (gym) exitGym();
      else toTitle();
    }
  },
  onBack: () => resume(),
});

function pause() {
  if (G.paused || !canPause()) return;
  G.paused = true;
  cancelGesture();
  setClock(G.clock);
  deck.inert = true;
  $('#sub').inert = true;
  menuBeforePause = activeMenu();
  menuBeforePause?.deactivate();
  const gym = G.scene === 'gym';
  $('#pz-restart').textContent = gym ? 'BOOKLET' : 'RESTART';
  $('#pz-quit').textContent = gym ? 'EXIT GYM' : 'QUIT TO TITLE';
  $('#paused').classList.add('show');
  pauseMenu.activate(0);
  sound.ui('open');
}

function closePause() {
  G.paused = false;
  $('#paused').classList.remove('show');
  pauseMenu.deactivate();
  deck.inert = !!screen2.cur;
  $('#sub').inert = false;
  setClock(G.clock);
}

function resume() {
  closePause();
  sound.init();
  sound.ui('back');
  menuBeforePause?.activate(menuBeforePause.i);
  menuBeforePause = null;
}

$('#pause').addEventListener('click', () => pause());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['intro', 'defend', 'attack', 'between', 'count', 'ko'].includes(G.mode)) pause();
});

// ---------------------------------------------------------------------------
// training gym: Coach Pops walks you through the booklet, move by move
const coachLine = $('#coach-line');
const coachSay = (text) => typeText(coachLine, text, { sound });

function coachPips(n, got) {
  $('#coach-pips').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < got ? 'on' : ''}"></i>`).join('');
}

function nextLesson() {
  const done = gymDone();
  return LESSONS.findIndex((L) => !done.has(L.id));
}

function renderLessons() {
  const done = gymDone();
  const next = nextLesson();
  $('#lessons').innerHTML = LESSONS.map((L, i) => `<li data-mi="l${i}" class="${done.has(L.id) ? 'done' : ''}"><span class="cur"></span><span class="n"></span><span>${L.name}</span></li>`).join('');
  $('#book-go').lastChild.textContent = !done.size ? 'START' : next < 0 ? 'REVIEW' : 'NEXT';
  $('#book-intro').textContent = !done.size
    ? 'NEW HERE? WE GO MOVE BY MOVE. START WITH LESSON 1.'
    : next < 0
      ? "EVERY LESSON CLEAR. YOU'RE READY, CHAMP."
      : `${done.size}/${LESSONS.length} CLEAR. NEXT UP: ${LESSONS[next].name}.`;
}

const bookMenu = new Menu($('[data-view="book"]'), {
  sound,
  onPick: (id) => {
    if (id === 'exit') { sound.ui('back'); exitGym(); return; }
    sound.ui('ok');
    if (id === 'next') openLesson(Math.max(0, nextLesson()));
    else openLesson(Number(id.slice(1)));
  },
  onBack: () => { sound.ui('back'); exitGym(); },
});

const lessonMenu = new Menu($('[data-view="lesson"]'), {
  sound,
  onPick: (id) => {
    if (id === 'try') { sound.ui('ok'); runLesson(gymLesson); }
    if (id === 'book') { sound.ui('back'); gymBook(); }
  },
  onBack: () => { sound.ui('back'); gymBook(); },
});

const gradMenu = new Menu($('[data-view="grad"]'), {
  sound,
  onPick: (id) => {
    if (id === 'fight') { sound.ui('ok'); startGame(); }
    if (id === 'book') { sound.ui('back'); gymBook(); }
  },
  onBack: () => { sound.ui('back'); gymBook(); },
});

let gymLesson = 0;

async function enterGym() {
  if (busy) return;
  busy = true;
  const my = ++gen;
  await wipe(wipeEl, () => {
    gameTimers.clear();
    realTimers.clear();
    resetMatch();
    setStars(0);
    setCombo(0);
    setScene('gym');
    showTop(null);
    screen2.hideNow();
    setVenue('gym');
    makeOpponent(R.COACH);
    G.oppHp = G.oppMax = R.COACH.hp;
    player.clear();
    hideTell();
    showTargets(null);
    stage.shot('attract', { snap: true });
    sound.setIntensity(1);
  }, sound);
  busy = false;
  if (my !== gen) return;
  gymBook();
}

/** Back to the booklet's contents page; the boxers spar in the background. */
function gymBook() {
  const my = ++gen;
  gymReset();
  setStatus('INSTRUCTION BOOKLET');
  renderLessons();
  const next = nextLesson();
  screen2.show('book', { menu: bookMenu, focus: next >= 0 ? `l${next}` : 'next' });
  stage.shot('attract', { rate: 1.5 });
  demoLoop({ my, demo: true });
}

function gymReset() {
  G.mode = 'gym';
  G.def = null;
  G.punchWait = null;
  G.timeScale = 1;
  showTop(null);
  setControls('wait');
  setTurn('idle', 'POPS GYM', '');
  hideTell();
  showTargets(null);
  setStars(0);
  setCombo(0);
  player.clear();
  opp.clear();
  G.hp = R.PLAYER_HP;
  G.oppHp = G.oppMax;
  G.oppDef = R.COACH;
}

/** Some lessons tweak how Pops fights (e.g. always switching his guard). */
const coachFor = (L) => ({ ...R.COACH, ...(L.drill.coach || {}) });

function openLesson(n) {
  const my = ++gen;
  gymLesson = n;
  const L = LESSONS[n];
  gymReset();
  setStatus(`LESSON ${n + 1} · ${L.name}`);
  $('#ls-no').textContent = `LESSON ${n + 1}`;
  $('#ls-name').textContent = L.title || L.name;
  $('#ls-page').textContent = `${n + 1}/${LESSONS.length}`;
  $('#ls-diagram').innerHTML = L.diagram();
  $('#ls-say').innerHTML = L.say;
  $('#ls-how').innerHTML = L.how;
  sound.ui('page');
  screen2.show('lesson', { menu: lessonMenu, focus: 'try' });
  stage.shot('fight', { rate: 3, lift: L.drill.kind === 'defend' ? 0 : 0.38, dolly: L.drill.kind === 'defend' ? 0 : 0.2 });
  G.oppDef = coachFor(L);
  lessonDemo(L, { my, demo: true, show: true, acc: 1 });
}

/** The boxers act out the lesson above the booklet page. */
async function lessonDemo(L, ctx) {
  const D = L.drill;
  let rep = 0;
  await wait(0.6);
  while (!gone(ctx)) {
    if (D.kind === 'defend' || D.kind === 'counter') {
      const plan = D.plans ? D.plans[rep % D.plans.length] : [{ key: D.pool[rep % D.pool.length] }];
      for (let i = 0; i < plan.length; i++) {
        if ((await defendOne(plan[i], i > 0, ctx)) === null) return;
        await wait(0.1);
      }
      if (gone(ctx)) return;
      if (D.kind === 'counter') {
        await wait(0.15);
        await attackTurn('perfect', ctx);
      }
    } else {
      if (D.kind === 'super') ctx.botSuper = true;
      await attackTurn('block', ctx);
    }
    if (gone(ctx)) return;
    await wait(0.8);
    rep++;
  }
}

/** Title + booklet contents: the boxers spar on their own. */
async function demoLoop(ctx) {
  let exchanges = 0;
  let showcase = 0;
  while (!gone(ctx)) {
    await wait(0.3);
    if (gone(ctx)) return;
    const d = await defendTurn(ctx);
    if (gone(ctx) || d === null) return;
    await attackTurn(d, ctx);
    if (gone(ctx)) return;
    if (ctx.circuit && ++exchanges % 3 === 0) {
      showcase = (showcase + 1) % R.OPPONENTS.length;
      const o = makeOpponent(showcase);
      setVenue(o.venue);
      G.oppHp = G.oppMax = o.hp;
      G.recent = [];
      player.clear();
      opp.dropIn(1.5);
      setStatus(o.venueName);
      $$('#card-row figure').forEach((el, i) => el.classList.toggle('showcase', i === showcase));
      await wait(0.6);
    }
  }
}

async function runLesson(n) {
  const my = ++gen;
  const ctx = { my, demo: false, train: true };
  const L = LESSONS[n];
  const D = L.drill;
  gymReset();
  G.oppDef = coachFor(L);
  G.tutorAttack = 9; // the coach does the talking
  await screen2.show(null);
  if (gone(ctx)) return;
  setFace($('#coach-face'), faces.coach);
  showTop('coach');
  coachPips(D.reps, 0);
  stage.shot('fight', { rate: 3 });
  setTurn('idle', `LESSON ${n + 1}`, L.name);
  await coachSay(L.go);
  await waitReal(0.5);

  let got = 0;
  let rep = 0;
  while (got < D.reps) {
    if (gone(ctx)) return;
    G.hp = R.PLAYER_HP;
    G.oppHp = G.oppMax;
    const out = await drillRep(D, rep, ctx);
    if (out === null || gone(ctx)) return;
    G.mode = 'between';
    setControls('wait');
    setTurn('idle', `LESSON ${n + 1}`, L.name);
    if (out.got) {
      got = Math.min(D.reps, got + out.got);
      coachPips(D.reps, got);
      sound.ui('tile');
    }
    coachSay(out.msg);
    rep++;
    await wait(got >= D.reps ? 0.5 : 1.1);
  }
  if (gone(ctx)) return;

  // lesson clear
  markDone(L.id);
  G.mode = 'gym';
  stamp($('#stamps'), 'LESSON CLEAR!', { cls: 'go', life: 1700, sound });
  sound.ui('clear');
  player.victory();
  coachSay(rand(["THAT'S MY FIGHTER!", "NOW YOU'RE TALKING!", 'PICTURE PERFECT!']));
  await waitReal(1.9);
  if (gone(ctx)) return;
  if (n + 1 < LESSONS.length) openLesson(n + 1);
  else graduate();
}

/** One attempt at the drill. Resolves { got, msg } or null if interrupted. */
async function drillRep(D, rep, ctx) {
  const hint = rep < (D.hints ?? 0);
  if (D.kind === 'defend' || D.kind === 'counter') {
    const plan = D.plans
      ? D.plans[rep % D.plans.length]
      : [{ key: rand(D.pool.filter((k) => D.pool.length < 2 || k !== G.recent[G.recent.length - 1])) }];
    G.mode = 'defend';
    setTurn('their', 'THEIR TURN', plan.length > 1 ? 'DOUBLE ATTACK!' : 'READ THE GLOVE');
    setControls('def');
    stage.shot('fight', { rate: 2.5 });
    opp.setGuard('base');
    await wait(0.45);
    for (let i = 0; i < plan.length; i++) {
      const res = await defendOne(plan[i], i > 0, { ...ctx, hint });
      if (res === null || gone(ctx)) return null;
      if (res !== 'perfect') return { got: 0, msg: readAdvice(G.lastRead) };
      if (i < plan.length - 1) await wait(0.1);
    }
    if (D.kind === 'defend') return { got: 1, msg: praise() };
    G.mode = 'between';
    setControls('wait');
    await wait(0.25);
    const log = await attackTurn('perfect', ctx);
    if (gone(ctx)) return null;
    const lands = log.filter((x) => x === 'land').length;
    if (lands) return { got: 1, msg: lands >= 3 ? "NOW THAT'S A COUNTER!" : praise() };
    return { got: 0, msg: 'I WAS WIDE OPEN! PUNCH ANYWHERE.' };
  }

  if (D.kind === 'super') setStars(R.MAX_STARS);
  G.mode = 'between';
  setControls('wait');
  await wait(0.3);
  const log = await attackTurn('block', ctx);
  if (gone(ctx)) return null;
  const lands = log.filter((x) => x === 'land').length;
  const miss = log.includes('blocked') ? PUNCH_ADVICE.blocked : PUNCH_ADVICE.slow;
  if (D.kind === 'super') {
    return log.includes('super') ? { got: 1, msg: "BOOM! THAT'S THE SUPER." } : { got: 0, msg: 'HIT THE STAR BUTTON IN THE MIDDLE!' };
  }
  if (D.kind === 'combo') {
    if (lands >= D.need) return { got: 1, msg: `${lands} IN A ROW! BEAUTIFUL.` };
    return { got: 0, msg: lands ? `${lands} HIT${lands > 1 ? 'S' : ''}. KEEP CHASING THE OPENING!` : miss };
  }
  return lands ? { got: lands, msg: lands > 1 ? 'A COMBO, EVEN. SHOWING OFF!' : praise() } : { got: 0, msg: miss };
}

function graduate() {
  ++gen;
  gymReset();
  setStatus('GRADUATION');
  setFace($('#grad-face'), faces.coach);
  screen2.show('grad', { menu: gradMenu, focus: 'fight' });
  sound.fanfare();
  stage.confetti(160);
  player.victory();
  stage.shot('results', { rate: 1.5 });
}

async function exitGym() {
  await toTitle();
}

// ---------------------------------------------------------------------------
// attract mode: the boxers demo the read-and-punch loop on the title screen
function attract() {
  const my = ++gen;
  G.mode = 'title';
  stage.shot('attract', { rate: 2 });
  setStatus(R.OPPONENTS[0].venueName);
  $$('#card-row figure').forEach((el, i) => el.classList.toggle('showcase', i === 0));
  demoLoop({ my, demo: true, circuit: true });
}

// ---------------------------------------------------------------------------
// portraits: rendered once from the 3D models through the retro pass
const faces = { opp: [], coach: null, you: null };

function setFace(img, src) {
  if (src) img.src = src;
}

/** Gloves down so the face reads, then let the smoothed pose catch up. */
function settle(b, guard = 'low') {
  b.setGuard(guard);
  for (let k = 0; k < 24; k++) b.update(0.05, k * 0.05);
  b.root.updateMatrixWorld(true);
}

function makePortraits() {
  const head = new THREE.Vector3();
  R.OPPONENTS.forEach((o, i) => {
    makeOpponent(i);
    settle(opp);
    faces.opp[i] = stage.portrait(opp.root, opp.headWorld(head), 1).toDataURL();
  });
  makeOpponent(R.COACH);
  settle(opp);
  faces.coach = stage.portrait(opp.root, opp.headWorld(head), 1, { bg: 0x3a2410 }).toDataURL();
  settle(player);
  faces.you = stage.portrait(player.root, player.headWorld(head), -1, { bg: 0x000000 }).toDataURL();
  settle(player, 'base');
}

// ---------------------------------------------------------------------------
// main loop
let last = performance.now();
// ?dtcap=0.25 lets slow headless test runs keep real-time pacing
const DT_CAP = Number(new URLSearchParams(location.search).get('dtcap')) || 0.05;
// ?ts=0.2 slows everything down (debug / screenshots)
const DEBUG_TS = Number(new URLSearchParams(location.search).get('ts')) || 1;
const shotEl = $('#shot');

function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.min(DT_CAP, (now - last) / 1000) * DEBUG_TS;
  last = now;
  if (G.paused) {
    stage.render();
    return;
  }

  let dt = realDt * G.timeScale;
  if (G.hitstop > 0) {
    G.hitstop -= realDt;
    dt = 0;
  }
  G.gameTime += dt;
  tickTimers(gameTimers, dt);
  tickTimers(realTimers, realDt);

  if (G.clockOn) {
    G.clock = Math.max(0, G.clock - realDt);
    if (G.clock <= 0) {
      G.clockOn = false;
      const w = G.punchWait;
      G.punchWait = null;
      w?.resolve('timeout');
      cancelGesture();
      hideTell();
      showTargets(null);
      setControls('wait');
    }
  }
  setClock(G.clock);

  // the turn timer: how long until their punch lands / your window closes
  let t = 0;
  if (G.punchWait) {
    const w = G.punchWait;
    const k = (G.gameTime - w.start) / w.total;
    t = 1 - k;
    if (w.switchAt && !w.switched && k >= w.switchAt) {
      w.switched = true;
      switchGuard();
    }
    if (k >= 1) {
      G.punchWait = null;
      w.resolve('timeout');
    }
  } else if (G.mode === 'defend' && G.def?.total) {
    t = 1 - (G.gameTime - G.def.start) / G.def.total;
  }
  shotEl.style.setProperty('--t', Math.max(0, Math.min(1, t)));
  shotEl.className = G.mode === 'defend' ? 'def' : G.mode === 'attack' ? 'off' : '';

  if (shownScore !== G.score && G.scene === 'fight') {
    shownScore += Math.ceil((G.score - shownScore) * 0.2);
    if (Math.abs(G.score - shownScore) < 3) shownScore = G.score;
    $('#score').textContent = String(shownScore).padStart(6, '0');
  }

  player.update(dt, G.gameTime);
  opp.update(dt, G.gameTime);
  stage.update(dt, realDt);
  updateOverlays();
  stage.render();
}

// ---------------------------------------------------------------------------
function buildSevenSeg(host) {
  const SEG = {
    a: '4,1 16,1 18,3 16,5 4,5 2,3',
    b: '17,4 19,6 19,15 17,17 15,15 15,6',
    c: '17,19 19,21 19,30 17,32 15,30 15,21',
    d: '4,31 16,31 18,33 16,35 4,35 2,33',
    e: '3,19 5,21 5,30 3,32 1,30 1,21',
    f: '3,4 5,6 5,15 3,17 1,15 1,6',
    g: '4,16 16,16 18,18 16,20 4,20 2,18',
  };
  const DIG = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 76 36');
  const root = document.createElementNS(ns, 'g');
  root.setAttribute('transform', 'skewX(-8) translate(4 0)');
  svg.appendChild(root);
  const digits = [0, 28, 52].map((x) => {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${x} 0)`);
    const segs = {};
    for (const [k, pts] of Object.entries(SEG)) {
      const p = document.createElementNS(ns, 'polygon');
      p.setAttribute('points', pts);
      p.setAttribute('class', 'seg');
      g.appendChild(p);
      segs[k] = p;
    }
    root.appendChild(g);
    return segs;
  });
  for (const cy of [11, 25]) {
    const dot = document.createElementNS(ns, 'rect');
    Object.entries({ x: 22, y: cy - 2, width: 4, height: 4, class: 'seg on' }).forEach(([k, v]) => dot.setAttribute(k, v));
    root.appendChild(dot);
  }
  host.appendChild(svg);
  return {
    set(text) {
      const ds = text.replace(':', '').padStart(3, ' ').slice(-3);
      digits.forEach((segs, i) => {
        const on = ds[i] === ' ' ? '' : DIG[Number(ds[i])];
        for (const [k, p] of Object.entries(segs)) p.classList.toggle('on', on.includes(k));
      });
    },
  };
}

// ---------------------------------------------------------------------------
/** Freeze a dramatic super uppercut for the Open Graph image. */
async function ogPose() {
  const my = ++gen;
  G.mode = 'og';
  app.classList.add('og');
  showTop(null);
  screen2.hideNow();
  makeOpponent(2);
  stage.shot('custom', {
    snap: true, hfov: 40,
    pos: new THREE.Vector3(-1.05, 1.55, 2.5),
    look: new THREE.Vector3(-0.72, 1.3, -0.1),
  });
  await wait(0.6);
  if (my !== gen) return 'aborted';
  player.punch(R.UPPER, 'land', opp, null, { hand: 1 });
  await wait(IMPACT);
  opp.react(R.UPPER, 1.8, -1);
  stage.impact(opp.headWorld(new THREE.Vector3()), '#f8d830', 1.6);
  await wait(0.2);
  G.paused = true;
  return 'ready';
}

async function boot() {
  setClock(G.clock);
  updateHud();
  setControls('wait');
  setHi();
  // the in-world signs are drawn with the pixel font, so let it arrive first
  await Promise.race([
    document.fonts?.load('16px "Press Start 2P"').then(() => document.fonts.ready),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  try {
    stage = new Stage($('#arena'));
    applyMotion();
  } catch (e) {
    console.error(e);
    $('#nogl').classList.add('show');
    return;
  }
  player = new Boxer({ color: '#58f858', ghost: true });
  player.root.position.set(0, 0, PLAYER_Z);
  player.root.rotation.y = Math.PI;
  player.root.scale.setScalar(PLAYER_SCALE);
  stage.scene.add(player.root);
  makePortraits();
  $('#card-row').innerHTML = R.OPPONENTS.map((o, i) => `<figure><img class="face" src="${faces.opp[i]}" alt="">${o.short}</figure>`).join('');
  makeOpponent(0);
  setVenue(R.OPPONENTS[0].venue);
  G.oppHp = G.oppMax = R.OPPONENTS[0].hp;
  sound.onBeat = (bar) => stage.beat(bar ? 1.3 : 0.8);
  stage.shot('attract', { snap: true });
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
  titleScreen();

  // hooks for tools/render-assets.mjs, tests and debugging
  const q = new URLSearchParams(location.search);
  if (q.get('autostart') === '1') startGame();
  if (q.get('gym') === '1') enterGym();
  window.__vb = {
    G, stage, sound, startGame, enterGym, openLesson, runLesson, gymBook, toTitle, pressStart, pause, ogPose,
    onDefend, onPunch, onSuper, faces, LESSONS,
    get player() { return player; }, get opp() { return opp; }, get screen() { return screen2.cur; },
  };
}

// split the logo into letters for the drop-in
letters($('#title .b'), letters($('#title .v')));
boot();
