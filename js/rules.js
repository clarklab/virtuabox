// Core rules: four punches on a clock. Every punch beats the next one
// clockwise, trades with its diagonal, and clashes with itself.
//
//        JAB (UL)  ──beats──▶  HOOK (UR)
//           ▲                     │
//         beats                 beats
//           │                     ▼
//       BODY (LL)  ◀──beats──  UPPER (LR)

export const JAB = 0, HOOK = 1, UPPER = 2, BODY = 3;

// sx: screen side (-1 left, +1 right). Order is clockwise from upper-left.
export const MOVES = [
  { id: JAB, key: 'UL', name: 'JAB', long: 'JAB', high: true, sx: -1, hotkeys: ['q', '7', 'u'] },
  { id: HOOK, key: 'UR', name: 'HOOK', long: 'HOOK', high: true, sx: 1, hotkeys: ['w', 'e', '9', 'i'] },
  { id: UPPER, key: 'LR', name: 'UPPER', long: 'UPPERCUT', high: false, sx: 1, hotkeys: ['s', 'd', '3', 'k'] },
  { id: BODY, key: 'LL', name: 'BODY', long: 'BODY SHOT', high: false, sx: -1, hotkeys: ['a', '1', 'j'] },
];

export const beatsWhat = (m) => (m + 1) % 4; // the move `m` beats
export const beatenBy = (m) => (m + 3) % 4; // the move that beats `m`

/** Result for the fighter who threw `a` against `b`. */
export function outcome(a, b) {
  switch ((b - a + 4) % 4) {
    case 0: return 'clash';
    case 1: return 'win';
    case 2: return 'trade';
    default: return 'lose';
  }
}

export const MATCH_SECONDS = 120;
export const PLAYER_HP = 100;
export const BASE_DMG = 12;
export const TRADE_DMG = 7;
export const KO_HEAL = 30;

export const comboMult = (streak) => 1 + 0.25 * Math.max(0, streak - 1);

export const SCORE = {
  hit: 100, // × streak
  trade: 40,
  clash: 25,
  flawless: 500,
  ko: 1000, // × fight number
  hpBonus: 10, // per remaining player HP at each KO
  timeBonus: 50, // per second left when you win it all
};

export const OPPONENTS = [
  {
    name: 'PIXEL PETE', short: 'PETE', title: 'THE ROOKIE',
    bio: 'Loves the JAB. Telegraphs everything.',
    color: '#f048b0', hp: 70, power: 0.8, intel: 2, shotClock: 8,
    style: 'pattern', hair: 'mohawk', bulk: 0.94, tall: 0.97,
    look: { skin: '#f8b890', trunks: '#f048b0', gloves: '#e82818', hair: '#9030e0', boots: '#f0f0f0' },
  },
  {
    name: 'NOVA KID', short: 'NOVA', title: 'THE COPYCAT',
    bio: 'Steals your last combo. Think one step ahead.',
    color: '#30b8f8', hp: 90, power: 1.0, intel: 1, shotClock: 7,
    style: 'copycat', hair: 'flattop', bulk: 1.0, tall: 1.02,
    look: { skin: '#a86038', trunks: '#30b8f8', gloves: '#2858e8', hair: '#181818', boots: '#202020' },
  },
  {
    name: 'MEGAVOLT', short: 'VOLT', title: 'THE CHAMP',
    bio: 'Reads your habits and counters them. Mix it up.',
    color: '#f8a800', hp: 110, power: 1.25, intel: 1, shotClock: 6,
    style: 'counter', hair: 'spikes', bulk: 1.18, tall: 1.07, belt: true,
    look: { skin: '#e09868', trunks: '#f8a800', gloves: '#e82818', hair: '#f8e030', boots: '#f0f0f0' },
  },
];

export const RANKS = [
  [16000, 'UNDISPUTED LEGEND'],
  [12000, 'WORLD CHAMPION'],
  [8000, 'TITLE CONTENDER'],
  [5000, 'MAIN EVENTER'],
  [2500, 'UNDERCARD HOPEFUL'],
  [1000, 'SPARRING PARTNER'],
  [0, 'GLASS JAW'],
];
export const rankFor = (score) => RANKS.find(([min]) => score >= min)[1];

const rand4 = (rng) => Math.floor(rng() * 4);

function pickIntelSlots(n, rng) {
  const slots = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots.slice(0, n).sort();
}

const PETE_PATTERNS = [
  [JAB, JAB, HOOK, JAB],
  [JAB, BODY, JAB, UPPER],
  [HOOK, JAB, JAB, BODY],
  [JAB, JAB, BODY, BODY],
  [UPPER, JAB, HOOK, JAB],
];

/**
 * Opponent brain. `history` is the list of previous rounds, each
 * `{ player: [4 moves], opp: [4 moves] }`.
 */
export function planRound(opp, history, rng = Math.random) {
  let moves;
  const last = history[history.length - 1];

  if (opp.style === 'pattern') {
    moves = PETE_PATTERNS[Math.floor(rng() * PETE_PATTERNS.length)].slice();
    if (rng() < 0.35) moves[rand4(rng)] = rand4(rng);
  } else if (opp.style === 'copycat') {
    if (last) {
      moves = last.player.map((m) => (rng() < 0.72 ? m : rand4(rng)));
    } else {
      moves = [HOOK, HOOK, UPPER, JAB];
    }
  } else {
    // Counter-puncher: predict each slot from the player's habits, then
    // throw what beats it. Weighted by slot history plus overall tendency.
    const all = [1, 1, 1, 1];
    const bySlot = [0, 1, 2, 3].map(() => [0.5, 0.5, 0.5, 0.5]);
    history.forEach((r, ri) => {
      const w = 1 + ri * 0.5; // recent rounds weigh more
      r.player.forEach((m, s) => {
        all[m] += w;
        bySlot[s][m] += w * 1.5;
      });
    });
    moves = [0, 1, 2, 3].map((s) => {
      if (rng() > 0.62) return rand4(rng);
      const score = [0, 1, 2, 3].map((m) => all[m] + bySlot[s][m] + rng() * 0.8);
      const predicted = score.indexOf(Math.max(...score));
      return beatenBy(predicted);
    });
  }

  return { moves, intel: pickIntelSlots(opp.intel, rng) };
}

export function randomMove(rng = Math.random) {
  return rand4(rng);
}
