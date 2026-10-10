import * as THREE from './vendor/three.js';
import { Stage, PLAYER_Z, OPP_Z, PLAYER_SCALE } from './stage.js';
import { Boxer, IMPACT } from './boxer.js';
import { Sound } from './audio.js';
import * as R from './rules.js';
import { renderCard, canvasToBlob, shareText, systemShare, HEADLINES } from './share.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const app = $('#app');
const deck = $('#deck');
const fx = $('#fx');
const arena = $('#arena');

const sound = new Sound();
let stage;
let player;
let opp;

// ---------------------------------------------------------------------------
// game state
const G = {
  mode: 'title', // title | intro | defend | attack | between | ko | over | og
  clock: R.MATCH_SECONDS,
  clockOn: false,
  paused: false,
  timeScale: 1,
  hitstop: 0,
  gameTime: 0,
  def: null, // the attack you're reading: { key, start, total, action, at }
  punchWait: null, // your punch window: { resolve, start, total, switchAt, switched }
  guard: 'base',
};

function resetMatch() {
  Object.assign(G, {
    clock: R.MATCH_SECONDS, clockOn: false, timeScale: 1, hitstop: 0,
    score: 0, hp: R.PLAYER_HP, oppHp: 0, oppMax: 1, fight: 0, stars: 0,
    combo: 0, bestCombo: 0, kos: 0, landed: 0, reads: 0, perfects: 0, early: 0, supers: 0,
    recent: [], rounds: [], reason: null, highlight: 0, tutor: 0, tutorAttack: 0,
    def: null, punchWait: null, guard: 'base',
  });
}
resetMatch();

let gen = 0; // bumps on every new flow so stale async sequences bail out
const gone = (ctx) => ctx.my !== gen;
const OPP = () => R.OPPONENTS[G.fight];

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

// ---------------------------------------------------------------------------
// HUD
const clockEl = $('#clock');
const clockSvg = buildSevenSeg(clockEl);
let lastClockText = '';

function setClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (text !== lastClockText) {
    lastClockText = text;
    clockSvg.set(text);
    clockEl.classList.toggle('hurry', s <= 10 && G.clockOn);
  }
}

function setBar(which, frac) {
  const bar = $(`.${which} .bar`);
  const v = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  bar.querySelector('.fill').style.setProperty('--hp', v);
  bar.querySelector('.lag').style.setProperty('--hp', v);
  bar.classList.toggle('low', frac < 0.25);
}

let shownScore = 0;
function updateHud() {
  setBar('p1', G.hp / R.PLAYER_HP);
  setBar('p2', G.oppHp / G.oppMax);
}

function setStatus(text, cls = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = cls;
}

function setCombo(n) {
  const c = $('#combo');
  if (n >= 2) {
    c.innerHTML = `x${n}<small>COMBO</small>`;
    c.classList.remove('bump');
    void c.offsetWidth;
    c.classList.add('bump');
  } else {
    c.innerHTML = '';
  }
}

function popup(text, cls = '', life = 1000) {
  const d = document.createElement('div');
  d.className = `pop ${cls}`;
  d.textContent = text;
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
  app.classList.remove('quake');
  void app.offsetWidth;
  app.classList.add('quake');
}

// ---------------------------------------------------------------------------
// deck: whose turn it is, stars, and which controls are live
const turnEl = $('#turn');
const starEls = $$('#stars i');
const superBtn = $('#super');
const padBtns = $$('.pb');
const dpadBtns = $$('.dp[data-d]');

function setTurn(kind, title, sub = '') {
  turnEl.className = kind;
  turnEl.querySelector('b').textContent = title;
  turnEl.querySelector('small').textContent = sub;
}

/** 'def' lights the D-pad, 'off' lights the punch pad, 'wait' dims both. */
function setControls(mode) {
  deck.dataset.mode = mode;
  dpadBtns.forEach((b) => b.classList.remove('on', 'hint'));
  superBtn.classList.toggle('ready', mode === 'off' && G.stars > 0);
}

function setStars(n, gained = false) {
  G.stars = Math.max(0, Math.min(R.MAX_STARS, n));
  starEls.forEach((el, i) => {
    el.classList.toggle('on', i < G.stars);
    el.classList.toggle('pop', gained && i === G.stars - 1);
  });
  $('#super-n').textContent = G.stars ? `x${G.stars}` : '';
  superBtn.classList.toggle('ready', G.mode === 'attack' && G.stars > 0);
}

function renderPad(guard) {
  const covered = guard ? R.GUARDS[guard] || [] : [];
  padBtns.forEach((b) => {
    const q = Number(b.dataset.q);
    b.classList.toggle('guarded', covered.includes(q));
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

/** Training wheels for the first reads: name the answer and light its button. */
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
  if (G.mode !== 'defend' || !d || d.action || !d.total) return;
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
  if (G.mode !== 'attack' || !G.punchWait) return;
  pressFx(padBtns.find((b) => Number(b.dataset.q) === q));
  const w = G.punchWait;
  G.punchWait = null;
  w.resolve(q);
}

function onSuper() {
  if (G.mode !== 'attack' || !G.punchWait || G.stars < 1) return;
  pressFx(superBtn);
  const w = G.punchWait;
  G.punchWait = null;
  w.resolve('super');
}

dpadBtns.forEach((b) => b.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onDefend(b.dataset.d);
}));
padBtns.forEach((b) => b.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onPunch(Number(b.dataset.q));
}));
superBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onSuper();
});

// swipe to slip / duck / block, tap a target to punch it, flick up for the super
let ptr = null;
arena.addEventListener('pointerdown', (e) => {
  if (G.mode === 'defend' || G.mode === 'attack') {
    ptr = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }
});
arena.addEventListener('pointerup', (e) => {
  if (!ptr) return;
  const dx = e.clientX - ptr.x;
  const dy = e.clientY - ptr.y;
  ptr = null;
  const swipe = Math.hypot(dx, dy) > 26;
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

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if ((G.mode === 'title' || G.mode === 'over') && k === 'enter') {
    e.preventDefault();
    startGame();
    return;
  }
  const def = Object.entries(R.DEFENSES).find(([, d]) => d.keys.includes(k));
  if (def) {
    e.preventDefault();
    onDefend(def[0]);
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    onSuper();
    return;
  }
  const q = R.QUADS.find((Q) => Q.keys.includes(k));
  if (q) onPunch(q.id);
});

// ---------------------------------------------------------------------------
// the fight
function makeOpponent(i) {
  const o = R.OPPONENTS[i];
  opp?.dispose();
  opp = new Boxer({ color: o.color, look: o.look, bulk: o.bulk, tall: o.tall, hair: o.hair, belt: o.belt });
  opp.root.position.set(0, 0, OPP_Z);
  stage.scene.add(opp.root);
  document.documentElement.style.setProperty('--opp', o.color);
  $('#opp-name').textContent = o.name;
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
    res = await defendOne(attacks[i], i > 0, ctx);
    if (res === null || (!ctx.demo && G.hp <= 0)) return res;
    if (i < attacks.length - 1) await wait(0.1);
  }
  return res;
}

async function defendOne(atk, second, ctx) {
  const o = OPP();
  const total = R.tellTime(o, ctx.demo ? 1 : G.oppHp / G.oppMax, second);
  const head = player.headWorld(new THREE.Vector3());
  const chest = player.chestWorld(new THREE.Vector3());
  G.def = { key: atk.key, start: G.gameTime, total, action: null, at: 0 };
  if (!ctx.demo) dpadBtns.forEach((b) => b.classList.remove('on', 'hint'));
  G.recent.push(atk.key);
  if (G.recent.length > 6) G.recent.shift();
  if (!ctx.demo) {
    showTell(atk.feintFrom || atk.key);
    sound.tell(R.ATTACKS[atk.key].mega);
    if (G.fight === 0 && G.tutor < 3 && !atk.feintFrom) hintTell(atk.key);
  } else {
    opp.windup(R.ATTACKS[atk.feintFrom || atk.key].move, R.attackHand(atk.feintFrom || atk.key));
    // demo boxer reads it right most of the time
    wait(total * (0.5 + Math.random() * 0.3)).then(() => {
      if (G.def && !G.def.action && !gone(ctx)) {
        G.def.action = Math.random() < 0.85 ? answerFor(atk.key) : rand(Object.keys(R.DEFENSES));
        player.defend(G.def.action);
      }
    });
  }

  if (atk.feintFrom) {
    await wait(total * atk.feintAt);
    if (gone(ctx)) return null;
    // the switch: a second, different tell. Early readers get caught.
    if (!ctx.demo) {
      showTell(atk.key, true);
      sound.tell(false, true);
      popup('FEINT!', 'sm trade', 600);
    } else {
      opp.windup(R.ATTACKS[atk.key].move, R.attackHand(atk.key));
    }
    await wait(total * (1 - atk.feintAt));
  } else {
    await wait(total);
  }
  if (gone(ctx)) return null;

  const d = G.def;
  d.total = 0; // window closed
  const action = d.action;
  const res = R.readAttack(atk.key, action);
  const A = R.ATTACKS[atk.key];
  const hand = R.attackHand(atk.key);
  if (!ctx.demo) {
    hideTell();
    G.reads++;
    if (action && d.at < 0.45) G.early++;
    if (G.fight === 0 && res === 'perfect') G.tutor++;
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
    if (!ctx.demo) {
      G.perfects++;
      G.score += R.SCORE.read;
      setStars(G.stars + 1, true);
      popup(READ_WORDS[action], 'clash');
      if (G.stars === R.MAX_STARS) setTimeout(() => popup('SUPER READY!', 'sm gold', 900), 250);
      haptic(15);
      sound.cheer(0.4);
    }
  } else if (res === 'block') {
    const chip = Math.round(o.hit * A.dmg * (A.mega ? 0.5 : R.BLOCK_CHIP));
    player.recoil();
    stage.clash(pos);
    sound.clash();
    G.hitstop = 0.06;
    if (!ctx.demo) {
      G.hp = Math.max(0, G.hp - chip);
      G.score += R.SCORE.block;
      floatNum(`-${chip}`, pos, 'trade');
      popup('BLOCK', 'sm');
      haptic(20);
    }
  } else {
    const dmg = Math.round(o.hit * A.dmg);
    const ko = !ctx.demo && G.hp - dmg <= 0;
    const power = ko ? 3 : A.mega ? 2.2 : 1.1;
    player.relax(true);
    player.react(A.move, Math.min(1.9, power), hand);
    stage.impact(pos, o.color, power);
    sound.hit(power, !A.high);
    G.hitstop = ko ? 0.14 : 0.07;
    if (!ctx.demo) {
      G.hp = Math.max(0, G.hp - dmg);
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
  if (!ctx.demo) updateHud();
  await wait(0.2);
  player.relax();
  G.def = null;
  return res;
}

/** YOUR TURN: punch the openings, chain until a glove stops you. */
async function attackTurn(defRes, ctx) {
  const o = OPP();
  const open = defRes === 'perfect';
  const stunned = defRes === 'hit';
  const log = [];
  if (!ctx.demo) {
    G.mode = 'attack';
    if (open) setTurn('counter', 'COUNTER!', 'WIDE OPEN — UNLOAD');
    else setTurn('your', 'YOUR TURN', G.tutorAttack < 2 ? 'HIT AN OPEN TARGET' : stunned ? 'TIGHT GUARD: ONE OPENING' : 'FIND THE OPENING');
    setControls('off');
    stage.shot('fight', { rate: 3, dolly: 0.2, lift: 0.38 });
  }
  let guard = null;
  let lastQ = null;
  let chain = 0;
  for (let i = 0; i < R.MAX_CHAIN; i++) {
    if (gone(ctx)) return log;
    // tagged last turn: they tighten up and leave one opening for your first shot
    guard = open ? 'open' : R.pickGuard(o, guard, lastQ, Math.random, stunned && i === 0);
    G.guard = guard;
    opp.setGuard(guard);
    if (!ctx.demo) {
      showTargets(guard);
      renderPad(guard);
    }
    const total = o.window * Math.pow(0.85, i) * (stunned ? 0.75 : 1) * (open && i === 0 ? 1.2 : 1);
    const switchAt = !open && !guard.startsWith('tight') && Math.random() < o.guardSwitch ? 0.45 + Math.random() * 0.15 : null;
    const choice = ctx.demo ? await botPunch(total) : await waitPunch(total, switchAt);
    if (gone(ctx)) return log;
    if (choice === 'timeout') {
      if (!ctx.demo && G.clock > 0) popup('TOO SLOW', 'sm lose', 600);
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
      if (gone(ctx)) return log;
      opp.recoil();
      stage.clash(target);
      sound.clash();
      G.hitstop = 0.05;
      log.push('blocked');
      if (!ctx.demo) {
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
    if (gone(ctx)) return log;
    chain++;
    log.push('land');
    const dmg = Math.round(R.PUNCH_DMG * R.chainMult(i) * (open ? R.COUNTER_MULT : 1));
    const ko = !ctx.demo && G.oppHp - dmg <= 0;
    const power = ko ? 3 : 0.8 + i * 0.3 + (open ? 0.3 : 0);
    const pos = player.gloveWorld(-Q.hand, new THREE.Vector3());
    opp.react(Q.move, Math.min(1.9, 0.85 + i * 0.25), -Q.hand);
    stage.impact(pos, '#58f858', power);
    sound.hit(power, !Q.high);
    G.hitstop = ko ? 0.14 : 0.05 + i * 0.02;
    if (!ctx.demo) {
      G.oppHp = Math.max(0, G.oppHp - dmg);
      G.landed++;
      G.combo++;
      G.bestCombo = Math.max(G.bestCombo, G.combo);
      G.tutorAttack++;
      G.score += R.SCORE.punch * (i + 1) * (open ? R.SCORE.counter : 1);
      setCombo(G.combo);
      floatNum(`-${dmg}`, pos);
      if (!ko) popup(i === 0 ? (open ? 'COUNTER!' : Q.high ? 'POW!' : 'BAM!') : ['', 'DOUBLE!', 'TRIPLE!', 'FLURRY!'][i], i >= 2 ? 'gold' : '');
      if (G.highlight < power) {
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
  if (!ctx.demo && chain === R.MAX_CHAIN && G.oppHp > 0) {
    G.score += R.SCORE.flurry;
    popup(`FLURRY +${R.SCORE.flurry}`, 'sm gold');
    sound.voice('combo');
  }
  opp.setGuard('base');
  if (!ctx.demo) {
    showTargets(null);
    renderPad(null);
  }
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

/** Demo boxer on the title screen: mostly finds the opening. */
async function botPunch(total) {
  await wait(total * (0.3 + Math.random() * 0.3));
  const open = [0, 1, 2, 3].filter((q) => !R.GUARDS[G.guard].includes(q));
  return open.length && Math.random() < 0.88 ? rand(open) : rand([0, 1, 2, 3]);
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

async function superPunch(ctx) {
  const n = G.stars;
  setStars(0);
  opp.setGuard('open');
  if (!ctx.demo) {
    popup('SUPER!', 'xl gold', 900);
    sound.riser();
  }
  G.timeScale = 0.45;
  player.punch(R.UPPER, 'land', opp, null, { hand: 1 });
  await wait(IMPACT);
  if (gone(ctx)) return;
  G.timeScale = 1;
  const dmg = R.SUPER_DMG * n;
  const pos = opp.headWorld(new THREE.Vector3());
  opp.react(R.UPPER, 2.2, -1);
  stage.impact(pos, '#f8d830', 2.6);
  stage.confetti(60);
  sound.hit(2.6);
  G.hitstop = 0.16;
  quake();
  haptic([50, 30, 50]);
  if (!ctx.demo) {
    G.supers++;
    G.oppHp = Math.max(0, G.oppHp - dmg);
    G.score += R.SCORE.super * n;
    G.highlight = 50;
    stage.capture();
    floatNum(`-${dmg}`, pos);
    updateHud();
  }
  await wait(0.35);
}

/** One fight: alternate their turn / your turn until someone drops or time runs out. */
async function fightLoop(ctx) {
  for (;;) {
    if (G.clock <= 0) return 'time';
    const d = await defendTurn(ctx);
    if (gone(ctx) || d === null) return 'abort';
    if (G.hp <= 0) return 'playerKO';
    if (G.clock <= 0) {
      G.rounds.push([d]);
      return 'time';
    }
    G.mode = 'between';
    setControls('wait');
    await wait(0.25);
    const log = await attackTurn(d, ctx);
    if (gone(ctx)) return 'abort';
    G.rounds.push([d, ...log]);
    if (G.oppHp <= 0) return 'oppKO';
    G.mode = 'between';
    setControls('wait');
    await wait(0.2);
  }
}

async function knockout(victim, my) {
  G.mode = 'ko';
  setControls('wait');
  hideTell();
  showTargets(null);
  G.timeScale = 0.28;
  sound.slowmo(true);
  victim.knockout();
  if (victim === opp) stage.confetti();
  const focus = new THREE.Vector3();
  victim.root.getWorldPosition(focus);
  stage.shot('ko', { focus, rate: 5, yaw: victim === opp ? 1 : -1 });
  popup('K.O.!!', 'xl gold', 1500);
  sound.ko();
  sound.voice('ko', 0.1);
  quake();
  await waitReal(0.35);
  stage.capture();
  G.highlight = 99;
  await waitReal(1.25);
  if (my !== gen) return;
  G.timeScale = 1;
  sound.slowmo(false);
}

async function introFight(i, my) {
  G.mode = 'intro';
  setControls('wait');
  G.fight = i;
  const o = makeOpponent(i);
  G.oppHp = G.oppMax = o.hp;
  G.combo = 0;
  G.recent = [];
  setCombo(0);
  updateHud();
  $('#fightno b').textContent = i + 1;
  setStatus(`FIGHT ${i + 1} OF 3`);
  setTurn('idle', 'GET READY', o.tip);

  player.clear();
  opp.dropIn(6);
  stage.shot('intro', { focus: new THREE.Vector3(0, 1.62 * o.tall, OPP_Z), rate: 6, snap: i === 0 });
  sound.riser();
  await wait(0.45);
  stage.impact(new THREE.Vector3(0, 0.05, OPP_Z), '#f0f0f0', 1.4);
  sound.slam();
  sound.voice(['pete', 'nova', 'volt'][i], i === 0 ? 0.8 : 0.15); // let the title call finish
  haptic(40);

  $('#vs-n').textContent = `#${i + 1}`;
  $('#vs-name').textContent = o.name;
  $('#vs-title').textContent = o.title;
  $('#vs-bio').textContent = o.bio;
  $('#vs-tip').textContent = o.tip;
  $('#vs-speed').textContent = o.tell >= 1.2 ? 'SLOW' : o.tell >= 0.95 ? 'FAST' : 'LIGHTNING';
  $('#vs').classList.add('show');
  await waitReal(i === 0 ? 2.3 : 1.9);
  $('#vs').classList.remove('show');
  if (my !== gen) return;
  stage.shot('fight', { rate: 3 });
  sound.bell(1);
  sound.voice('fight', 0.05);
  popup('FIGHT!', '', 900);
  G.clockOn = true;
  await waitReal(0.5);
}

async function startGame() {
  if (G.mode !== 'title' && G.mode !== 'over') return;
  sound.init();
  const my = ++gen;
  gameTimers.clear();
  realTimers.clear();
  resetMatch();
  setStars(0);
  G.mode = 'intro';
  app.classList.remove('is-title');
  ['#title', '#results', '#sharebox'].forEach((s) => $(s).classList.remove('show'));
  player.clear();
  player.root.position.set(0, 0, PLAYER_Z);
  $('#score').textContent = '000000';
  shownScore = 0;
  setClock(G.clock);
  sound.voice('title');
  sound.setIntensity(1);

  const ctx = { my, demo: false };
  for (let f = 0; f < 3; f++) {
    await introFight(f, my);
    if (my !== gen) return;
    sound.setIntensity(2);
    const r = await fightLoop(ctx);
    if (my !== gen || r === 'abort') return;
    if (r === 'oppKO') {
      await knockout(opp, my);
      if (my !== gen) return;
      G.kos++;
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
        if (heal > 0) popup(`+${heal} HP`, 'sm');
        updateHud();
        await waitReal(0.5);
      }
      continue;
    }
    if (r === 'playerKO') {
      await knockout(player, my);
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
  G.reason = reason;
  G.punchWait = null;
  G.def = null;
  setControls('wait');
  hideTell();
  showTargets(null);
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
  showResults();
}

// ---------------------------------------------------------------------------
// results + sharing
let shareBlob = null;
let shareUrl = null;

function stats() {
  return {
    score: G.score, reason: G.reason, rank: R.rankFor(G.score), kos: G.kos, landed: G.landed,
    bestCombo: G.bestCombo, readPct: G.reads ? Math.round((G.perfects / G.reads) * 100) : 0,
    supers: G.supers, rounds: G.rounds.filter((r) => r.length),
  };
}

function loadBest() {
  try { return Number(localStorage.getItem('virtuabox.best')) || 0; } catch { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem('virtuabox.best', String(v)); } catch { /* private mode */ }
}

async function showResults() {
  const s = stats();
  const head = $('#res-head');
  head.textContent = HEADLINES[s.reason];
  head.className = s.reason;
  $('#res-rank').textContent = s.rank;
  $('#res-stats').innerHTML = [
    ['KOs', `${s.kos}/3`], ['READS', `${s.readPct}%`], ['BEST', `x${s.bestCombo}`], ['SUPERS', s.supers],
  ].map(([l, v]) => `<div><b>${v}</b><small>${l}</small></div>`).join('');
  $('#res-grid').innerHTML = s.rounds
    .map((r) => `<div class="rd">${r.map((x) => `<i class="${x}"></i>`).join('')}</div>`)
    .join('');
  const best = loadBest();
  const rb = $('#res-best');
  if (s.score > best) {
    saveBest(s.score);
    rb.textContent = 'NEW PERSONAL BEST!';
    rb.className = 'new';
  } else {
    rb.textContent = `BEST ${best.toLocaleString()}`;
    rb.className = '';
  }
  $('#results').classList.add('show');

  // count up
  const el = $('#res-score');
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(s.score * (1 - Math.pow(1 - k, 3))).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  // pre-render the share card so the share tap stays inside the user gesture
  shareBlob = null;
  const card = renderCard(s, stage.hasCapture ? stage.captureCanvas : null);
  shareBlob = await canvasToBlob(card);
  if (shareUrl) URL.revokeObjectURL(shareUrl);
  shareUrl = shareBlob ? URL.createObjectURL(shareBlob) : card.toDataURL('image/png');
}

$('#share').addEventListener('click', async () => {
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
  $('#share-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      $('#share-copy').textContent = 'COPIED!';
    } catch {
      $('#share-copy').textContent = 'COPY FAILED';
    }
    setTimeout(() => { $('#share-copy').textContent = 'COPY TEXT'; }, 1500);
  };
});
$('#share-close').addEventListener('click', () => $('#sharebox').classList.remove('show'));
$('#again').addEventListener('click', () => startGame());
$('#start').addEventListener('click', () => startGame());

const muteBtn = $('#mute');
let muted = false;
try { muted = localStorage.getItem('virtuabox.muted') === '1'; } catch { /* ignore */ }
function applyMute() {
  sound.setMuted(muted);
  muteBtn.textContent = muted ? 'SOUND: OFF' : 'SOUND: ON';
  muteBtn.setAttribute('aria-pressed', String(muted));
}
applyMute();
muteBtn.addEventListener('click', () => {
  muted = !muted;
  try { localStorage.setItem('virtuabox.muted', muted ? '1' : '0'); } catch { /* ignore */ }
  applyMute();
});

// ---------------------------------------------------------------------------
// attract mode: the boxers demo the read-and-punch loop on the title screen
async function attract() {
  const my = ++gen;
  G.mode = 'title';
  stage.shot('attract', { rate: 2 });
  const ctx = { my, demo: true };
  while (my === gen) {
    await wait(0.3);
    const d = await defendTurn(ctx);
    if (gone(ctx) || d === null) return;
    await attackTurn(d, ctx);
  }
}

// pause when the tab hides
document.addEventListener('visibilitychange', () => {
  if (document.hidden && G.mode !== 'title' && G.mode !== 'over') {
    G.paused = true;
    $('#paused').classList.add('show');
  }
});
$('#paused').addEventListener('pointerdown', () => {
  G.paused = false;
  $('#paused').classList.remove('show');
  sound.init();
});

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

  if (shownScore !== G.score) {
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
  app.classList.remove('is-title');
  $('#title').classList.remove('show');
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
  const best = loadBest();
  if (best) $('#best').textContent = `BEST ${best.toLocaleString()}`;
  setClock(G.clock);
  updateHud();
  setControls('wait');
  // the in-world signs are drawn with the pixel font, so let it arrive first
  await Promise.race([
    document.fonts?.load('16px "Press Start 2P"').then(() => document.fonts.ready),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  try {
    stage = new Stage($('#arena'));
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
  makeOpponent(0);
  G.oppHp = G.oppMax = R.OPPONENTS[0].hp;
  sound.onBeat = (bar) => stage.beat(bar ? 1.3 : 0.8);
  stage.shot('attract', { snap: true });
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
  attract();

  // hooks for tools/render-assets.mjs, tests and debugging
  const q = new URLSearchParams(location.search);
  if (q.get('autostart') === '1') startGame();
  window.__vb = {
    G, stage, sound, startGame, ogPose, onDefend, onPunch, onSuper,
    get player() { return player; }, get opp() { return opp; },
  };
}

boot();
