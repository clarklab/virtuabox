import * as THREE from './vendor/three.js';

// All venue colors live here; Stage applies them together when a bout changes.
export const VENUE_CONFIG = {
  pete: {
    name: 'BIT CITY GYM', label: 'NEIGHBORHOOD CIRCUIT',
    top: '#10151d', horizon: '#594039', fog: '#29252d', floor: '#3b3540',
    skyLight: '#f6ddbd', groundLight: '#282a38', keyLight: '#fff0dc',
    canvas: '#87939f', fleck: '#7f8a95', border: '#344a59', accent: '#e3ad79', mark: '#627788',
    ropes: ['#c75951', '#e4dfd3', '#517688'], beam: '#ffe0b9', bulb: '#e6c79c',
  },
  nova: {
    name: 'NEON BAY ROOFTOP', label: 'SKYLINE SHOWDOWN',
    top: '#111b44', horizon: '#b9587b', fog: '#282746', floor: '#20354a',
    skyLight: '#c8e6ff', groundLight: '#282643', keyLight: '#fff1ef',
    canvas: '#7e9bae', fleck: '#7491a5', border: '#294c66', accent: '#62d6d3', mark: '#53758e',
    ropes: ['#d773a0', '#d1e9e8', '#54b6c9'], beam: '#83d5e2', bulb: '#88d9da',
  },
  volt: {
    name: 'VOLTAGE DOME', label: 'WORLD CHAMPIONSHIP',
    top: '#070c20', horizon: '#22294d', fog: '#101a32', floor: '#18263d',
    skyLight: '#d6e1ff', groundLight: '#2a2740', keyLight: '#fff7e6',
    canvas: '#8895b0', fleck: '#7e8aa5', border: '#2b405e', accent: '#dfbd75', mark: '#5f7393',
    ropes: ['#c95d67', '#e9dfc8', '#697daf'], beam: '#b9cfff', bulb: '#e7cc96',
  },
  gym: {
    name: 'POPS TRAINING GYM', label: 'LEARN THE ROPES',
    top: '#171d24', horizon: '#604936', fog: '#302c2e', floor: '#463d36',
    skyLight: '#f3debd', groundLight: '#34312e', keyLight: '#fff0d6',
    canvas: '#a29c87', fleck: '#96907a', border: '#50605e', accent: '#e2bd82', mark: '#7b806d',
    ropes: ['#bb725d', '#e1ddca', '#6d858b'], beam: '#ffe4b4', bulb: '#ebcda5',
  },
};

const FONT = '"Press Start 2P", monospace';
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const transform = new THREE.Mesh();
const point = new THREE.Vector3();
const normal = new THREE.Vector3();

/** Static architecture is merged into one vertex-colored draw per venue. */
class Batch {
  constructor(group) { this.group = group; this.positions = []; this.colors = []; }
  geometry(geo, x, y, z, sx, sy, sz, hex, rx = 0, ry = 0, rz = 0) {
    transform.position.set(x, y, z); transform.scale.set(sx, sy, sz);
    transform.rotation.set(rx, ry, rz); transform.updateMatrix();
    const tint = new THREE.Color(hex), p = geo.attributes.position, n = geo.attributes.normal;
    const index = geo.index, count = index ? index.count : p.count;
    for (let i = 0; i < count; i++) {
      const j = index ? index.getX(i) : i;
      point.fromBufferAttribute(p, j).applyMatrix4(transform.matrix);
      normal.fromBufferAttribute(n, j).transformDirection(transform.matrix);
      const shade = 0.66 + Math.max(0, normal.y) * 0.26 + Math.max(0, normal.z) * 0.1;
      this.positions.push(point.x, point.y, point.z);
      this.colors.push(tint.r * shade, tint.g * shade, tint.b * shade);
    }
  }
  box(x, y, z, w, h, d, color, rx = 0, ry = 0, rz = 0) {
    this.geometry(unitBox, x, y, z, w, h, d, color, rx, ry, rz);
  }
  cylinder(x, y, z, rt, rb, h, color, segments = 8) {
    const geo = new THREE.CylinderGeometry(rt, rb, h, segments);
    this.geometry(geo, x, y, z, 1, 1, 1, color); geo.dispose();
  }
  finish() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.colors), 3));
    geo.computeBoundingSphere();
    this.group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true })));
    this.positions = this.colors = null;
  }
}

function texture(w, h, paint) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; paint(ctx);
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  return tex;
}

function sign(group, x, y, z, w, h, title, sub, accent, bg = '#152332') {
  const map = texture(512, 128, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = accent; g.lineWidth = 4; g.strokeRect(7, 7, 498, 114);
    g.fillStyle = accent; g.font = `24px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(title, 256, 47, 474);
    g.font = `12px ${FONT}`; g.fillStyle = '#b9c4cd'; g.fillText(sub, 256, 89, 459);
    for (let i = 0; i < 4; i++) { g.fillStyle = accent; g.fillRect(24 + i * 146, 112, 20, 4); }
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map }));
  mesh.position.set(x, y, z); group.add(mesh); return mesh;
}

let bricks;
function wall(group, x, y, z, w, h, ry = 0) {
  bricks ||= texture(512, 256, (g) => {
    g.fillStyle = '#3d3037'; g.fillRect(0, 0, 512, 256);
    for (let row = 0; row < 16; row++) for (let col = -1; col < 16; col++) {
      g.fillStyle = ['#614b49', '#6b504c', '#594648', '#72564e'][(col + 17 + row * 3) % 4];
      g.fillRect(col * 36 + (row % 2) * 18, row * 16, 33, 13);
    }
    g.fillStyle = '#31353e'; g.fillRect(0, 176, 512, 80);
    g.fillStyle = '#817366'; g.fillRect(0, 174, 512, 4);
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: bricks }));
  mesh.position.set(x, y, z); mesh.rotation.y = ry; group.add(mesh);
}

function hall(training = false) {
  const group = new THREE.Group(), b = new Batch(group);
  const steel = '#465461', pale = '#b9b8aa', wood = '#b38c68';
  wall(group, 0, 2.75, -7.6, 18, 6.7);
  wall(group, -9, 2.75, 0, 16, 6.7, Math.PI / 2);
  wall(group, 9, 2.75, 0, 16, 6.7, -Math.PI / 2);
  for (const x of [-8, -4, 4, 8]) {
    b.box(x, 2.6, -7.4, 0.16, 6.3, 0.21, steel);
    b.box(x, 5.4, -0.7, 0.18, 0.3, 14, steel);
  }
  for (const z of [-5.7, -1, 4]) {
    b.box(0, 5.4, z, 17, 0.23, 0.21, steel);
    for (const side of [-1, 1]) {
      b.box(side * 6.1, 4.65, z, 0.16, 2.2, 0.16, steel, 0, 0, side * 0.7);
      b.box(side * 3.6, 4.95, z, 1.65, 0.16, 0.45, '#303b46');
      b.box(side * 3.6, 4.85, z, 1.48, 0.035, 0.32, '#ded7bf');
    }
  }
  for (const x of [-5.9, 5.9]) {
    b.box(x, 3.25, -7.42, 2.5, 2.3, 0.12, '#263744');
    b.box(x, 3.25, -7.33, 2.3, 2.1, 0.055, '#7d9696');
    for (const dx of [-1.16, 0, 1.16]) b.box(x + dx, 3.25, -7.27, 0.065, 2.2, 0.06, steel);
    for (const y of [2.18, 3.25, 4.32]) b.box(x, y, -7.26, 2.4, 0.065, 0.07, steel);
    b.box(x, -0.02, -5.2, 2.4, 0.16, 0.5, wood);
    for (const dx of [-0.9, 0.9]) b.box(x + dx, -0.33, -5.2, 0.13, 0.57, 0.4, steel);
    for (let i = 0; i < 3; i++) {
      b.box(x + (i - 1) * 0.63, 0.6, -7, 0.6, 2.35, 0.68, i % 2 ? '#526872' : '#617780');
      b.box(x + (i - 1) * 0.63 + 0.18, 0.6, -6.645, 0.055, 0.22, 0.045, pale);
      for (let v = 0; v < 3; v++) b.box(x + (i - 1) * 0.63, 1.25 + v * 0.09, -6.645, 0.37, 0.024, 0.025, '#35414a');
    }
  }
  b.box(0, 1, -7.35, 2.1, 3.15, 0.15, '#242d37');
  b.box(0, 2.65, -7.3, 2.35, 0.18, 0.2, '#a39076');
  b.box(0, -0.54, -4.5, 3.6, 0.04, 2.4, '#4b535a');
  if (!training) {
    for (const x of [-5.1, 5.1]) {
      b.cylinder(x, 4.08, -3.2, 0.018, 0.018, 1.7, '#919b9b', 5);
      b.cylinder(x, 2.55, -3.2, 0.3, 0.3, 1.36, x < 0 ? '#a94d4f' : '#526f82', 10);
      b.cylinder(x, 3.22, -3.2, 0.23, 0.29, 0.14, '#293540', 10);
      b.cylinder(x, 2.48, -3.2, 0.307, 0.307, 0.13, '#bbae9a', 10);
    }
    for (let i = 0; i < 12; i++) {
      const side = i < 6 ? -1 : 1, z = -4.9 + (i % 6) * 0.78;
      b.box(side * 6.5, 0.29, z, 0.3, 0.47, 0.31, ['#8e5e65', '#647c8d', '#9a855f'][i % 3]);
      b.box(side * 6.5, 0.67, z, 0.22, 0.25, 0.23, ['#c29a7a', '#94725d'][i % 2]);
    }
    sign(group, 0, 2.5, -7.18, 6.5, 1.16, 'BIT CITY GYM', 'EST. 1987 / LOCAL FIGHT NIGHT', '#d6ae7c', '#25333d');
    sign(group, -3.1, 1.45, -7.16, 1.25, 1.35, '8 BIT', 'HEART', '#c99277', '#303c48');
    sign(group, 3.1, 1.45, -7.16, 1.25, 1.35, 'NO', 'QUIT', '#d1c4a0', '#554449');
  }
  for (let i = 0; i < 3; i++) b.box(-3.05 - i * 0.26, -0.09 - i * 0.18, 1.2, 0.44, 0.19, 0.85, steel);
  b.finish(); return group;
}

function rooftop() {
  const group = new THREE.Group(), b = new Batch(group);
  b.box(0, -0.75, 0, 18, 0.3, 17, '#243c50');
  b.box(0, -0.6, -8, 18, 0.42, 0.36, '#344b64');
  for (const x of [-8.6, 8.6]) b.box(x, -0.6, 0, 0.36, 0.42, 16, '#344b64');
  for (let i = 0; i < 19; i++) {
    const x = -24 + i * 2.65, h = 3 + ((i * 7) % 11) * 0.68, z = -21 - (i % 3) * 3;
    const width = 1.9 + (i % 3) * 0.35;
    b.box(x, h / 2 - 2.5, z, width, h, 2.5, ['#25375c', '#302f51', '#213750'][i % 3]);
    b.box(x, h - 2.43, z, width + 0.13, 0.15, 2.7, '#44536f');
    if (i % 4 === 1) b.box(x, h - 1.8, z, 0.05, 1.4, 0.05, '#88a4be');
    for (let floor = 0; floor < Math.floor(h / 0.6); floor++) for (let col = 0; col < 3; col++) {
      if ((i * 3 + floor * 7 + col) % 5 === 0) continue;
      b.box(x + (col - 1) * 0.48, -1.95 + floor * 0.56, z + 1.262, 0.19, 0.23, 0.025, (floor + i) % 3 ? '#b89399' : '#74b4c0');
    }
  }
  const sun = new THREE.SphereGeometry(2.6, 24, 16);
  b.geometry(sun, -7, 5.8, -30, 1, 1, 0.035, '#f1a57d'); sun.dispose();
  for (let i = 0; i < 5; i++) b.box(-7, 3.5 + i * 0.32, -29.82, 5.3, 0.09 + i * 0.012, 0.03, '#6f4e73');
  for (const x of [-7.7, 7.7]) {
    for (let i = 0; i < 8; i++) b.box(x, 0.25, -6 + i * 1.6, 0.055, 1.5, 0.055, '#597993');
    b.box(x, 0.97, 0, 0.075, 0.075, 15, '#7193aa');
    b.box(x, 0.15, 0, 0.055, 0.045, 15, '#597993');
    b.box(x, -0.44, 0, 0.055, 0.055, 15, '#65bdbd');
  }
  for (let i = 0; i < 11; i++) b.box(-7.7 + i * 1.54, 0.25, -7.4, 0.055, 1.5, 0.055, '#597993');
  b.box(0, 0.97, -7.4, 15.5, 0.075, 0.075, '#76a0b3');
  for (const x of [-5.8, 5.8]) {
    b.box(x, 0.05, -4.5, 1.6, 1.2, 1.55, '#465d72');
    b.box(x, 0.72, -4.5, 1.68, 0.12, 1.64, '#6b7c89');
    for (let v = 0; v < 7; v++) b.box(x - 0.57 + v * 0.19, 0.1, -3.71, 0.06, 0.67, 0.04, '#223b50');
    b.cylinder(x, 1.15, -5, 0.13, 0.13, 0.9, '#526579');
    b.box(x, 2.35, -6.8, 0.06, 5.6, 0.06, '#758ba6');
    b.box(x, 4.2, -6.8, 2.1, 0.08, 0.08, '#6aaaba');
    for (let lamp = 0; lamp < 5; lamp++) b.box(x - 0.9 + lamp * 0.45, 4.09, -6.8, 0.11, 0.17, 0.11, lamp % 2 ? '#e7aab0' : '#91d4d2');
  }
  for (const x of [-4.4, 4.4]) {
    b.box(x, 2.4, -7.1, 0.19, 5.7, 0.19, '#23394e');
    b.box(x, 2.4, -6.98, 0.08, 5.6, 0.035, x < 0 ? '#ce789d' : '#72c8c6');
  }
  sign(group, 0, 2.45, -8, 7.5, 1.16, 'NEON BAY', 'ROOFTOP / AFTER HOURS', '#74d5d1', '#253049');
  sign(group, 9, 5.5, -18, 2.1, 4, 'NOVA', 'CITY', '#d18ca7', '#3e3859');
  b.finish(); return group;
}

function dome() {
  const group = new THREE.Group(), b = new Batch(group);
  for (const side of [-1, 1]) {
    const x = side * 5.7;
    for (const dx of [-0.32, 0.32]) b.box(x + dx, 2.95, -5.8, 0.11, 7.1, 0.11, '#526c8d');
    for (let tier = 0; tier < 7; tier++) {
      b.box(x, -0.25 + tier * 1.04, -5.8, 0.72, 0.08, 0.12, '#6985a0');
      b.box(x, 0.23 + tier * 1.04, -5.8, 0.07, 1.1, 0.07, '#485f7c', 0, 0, tier % 2 ? 0.6 : -0.6);
    }
    b.box(x + side * 0.5, 2.9, -5.7, 0.13, 6.4, 0.16, '#ab925f');
    b.box(x + side * 0.5, 2.9, -5.6, 0.075, 6.2, 0.03, '#ddbb79');
    b.box(side * 7.5, 3, -9.1, 1.9, 4.7, 0.16, '#3e4978');
    b.box(side * 7.5, 5.4, -8.95, 2.2, 0.12, 0.17, '#b69e6c');
    for (let i = 0; i < 3; i++) b.box(side * 7.5, 2.1 + i * 0.7, -8.96, 0.54, 0.16, 0.035, '#d1b473', 0, 0, -0.45);
    sign(group, side * 7.5, 4.36, -8.9, 1.7, 0.95, 'WVBA', 'CHAMP', '#d1b578', '#3e4978');
    b.box(side * 4.3, -0.04, -3.9, 1.5, 0.23, 1, '#344866');
    b.box(side * 4.3, 0.21, -3.97, 0.9, 0.4, 0.11, '#163649', -0.18);
    b.box(side * 4.3, 0.21, -3.89, 0.76, 0.27, 0.02, '#66929e', -0.18);
    for (const dx of [-0.5, 0.5]) b.box(side * 4.3 + dx, -0.33, -3.9, 0.1, 0.5, 0.68, '#273751');
  }
  b.box(-5, -0.03, -1.5, 1.1, 1.1, 1.1, '#354d69');
  b.box(-5, 0.57, -1.5, 1.2, 0.12, 1.2, '#ceb87f');
  b.cylinder(-5, 0.74, -1.5, 0.35, 0.4, 0.23, '#9d8046');
  b.cylinder(-5, 1.05, -1.5, 0.1, 0.18, 0.45, '#d9b568');
  b.cylinder(-5, 1.57, -1.5, 0.55, 0.15, 0.65, '#e7c57d', 12);
  b.cylinder(-5, 1.91, -1.5, 0.57, 0.57, 0.09, '#eed69b', 12);
  for (const side of [-1, 1]) {
    b.box(-5 + side * 0.65, 1.53, -1.5, 0.12, 0.59, 0.14, '#c29b59', 0, 0, side * 0.25);
    b.box(-5 + side * 0.5, 1.24, -1.5, 0.35, 0.1, 0.14, '#c29b59');
  }
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    b.box(Math.sin(a) * 10.8, 3.6, Math.cos(a) * 10.8, 2.35, 0.22, 0.08, i % 3 ? '#516697' : '#b09b66', 0, a);
    b.box(Math.sin(a) * 12.6, 6.8, Math.cos(a) * 12.6, 2.7, 0.1, 0.08, '#668db1', 0, a);
  }
  sign(group, 0, 2.45, -8.5, 7.2, 1.16, 'VOLTAGE DOME', 'WORLD CHAMPIONSHIP / MAIN EVENT', '#d6bb7d', '#182c46');
  b.finish(); return group;
}

export function buildVenues(scene) {
  const groups = { pete: hall(), nova: rooftop(), volt: dome(), gym: hall(true) };
  for (const [key, group] of Object.entries(groups)) {
    group.name = `venue-${key}`; group.visible = false; scene.add(group);
  }
  return groups;
}
