// Training gym: the instruction booklet, one move per page. Each lesson has a
// page (diagram + Coach Pops' notes), a demo the boxers act out above it, and
// a drill you have to pass with the real controls.

import * as R from './rules.js';

const tri = (dir) => `<svg class="tri ${dir}"><use href="#tri"/></svg>`;
const kc = (dir) => `<span class="kc lit">${tri(dir)}</span>`;
const star = '<span class="kc star"><svg><use href="#star"/></svg></span>';
const go = '<svg class="go-arrow"><use href="#tri"/></svg>';
const chip = (t = '!', cls = '') => `<span class="tchip ${cls}">${t}</span>`;
const mpad = (guarded) => `<span class="mpad">${[0, 1, 2, 3].map((q) => `<i class="${guarded.includes(q) ? 'g' : ''}"></i>`).join('')}</span>`;
const row = (...cells) => `<div class="drow">${cells.join('')}</div>`;
const nm = (t) => `<span class="nm">${t}</span>`;
const ans = (t) => `<span class="ans">${t}</span>`;

const grid = (...cells) => `<div class="dgrid">${cells.map((c) => `<div class="dcell">${c}</div>`).join('')}</div>`;

const DIR = { L: 'left', R: 'right', DUCK: 'down', BLOCK: 'up' };
const ANSWER = { L: 'SLIP LEFT', R: 'SLIP RIGHT', DUCK: 'DUCK', BLOCK: 'BLOCK', SLIP: 'SLIP IT' };

/** "! LEFT HOOK > [->] SLIP RIGHT" */
function readRow(key) {
  const A = R.ATTACKS[key];
  return row(chip(A.mega ? '!!' : '!', A.mega ? 'mega' : ''), nm(A.name), go, `<span class="grp">${answerKeys(A)}</span>`, ans(ANSWER[A.answer]));
}

const answerKeys = (A) => (A.answer === 'SLIP' ? kc('left') + kc('right') : kc(DIR[A.answer]));

/** Compact "! JAB [v]" cell for the four-up tables. */
function readCell(key) {
  const A = R.ATTACKS[key];
  return `${chip(A.mega ? '!!' : '!', A.mega ? 'mega' : '')}${nm(A.name)}${answerKeys(A)}`;
}

const DEFEND_HOW = '<b>D-PAD</b> · SWIPE THE RING · <b>ARROW KEYS</b>';
const PUNCH_HOW = '<b>PUNCH PAD</b> · TAP THE RING · <b>Q W A S</b>';

export const LESSONS = [
  {
    id: 'slip',
    name: 'SLIP',
    diagram: () => readRow('hookL') + readRow('hookR'),
    say: 'Hooks swing in from the side. When a glove flashes, slip <b>away</b> from it.',
    how: DEFEND_HOW,
    go: 'SHOW ME 3 CLEAN SLIPS.',
    drill: { kind: 'defend', pool: ['hookL', 'hookR'], reps: 3, hints: 1 },
  },
  {
    id: 'duck',
    name: 'DUCK',
    diagram: () => readRow('jab') + row(nm('THE JAB COMES FROM MY LEAD HAND, STRAIGHT DOWN THE MIDDLE.')),
    say: 'Nothing to slip away from, so get <b>under</b> it.',
    how: DEFEND_HOW,
    go: 'DUCK 2 JABS FOR ME.',
    drill: { kind: 'defend', pool: ['jab'], reps: 2, hints: 1 },
  },
  {
    id: 'block',
    name: 'BLOCK',
    diagram: () => readRow('body') + row(nm('A LOW GLOVE IS A BODY BLOW. SLIPS AND DUCKS WON\'T CLEAR IT.')),
    say: 'Gloves up! Not sure what\'s coming? A <b>block</b> soaks most of any punch.',
    how: DEFEND_HOW,
    go: 'BLOCK 2 BODY BLOWS.',
    drill: { kind: 'defend', pool: ['body'], reps: 2, hints: 1 },
  },
  {
    id: 'read',
    name: 'READ IT',
    diagram: () => grid(...['hookL', 'hookR', 'jab', 'body'].map(readCell)),
    say: 'No more hints. Wait for the flash, spot the punch, <b>then</b> move.',
    how: DEFEND_HOW,
    go: '4 GOOD READS. NO HINTS!',
    drill: { kind: 'defend', pool: ['hookL', 'hookR', 'jab', 'body'], reps: 4, hints: 0 },
  },
  {
    id: 'punch',
    name: 'PUNCH',
    diagram: () => row(mpad(R.GUARDS.high), mpad(R.GUARDS.left), nm('SHIELD = GUARDED. FLASHING = OPEN. MY GUARD MOVES EVERY PUNCH.')),
    say: 'Your turn: hit what\'s open. Punch a glove and your turn is <b>over</b>.',
    how: PUNCH_HOW,
    go: 'LAND 3 PUNCHES ON ME.',
    drill: { kind: 'punch', reps: 3 },
  },
  {
    id: 'combo',
    name: 'COMBO',
    diagram: () => row(
      `<span class="chain">${[1, 1.25, 1.5, 1.75].map((m, i) => `<i style="height:${10 + i * 8}px">${i + 1}</i>`).join('')}</span>`,
      nm(`EACH HIT IN A ROW DOES MORE: x1 > x${R.chainMult(3)}. LAND ALL ${R.MAX_CHAIN} FOR A FLURRY BONUS.`),
    ),
    say: 'Don\'t stop at one. Chase the opening and keep the chain alive.',
    how: PUNCH_HOW,
    go: 'LAND A 3-HIT COMBO.',
    drill: { kind: 'combo', reps: 1, need: 3 },
  },
  {
    id: 'counter',
    name: 'COUNTER',
    diagram: () => row(chip(), nm('PERFECT READ'), go, mpad([]), ans(`x${R.COUNTER_MULT} DMG`)),
    say: 'Make me whiff and I\'m wide open: no guard, double points. <b>Unload!</b>',
    how: '<b>D-PAD</b>, THEN THE <b>PUNCH PAD</b>',
    go: 'READ IT, THEN MAKE ME PAY. TWICE.',
    drill: { kind: 'counter', pool: ['hookL', 'hookR', 'jab', 'body'], reps: 2, hints: 2 },
  },
  {
    id: 'super',
    name: 'SUPER',
    diagram: () => grid(`${chip()}${nm('READ')}${star}${ans('+1')}`, `${chip('!', 'dim')}${nm('GET HIT')}${star}${ans('-1')}`)
      + row(star, nm('SUPER UPPERCUT'), go, ans(`${R.SUPER_DMG} DMG PER STAR`)),
    say: 'On your turn, cash in every star for an <b>unblockable</b> uppercut.',
    how: '<b>STAR BUTTON</b> · FLICK UP · <b>SPACE</b>',
    go: '3 STARS ON THE HOUSE. SPEND \'EM!',
    drill: { kind: 'super', reps: 1 },
  },
  {
    id: 'tricks',
    name: 'TRICKS',
    diagram: () => grid(
      `${chip('!', 'dim')}${go}${chip()}${nm('FEINT')}`,
      `${chip()}${chip()}${nm('DOUBLE')}`,
      `${mpad(R.GUARDS.low)}${nm('GUARD SWITCH')}`,
      readCell('mega'),
    ),
    say: 'Read the <b>last</b> flash, re-read a moving guard, and never duck the MEGA.',
    how: DEFEND_HOW,
    go: 'SURVIVE 3 OF MY DIRTY TRICKS.',
    drill: {
      kind: 'defend',
      reps: 3,
      hints: 0,
      plans: [
        [{ key: 'hookR', feintFrom: 'jab', feintAt: 0.45 }],
        [{ key: 'jab' }, { key: 'hookL' }],
        [{ key: 'mega', hint: true }],
        [{ key: 'body', feintFrom: 'hookL', feintAt: 0.45 }],
      ],
    },
  },
];

const PRAISE = ['NICE!', "THAT'S IT!", 'BEAUTIFUL!', 'SHARP!', 'TEXTBOOK!', 'NOW YOU\'RE COOKING!'];
export const praise = () => PRAISE[Math.floor(Math.random() * PRAISE.length)];

/** Coach Pops explains what went wrong with a read. */
export function readAdvice(r) {
  const A = R.ATTACKS[r.key];
  if (!r.action) return 'TOO SLOW! MOVE BEFORE IT LANDS.';
  if (r.feint && r.at < r.feintAt) return 'GOTCHA! THAT WAS A FEINT. WAIT FOR THE SWITCH.';
  if (A.mega && r.action === 'DUCK') return 'NEVER DUCK THE MEGA! SLIP IT.';
  return `THAT WAS A ${A.name}. ${A.hint.replace(/!$/, '')}!`;
}

export const PUNCH_ADVICE = {
  blocked: "THAT'S MY GLOVE! HIT WHAT'S OPEN.",
  slow: "DON'T WAIT! PUNCH AN OPEN TARGET.",
};
