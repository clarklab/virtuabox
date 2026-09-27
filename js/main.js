import * as THREE from './vendor/three.js';
import { Stage, PLAYER_Z, OPP_Z, PLAYER_SCALE } from './stage.js';
import { Boxer, IMPACT } from './boxer.js';
import { Sound } from './audio.js';
import * as R from './rules.js';
import { renderCard, canvasToBlob, shareText, systemShare, HEADLINES } from './share.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const deck = $('#deck');
const fx = $('#fx');

const sound = new Sound();
let stage;
let player;
let opp;

// ---------------------------------------------------------------------------
// game state
const G = {
  mode: 'title', // title | intro | plan | locked | action | ko | over
  clock: R.MATCH_SECONDS,
  clockOn: false,
  paused: false,
  timeScale: 1,
  hitstop: 0,
  gameTime: 0,
  shot: 0,
  shotMax: 8,
  picks: [],
  plan: null,
  history: [],
  rounds: [],
};

function resetMatch() {
  Object.assign(G, {
    clock: R.MATCH_SECONDS, clockOn: false, timeScale: 1, hitstop: 0,
    score: 0, hp: R.PLAYER_HP, oppHp: 0, oppMax: 1, fight: 0,
    streak: 0, oppStreak: 0, bestCombo: 0, kos: 0, hits: 0, exchanges: 0, wins: 0,
    picks: [], plan: null, history: [], rounds: [], reason: null, highlight: 0,
  });
}
resetMatch();

let gen = 0; // bumps on every new flow so stale async sequences bail out

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
// deck (bottom screen)
const arrowSvg = (m) => `<svg class="arr m${m}"><use href="#arrow"/></svg>`;
const themSlots = $('#them-slots');
const youSlots = $('#you-slots');
for (let i = 0; i < 4; i++) {
  themSlots.insertAdjacentHTML('beforeend', `<div class="slot q" data-i="${i + 1}">?</div>`);
  youSlots.insertAdjacentHTML('beforeend', `<button class="slot" data-i="${i + 1}" aria-label="Slot ${i + 1}"></button>`);
}

function renderThem(reveal = false) {
  const plan = G.plan;
  [...themSlots.children].forEach((el, i) => {
    const m = plan?.moves[i];
    const known = plan && (reveal || plan.intel.includes(i));
    el.className = 'slot';
    if (known) {
      el.classList.add('filled');
      if (!reveal) el.classList.add('intel');
      el.innerHTML = `${arrowSvg(m)}<span class="nm">${R.MOVES[m].name}</span>`;
    } else {
      el.classList.add('q');
      el.textContent = '?';
    }
  });
}

function renderYou() {
  [...youSlots.children].forEach((el, i) => {
    const m = G.picks[i];
    el.className = 'slot';
    if (m !== undefined) {
      el.classList.add('filled');
      el.innerHTML = `${arrowSvg(m)}<span class="nm">${R.MOVES[m].name}</span>`;
    } else {
      el.innerHTML = '';
      if (i === G.picks.length && G.mode === 'plan') el.classList.add('next');
    }
  });
}

function markSlot(i, res) {
  const y = youSlots.children[i];
  const t = themSlots.children[i];
  [...youSlots.children, ...themSlots.children].forEach((el) => el.classList.remove('now'));
  y.classList.add(`r-${res}`, 'now');
  const inverse = { win: 'lose', lose: 'win', trade: 'trade', clash: 'clash' }[res];
  t.classList.add(`r-${inverse}`, 'now');
}

function lockDeck(locked) {
  deck.classList.toggle('locked', locked);
}

// ---------------------------------------------------------------------------
// input
let resolvePicks = null;

function pick(m) {
  if (G.mode !== 'plan' || G.picks.length >= 4) return;
  G.picks.push(m);
  sound.select(G.picks.length);
  haptic(12);
  const btn = document.querySelector(`.pb[data-m="${m}"]`);
  btn.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => btn.classList.remove('hit'), 220);
  renderYou();
  if (G.picks.length === 4) {
    G.mode = 'locked';
    setStatus('LOCKED IN', 'go');
    setTimeout(() => resolvePicks?.('picked'), 140);
  }
}

function unpick(i) {
  if (G.mode !== 'plan' || i >= G.picks.length) return;
  G.picks.splice(i, 1);
  sound.tick();
  renderYou();
}

document.querySelectorAll('.pb').forEach((b) => {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pick(Number(b.dataset.m));
  });
});
[...youSlots.children].forEach((el, i) => el.addEventListener('pointerdown', () => unpick(i)));

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (G.mode === 'title' && (k === 'enter' || k === ' ')) {
    e.preventDefault();
    startGame();
    return;
  }
  if (k === 'backspace') {
    unpick(G.picks.length - 1);
    return;
  }
  const mv = R.MOVES.find((m) => m.hotkeys.includes(k));
  if (mv) pick(mv.id);
});

// ---------------------------------------------------------------------------
// the fight
function makeOpponent(i) {
  const o = R.OPPONENTS[i];
  opp?.dispose();
  opp = new Boxer({ color: o.color, bulk: o.bulk, tall: o.tall, hair: o.hair, belt: o.belt });
  opp.root.position.set(0, 0, OPP_Z);
  stage.scene.add(opp.root);
  document.documentElement.style.setProperty('--opp', o.color);
  $('#opp-name').textContent = o.name;
  $('#them-label').textContent = o.short;
  return o;
}

async function exchange(i, pm, om, my, demo = false) {
  const res = R.outcome(pm, om);
  const mvP = R.MOVES[pm];
  const pRes = res === 'clash' ? 'clash' : res === 'win' || res === 'trade' ? 'land' : om === R.BODY ? 'whiff' : 'stuffed';
  const oRes = res === 'clash' ? 'clash' : res === 'lose' || res === 'trade' ? 'land' : pm === R.BODY ? 'whiff' : 'stuffed';
  const clashPt = new THREE.Vector3(mvP.sx * 0.17, mvP.high ? 1.47 : 1.17, (PLAYER_Z + OPP_Z) / 2);

  if (!demo) {
    stage.shot('fight', { yaw: [-0.2, 0.16, -0.1, 0.22][i], dolly: 0.12 + i * 0.07, lift: i % 2 ? -0.08 : 0.04, rate: 3.5 });
  }
  player.punch(pm, pRes, opp, clashPt);
  opp.punch(om, oRes, player, clashPt);
  sound.whoosh(0.06);
  await wait(IMPACT);
  if (my !== gen) return res;

  const o = R.OPPONENTS[G.fight];
  const gP = player.gloveWorld(player.handFor(pm));
  const gO = opp.gloveWorld(opp.handFor(om));

  if (res === 'clash') {
    player.recoil();
    opp.recoil();
    stage.clash(clashPt);
    sound.clash();
    G.hitstop = 0.09;
    if (!demo) {
      G.streak = 0;
      G.oppStreak = 0;
      G.score += R.SCORE.clash;
      popup('CLASH!', 'clash');
      haptic(20);
    }
  } else if (res === 'win' || res === 'trade') {
    // we land
    const streak = demo ? 1 : res === 'win' ? ++G.streak : 1;
    const dmg = res === 'win' ? Math.round(R.BASE_DMG * R.comboMult(streak)) : R.TRADE_DMG;
    const ko = !demo && G.oppHp - dmg <= 0;
    const power = ko ? 3 : res === 'trade' ? 0.8 : 0.9 + (streak - 1) * 0.35;
    opp.react(pm, Math.min(1.9, 0.85 + (streak - 1) * 0.25), player.handFor(pm));
    stage.impact(gP, '#3dff72', power);
    sound.hit(power, pm === R.BODY);
    G.hitstop = ko ? 0.14 : 0.055 + streak * 0.02;
    if (!demo) {
      G.oppHp = Math.max(0, G.oppHp - dmg);
      G.hits++;
      floatNum(`-${dmg}`, gP, res === 'trade' ? 'trade' : '');
      if (res === 'win') {
        G.wins++;
        G.oppStreak = 0;
        G.bestCombo = Math.max(G.bestCombo, streak);
        G.score += R.SCORE.hit * streak;
        setCombo(streak);
        if (!ko) {
          const words = { [R.JAB]: 'JAB!', [R.HOOK]: 'HOOK!', [R.UPPER]: 'UPPERCUT!', [R.BODY]: 'BODY SHOT!' };
          popup(streak >= 4 ? 'UNSTOPPABLE!' : streak === 3 ? 'TRIPLE!' : streak === 2 ? 'DOUBLE!' : words[pm], streak >= 3 ? 'gold' : '');
          if (streak === 3) sound.voice('combo');
        }
        if (G.highlight < power) { G.highlight = power; stage.capture(); }
        haptic(ko ? [40, 30, 80] : 25);
      }
      if (streak >= 3) quake();
    }
  }
  if (res === 'lose' || res === 'trade') {
    const streak = demo ? 1 : res === 'lose' ? ++G.oppStreak : 1;
    const dmg = Math.round((res === 'lose' ? R.BASE_DMG * R.comboMult(streak) : R.TRADE_DMG) * o.power);
    const ko = !demo && G.hp - dmg <= 0;
    const power = ko ? 3 : res === 'trade' ? 0.8 : 0.9 + (streak - 1) * 0.3;
    player.react(om, Math.min(1.8, 0.85 + (streak - 1) * 0.25), opp.handFor(om));
    stage.impact(gO, o.color, power);
    if (res === 'lose') sound.hit(power, om === R.BODY);
    G.hitstop = Math.max(G.hitstop, ko ? 0.14 : 0.06);
    if (!demo) {
      G.hp = Math.max(0, G.hp - dmg);
      floatNum(`-${dmg}`, gO, 'lose');
      if (res === 'lose') {
        G.streak = 0;
        setCombo(0);
        popup(streak >= 2 ? `OUCH x${streak}` : ['COUNTERED!', 'OUCH!', 'READ YOU!'][Math.floor(Math.random() * 3)], 'lose');
        haptic([30, 20, 30]);
      } else {
        G.streak = 0;
        G.oppStreak = 0;
        setCombo(0);
        G.score += R.SCORE.trade;
        popup('TRADE!', 'trade');
        haptic(30);
      }
    }
  }
  if (!demo) {
    G.exchanges++;
    markSlot(i, res);
    updateHud();
  }
  return res;
}

async function playRound(my) {
  if (G.clock <= 0) return 'time';
  const o = R.OPPONENTS[G.fight];
  G.plan = R.planRound(o, G.history);
  G.picks = [];
  G.mode = 'plan';
  G.shotMax = o.shotClock;
  G.shot = o.shotClock;
  renderThem(false);
  renderYou();
  lockDeck(false);
  setStatus(o.intel > 1 ? 'INTEL: 2 PUNCHES' : 'INTEL: 1 PUNCH');
  sound.setIntensity(1);
  stage.shot('fight', { rate: 2.5 });
  if (Math.random() < 0.5) opp.shimmy();

  const how = await new Promise((res) => { resolvePicks = res; });
  resolvePicks = null;
  if (my !== gen) return 'abort';
  if (how === 'time') return 'time';
  if (how === 'slow') {
    while (G.picks.length < 4) G.picks.push(R.randomMove());
    renderYou();
    popup('TOO SLOW!', 'lose sm');
    sound.buzz();
  }

  G.mode = 'action';
  lockDeck(true);
  setStatus('FIGHT!', 'go');
  sound.setIntensity(2);
  renderThem(true);
  [...themSlots.children].forEach((el) => el.classList.add('flip'));
  await wait(0.22);

  const results = [];
  for (let i = 0; i < 4; i++) {
    if (my !== gen) return 'abort';
    const r = await exchange(i, G.picks[i], G.plan.moves[i], my);
    results.push(r);
    if (G.oppHp <= 0 || G.hp <= 0) break;
    await wait(0.4);
    if (G.clock <= 0) break;
  }
  G.history.push({ player: G.picks.slice(), opp: G.plan.moves.slice() });
  G.rounds.push(results);
  if (my !== gen) return 'abort';

  if (results.length === 4 && results.every((r) => r === 'win')) {
    G.score += R.SCORE.flawless;
    popup('FLAWLESS +500', 'gold sm');
    sound.voice('flawless');
  }
  if (G.oppHp <= 0) return 'oppKO';
  if (G.hp <= 0) return 'playerKO';
  if (G.clock <= 0) return 'time';
  await wait(0.35);
  return 'next';
}

async function knockout(victim, my) {
  G.mode = 'ko';
  lockDeck(true);
  G.timeScale = 0.28;
  sound.slowmo(true);
  victim.knockout();
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
  lockDeck(true);
  G.fight = i;
  const o = makeOpponent(i);
  G.oppHp = G.oppMax = o.hp;
  G.streak = 0;
  G.oppStreak = 0;
  setCombo(0);
  updateHud();
  $('#fightno b').textContent = i + 1;
  G.plan = null;
  G.picks = [];
  renderThem();
  renderYou();
  setStatus(`FIGHT ${i + 1} OF 3`);

  player.clear();
  opp.dropIn(6);
  stage.shot('intro', { focus: new THREE.Vector3(0, 1.62 * o.tall, OPP_Z), rate: 6, snap: i === 0 });
  sound.riser();
  await wait(0.45);
  stage.impact(new THREE.Vector3(0, 0.05, OPP_Z), o.color, 1.4);
  sound.slam();
  sound.voice(['pete', 'nova', 'volt'][i], i === 0 ? 0.8 : 0.15); // let the title call finish
  haptic(40);

  $('#vs-n').textContent = `#${i + 1}`;
  $('#vs-name').textContent = o.name;
  $('#vs-title').textContent = o.title;
  $('#vs-bio').textContent = o.bio;
  $('#vs-intel').textContent = o.intel;
  $('#vs-clock').textContent = `${o.shotClock}s`;
  $('#vs').classList.add('show');
  await waitReal(i === 0 ? 2.1 : 1.7);
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

  for (let f = 0; f < 3; f++) {
    await introFight(f, my);
    if (my !== gen) return;
    for (;;) {
      const r = await playRound(my);
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
        break;
      }
      if (r === 'playerKO') {
        await knockout(player, my);
        opp.victory();
        return endGame('ko', my);
      }
      if (r === 'time') return endGame('time', my);
    }
  }
  endGame('champ', my);
}

async function endGame(reason, my) {
  if (my !== gen) return;
  G.mode = 'over';
  G.clockOn = false;
  G.reason = reason;
  lockDeck(true);
  resolvePicks = null;
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
  const winPct = G.exchanges ? Math.round((G.wins / G.exchanges) * 100) : 0;
  return {
    score: G.score, reason: G.reason, rank: R.rankFor(G.score), kos: G.kos, hits: G.hits,
    bestCombo: G.bestCombo, winPct, rounds: G.rounds.filter((r) => r.length),
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
    ['KOs', `${s.kos}/3`], ['HITS', s.hits], ['BEST', `x${s.bestCombo}`], ['WIN %', s.winPct],
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
// attract mode: the boxers spar on the title screen
async function attract() {
  const my = ++gen;
  G.mode = 'title';
  stage.shot('attract', { rate: 2 });
  while (my === gen) {
    await wait(0.55 + Math.random() * 0.5);
    if (my !== gen) return;
    await exchange(Math.floor(Math.random() * 4), R.randomMove(), R.randomMove(), my, true);
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
let lastTick = 0;
// ?dtcap=0.25 lets slow headless test runs keep real-time pacing
const DT_CAP = Number(new URLSearchParams(location.search).get('dtcap')) || 0.05;
// ?ts=0.2 slows everything down (debug / screenshots)
const DEBUG_TS = Number(new URLSearchParams(location.search).get('ts')) || 1;

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
      if (G.mode === 'plan' || G.mode === 'locked') resolvePicks?.('time');
    }
  }
  setClock(G.clock);

  if (G.mode === 'plan') {
    G.shot -= realDt;
    const t = Math.max(0, G.shot / G.shotMax);
    const bar = $('#shot');
    bar.style.setProperty('--t', t);
    bar.classList.toggle('hurry', G.shot < 2.5);
    const sec = Math.ceil(G.shot);
    if (G.shot < 3 && sec !== lastTick) {
      lastTick = sec;
      sound.tick(true);
    }
    if (G.shot <= 0) {
      G.mode = 'locked';
      resolvePicks?.('slow');
    }
  } else if (G.mode !== 'locked') {
    $('#shot').style.setProperty('--t', 0);
  }

  if (shownScore !== G.score) {
    shownScore += Math.ceil((G.score - shownScore) * 0.2);
    if (Math.abs(G.score - shownScore) < 3) shownScore = G.score;
    $('#score').textContent = String(shownScore).padStart(6, '0');
  }

  player.update(dt, G.gameTime);
  opp.update(dt, G.gameTime);
  stage.update(dt, realDt);
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
/** Freeze a dramatic uppercut for the Open Graph image (?og=1). */
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
  exchange(0, R.UPPER, R.BODY, my, true);
  await wait(IMPACT + 0.2);
  G.paused = true;
  return 'ready';
}

async function boot() {
  const best = loadBest();
  if (best) $('#best').textContent = `BEST ${best.toLocaleString()}`;
  setClock(G.clock);
  updateHud();
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
  try {
    stage = new Stage($('#arena'));
  } catch (e) {
    console.error(e);
    $('#nogl').classList.add('show');
    return;
  }
  player = new Boxer({ color: '#3dff72', ghost: true });
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

  // hooks for tools/render-assets.mjs and debugging
  const q = new URLSearchParams(location.search);
  if (q.get('autostart') === '1') startGame();
  window.__vb = { G, stage, sound, startGame, pick, ogPose, get player() { return player; }, get opp() { return opp; } };
}

boot();
