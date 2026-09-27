// Score card: a 1080x1350 PNG with the fight's highlight frame, the score,
// and a Wordle-style grid of every exchange.

const RESULT_COLORS = { win: '#3dff72', lose: '#ff3355', trade: '#ffe53d', clash: '#22e5ff' };
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

function glowText(g, text, x, y, font, color, blur = 28, core = '#ffffff') {
  g.font = font;
  g.shadowColor = color;
  g.shadowBlur = blur;
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.shadowBlur = blur / 3;
  g.fillStyle = core;
  g.globalAlpha = 0.85;
  g.fillText(text, x, y);
  g.globalAlpha = 1;
  g.shadowBlur = 0;
}

export function renderCard(s, capture) {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // backdrop
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#12002a');
  bg.addColorStop(0.55, '#05010c');
  bg.addColorStop(1, '#1a0030');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(176, 38, 255, 0.18)';
  g.lineWidth = 2;
  for (let x = 0; x <= W; x += 54) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 54) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  glowText(g, 'VIRTUABOX', W / 2, 118, 'italic 900 104px Orbitron, "Arial Black", sans-serif', '#ff2bd6', 36);

  // highlight frame
  const fx = 60;
  const fy = 160;
  const fw = W - 120;
  const fh = 560;
  g.save();
  g.beginPath();
  g.roundRect(fx, fy, fw, fh, 26);
  g.clip();
  g.fillStyle = '#000';
  g.fillRect(fx, fy, fw, fh);
  if (capture && capture.width > 0) {
    const sr = capture.width / capture.height;
    const dr = fw / fh;
    let sw = capture.width;
    let sh = capture.height;
    let sx = 0;
    let sy = 0;
    if (sr > dr) { sw = sh * dr; sx = (capture.width - sw) / 2; } else { sh = sw / dr; sy = (capture.height - sh) * 0.3; }
    g.drawImage(capture, sx, sy, sw, sh, fx, fy, fw, fh);
  }
  const shade = g.createLinearGradient(0, fy + fh - 170, 0, fy + fh);
  shade.addColorStop(0, 'rgba(5,1,12,0)');
  shade.addColorStop(1, 'rgba(5,1,12,0.92)');
  g.fillStyle = shade;
  g.fillRect(fx, fy, fw, fh);
  g.restore();
  g.save();
  g.shadowColor = '#3dff72';
  g.shadowBlur = 30;
  g.strokeStyle = '#3dff72';
  g.lineWidth = 6;
  g.beginPath();
  g.roundRect(fx, fy, fw, fh, 26);
  g.stroke();
  g.restore();

  const headColor = s.reason === 'champ' ? '#ffe53d' : s.reason === 'ko' ? '#ff3355' : '#22e5ff';
  glowText(g, HEADLINES[s.reason], W / 2, fy + fh - 34, 'italic 900 78px Orbitron, "Arial Black", sans-serif', headColor, 30);

  // score
  g.font = '700 30px "Chakra Petch", sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fillText('SCORE', W / 2, fy + fh + 64);
  glowText(g, fmt(s.score), W / 2, fy + fh + 184, '900 132px Orbitron, "Arial Black", sans-serif', '#ffe53d', 34, '#fff6c0');
  g.font = '700 40px "Chakra Petch", sans-serif';
  g.fillStyle = '#3dff72';
  g.shadowColor = '#3dff72';
  g.shadowBlur = 16;
  g.fillText(s.rank, W / 2, fy + fh + 240);
  g.shadowBlur = 0;

  // stats
  const stats = [
    ['KOs', `${s.kos}/3`],
    ['HITS', String(s.hits)],
    ['BEST', `x${s.bestCombo}`],
    ['WIN %', `${s.winPct}`],
  ];
  const sy = fy + fh + 290;
  const bw = 222;
  const gap = 20;
  const sx0 = (W - (bw * 4 + gap * 3)) / 2;
  stats.forEach(([label, val], i) => {
    const x = sx0 + i * (bw + gap);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.strokeStyle = 'rgba(61,255,114,0.45)';
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x, sy, bw, 116, 16);
    g.fill();
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = '900 50px Orbitron, "Arial Black", sans-serif';
    g.fillText(val, x + bw / 2, sy + 62);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '700 24px "Chakra Petch", sans-serif';
    g.fillText(label, x + bw / 2, sy + 98);
  });

  // exchange grid
  const rounds = s.rounds.slice(0, 15);
  const cell = 22;
  const cg = 5;
  const groupW = cell * 4 + cg * 3;
  const perRow = 5;
  const rowGap = 12;
  const colGap = 30;
  const gy = sy + 150;
  const rowsN = Math.ceil(rounds.length / perRow);
  rounds.forEach((r, ri) => {
    const row = Math.floor(ri / perRow);
    const col = ri % perRow;
    const inRow = Math.min(perRow, rounds.length - row * perRow);
    const totalW = inRow * groupW + (inRow - 1) * colGap;
    const x0 = (W - totalW) / 2 + col * (groupW + colGap);
    const y0 = gy + row * (cell + rowGap);
    r.forEach((res, k) => {
      g.fillStyle = RESULT_COLORS[res];
      g.shadowColor = RESULT_COLORS[res];
      g.shadowBlur = 10;
      g.beginPath();
      g.roundRect(x0 + k * (cell + cg), y0, cell, cell, 5);
      g.fill();
    });
  });
  g.shadowBlur = 0;

  // footer
  const fy2 = Math.max(gy + rowsN * (cell + rowGap) + 50, H - 60);
  g.font = '700 30px "Chakra Petch", sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.fillText(`4 PUNCHES · 2 MINUTES · ${playUrl().replace(/^https?:\/\//, '').replace(/\/$/, '')}`, W / 2, Math.min(fy2, H - 34));
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
