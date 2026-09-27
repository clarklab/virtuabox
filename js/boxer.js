import * as THREE from './vendor/three.js';
import { JAB, HOOK, UPPER, BODY, MOVES } from './rules.js';

const { Vector3, Group, Mesh, Matrix4, Color } = THREE;

const UP = new Vector3(0, 1, 0);
const _m = new Matrix4();
const _mi = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _w = new Vector3();
const _pole = new Vector3();
const FLASH_WHITE = new Color(1, 1, 1);

// ---------------------------------------------------------------------------
// Pixel-crisp line + outline materials. Widths are in drawing-buffer pixels
// (one "game pixel" after upscaling), so the stage updates them on resize.
export const LINE_MATERIALS = new Set();
const lineRes = { w: 1, h: 1, dpr: 1 };
const OUTLINE_RES = new THREE.Vector2(1, 1);

export function pixelLine(color, cssWidth, extra = {}) {
  const mat = new THREE.LineMaterial({ color: new Color(color), linewidth: cssWidth, ...extra });
  // An edge pointing straight down the view axis has a zero-length screen
  // direction; normalize() would yield NaN vertices.
  mat.vertexShader = mat.vertexShader.replace(
    'dir = normalize( dir );',
    'dir = dot( dir, dir ) > 1e-14 ? normalize( dir ) : vec2( 1.0, 0.0 );',
  );
  mat.userData.cssWidth = cssWidth;
  mat.resolution.set(lineRes.w, lineRes.h);
  mat.linewidth = cssWidth * lineRes.dpr;
  LINE_MATERIALS.add(mat);
  return mat;
}

export function setLineResolution(w, h, dpr) {
  Object.assign(lineRes, { w, h, dpr });
  OUTLINE_RES.set(w, h);
  for (const m of LINE_MATERIALS) {
    m.resolution.set(w, h);
    m.linewidth = m.userData.cssWidth * dpr;
  }
}

/** Quad-edge wireframe (drops the triangle diagonals of flat quads). */
export function edgeLines(geo, threshold = 1) {
  const edges = new THREE.EdgesGeometry(geo, threshold);
  const lines = new THREE.LineSegmentsGeometry().fromEdgesGeometry(edges);
  edges.dispose();
  return lines;
}

/**
 * Inverted-hull outline with a constant on-screen thickness in pixels: back
 * faces pushed out along their screen-space normal. Sprite-style ink lines.
 */
export function outlineMaterial(color, px, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new Color(color) }, uPx: { value: px }, uRes: { value: OUTLINE_RES } },
    vertexShader: /* glsl */ `
      uniform float uPx; uniform vec2 uRes;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 dir = (projectionMatrix * vec4(normalize(normalMatrix * normal), 0.0)).xy;
        float l = length(dir);
        if (l > 1e-5) clip.xy += dir / l * (uPx * 2.0 / uRes) * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.BackSide,
    ...extra,
  });
}

// 3-step cel ramp shared by every toon material
let toonRamp = null;
function ramp() {
  if (!toonRamp) {
    toonRamp = new THREE.DataTexture(new Uint8Array([95, 175, 255]), 3, 1, THREE.RedFormat);
    toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

// ---------------------------------------------------------------------------
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeOut3 = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

function bezier(out, p0, p1, p2, t) {
  const u = 1 - t;
  return out.set(
    u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
  );
}

// Punch timing (seconds). IMPACT is shared with the game loop.
export const IMPACT = 0.25;
const WINDUP = 0.085;
const HOLD = 0.07;
const RETRACT = 0.26;

const PUNCH_STYLE = {
  [JAB]: { windup: [0, -0.02, -0.09], bend: [0, 0.02, 0], twist: 0.3, lean: 0.12, crouch: 0, flare: 0.05, step: 0.07 },
  [HOOK]: { windup: [0.16, 0.02, -0.06], bend: [0.42, 0.06, 0.05], twist: 0.65, lean: 0.1, crouch: 0.02, flare: 1, step: 0.05 },
  [UPPER]: { windup: [0.04, -0.22, -0.02], bend: [0.05, -0.32, 0], twist: 0.35, lean: 0.02, crouch: -0.05, flare: -0.35, step: 0.06 },
  [BODY]: { windup: [0.05, -0.12, -0.06], bend: [0.16, -0.08, 0], twist: 0.35, lean: 0.36, crouch: 0.16, flare: 0.1, step: 0.09 },
};

// ---------------------------------------------------------------------------
const PLAYER_GREEN = '#58f858';
const PLAYER_INNER = '#10702a';

export class Boxer {
  /**
   * @param {object} o
   * @param {string} o.color  accent color (UI)
   * @param {boolean} o.ghost  the player: see-through green outline + wireframe
   * @param {object} o.look   toon colors { skin, trunks, gloves, hair, boots }
   */
  constructor(o) {
    this.o = o;
    const ghost = (this.isPlayer = !!o.ghost);
    this.color = new Color(o.color);
    const bulk = o.bulk ?? 1;
    const tall = o.tall ?? 1;
    this.bulk = bulk;
    this.materials = [];
    this.geometries = [];
    this.flash = 0;

    if (ghost) {
      // Depth-only prepass hides the far side of the wireframe while the
      // opponent stays visible through the body, Super Punch-Out style.
      this.fillMat = this.#track(new THREE.MeshBasicMaterial({
        colorWrite: false, transparent: true, depthWrite: true,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
      }));
      this.hullMat = this.#track(outlineMaterial(PLAYER_GREEN, 2, { transparent: true, depthWrite: false }));
      this.lineCol = new Color(PLAYER_INNER);
      this.lineMat = this.#track(pixelLine(this.lineCol.clone(), 1, { fog: false, transparent: true }));
      this.gloveLineMat = this.#track(pixelLine('#30c040', 1, { fog: false, transparent: true }));
    } else {
      const look = o.look || {};
      const toon = (hex) => this.#track(new THREE.MeshToonMaterial({ color: new Color(hex), gradientMap: ramp() }));
      this.toon = {
        skin: toon(look.skin || '#f0b080'),
        trunks: toon(look.trunks || o.color),
        band: toon('#f8f8f8'),
        gloves: toon(look.gloves || '#e02020'),
        boots: toon(look.boots || '#f0f0f0'),
        hair: toon(look.hair || '#202020'),
        gold: toon('#f8d030'),
        dark: toon('#181818'),
      };
      this.hullMat = this.#track(outlineMaterial('#000000', 1.1));
    }
    this.eyeMat = this.#track(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
    this.inkMat = this.#track(new THREE.MeshBasicMaterial({ color: 0x080808, fog: false }));

    // wireframe reads best low-poly; toon shading wants rounder shapes
    const cyl = (rt, rb, h, seg, hs = 1, t0 = 0) => new THREE.CylinderGeometry(rt, rb, h, ghost ? seg : seg + 6, hs, ghost, t0);
    const sph = (r, ws, hs) => new THREE.SphereGeometry(r, ghost ? ws : ws + 6, ghost ? hs : hs + 4);

    // ---- hierarchy -------------------------------------------------------
    this.root = new Group();
    this.rig = new Group();
    this.root.add(this.rig);
    this.hips = new Group();
    this.rig.add(this.hips);
    this.torso = new Group();
    this.torso.rotation.order = 'YXZ';
    this.hips.add(this.torso);
    this.head = new Group();
    this.torso.add(this.head);

    const D = (this.D = {
      hipY: 0.96 * tall,
      thigh: 0.47 * tall,
      shin: 0.47 * tall,
      ankleY: 0.075,
      upper: 0.29 * tall,
      fore: 0.28 * tall,
      shoulderY: 0.45 * tall,
      shoulderX: 0.225 * bulk,
      headY: 0.66 * tall,
      gloveR: 0.108 * Math.sqrt(bulk),
      gloveOffset: 0.085,
    });

    // torso: lathe, flattened front-to-back
    const prof = [
      [0.145, -0.02], [0.155, 0.1], [0.185, 0.24], [0.225, 0.36], [0.235, 0.44], [0.19, 0.52], [0.08, 0.565],
    ].map(([r, y]) => new THREE.Vector2(r, y * tall));
    const torsoGeo = new THREE.LatheGeometry(prof, ghost ? 8 : 16, Math.PI / 8);
    torsoGeo.scale(bulk, 1, 0.7 * bulk);
    this.#part(torsoGeo, this.torso, 'skin');

    const neckGeo = cyl(0.055, 0.065, 0.12, 6);
    neckGeo.translate(0, 0.58 * tall, 0);
    this.#part(neckGeo, this.torso, 'skin');

    // head
    this.head.position.y = D.headY;
    const headGeo = sph(0.115, 8, 6);
    headGeo.scale(0.92, 1.12, 1.0);
    this.#part(headGeo, this.head, 'skin');
    const jawGeo = new THREE.BoxGeometry(0.13, 0.05, 0.1);
    jawGeo.translate(0, -0.085, 0.03);
    this.#part(jawGeo, this.head, 'skin');
    this.#hair(o.hair);
    if (!ghost) this.#face();
    else {
      const bandGeo = cyl(0.1, 0.1, 0.03, 8);
      bandGeo.translate(0, 0.045, 0);
      this.#part(bandGeo, this.head, 'gloves');
    }

    // trunks + waistband (+ title belt)
    const shortsGeo = cyl(0.19 * bulk, 0.205 * bulk, 0.27, 8, 2, Math.PI / 8);
    shortsGeo.scale(1, 1, 0.8);
    shortsGeo.translate(0, -0.1, 0);
    this.#part(shortsGeo, this.hips, 'trunks');
    const bandGeo = cyl(0.182 * bulk, 0.195 * bulk, 0.06, 8, 1, Math.PI / 8);
    bandGeo.scale(1, 1, 0.8);
    bandGeo.translate(0, 0.02, 0);
    this.#part(bandGeo, this.hips, o.belt ? 'gold' : 'band');
    if (o.belt) {
      const plateGeo = new THREE.BoxGeometry(0.16, 0.11, 0.03);
      plateGeo.translate(0, 0.02, 0.16 * bulk);
      this.#part(plateGeo, this.hips, 'gold');
    }

    // arms
    this.arms = [1, -1].map((side) => {
      const upperGeo = cyl(0.066 * bulk, 0.056 * bulk, D.upper, 6);
      upperGeo.translate(0, D.upper / 2, 0);
      const foreGeo = cyl(0.056 * bulk, 0.046 * bulk, D.fore, 6);
      foreGeo.translate(0, D.fore / 2, 0);
      const gloveGeo = sph(D.gloveR, 8, 6);
      gloveGeo.scale(1, 1.22, 1.05);
      gloveGeo.translate(0, D.gloveOffset, 0);
      const cuffGeo = cyl(0.066, 0.058, 0.08, 8);
      const upper = new Group();
      const fore = new Group();
      const glove = new Group();
      this.torso.add(upper, fore, glove);
      this.#part(upperGeo, upper, 'skin');
      this.#part(foreGeo, fore, 'skin');
      this.#part(gloveGeo, glove, 'gloves');
      this.#part(cuffGeo, glove, ghost ? 'gloves' : 'band');
      return {
        side, upper, fore, glove,
        shoulder: new Vector3(side * D.shoulderX, D.shoulderY, 0),
        guard: new Vector3(side * 0.105, D.shoulderY + (side > 0 ? 0.07 : 0.045), side > 0 ? 0.27 : 0.2),
      };
    });

    // legs
    this.legs = [1, -1].map((side) => {
      const thighGeo = cyl(0.08 * bulk, 0.06 * bulk, D.thigh, 6);
      thighGeo.translate(0, D.thigh / 2, 0);
      const shinGeo = cyl(0.058 * bulk, 0.045 * bulk, D.shin, 6);
      shinGeo.translate(0, D.shin / 2, 0);
      const bootGeo = new THREE.BoxGeometry(0.1, 0.12, 0.22, 1, 1, 2);
      bootGeo.translate(0, -0.01, 0.05);
      const thigh = new Group();
      const shin = new Group();
      const boot = new Group();
      this.rig.add(thigh, shin, boot);
      this.#part(thighGeo, thigh, 'skin');
      this.#part(shinGeo, shin, 'skin');
      this.#part(bootGeo, boot, 'boots');
      return {
        side, thigh, shin, boot,
        hip: new Vector3(side * 0.095 * bulk, -0.06, 0),
        foot: new Vector3(side * 0.17 * bulk, D.ankleY, side > 0 ? 0.13 : -0.13),
      };
    });

    // pose state
    this.pose = {
      x: 0, y: 0, z: 0, crouch: 0, lean: 0, twist: 0, roll: 0,
      hp: 0, hy: 0, hr: 0, flare: [0, 0], fall: 0,
      gL: new Vector3(), gR: new Vector3(),
    };
    this.clips = [];
    this.bps = 2.5; // idle bounce synced to the 150bpm soundtrack
    this.phase = Math.random() * 10;
    this.update(0, 0);
  }

  #track(m) {
    this.materials.push(m);
    return m;
  }

  #geo(g) {
    this.geometries.push(g);
    return g;
  }

  /** One body part: toon fill + ink outline, or ghost prepass + green outline + wireframe. */
  #part(geo, parent, kind) {
    this.#geo(geo);
    const hull = new Mesh(geo, this.hullMat);
    if (this.isPlayer) {
      const fill = new Mesh(geo, this.fillMat);
      fill.renderOrder = 100;
      hull.renderOrder = 101;
      const lines = new THREE.LineSegments2(this.#geo(edgeLines(geo)), kind === 'gloves' ? this.gloveLineMat : this.lineMat);
      lines.renderOrder = 102;
      parent.add(fill, hull, lines);
    } else {
      parent.add(new Mesh(geo, this.toon[kind] || this.toon.skin), hull);
    }
  }

  #face() {
    const add = (geo, mat, x, y, z, rz = 0) => {
      const m = new Mesh(this.#geo(geo), mat);
      m.position.set(x, y, z);
      m.rotation.z = rz;
      this.head.add(m);
    };
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.036, 0.024, 0.012), this.eyeMat, s * 0.04, 0.02, 0.1);
      add(new THREE.BoxGeometry(0.014, 0.02, 0.012), this.inkMat, s * 0.036, 0.018, 0.106);
      add(new THREE.BoxGeometry(0.05, 0.014, 0.014), this.inkMat, s * 0.042, 0.048, 0.1, s * 0.3); // scowl
    }
    add(new THREE.BoxGeometry(0.05, 0.01, 0.012), this.inkMat, 0, -0.06, 0.09);
  }

  #hair(kind) {
    if (kind === 'mohawk') {
      const g = new THREE.BoxGeometry(0.04, 0.09, 0.24, 1, 1, 4);
      g.translate(0, 0.13, -0.01);
      this.#part(g, this.head, 'hair');
    } else if (kind === 'flattop') {
      const g = new THREE.BoxGeometry(0.21, 0.08, 0.21, 2, 1, 2);
      g.translate(0, 0.125, -0.005);
      this.#part(g, this.head, 'hair');
    } else if (kind === 'spikes') {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const g = new THREE.ConeGeometry(0.04, 0.15, this.isPlayer ? 4 : 6, 1, this.isPlayer);
        g.rotateX(-0.5);
        g.rotateY(a);
        g.translate(Math.sin(a) * 0.05, 0.14, Math.cos(a) * 0.05);
        this.#part(g, this.head, 'hair');
      }
    }
  }

  // ---- world helpers ------------------------------------------------------
  headWorld(out = new Vector3()) {
    return this.head.getWorldPosition(out);
  }

  chestWorld(out = new Vector3()) {
    return out.set(0, this.D.shoulderY * 0.55, 0.08).applyMatrix4(this.torso.matrixWorld);
  }

  gloveWorld(side, out = new Vector3()) {
    const arm = this.arms[side > 0 ? 0 : 1];
    return out.set(0, this.D.gloveOffset, 0).applyMatrix4(arm.glove.matrixWorld);
  }

  /** Local x sign of the hand that throws `move` (quadrants are screen-space). */
  handFor(move) {
    const sx = MOVES[move].sx;
    return this.isPlayer ? -sx : sx;
  }

  // ---- animation ----------------------------------------------------------
  clear() {
    this.clips.length = 0;
  }

  play(clip) {
    clip.t = 0;
    this.clips.push(clip);
    return clip;
  }

  /**
   * Throw `move`. `result` is 'land' | 'clash' | 'stuffed' | 'whiff'.
   * `victim` is the other Boxer; `clashPoint` a world position.
   */
  punch(move, result, victim, clashPoint) {
    const hs = this.handFor(move);
    const gi = hs > 0 ? 0 : 1;
    const st = PUNCH_STYLE[move];
    this.root.updateMatrixWorld(true);
    victim.root.updateMatrixWorld(true);

    // target in rig space, frozen at the start of the punch
    const reach = result === 'stuffed' ? 0.42 : 1;
    const T = new Vector3();
    if (result === 'clash') {
      T.copy(clashPoint);
    } else if (MOVES[move].high) {
      victim.headWorld(T);
    } else {
      victim.chestWorld(T);
    }
    this.rig.worldToLocal(T);
    if (result !== 'clash') {
      if (move === JAB) T.x += hs * 0.035;
      if (move === HOOK) T.x -= hs * 0.02;
      if (move === UPPER) { T.y -= 0.07; T.x += hs * 0.01; }
      if (move === BODY) { T.x += hs * 0.07; T.y -= 0.02; }
      T.z -= move === BODY ? 0.17 : 0.11;
    }
    if (result === 'whiff') { T.z += 0.16; T.y += 0.06; T.x += hs * 0.05; }
    // Lunge in far enough that the glove always connects, then compensate the
    // rig-space target for the rig moving forward underneath it.
    const D = this.D;
    const shoulder = _b.set(hs * D.shoulderX, D.hipY + D.shoulderY, 0);
    const shortfall = shoulder.distanceTo(T) - (D.upper + D.fore + D.gloveOffset + 0.08);
    const lunge = st.step + Math.max(0, shortfall - st.step);
    T.z -= lunge * reach;

    const W = new Vector3(st.windup[0] * hs, st.windup[1], st.windup[2]);
    const bend = new Vector3(st.bend[0] * hs, st.bend[1], st.bend[2]);
    const S = new Vector3();
    const C = new Vector3();
    const dur = IMPACT + HOLD + RETRACT;

    const ext = (t) => {
      if (t < WINDUP) return 0;
      if (t < IMPACT) return reach * easeOut3((t - WINDUP) / (IMPACT - WINDUP));
      if (result === 'stuffed') return reach * (1 - easeOut(clamp01((t - IMPACT) / 0.12)));
      if (result === 'clash') {
        const k = (t - IMPACT) / (HOLD + RETRACT);
        return Math.max(0, 1 - easeOut(clamp01(k * 1.6)) * 1.05);
      }
      if (t < IMPACT + HOLD) return 1;
      return 1 - easeInOut(clamp01((t - IMPACT - HOLD) / RETRACT));
    };
    const wind = (t) => (t < WINDUP ? Math.sin((t / WINDUP) * Math.PI * 0.5) : Math.max(0, 1 - (t - WINDUP) / (IMPACT - WINDUP) * 1.6));

    return this.play({
      dur,
      body: (p, t) => {
        const e = ext(t);
        const w = wind(t);
        p.twist += -hs * st.twist * e + hs * 0.12 * w;
        p.lean += st.lean * e;
        p.crouch += st.crouch * e + (move === UPPER ? 0.1 * w : 0.02 * w);
        p.z += lunge * e;
        if (move === BODY) { p.roll += hs * 0.14 * e; p.hp += 0.12 * e; }
        if (move === UPPER) p.lean -= 0.06 * w;
        p.flare[gi] += st.flare * e;
      },
      hands: (p, t) => {
        const e = ext(t);
        const w = wind(t);
        const G = gi === 0 ? p.gL : p.gR;
        S.copy(G);
        C.copy(S).lerp(T, 0.5).add(bend);
        bezier(G, S, C, T, e);
        G.addScaledVector(W, w);
        // tuck the other glove in tight to guard the chin
        const O = gi === 0 ? p.gR : p.gL;
        O.z += 0.03 * e;
        O.x += hs * 0.03 * e;
      },
    });
  }

  /** Get hit. `move` is the attacker's move, `power` ~0.6..2. */
  react(move, power = 1, attackerHand = 1) {
    this.flash = 1;
    const high = move !== BODY;
    const dir = -attackerHand; // hand side mirrored into our frame
    return this.play({
      dur: 0.6,
      body: (p, t) => {
        const r = (t < 0.035 ? t / 0.035 : Math.exp(-(t - 0.035) * 6.5)) * power;
        if (high) {
          p.hp -= (move === UPPER ? 0.75 : move === JAB ? 0.42 : 0.2) * r;
          p.hy += (move === HOOK ? 0.75 : 0.12) * dir * r;
          p.hr += (move === HOOK ? 0.25 : 0.08) * dir * r;
          p.lean -= (move === UPPER ? 0.28 : 0.2) * r;
          p.z -= 0.13 * r;
          if (move === UPPER) p.y += 0.04 * r;
        } else {
          p.lean += 0.5 * r;
          p.crouch += 0.13 * r;
          p.hp += 0.3 * r;
          p.z -= 0.08 * r;
        }
      },
      hands: (p, t) => {
        const r = (t < 0.035 ? t / 0.035 : Math.exp(-(t - 0.035) * 6.5)) * power;
        p.gL.y -= 0.12 * r; p.gR.y -= 0.12 * r;
        p.gL.x += 0.08 * r; p.gR.x -= 0.08 * r;
        p.gL.z -= 0.05 * r; p.gR.z -= 0.05 * r;
      },
    });
  }

  /** Recoil from a glove-to-glove clash. */
  recoil() {
    return this.play({
      dur: 0.4,
      body: (p, t) => {
        const r = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) * 8);
        p.z -= 0.09 * r;
        p.lean -= 0.12 * r;
      },
    });
  }

  knockout() {
    this.flash = 1.5;
    this.clear();
    return this.play({
      dur: Infinity,
      body: (p, t) => {
        const f = Math.min(1, t / 0.75);
        const fall = f * f;
        let bounce = 0;
        if (t > 0.75) bounce = 0.12 * Math.sin((t - 0.75) * 16) * Math.exp(-(t - 0.75) * 6);
        p.fall = -1.5 * fall + bounce;
        p.z -= 0.55 * easeOut(Math.min(1, t / 0.9));
        p.hp -= 0.6 * Math.min(1, t * 5);
        p.hy += 0.5 * Math.min(1, t * 3);
        p.lean -= 0.3 * Math.min(1, t * 4);
        p.crouch += 0.05;
      },
      hands: (p, t) => {
        const k = Math.min(1, t * 3);
        p.gL.set(0.42, 1.2 + 0.4 * k, -0.1);
        p.gR.set(-0.45, 1.1 + 0.5 * k, 0.05);
      },
    });
  }

  victory() {
    this.clear();
    return this.play({
      dur: Infinity,
      body: (p, t) => {
        p.y += Math.abs(Math.sin(t * 7)) * 0.08;
        p.hp -= 0.35;
        p.lean -= 0.1;
      },
      hands: (p, t) => {
        const k = easeOut(Math.min(1, t * 4));
        p.gL.lerp(_a.set(0.32, 2.05 + Math.sin(t * 7) * 0.05, 0.12), k);
        p.gR.lerp(_a.set(-0.32, 2.05 + Math.cos(t * 7) * 0.05, 0.12), k);
      },
    });
  }

  dropIn(height = 5) {
    return this.play({
      dur: 0.55,
      body: (p, t) => {
        const k = Math.min(1, t / 0.45);
        p.y += (1 - k * k) * height;
        if (t > 0.45) p.crouch += 0.18 * Math.exp(-(t - 0.45) * 18);
      },
    });
  }

  /** Quick idle feint so the opponent looks alive between rounds. */
  shimmy() {
    const s = Math.random() < 0.5 ? -1 : 1;
    return this.play({
      dur: 0.5,
      body: (p, t) => {
        const r = Math.sin((t / 0.5) * Math.PI);
        p.twist += 0.25 * s * r;
        p.x += 0.05 * s * r;
        p.roll += 0.1 * s * r;
      },
    });
  }

  // ---- per-frame ----------------------------------------------------------
  update(dt, time) {
    const p = this.pose;
    const D = this.D;
    p.x = p.y = p.z = 0;
    p.crouch = 0; p.lean = 0.1; p.twist = 0.08; p.roll = 0;
    p.hp = 0.05; p.hy = 0; p.hr = 0;
    p.flare[0] = p.flare[1] = 0;
    p.fall = 0;

    // idle bounce on the beat + sway
    const tt = time + this.phase;
    const bounce = Math.abs(Math.sin(Math.PI * this.bps * time));
    p.crouch += 0.035 * (1 - bounce);
    p.twist += 0.06 * Math.sin(tt * 1.3);
    p.roll += 0.035 * Math.sin(tt * 1.1);
    p.x += 0.03 * Math.sin(tt * 0.9);

    for (const c of this.clips) {
      c.t += dt;
      c.body?.(p, Math.min(c.t, c.dur));
    }

    this.rig.position.set(p.x, p.y, p.z);
    this.rig.rotation.x = p.fall;
    this.hips.position.set(0, D.hipY - p.crouch, 0);
    this.torso.rotation.set(p.lean, p.twist, p.roll);
    this.head.rotation.set(p.hp - p.lean * 0.6, p.hy - p.twist * 0.5, p.hr);

    this.hips.updateMatrix();
    this.torso.updateMatrix();
    _m.multiplyMatrices(this.hips.matrix, this.torso.matrix); // torso -> rig
    const [aL, aR] = this.arms;
    p.gL.copy(aL.guard).applyMatrix4(_m);
    p.gR.copy(aR.guard).applyMatrix4(_m);
    const gb = 0.012 * (1 - bounce);
    p.gL.y -= gb; p.gR.y -= gb;

    for (const c of this.clips) c.hands?.(p, Math.min(c.t, c.dur));
    this.clips = this.clips.filter((c) => c.t < c.dur);

    _mi.copy(_m).invert();
    this.#solveArm(aL, _a.copy(p.gL).applyMatrix4(_mi), p.flare[0]);
    this.#solveArm(aR, _a.copy(p.gR).applyMatrix4(_mi), p.flare[1]);
    for (const leg of this.legs) this.#solveLeg(leg);

    // hit flash: classic sprite white-out, stepped like a palette swap
    if (this.flash > 0 || this.flash === 0) {
      this.flash = Math.max(0, this.flash - dt * 6);
      const k = this.flash > 0.5 ? 1 : this.flash > 0.2 ? 0.5 : 0;
      if (this.isPlayer) this.lineMat.color.copy(this.lineCol).lerp(FLASH_WHITE, k);
      else for (const m of Object.values(this.toon)) m.emissive.setScalar(k * 0.85);
      if (this.flash === 0) this.flash = -1;
    }
  }

  #solveArm(arm, target, flare) {
    const D = this.D;
    const S = arm.shoulder;
    const dir = _d.subVectors(target, S);
    let dist = dir.length() - D.gloveOffset;
    dir.normalize();
    const a = D.upper;
    const b = D.fore;
    dist = Math.max(0.06, Math.min(a + b - 0.002, dist));
    _w.copy(S).addScaledVector(dir, dist); // wrist
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    _pole.set(arm.side * (0.55 + flare * 0.7), -1 + flare * 1.25, -0.35);
    _pole.addScaledVector(dir, -_pole.dot(dir)).normalize();
    _e.copy(S).addScaledVector(dir, x).addScaledVector(_pole, h); // elbow
    arm.upper.position.copy(S);
    arm.upper.quaternion.setFromUnitVectors(UP, _b.subVectors(_e, S).normalize());
    arm.fore.position.copy(_e);
    arm.fore.quaternion.setFromUnitVectors(UP, _b.subVectors(_w, _e).normalize());
    arm.glove.position.copy(_w);
    arm.glove.quaternion.copy(arm.fore.quaternion);
  }

  #solveLeg(leg) {
    const D = this.D;
    const H = _a.copy(leg.hip).add(this.hips.position);
    const F = leg.foot;
    const dir = _d.subVectors(F, H);
    let dist = dir.length();
    dir.normalize();
    const a = D.thigh;
    const b = D.shin;
    dist = Math.max(0.1, Math.min(a + b - 0.002, dist));
    _w.copy(H).addScaledVector(dir, dist);
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    _pole.set(leg.side * 0.25, 0, 1);
    _pole.addScaledVector(dir, -_pole.dot(dir)).normalize();
    _e.copy(H).addScaledVector(dir, x).addScaledVector(_pole, h);
    leg.thigh.position.copy(H);
    leg.thigh.quaternion.setFromUnitVectors(UP, _b.subVectors(_e, H).normalize());
    leg.shin.position.copy(_e);
    leg.shin.quaternion.setFromUnitVectors(UP, _b.subVectors(_w, _e).normalize());
    leg.boot.position.copy(_w);
  }

  dispose() {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) {
      LINE_MATERIALS.delete(m);
      m.dispose();
    }
  }
}
