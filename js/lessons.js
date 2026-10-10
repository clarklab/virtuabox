// Training gym: the instruction booklet, one move per page. Each lesson has a
// page (diagram + Coach Pops' notes), a demo the boxers act out above it, and
// a drill you have to pass with the real controls.

import * as R from './rules.js';

const tri = (dir) => `<svg class="tri ${dir}"><use href="#tri"/></svg>`;
const kc = (dir) => `<span class="kc lit">${tri(dir)}</span>`;
const star = (cls = '') => `<span class="kc star ${cls}"><svg><use href="#star"/></svg></span>`;
const go = '<svg class="go-arrow"><use href="#tri"/></svg>';
const chip = (t = '!', cls = '') => `<span class="tchip ${cls}">${t}</span>`;
const mpad = (guarded) => `<span class="mpad">${[0, 1, 2, 3].map((q) => `<i class="${guarded.includes(q) ? 'g' : ''}"></i>`).join('')}</span>`;
/** One punch-pad button: grey with a shield (guarded) or bright and flashing (open). */
const mbtn = (guarded, color = 'r') => `<span class="mbtn ${color}${guarded ? ' g' : ''}"></span>`;

// Booklet building blocks. Everything is spelled out in words: a picture on
// the left, a plain sentence on the right.
const note = (icon, text) => `<div class="dnote"><span class="ic">${icon}</span><span>${text}</span></div>`;

const DIR = { L: 'left', R: 'right', DUCK: 'down', BLOCK: 'up' };
const ANSWER = { L: 'SLIP LEFT', R: 'SLIP RIGHT', DUCK: 'DUCK', BLOCK: 'BLOCK', SLIP: 'SLIP EITHER WAY' };
const answerKeys = (A) => (A.answer === 'SLIP' ? kc('left') + kc('right') : kc(DIR[A.answer]));

/** "When he throws ... / you press ..." table. */
function readTable(keys) {
  const rows = keys.map((key) => {
    const A = R.ATTACKS[key];
    return `<div class="drow"><span class="l">${chip(A.mega ? '!!' : '!', A.mega ? 'mega' : '')}<span>${A.name}</span></span>`
      + `<span class="r">${answerKeys(A)}<span class="ans">${ANSWER[A.answer]}</span></span></div>`;
  });
  return `<div class="dhead"><span>WHEN HE THROWS</span><span>YOU PRESS</span></div>${rows.join('')}`;
}

const KB = (keys) => `<span class="kb"> Keys: ${keys}.</span>`;
const DEFEND_HOW = `Use the <b>D-pad</b>, or swipe on the ring.${KB('arrows')}`;
const PUNCH_HOW = `Use the <b>punch pad</b>, or tap the target on the ring.${KB('Q W A S')}`;
const READ_ALL = ['hookL', 'hookR', 'jab', 'body'];

export const LESSONS = [
  {
    id: 'slip',
    name: 'SLIP',
    diagram: () => readTable(['hookL', 'hookR']),
    say: 'A hook swings in from the side. Slip <b>away</b> from the flashing glove and it misses.',
    how: DEFEND_HOW,
    go: 'SHOW ME 3 CLEAN SLIPS.',
    drill: { kind: 'defend', pool: ['hookL', 'hookR'], reps: 3, hints: 1 },
  },
  {
    id: 'duck',
    name: 'DUCK',
    diagram: () => readTable(['jab']),
    say: 'The jab comes straight at your face. <b>Duck</b> under it.',
    how: DEFEND_HOW,
    go: 'DUCK 2 JABS FOR ME.',
    drill: { kind: 'defend', pool: ['jab'], reps: 2, hints: 1 },
  },
  {
    id: 'block',
    name: 'BLOCK',
    diagram: () => readTable(['body']),
    say: 'A body blow comes in low. Gloves up and <b>block</b> it. Not sure what\'s coming? A block stops most of any punch.',
    how: DEFEND_HOW,
    go: 'BLOCK 2 BODY BLOWS.',
    drill: { kind: 'defend', pool: ['body'], reps: 2, hints: 1 },
  },
  {
    id: 'read',
    name: 'READ IT',
    diagram: () => readTable(READ_ALL),
    say: 'Now I mix them up, with no hints. Watch which glove flashes, <b>then</b> react.',
    how: DEFEND_HOW,
    go: '4 GOOD READS. NO HINTS!',
    drill: { kind: 'defend', pool: READ_ALL, reps: 4, hints: 0 },
  },
  {
    id: 'punch',
    name: 'PUNCH',
    diagram: () => note(mbtn(true), 'A grey button with a shield: I\'m guarding that target.')
      + note(mbtn(false, 'b'), 'A bright, flashing button: that target is open. Hit it!'),
    say: 'On your turn, punch an open target. Hit my glove and your turn is <b>over</b>.',
    how: PUNCH_HOW,
    go: 'LAND 3 PUNCHES ON ME.',
    drill: { kind: 'punch', reps: 3 },
  },
  {
    id: 'combo',
    name: 'COMBO',
    diagram: () => note(
      `<span class="chain">${[0, 1, 2, 3].map((i) => `<i style="height:${8 + i * 6}px">${i + 1}</i>`).join('')}</span>`,
      `Keep landing in one turn and every hit does more damage. Land all ${R.MAX_CHAIN} for a flurry bonus.`,
    ),
    say: 'After each hit my guard moves, so look again before the next punch.',
    how: PUNCH_HOW,
    go: 'LAND A 3-HIT COMBO.',
    drill: { kind: 'combo', reps: 1, need: 3 },
  },
  {
    id: 'counter',
    name: 'COUNTER',
    diagram: () => note(chip(), 'Read my punch perfectly and I miss...')
      + note(mpad([]), '...and all 4 targets open up. Your punches hit harder, too.'),
    say: 'That\'s a counter: the best time to <b>unload</b>.',
    how: 'Use the <b>D-pad</b> to read, then the <b>punch pad</b>.',
    go: 'READ IT, THEN MAKE ME PAY. TWICE.',
    drill: { kind: 'counter', pool: READ_ALL, reps: 2, hints: 2 },
  },
  {
    id: 'super',
    name: 'SUPER',
    diagram: () => note(star(), `Every perfect read earns a star, up to ${R.MAX_STARS}. Getting hit costs one.`)
      + note(star('btn'), 'On your turn, press the star button to spend them all on a super uppercut.'),
    say: `The more stars, the bigger the hit: 1 star does ${R.SUPER_DMG[1]}, all 3 do <b>${R.SUPER_DMG[3]}</b>!`,
    how: `Use the <b>star button</b>, or flick up on the ring.${KB('space')}`,
    go: '3 STARS ON THE HOUSE. SPEND \'EM!',
    drill: { kind: 'super', reps: 1 },
  },
  {
    id: 'feint',
    name: 'FEINT',
    diagram: () => note(`${chip('!', 'dim')}${go}${chip()}`, 'Tricky fighters fake one punch, then throw another. The flash jumps to the other glove and you hear a double beep.'),
    say: 'Don\'t move too early. Wait for the switch, then react to the <b>second</b> punch.',
    how: DEFEND_HOW,
    go: 'DON\'T FALL FOR 3 OF MY FAKES.',
    drill: {
      kind: 'defend',
      reps: 3,
      hints: 1,
      plans: [
        [{ key: 'hookR', feintFrom: 'jab', feintAt: 0.45 }],
        [{ key: 'body', feintFrom: 'hookL', feintAt: 0.45 }],
        [{ key: 'jab', feintFrom: 'hookR', feintAt: 0.45 }],
        [{ key: 'hookL', feintFrom: 'body', feintAt: 0.45 }],
      ],
    },
  },
  {
    id: 'double',
    name: 'DOUBLE',
    title: 'DOUBLE ATTACK',
    diagram: () => note(`${chip()}${chip()}`, 'Some fighters throw two punches in a row, and the second one comes faster.'),
    say: 'Read the first punch, then get ready for the <b>next one</b> right away.',
    how: DEFEND_HOW,
    go: 'SURVIVE 2 DOUBLES.',
    drill: {
      kind: 'defend',
      reps: 2,
      hints: 1,
      plans: [
        [{ key: 'jab' }, { key: 'hookL' }],
        [{ key: 'body' }, { key: 'hookR' }],
        [{ key: 'hookL' }, { key: 'jab' }],
      ],
    },
  },
  {
    id: 'mega',
    name: 'MEGA',
    title: 'MEGA UPPERCUT',
    diagram: () => readTable(['mega']) + note(chip('!!', 'mega'), 'The champ\'s glove glows gold with a double !! when it\'s coming.'),
    say: 'It comes straight up the middle, so ducking walks right into it. <b>Slip!</b>',
    how: DEFEND_HOW,
    go: 'SLIP 2 MEGAS. NEVER DUCK!',
    drill: { kind: 'defend', reps: 2, hints: 1, plans: [[{ key: 'mega' }]] },
  },
  {
    id: 'switch',
    name: 'SWITCH',
    title: 'GUARD SWITCH',
    diagram: () => note(`${mpad(R.GUARDS.high)}${go}${mpad(R.GUARDS.low)}`, 'Champs can move their guard while you\'re deciding. If the shields jump, look again before you punch.'),
    say: 'Watch the <b>buttons</b>, not just the gloves.',
    how: PUNCH_HOW,
    go: 'LAND 3 PUNCHES. MY GUARD WILL MOVE!',
    drill: { kind: 'punch', reps: 3, coach: { guardSwitch: 1 } },
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
