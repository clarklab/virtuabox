// Score card: a 1080x1352 pixel-art PNG with the knockout frame, the score,
// and a Wordle-style grid of every exchange.

const RESULT_EMOJI = { win: '🟩', lose: '🟥', trade: '🟨', clash: '🟦' };
export const HEADLINES = { champ: 'CHAMPION!', time: 'TIME!', ko: 'KNOCKED OUT' };

const fmt = (n) => n.toLocaleString('en-US');

export function playUrl() {
  const { origin, pathname } = window.location;
  return origin.startsWith('http') ? origin + pathname.replace(/index\.html$/, '') : 'virtuabox';
}

export function shareText(s) {
  const grid = s.rounds
    .slice(0, 8)
    .map((r) => r.map((x) => RESULT_EMOJI[x]).join(''))
    .join('\n');
  return [
    `VIRTUABOX 🥊 ${fmt(s.score)} pts — ${s.rank}`,
    `${HEADLINES[s.reason]} · KOs ${s.kos}/3 · best combo x${s.bestCombo}`,
    grid,
    playUrl(),
  ].join('\n');
}

const FONT = '"Press Start 2P", monospace';
const COLORS = { win: '#58f858', lose: '#e82818', trade: '#f8d830', clash: '#40c8f8' };

/** Pixel-font text with a hard black outline (and optional extrusion). */
function pixelText(g, text, x, y, size, color, { outline = size / 8, extrude = null } = {}) {
  g.font = `${size}px ${FONT}`;
  g.fillStyle = '#000';
  const o = outline;
  for (const [dx, dy] of [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o], [o, o * 2], [0, o * 2]]) {
    g.fillText(text, x + dx, y + dy + (extrude ? o : 0));
  }
  if (extrude) {
    g.fillStyle = extrude;
    g.fillText(text, x, y + o);
  }
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/** SNES-style window: blue gradient, white rule, black edges. */
function snesWindow(g, x, y, w, h) {
  const bg = g.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, '#2828a8');
  bg.addColorStop(1, '#080850');
  g.fillStyle = '#000';
  g.fillRect(x - 8, y - 8, w + 16, h + 16);
  g.fillStyle = '#f8f8f8';
  g.fillRect(x - 4, y - 4, w + 8, h + 8);
  g.fillStyle = '#000';
  g.fillRect(x, y, w, h);
  g.fillStyle = bg;
  g.fillRect(x + 4, y + 4, w - 8, h - 8);
}

/** 1080x1352 card: everything sits on a 4px grid so the pixel font stays crisp. */
export function renderCard(s, capture) {
  const W = 1080;
  const H = 1352;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#06061a';
  for (let y = 0; y < H; y += 8) g.fillRect(0, y, W, 4);
  // rope stripes
  [['#e82818', 0], ['#f8f8f8', 8], ['#2858f0', 16]].forEach(([col, dy]) => {
    g.fillStyle = col;
    g.fillRect(0, 16 + dy, W, 8);
    g.fillRect(0, H - 48 + dy, W, 8);
  });

  pixelText(g, 'VIRTUABOX', W / 2, 136, 64, '#f8d830', { extrude: '#e82818' });

  // KO highlight, nearest-neighbour upscaled
  const fx = 64;
  const fy = 184;
  const fw = W - 128;
  const fh = 560;
  snesWindow(g, fx, fy, fw, fh);
  const ix = fx + 12;
  const iy = fy + 12;
  const iw = fw - 24;
  const ih = fh - 24;
  if (capture && capture.width > 0) {
    const sr = capture.width / capture.height;
    const dr = iw / ih;
    let sw = capture.width;
    let sh = capture.height;
    let sx = 0;
    let sy = 0;
    if (sr > dr) { sw = sh * dr; sx = (capture.width - sw) / 2; } else { sh = sw / dr; sy = (capture.height - sh) * 0.35; }
    g.drawImage(capture, sx, sy, sw, sh, ix, iy, iw, ih);
  }
  const headColor = s.reason === 'champ' ? '#f8d830' : s.reason === 'ko' ? '#e82818' : '#40c8f8';
  pixelText(g, HEADLINES[s.reason], W / 2, fy + fh - 44, 48, headColor);

  // score window
  snesWindow(g, 64, 800, W - 128, 424);
  pixelText(g, 'SCORE', W / 2, 872, 24, '#a0a0c0', { outline: 0 });
  pixelText(g, fmt(s.score), W / 2, 976, 80, '#f8f8f8', { outline: 8 });
  pixelText(g, s.rank, W / 2, 1036, 24, '#58f858');

  const stats = [['KOs', `${s.kos}/3`], ['HITS', String(s.hits)], ['BEST', `x${s.bestCombo}`], ['WIN%', `${s.winPct}`]];
  const bw = 208;
  const gap = 16;
  const bx0 = (W - (bw * 4 + gap * 3)) / 2;
  stats.forEach(([label, val], i) => {
    const x = bx0 + i * (bw + gap);
    g.fillStyle = '#3838b8';
    g.fillRect(x, 1068, bw, 104);
    g.fillStyle = '#000';
    g.fillRect(x + 4, 1072, bw - 8, 96);
    pixelText(g, val, x + bw / 2, 1120, 32, '#f8f8f8', { outline: 0 });
    pixelText(g, label, x + bw / 2, 1152, 16, '#a0a0c0', { outline: 0 });
  });

  // exchange grid
  const rounds = s.rounds.slice(0, 16);
  const cell = 20;
  const cg = 4;
  const groupW = cell * 4 + cg * 3;
  const perRow = 8;
  const colGap = 16;
  rounds.forEach((r, ri) => {
    const row = Math.floor(ri / perRow);
    const col = ri % perRow;
    const inRow = Math.min(perRow, rounds.length - row * perRow);
    const totalW = inRow * groupW + (inRow - 1) * colGap;
    const x0 = Math.round((W - totalW) / 2 / 4) * 4 + col * (groupW + colGap);
    const y0 = 1240 + row * (cell + 8);
    r.forEach((res, k) => {
      g.fillStyle = COLORS[res];
      g.fillRect(x0 + k * (cell + cg), y0, cell, cell);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x0 + k * (cell + cg) + cell - 4, y0 + 4, 4, cell - 4);
      g.fillRect(x0 + k * (cell + cg) + 4, y0 + cell - 4, cell - 4, 4);
    });
  });

  const host = playUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
  pixelText(g, host.toUpperCase(), W / 2, H - 64, 16, '#a0a0c0', { outline: 0 });
  return c;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Returns 'shared' | 'aborted' | 'fallback'. */
export async function systemShare(blob, text) {
  try {
    const file = new File([blob], 'virtuabox-score.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text, title: 'VIRTUABOX' });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'aborted';
  }
  return 'fallback';
}
