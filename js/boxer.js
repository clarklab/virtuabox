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
const FLASH_WHITE = new Color(3, 3, 3);

// ---------------------------------------------------------------------------
// Fat neon line materials. LineMaterial widths are in drawing-buffer pixels,
// so the stage rescales every registered material on resize.
export const LINE_MATERIALS = new Set();
const lineRes = { w: 1, h: 1, dpr: 1 };

export function neonLine(color, cssWidth, extra = {}) {
  const mat = new THREE.LineMaterial({ color: new Color(color), linewidth: cssWidth, ...extra });
  // An edge pointing straight down the view axis has a zero-length screen
  // direction; normalize() then yields NaN vertices, and some GPUs rasterize
  // those with NaN varyings that bloom smears across the whole frame.
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

const hdr = (hex, k) => new Color(hex).multiplyScalar(k);

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
export class Boxer {
  /**
   * @param {object} o
   * @param {string} o.color  neon hex color
   * @param {boolean} o.ghost  translucent hidden-line wireframe (the player)
   */
  constructor(o) {
    this.o = o;
    this.isPlayer = !!o.ghost;
    this.color = new Color(o.color);
    const bulk = o.bulk ?? 1;
    const tall = o.tall ?? 1;
    this.bulk = bulk;

    this.materials = [];
    this.geometries = [];
    this.lineCol = hdr(o.color, o.ghost ? 0.85 : 1.25);
    this.lineMat = this.#track(neonLine(this.lineCol.clone(), o.ghost ? 1.8 : 2.6, { fog: false }));
    this.gloveLineMat = this.#track(neonLine(hdr(o.color, o.ghost ? 1.3 : 1.9), o.ghost ? 2.2 : 2.8, { fog: false }));

    if (o.ghost) {
      // Depth-only prepass hides the far side of the wireframe while the
      // opponent stays visible through the body, Punch-Out style.
      this.fillMat = this.#track(new THREE.MeshBasicMaterial({
        colorWrite: false, transparent: true, depthWrite: true,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
      }));
      this.gloveFillMat = this.fillMat;
      this.lineMat.transparent = true;
      this.gloveLineMat.transparent = true;
    } else {
      this.fillMat = this.#track(new THREE.MeshBasicMaterial({
        color: new Color(o.color).multiplyScalar(0.05).add(new Color(0x020008)),
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
      }));
      this.gloveFillMat = this.#track(new THREE.MeshBasicMaterial({
        color: new Color(o.color).multiplyScalar(0.28),
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
      }));
    }
    this.eyeMat = this.#track(new THREE.MeshBasicMaterial({ color: new Color(1, 1, 1).multiplyScalar(4), fog: false }));
    this.flash = 0;
    this.fillOrder = o.ghost ? 100 : 0;
    this.lineOrder = o.ghost ? 101 : 0;

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

    // torso: lathe, octagonal cross-section, flattened front-to-back
    const prof = [
      [0.145, -0.02], [0.155, 0.1], [0.185, 0.24], [0.225, 0.36], [0.235, 0.44], [0.19, 0.52], [0.08, 0.565],
    ].map(([r, y]) => new THREE.Vector2(r, y * tall));
    const torsoGeo = new THREE.LatheGeometry(prof, 8, Math.PI / 8);
    torsoGeo.scale(bulk, 1, 0.7 * bulk);
    this.#part(torsoGeo, this.torso, this.lineMat, this.fillMat);

    // pecs/abs detail line on the opponent chest
    const neckGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.12, 6, 1, true);
    neckGeo.translate(0, 0.58 * tall, 0);
    this.#part(neckGeo, this.torso, this.lineMat, this.fillMat);

    // head
    this.head.position.y = D.headY;
    const headGeo = new THREE.SphereGeometry(0.115, 8, 6);
    headGeo.scale(0.92, 1.12, 1.0);
    this.#part(headGeo, this.head, this.lineMat, this.fillMat);
    const jawGeo = new THREE.BoxGeometry(0.13, 0.05, 0.1);
    jawGeo.translate(0, -0.085, 0.03);
    this.#part(jawGeo, this.head, this.lineMat, this.fillMat);
    this.#hair(o.hair);
    if (!o.ghost) {
      const eyeGeo = this.#geo(new THREE.BoxGeometry(0.032, 0.012, 0.01));
      for (const s of [-1, 1]) {
        const eye = new Mesh(eyeGeo, this.eyeMat);
        eye.position.set(s * 0.038, 0.018, 0.098);
        eye.rotation.z = s * 0.18;
        this.head.add(eye);
      }
    } else {
      // headband knot for the player
      const bandGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.03, 8, 1, true);
      bandGeo.translate(0, 0.045, 0);
      this.#part(bandGeo, this.head, this.gloveLineMat, this.fillMat);
    }

    // shorts + belt
    const shortsGeo = new THREE.CylinderGeometry(0.19 * bulk, 0.205 * bulk, 0.27, 8, 2, true, Math.PI / 8);
    shortsGeo.scale(1, 1, 0.8);
    shortsGeo.translate(0, -0.1, 0);
    this.#part(shortsGeo, this.hips, this.gloveLineMat, this.fillMat);
    const bandGeo = new THREE.CylinderGeometry(0.175 * bulk, 0.19 * bulk, 0.06, 8, 1, true, Math.PI / 8);
    bandGeo.scale(1, 1, 0.8);
    bandGeo.translate(0, 0.02, 0);
    this.#part(bandGeo, this.hips, this.lineMat, this.fillMat);
    if (o.belt) {
      const beltGeo = new THREE.CylinderGeometry(0.2 * bulk, 0.2 * bulk, 0.09, 8, 1, true, Math.PI / 8);
      beltGeo.scale(1, 1, 0.82);
      beltGeo.translate(0, 0.02, 0);
      const goldLine = this.#track(neonLine(hdr('#ffe24a', 2.2), 2.4, { fog: false }));
      this.#part(beltGeo, this.hips, goldLine, this.fillMat);
      const plateGeo = new THREE.BoxGeometry(0.16, 0.11, 0.02);
      plateGeo.translate(0, 0.02, 0.17 * bulk);
      this.#part(plateGeo, this.hips, goldLine, this.gloveFillMat);
    }

    // arms
    this.arms = [1, -1].map((side) => {
      const upperGeo = new THREE.CylinderGeometry(0.066 * bulk, 0.056 * bulk, D.upper, 6, 1, true);
      upperGeo.translate(0, D.upper / 2, 0);
      const foreGeo = new THREE.CylinderGeometry(0.056 * bulk, 0.046 * bulk, D.fore, 6, 1, true);
      foreGeo.translate(0, D.fore / 2, 0);
      const gloveGeo = new THREE.SphereGeometry(D.gloveR, 8, 6);
      gloveGeo.scale(1, 1.22, 1.05);
      gloveGeo.translate(0, D.gloveOffset, 0);
      const cuffGeo = new THREE.CylinderGeometry(0.066, 0.058, 0.08, 8, 1, true);
      cuffGeo.translate(0, 0.0, 0);
      const upper = new Group();
      const fore = new Group();
      const glove = new Group();
      this.torso.add(upper, fore, glove);
      this.#part(upperGeo, upper, this.lineMat, this.fillMat);
      this.#part(foreGeo, fore, this.lineMat, this.fillMat);
      this.#part(gloveGeo, glove, this.gloveLineMat, this.gloveFillMat);
      this.#part(cuffGeo, glove, this.gloveLineMat, this.gloveFillMat);
      return {
        side, upper, fore, glove,
        shoulder: new Vector3(side * D.shoulderX, D.shoulderY, 0),
        guard: new Vector3(side * 0.105, D.shoulderY + (side > 0 ? 0.07 : 0.045), side > 0 ? 0.27 : 0.2),
      };
    });

    // legs
    this.legs = [1, -1].map((side) => {
      const thighGeo = new THREE.CylinderGeometry(0.08 * bulk, 0.06 * bulk, D.thigh, 6, 1, true);
      thighGeo.translate(0, D.thigh / 2, 0);
      const shinGeo = new THREE.CylinderGeometry(0.058 * bulk, 0.045 * bulk, D.shin, 6, 1, true);
      shinGeo.translate(0, D.shin / 2, 0);
      const bootGeo = new THREE.BoxGeometry(0.1, 0.1, 0.22, 1, 1, 2);
      bootGeo.translate(0, -0.02, 0.05);
      const thigh = new Group();
      const shin = new Group();
      const boot = new Group();
      this.rig.add(thigh, shin, boot);
      this.#part(thighGeo, thigh, this.lineMat, this.fillMat);
      this.#part(shinGeo, shin, this.lineMat, this.fillMat);
      this.#part(bootGeo, boot, this.gloveLineMat, this.fillMat);
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
    this.gloveHistory = [[], []];
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

  #part(geo, parent, lineMat, fillMat) {
    this.#geo(geo);
    const mesh = new Mesh(geo, fillMat);
    mesh.renderOrder = this.fillOrder;
    const lines = new THREE.LineSegments2(this.#geo(edgeLines(geo)), lineMat);
    lines.renderOrder = this.lineOrder;
    parent.add(mesh, lines);
    return mesh;
  }

  #hair(kind) {
    const lm = this.gloveLineMat;
    if (kind === 'mohawk') {
      const g = new THREE.BoxGeometry(0.035, 0.09, 0.24, 1, 1, 4);
      g.translate(0, 0.13, -0.01);
      this.#part(g, this.head, lm, this.gloveFillMat);
    } else if (kind === 'flattop') {
      const g = new THREE.BoxGeometry(0.2, 0.08, 0.2, 2, 1, 2);
      g.translate(0, 0.125, -0.005);
      this.#part(g, this.head, lm, this.gloveFillMat);
    } else if (kind === 'spikes') {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const g = new THREE.ConeGeometry(0.035, 0.14, 4, 1, true);
        g.rotateX(-0.5);
        g.rotateY(a);
        g.translate(Math.sin(a) * 0.05, 0.14, Math.cos(a) * 0.05);
        this.#part(g, this.head, lm, this.gloveFillMat);
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

    // hit flash
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 6);
      const k = Math.min(1, this.flash);
      this.lineMat.color.copy(this.lineCol).lerp(FLASH_WHITE, k);
    } else if (this.flash === 0) {
      this.lineMat.color.copy(this.lineCol);
      this.flash = -1;
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
