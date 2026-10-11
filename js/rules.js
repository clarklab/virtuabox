// Fight rules: a turn-based read-and-react loop.
//
// THEIR TURN: the opponent winds up an attack with a visible tell. You make
// one read before it lands: SLIP away from hooks, DUCK jabs, BLOCK body shots.
// A perfect read makes them whiff, earns a star and leaves them wide open.
//
// YOUR TURN: they hold a guard over two of four targets (head/body x
// left/right). Punch an open target to land and chain; hit a glove and your
// turn is over. Stars power an unblockable SUPER uppercut.

export const JAB = 0, HOOK = 1, UPPER = 2, BODY = 3;

// Punch animations. sx = screen side the punch travels on (-1 left, +1 right).
export const MOVES = [
  { id: JAB, name: 'JAB', high: true, sx: -1 },
  { id: HOOK, name: 'HOOK', high: true, sx: 1 },
  { id: UPPER, name: 'UPPER', high: false, sx: 1 },
  { id: BODY, name: 'BODY', high: false, sx: -1 },
];

// Targets on the opponent as you see them. `hand` is the screen side of the
// glove you throw with; the animation follows from the move.
export const QUADS = [
  { id: 0, key: 'UL', name: 'HEAD', high: true, sx: -1, move: JAB, hand: -1, keys: ['q', '7'] },
  { id: 1, key: 'UR', name: 'HEAD', high: true, sx: 1, move: HOOK, hand: 1, keys: ['w', 'e', '9'] },
  { id: 2, key: 'LL', name: 'BODY', high: false, sx: -1, move: BODY, hand: -1, keys: ['a', '1'] },
  { id: 3, key: 'LR', name: 'BODY', high: false, sx: 1, move: BODY, hand: 1, keys: ['s', 'd', '3'] },
];

// Guard stances and the targets each one covers. A tight guard (after you
// got tagged) leaves a single opening; `pose` is the stance the boxer shows.
export const GUARDS = {
  high: [0, 1],
  low: [2, 3],
  left: [0, 2],
  right: [1, 3],
  open: [],
  tight0: [1, 2, 3],
  tight1: [0, 2, 3],
  tight2: [0, 1, 3],
  tight3: [0, 1, 2],
};
export const GUARD_POSE = { tight0: 'right', tight1: 'left', tight2: 'high', tight3: 'high' };

// Defensive reads. `sx` is the screen direction of the slip.
export const DEFENSES = {
  L: { name: 'SLIP', sx: -1, keys: ['arrowleft'] },
  R: { name: 'SLIP', sx: 1, keys: ['arrowright'] },
  DUCK: { name: 'DUCK', keys: ['arrowdown'] },
  BLOCK: { name: 'BLOCK', keys: ['arrowup'] },
};

// Opponent attacks. `from` = screen side the punch comes from; `answer` = the
// read that makes it whiff.
export const ATTACKS = {
  hookL: { name: 'LEFT HOOK', move: HOOK, from: -1, answer: 'R', hint: 'SLIP RIGHT', dmg: 1, high: true },
  hookR: { name: 'RIGHT HOOK', move: HOOK, from: 1, answer: 'L', hint: 'SLIP LEFT', dmg: 1, high: true },
  jab: { name: 'JAB', move: JAB, from: 0, answer: 'DUCK', hint: 'DUCK!', dmg: 0.8, high: true },
  body: { name: 'BODY BLOW', move: BODY, from: 0, answer: 'BLOCK', hint: 'BLOCK!', dmg: 1, high: false },
  mega: { name: 'MEGA UPPERCUT', move: UPPER, from: 0, answer: 'SLIP', hint: 'SLIP IT!', dmg: 2.2, high: true, mega: true },
};

/** Screen side of the glove that throws `attack` (jab = lead hand, body/mega = rear). */
export const attackHand = (key) => ATTACKS[key].from || (key === 'jab' ? 1 : -1);

/** 'perfect' | 'block' | 'hit' for a read against an attack. */
export function readAttack(key, action) {
  const a = ATTACKS[key];
  if (!action) return 'hit';
  if (a.answer === action || (a.answer === 'SLIP' && (action === 'L' || action === 'R'))) return 'perfect';
  if (action === 'BLOCK') return 'block';
  return 'hit';
}

export const MATCH_SECONDS = 120;
export const PLAYER_HP = 100;
export const KO_HEAL = 30;
export const KNOCKDOWNS_TO_KO = 3;
export const REFEREE_COUNT = 10;
// The first two falls get a recovery count; the third is an immediate KO.
export const countLimit = (downs) => downs >= KNOCKDOWNS_TO_KO ? 0 : downs === 1 ? 6 : 8;
// Shorter health bars on recovery keep three-knockdown bouts within the clock.
export const recoveryHp = (maxHp, downs) => downs >= KNOCKDOWNS_TO_KO ? 0 : Math.ceil(maxHp * (downs === 1 ? 0.6 : 0.4));
export const MAX_STARS = 3;
export const MAX_CHAIN = 4;
export const PUNCH_DMG = 7;
// SUPER uppercut damage by stars spent: saving up all three pays off big
export const SUPER_DMG = [0, 20, 44, 76];
export const superCharge = (stars) => 0.55 + 0.42 * stars; // seconds of wind-up
export const BLOCK_CHIP = 0.35; // damage taken when you block the wrong attack
export const COUNTER_MULT = 1.5; // damage bonus while they're wide open

export const chainMult = (i) => 1 + 0.25 * i;

export const SCORE = {
  read: 150, // perfect read
  block: 30,
  punch: 100, // × chain position
  counter: 2, // punch score multiplier while they're open
  flurry: 300, // land the full chain
  super: 400, // × stars spent, squared
  ko: 1000, // × fight number
  hpBonus: 10, // per remaining player HP at each KO
  timeBonus: 50, // per second left when you win it all
};

// `stats` are the 1-5 bars on the tale-of-the-tape card.
export const OPPONENTS = [
  {
    name: 'PIXEL PETE', short: 'PETE', title: 'THE ROOKIE',
    venue: 'pete', venueName: 'BIT CITY GYM',
    bio: 'Slow, honest tells. Loves the JAB.', tip: 'DUCK THE JAB',
    from: 'BIT CITY', record: '8-21', stats: { speed: 1, power: 2, tricks: 1 },
    color: '#f048b0', hp: 80, hit: 11,
    tell: 1.3, window: 1.6, feint: 0, double: 0, guardSwitch: 0, mega: 0, counterGuard: 0,
    guards: ['high', 'low'],
    attacks: { jab: 4, hookL: 2, hookR: 2, body: 1.5 },
    hair: 'mohawk', bulk: 0.94, tall: 0.97,
    look: { skin: '#f8b890', trunks: '#f048b0', gloves: '#e82818', hair: '#9030e0', boots: '#f0f0f0' },
  },
  {
    name: 'NOVA KID', short: 'NOVA', title: 'THE SPEEDSTER',
    venue: 'nova', venueName: 'NEON BAY ROOFTOP',
    bio: 'Fast hands, double-ups, sneaky feints.', tip: "DON'T READ TOO EARLY",
    from: 'NEON BAY', record: '19-4', stats: { speed: 4, power: 3, tricks: 3 },
    color: '#30b8f8', hp: 125, hit: 17,
    tell: 1.05, window: 1.3, feint: 0.18, double: 0.25, guardSwitch: 0, mega: 0, counterGuard: 0.2,
    guards: ['high', 'low', 'left', 'right'],
    attacks: { jab: 2, hookL: 2.5, hookR: 2.5, body: 3 },
    hair: 'flattop', bulk: 1.0, tall: 1.02,
    look: { skin: '#a86038', trunks: '#30b8f8', gloves: '#2858e8', hair: '#181818', boots: '#202020' },
  },
  {
    name: 'MEGAVOLT', short: 'VOLT', title: 'THE CHAMP',
    venue: 'volt', venueName: 'VOLTAGE DOME',
    bio: 'Feints, shifting guards and the MEGA UPPERCUT.', tip: 'SLIP THE MEGA, NEVER DUCK IT',
    from: 'VOLTAGE PEAK', record: '38-0', stats: { speed: 5, power: 5, tricks: 5 },
    color: '#f8a800', hp: 145, hit: 20,
    tell: 0.95, window: 1.15, feint: 0.3, double: 0.3, guardSwitch: 0.45, mega: 0.25, counterGuard: 0.55,
    guards: ['high', 'low', 'left', 'right'],
    attacks: { jab: 2, hookL: 2.5, hookR: 2.5, body: 2 },
    hair: 'spikes', bulk: 1.18, tall: 1.07, belt: true,
    look: { skin: '#e09868', trunks: '#f8a800', gloves: '#e82818', hair: '#f8e030', boots: '#f0f0f0' },
  },
];

// The training-gym sparring partner: slow tells, focus mitts, pulls his punches.
export const COACH = {
  name: 'COACH POPS', short: 'POPS', title: 'HEAD TRAINER',
  color: '#f8d830', hp: 9999, hit: 4,
  tell: 1.45, window: 2.4, feint: 0, double: 0, guardSwitch: 0, mega: 0, counterGuard: 0,
  guards: ['high', 'low', 'left', 'right'],
  attacks: { jab: 1, hookL: 1, hookR: 1, body: 1 },
  hair: 'flattop', bulk: 1.08, tall: 0.96,
  look: { skin: '#c07848', trunks: '#3048d8', gloves: '#f8d830', hair: '#e0e0e8', boots: '#202020' },
};

export const RANKS = [
  [28000, 'UNDISPUTED LEGEND'],
  [22000, 'WORLD CHAMPION'],
  [18000, 'TITLE CONTENDER'],
  [12000, 'MAIN EVENTER'],
  [6000, 'UNDERCARD HOPEFUL'],
  [2500, 'SPARRING PARTNER'],
  [0, 'GLASS JAW'],
];
export const rankFor = (score) => RANKS.find(([min]) => score >= min)[1];

/** Wind-up time: champs are quicker, and everyone speeds up when hurt. */
export function tellTime(opp, hpFrac, second = false) {
  return opp.tell * (0.85 + 0.15 * hpFrac) * (second ? 0.82 : 1);
}

function weighted(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = rng() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Plan their turn: one or two attacks, each maybe a feint that switches late.
 * `state.recent` = last attack keys, `state.earlyRate` = how often you read
 * before the halfway mark (feinters punish that).
 */
export function planAttacks(opp, state, rng = Math.random) {
  const hpFrac = state.hpFrac ?? 1;
  const pick = (allowMega) => {
    const w = { ...opp.attacks };
    // don't throw the same thing three times running
    const [a, b] = state.recent.slice(-2);
    if (a && a === b) w[a] = 0;
    if (allowMega && opp.mega && hpFrac < 0.75) w.mega = opp.mega * 8;
    return weighted(w, rng);
  };
  const feintChance = opp.feint ? Math.min(0.6, opp.feint + (state.earlyRate > 0.5 ? 0.15 : 0)) : 0;
  const make = (allowMega) => {
    const key = pick(allowMega);
    const atk = { key };
    if (key !== 'mega' && rng() < feintChance) {
      const others = Object.keys(opp.attacks).filter((k) => k !== key);
      atk.feintFrom = others[Math.floor(rng() * others.length)];
      atk.feintAt = 0.38 + rng() * 0.12;
    }
    return atk;
  };
  const first = make(true);
  const attacks = [first];
  if (first.key !== 'mega' && rng() < opp.double) attacks.push(make(false));
  return attacks;
}

/** Their guard for your next punch. Counter-punchers cover where you just hit. */
export function pickGuard(opp, prev, lastQuad, rng = Math.random, tight = false) {
  if (tight) return `tight${Math.floor(rng() * 4)}`;
  let options = opp.guards.filter((g) => g !== prev);
  if (lastQuad != null && rng() < opp.counterGuard) {
    const covering = options.filter((g) => GUARDS[g].includes(lastQuad));
    if (covering.length) options = covering;
  }
  return options[Math.floor(rng() * options.length)];
}
