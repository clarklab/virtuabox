import * as THREE from './vendor/three.js';
import { pixelLine, outlineMaterial, setLineResolution } from './boxer.js';

const { Vector3, Color } = THREE;

export const PLAYER_Z = 0.46;
export const OPP_Z = -0.46;
export const PLAYER_SCALE = 0.9; // Little-Mac-sized so the opponent reads above your head
const RING = 2.5; // half-size of the ring, posts sit on the corners
const PIXEL_ROWS = 232; // target vertical resolution, SNES-ish (224..240)
const PIXEL_FONT = '"Press Start 2P", monospace';

const _v = new Vector3();
const _v2 = new Vector3();

// fight camera: height, distance behind the player, look-at height, x offset, horizontal fov
const CAM = (new URLSearchParams(location.search).get('cam') || '2.6,3.0,1.36,-0.28,25').split(',').map(Number);
const SHOT_HFOV = { fight: CAM[4] || 30, attract: 62, intro: 44, ko: 56, results: 56 };

const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Stage {
  constructor(container) {
    this.container = container;
    this.time = 0;

    const renderer = (this.renderer = new THREE.WebGLRenderer({
      antialias: false, powerPreference: 'high-performance', stencil: false,
    }));
    renderer.setClearColor(0x05051a, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(1);
    renderer.domElement.id = 'gl';
    container.prepend(renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0a26, 11, 30);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 250);

    // cel lighting for the toon-shaded fighters and ring hardware
    this.scene.add(new THREE.HemisphereLight(0xdde4ff, 0x302838, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1.6, 5, 3.5);
    this.scene.add(key);

    // Low-res scene -> palette + ordered-dither pass -> nearest-neighbour upscale (CSS)
    this.composer = new THREE.EffectComposer(renderer);
    this.composer.addPass(new THREE.RenderPass(this.scene, this.camera));
    this.retro = new THREE.ShaderPass(RetroShader);
    this.composer.addPass(this.retro);

    this.pointMats = [];
    this.#buildWorld();
    this.#buildFx();

    this.cam = {
      pos: new Vector3(0, 3, 7), look: new Vector3(0, 1.2, 0),
      shot: 'attract', shotT: 0, rate: 3, yaw: 0, dolly: 0, lift: 0, focus: null, hfov: 60, hfovNow: 60,
    };
    this.trauma = 0;
    this.fovKick = 0;
    this.flashAmt = 0;
    this.hype = 0;
    this.pulse = 0;

    this.captureCanvas = document.createElement('canvas');
    this.captureWanted = false;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  // ---------------------------------------------------------------------------
  /** Render at ~232 rows and upscale by a whole number so every pixel is square. */
  resize() {
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    const s = (this.pixel = Math.max(2, Math.round(ch / PIXEL_ROWS)));
    const w = Math.ceil(cw / s);
    const h = Math.ceil(ch / s);
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    const el = this.renderer.domElement;
    el.style.width = `${w * s}px`;
    el.style.height = `${h * s}px`;
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    setLineResolution(w, h, 1);
    this.#pointScale();
  }

  /** Vertical FOV that keeps a horizontal FOV of `hfov` degrees whatever the aspect. */
  #vfov(hfov) {
    const v = 2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / this.camera.aspect) * (180 / Math.PI);
    return Math.min(70, Math.max(35, v));
  }

  #pointScale() {
    const pxScale = this.h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    for (const m of this.pointMats) m.uniforms.uScale.value = pxScale;
  }

  // ---------------------------------------------------------------------------
  #buildWorld() {
    const scene = this.scene;
    const toon = (hex) => new THREE.MeshToonMaterial({ color: new Color(hex), gradientMap: toonRamp() });
    const ink = outlineMaterial('#000000', 1);

    // arena dome: dark rafters fading to a warm glow over the crowd
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(120, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { uTop: { value: new Color(0x03030c) }, uHorizon: { value: new Color(0x241a4a) } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uHorizon; varying vec3 vDir;
          void main(){ gl_FragColor = vec4(mix(uHorizon, uTop, smoothstep(-0.05, 0.35, vDir.y)), 1.0); }`,
      }),
    );
    sky.renderOrder = -10;
    scene.add(sky);

    // arena floor + tiered stands
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ color: 0x14143a }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.62;
    scene.add(floor);
    const stands = new THREE.Mesh(
      new THREE.CylinderGeometry(15.5, 7.2, 7.5, 32, 10, true),
      new THREE.MeshBasicMaterial({ color: 0x0c0c26, side: THREE.BackSide }),
    );
    stands.position.y = 3.1;
    scene.add(stands);

    // ring platform: apron with the logo, mat on top
    const plat = new THREE.BoxGeometry(RING * 2 + 0.5, 0.6, RING * 2 + 0.5);
    plat.translate(0, -0.3, 0);
    const apron = makeApronTexture();
    const platMesh = new THREE.Mesh(plat, [
      new THREE.MeshBasicMaterial({ map: apron }), new THREE.MeshBasicMaterial({ map: apron }),
      new THREE.MeshBasicMaterial({ color: 0x1830a0 }), new THREE.MeshBasicMaterial({ color: 0x1830a0 }),
      new THREE.MeshBasicMaterial({ map: apron }), new THREE.MeshBasicMaterial({ map: apron }),
    ]);
    scene.add(platMesh);
    const mat = new THREE.Mesh(
      new THREE.PlaneGeometry(RING * 2 + 0.5, RING * 2 + 0.5),
      new THREE.MeshBasicMaterial({ map: makeMatTexture(this.renderer) }),
    );
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.002;
    scene.add(mat);

    // corner posts (red/blue/white like the classics) + ropes
    const postGeo = new THREE.CylinderGeometry(0.08, 0.1, 1.45, 10);
    postGeo.translate(0, 0.725, 0);
    const padGeo = new THREE.BoxGeometry(0.2, 0.22, 0.2);
    const corners = [[-1, -1, '#d82828'], [1, -1, '#2850d8'], [1, 1, '#f0f0f0'], [-1, 1, '#f0f0f0']];
    for (const [x, z, col] of corners) {
      const post = new THREE.Group();
      post.position.set(x * RING, 0, z * RING);
      post.add(new THREE.Mesh(postGeo, toon('#c0c0c8')), new THREE.Mesh(postGeo, ink));
      for (const y of [0.5, 0.86, 1.22]) {
        const pad = new THREE.Mesh(padGeo, toon(col));
        const padInk = new THREE.Mesh(padGeo, ink);
        pad.position.y = padInk.position.y = y;
        post.add(pad, padInk);
      }
      scene.add(post);
    }
    this.ropeMats = [];
    const cornerPts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, z]) => [x * RING * 0.99, z * RING * 0.99]);
    [[0.5, '#e02828'], [0.86, '#f0f0f0'], [1.22, '#2850e0']].forEach(([y, col]) => {
      const g = new THREE.LineGeometry();
      g.setPositions(cornerPts.flatMap(([x, z]) => [x, y, z]));
      const m = pixelLine(col, 2);
      m.userData.base = new Color(col);
      this.ropeMats.push(m);
      scene.add(new THREE.Line2(g, m));
    });

    // lighting truss with bulbs
    const trussMat = new THREE.MeshBasicMaterial({ color: 0x3a3a58 });
    for (const [sx, sz, len, rot] of [[0, -1, 7, 0], [0, 1, 7, 0], [-1, 0, 7, 1], [1, 0, 7, 1]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.12), trussMat);
      bar.position.set(sx * 3.5, 5.2, sz * 3.5);
      bar.rotation.y = rot * Math.PI / 2;
      scene.add(bar);
    }
    this.bulbs = [];
    const bulbGeo = new THREE.BoxGeometry(0.22, 0.14, 0.22);
    for (let i = 0; i < 12; i++) {
      const side = i % 4;
      const k = (Math.floor(i / 4) - 1) * 2;
      const b = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0xfff4c0, fog: false }));
      const [x, z] = [[k, -3.5], [3.5, k], [k, 3.5], [-3.5, k]][side];
      b.position.set(x, 5.08, z);
      this.bulbs.push(b);
      scene.add(b);
    }

    // soft light shafts (the dither pass turns them into proper 16-bit beams)
    this.cones = [];
    const coneGeo = new THREE.ConeGeometry(1.9, 5.3, 24, 1, true);
    coneGeo.translate(0, -2.65, 0);
    [[-2, -2, 0], [2, -2, 1.3], [0, 2.4, 2.6]].forEach(([x, z, ph]) => {
      const m = new THREE.Mesh(coneGeo, makeConeMaterial('#fff2c8'));
      m.position.set(x, 5.05, z);
      m.userData.phase = ph;
      m.renderOrder = 5;
      this.cones.push(m);
      scene.add(m);
    });

    // crowd: each fan is a 2-pixel head over a 2-pixel shirt, with camera flashes
    {
      const fans = 2600;
      const n = fans * 2;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      const shirts = ['#e83030', '#3060e8', '#f8d030', '#30b848', '#f0f0f0', '#a040e0', '#f08020', '#40c8e8'].map((c) => new Color(c));
      const skins = ['#f8c8a0', '#e0a070', '#a86038', '#704020'].map((c) => new Color(c));
      for (let i = 0; i < fans; i++) {
        const a = Math.random() * Math.PI * 2;
        const row = Math.floor(Math.random() * 16);
        const r = 7.6 + row * 0.5;
        const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
        const rr = r * (0.8 + 0.2 * sq);
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        const y = -0.2 + row * 0.42;
        const sd = Math.random();
        const shirt = shirts[Math.floor(Math.random() * shirts.length)];
        const skin = skins[Math.floor(Math.random() * skins.length)];
        pos.set([x, y, z, x, y + 0.16, z], i * 6);
        col.set([shirt.r, shirt.g, shirt.b, skin.r, skin.g, skin.b], i * 6);
        seed[i * 2] = sd;
        seed[i * 2 + 1] = sd;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uHype: { value: 0 }, uScale: { value: 300 } },
        vertexShader: /* glsl */ `
          attribute vec3 aColor; attribute float aSeed;
          uniform float uTime, uHype, uScale;
          varying vec3 vColor;
          void main(){
            vec3 p = position;
            p.y += step(0.0, sin(uTime * (7.0 + aSeed * 4.0) + aSeed * 40.0)) * (0.02 + uHype * 0.16);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float slot = floor(uTime * 10.0);
            float h = fract(sin(aSeed * 917.3 + slot * 13.17) * 43758.5453);
            float flash = step(0.9965 - uHype * 0.012, h);
            float fade = clamp(1.25 - length(p.xz) * 0.05, 0.35, 1.0);
            vColor = mix(aColor * fade * (0.55 + 0.25 * uHype), vec3(1.0), flash);
            gl_PointSize = max(1.0, floor(0.16 * uScale / -mv.z + 0.5));
          }`,
        fragmentShader: /* glsl */ `varying vec3 vColor; void main(){ gl_FragColor = vec4(vColor, 1.0); }`,
        depthWrite: true,
      });
      this.pointMats.push(m);
      this.crowd = new THREE.Points(g, m);
      scene.add(this.crowd);
    }

    // jumbotron
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 2),
      new THREE.MeshBasicMaterial({ map: makeBoardTexture(), fog: false }),
    );
    board.position.set(0, 5.9, -11.5);
    this.board = board;
    scene.add(board);
  }

  // ---------------------------------------------------------------------------
  #buildFx() {
    // square pixel sparks
    const N = (this.sparkN = 700);
    this.sp = {
      pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), col: new Float32Array(N * 3),
      size: new Float32Array(N), alpha: new Float32Array(N), life: new Float32Array(N), max: new Float32Array(N),
      grav: new Float32Array(N), cursor: 0,
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sp.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.sp.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.sp.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.sp.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 300 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        uniform float uScale; varying vec3 vColor;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // shrink in whole-pixel steps as the spark dies
          float px = floor(aSize * uScale / max(-mv.z, 0.2) * (0.35 + 0.65 * aAlpha) + 0.5);
          gl_PointSize = aAlpha > 0.0 ? clamp(px, 1.0, 64.0) : 0.0;
          vColor = aColor;
        }`,
      fragmentShader: /* glsl */ `varying vec3 vColor; void main(){ gl_FragColor = vec4(vColor, 1.0); }`,
      depthTest: false, depthWrite: false, transparent: true,
    });
    this.pointMats.push(m);
    this.sparks = new THREE.Points(g, m);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 60;
    this.scene.add(this.sparks);

    // shockwave rings
    const ringGeo = new THREE.RingGeometry(0.84, 1, 32);
    this.rings = Array.from({ length: 8 }, () => {
      const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: new Color(), transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false,
      }));
      r.visible = false;
      r.renderOrder = 61;
      r.userData = { t: 0, dur: 0.3, size: 1 };
      this.scene.add(r);
      return r;
    });

    // Punch-Out style hit sparks: hand-pixelled starbursts
    const starTex = makeStarTexture();
    this.stars = Array.from({ length: 6 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, color: new Color(), depthTest: false, depthWrite: false, alphaTest: 0.5, fog: false }));
      s.visible = false;
      s.renderOrder = 62;
      s.userData = { t: 0, dur: 0.2, size: 1 };
      this.scene.add(s);
      return s;
    });
  }

  spawn(p, v, color, size, life, grav = 1) {
    const s = this.sp;
    const i = s.cursor;
    s.cursor = (s.cursor + 1) % this.sparkN;
    s.pos.set([p.x, p.y, p.z], i * 3);
    s.vel.set([v.x, v.y, v.z], i * 3);
    s.col.set([color.r, color.g, color.b], i * 3);
    s.size[i] = size;
    s.life[i] = life;
    s.max[i] = life;
    s.alpha[i] = 1;
    s.grav[i] = grav;
  }

  /** Big juicy hit. `power` ~ 0.5 (tap) .. 3 (KO). */
  impact(pos, colorHex, power = 1) {
    const pal = [new Color('#ffffff'), new Color('#f8f040'), new Color('#f89820'), new Color(colorHex)];
    const n = Math.floor(22 + power * 26);
    for (let i = 0; i < n; i++) {
      _v.randomDirection().multiplyScalar(1.5 + Math.random() * 4.5 * Math.sqrt(power));
      this.spawn(pos, _v, pal[Math.floor(Math.random() * pal.length)], 0.02 + Math.random() * 0.025, 0.2 + Math.random() * 0.4);
    }
    this.ring(pos, pal[0], 0.22 + power * 0.12);
    this.star(pos, pal[1], 0.34 + power * 0.14);
    this.shake(0.3 + power * 0.18);
    this.fovKick = -3 - power * 2.5;
    this.flash(pal[0], Math.min(0.28, 0.06 + power * 0.06));
    this.hype = Math.min(1, this.hype + 0.35 * power);
    for (const m of this.ropeMats) m.color.setScalar(1);
  }

  clash(pos) {
    const pal = [new Color('#ffffff'), new Color('#80e8ff'), new Color('#3890f8')];
    for (let i = 0; i < 60; i++) {
      _v.randomDirection();
      _v.z *= 0.3;
      _v.multiplyScalar(2 + Math.random() * 4.5);
      this.spawn(pos, _v, pal[i % 3], 0.02 + Math.random() * 0.02, 0.2 + Math.random() * 0.3, 0.6);
    }
    this.ring(pos, pal[1], 0.45, 0.28);
    this.star(pos, pal[0], 0.42);
    this.shake(0.35);
    this.fovKick = -2;
    this.flash(pal[1], 0.18);
  }

  /** Knockout confetti rains from the rafters. */
  confetti() {
    const pal = ['#e83030', '#3060e8', '#f8d030', '#30b848', '#f0f0f0', '#f048b0'].map((c) => new Color(c));
    for (let i = 0; i < 220; i++) {
      _v2.set((Math.random() - 0.5) * 6, 4 + Math.random() * 2.5, (Math.random() - 0.5) * 6);
      _v.set((Math.random() - 0.5) * 1.5, -Math.random(), (Math.random() - 0.5) * 1.5);
      this.spawn(_v2, _v, pal[i % pal.length], 0.035, 2.5 + Math.random() * 1.5, 0.12);
    }
  }

  ring(pos, color, size, dur = 0.3) {
    const r = this.rings.find((x) => !x.visible) || this.rings[0];
    r.visible = true;
    r.position.copy(pos);
    r.material.color.copy(color);
    r.userData.t = 0;
    r.userData.dur = dur;
    r.userData.size = size;
  }

  star(pos, color, size) {
    const s = this.stars.find((x) => !x.visible) || this.stars[0];
    s.visible = true;
    s.position.copy(pos);
    s.material.color.copy(color);
    s.material.rotation = Math.floor(Math.random() * 4) * (Math.PI / 4);
    s.userData.t = 0;
    s.userData.size = size;
  }

  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  flash(color, amt) {
    this.retro.uniforms.uFlash.value.copy(color);
    this.flashAmt = Math.max(this.flashAmt, amt);
  }

  beat(strength = 1) {
    this.pulse = Math.max(this.pulse, 0.6 * strength);
  }

  // ---------------------------------------------------------------------------
  /**
   * Camera shots: 'attract' | 'fight' | 'intro' | 'ko' | 'results' | 'custom'.
   * opts.yaw / opts.dolly / opts.lift nudge the fight shot per exchange.
   */
  shot(name, opts = {}) {
    const c = this.cam;
    c.shot = name;
    c.shotT = 0;
    c.rate = opts.rate ?? 4;
    c.yaw = opts.yaw ?? 0;
    c.dolly = opts.dolly ?? 0;
    c.lift = opts.lift ?? 0;
    c.focus = opts.focus ?? null;
    c.hfov = opts.hfov ?? SHOT_HFOV[name] ?? 50;
    if (opts.pos) c.customPos = opts.pos.clone();
    if (opts.look) c.customLook = opts.look.clone();
    if (opts.snap) {
      c.hfovNow = c.hfov;
      this.#shotTarget(0, true);
    }
  }

  #shotTarget(dt, snap = false) {
    const c = this.cam;
    c.shotT += dt;
    const t = this.time;
    const pos = _v;
    const look = _v2;
    switch (c.shot) {
      case 'attract': {
        const a = t * 0.18 + 0.4;
        pos.set(Math.sin(a) * 4.6, 2.1 + Math.sin(t * 0.3) * 0.5, Math.cos(a) * 4.6);
        look.set(0, 1.15, 0);
        break;
      }
      case 'intro': {
        // close-up on the new challenger, pulling back
        const k = Math.min(1, c.shotT / 1.6);
        const e = 1 - Math.pow(1 - k, 3);
        const f = c.focus || look.set(0, 1.6, OPP_Z);
        pos.set(0.55 - e * 0.9, 1.55 + e * 0.25, OPP_Z + 0.75 + e * 1.4);
        look.copy(f);
        break;
      }
      case 'ko': {
        const f = c.focus || _v2.set(0, 1, OPP_Z);
        const a = 1.2 + c.shotT * 0.35 * (c.yaw >= 0 ? 1 : -1);
        pos.set(f.x + Math.sin(a) * 2.2, 0.7, f.z + Math.cos(a) * 2.2);
        look.set(f.x, 0.75, f.z);
        break;
      }
      case 'custom':
        pos.copy(c.customPos);
        look.copy(c.customLook);
        break;
      case 'results': {
        const a = t * 0.12;
        pos.set(Math.sin(a) * 3.4, 1.6, Math.cos(a) * 3.4);
        look.set(0, 1.1, 0);
        break;
      }
      default: {
        const [cy, cr, ly, cx = 0] = CAM;
        const yaw = c.yaw + Math.sin(t * 0.4) * 0.03;
        const r = cr - c.dolly;
        pos.set(cx + Math.sin(yaw) * r, cy + c.lift, PLAYER_Z + Math.cos(yaw) * r);
        look.set(Math.sin(yaw) * -0.3, ly + c.lift * 0.3, OPP_Z + 0.05);
      }
    }
    const k = snap ? 1 : damp(c.rate, dt);
    c.pos.lerp(pos, k);
    c.look.lerp(look, k);
  }

  // ---------------------------------------------------------------------------
  update(dt, realDt) {
    this.time += realDt;
    const t = this.time;

    // particles (real time so they keep flying during hit-stop)
    const s = this.sp;
    const pd = realDt * (dt > 0 ? 1 : 0.35);
    for (let i = 0; i < this.sparkN; i++) {
      if (s.life[i] <= 0) {
        s.alpha[i] = 0;
        continue;
      }
      s.life[i] -= pd;
      const k = i * 3;
      s.vel[k + 1] -= 7 * s.grav[i] * pd;
      const drag = Math.exp(-3.2 * pd * (s.grav[i] < 0.5 ? 0.3 : 1));
      s.vel[k] *= drag; s.vel[k + 1] *= drag; s.vel[k + 2] *= drag;
      s.pos[k] += s.vel[k] * pd;
      s.pos[k + 1] += s.vel[k + 1] * pd;
      s.pos[k + 2] += s.vel[k + 2] * pd;
      s.alpha[i] = Math.max(0, s.life[i] / s.max[i]);
    }
    const ga = this.sparks.geometry.attributes;
    ga.position.needsUpdate = ga.aColor.needsUpdate = ga.aSize.needsUpdate = ga.aAlpha.needsUpdate = true;

    for (const r of this.rings) {
      if (!r.visible) continue;
      r.userData.t += realDt;
      const k = r.userData.t / r.userData.dur;
      if (k >= 1) { r.visible = false; continue; }
      r.scale.setScalar(0.05 + (1 - Math.pow(1 - k, 3)) * r.userData.size);
      r.material.opacity = k < 0.6 ? 1 : 0.5;
      r.lookAt(this.camera.position);
    }
    for (const st of this.stars) {
      if (!st.visible) continue;
      st.userData.t += realDt;
      const k = st.userData.t / st.userData.dur;
      if (k >= 1) { st.visible = false; continue; }
      // three-frame sprite animation: pop big, hold, shrink
      st.scale.setScalar(st.userData.size * (k < 0.25 ? 0.7 : k < 0.7 ? 1 : 0.55));
    }

    // world animation
    this.pulse *= Math.exp(-realDt * 6);
    this.hype *= Math.exp(-realDt * 0.9);
    this.crowd.material.uniforms.uTime.value = t;
    this.crowd.material.uniforms.uHype.value = this.hype;
    for (const m of this.ropeMats) m.color.lerp(m.userData.base, damp(5, realDt));
    for (const c of this.cones) {
      const ph = c.userData.phase;
      c.rotation.z = Math.sin(t * 0.5 + ph) * 0.18;
      c.rotation.x = Math.cos(t * 0.37 + ph) * 0.14;
      c.material.uniforms.uBoost.value = 1 + this.pulse * 0.5 + this.hype * 0.6;
    }
    this.board.visible = this.cam.shot !== 'attract'; // keep the title logo clean
    const chase = Math.floor(t * 8);
    this.bulbs.forEach((b, i) => b.material.color.setHex((i + chase) % 4 === 0 && this.hype > 0.3 ? 0xfff0a0 : 0xd8c890));

    // camera
    this.#shotTarget(realDt);
    const cam = this.camera;
    cam.position.copy(this.cam.pos);
    const tr = this.trauma * this.trauma;
    this.trauma = Math.max(0, this.trauma - realDt * 1.8);
    if (tr > 0) {
      cam.position.x += tr * 0.12 * noise(t * 31);
      cam.position.y += tr * 0.1 * noise(t * 29 + 7);
      cam.position.z += tr * 0.06 * noise(t * 23 + 3);
    }
    cam.lookAt(this.cam.look);
    if (tr > 0) cam.rotateZ(tr * 0.05 * noise(t * 17 + 11));
    this.fovKick *= Math.exp(-realDt * 9);
    this.cam.hfovNow += (this.cam.hfov - this.cam.hfovNow) * damp(this.cam.rate, realDt);
    const fov = this.#vfov(this.cam.hfovNow) * (1 + this.fovKick / 50);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
      this.#pointScale();
    }

    // palette flash snaps off in steps rather than fading smoothly
    this.flashAmt = this.flashAmt > 0.02 ? this.flashAmt * Math.exp(-realDt * 12) : 0;
    this.retro.uniforms.uFlashAmt.value = this.flashAmt > 0.12 ? this.flashAmt : this.flashAmt > 0.04 ? 0.06 : 0;
  }

  render() {
    this.composer.render();
    if (this.captureWanted) {
      this.captureWanted = false;
      const src = this.renderer.domElement;
      const c = this.captureCanvas;
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      this.hasCapture = true;
    }
  }

  capture() {
    this.captureWanted = true;
  }

  /** World position -> CSS px inside the arena container. */
  project(p) {
    _v.copy(p).project(this.camera);
    const s = this.pixel;
    return { x: (_v.x * 0.5 + 0.5) * this.w * s, y: (-_v.y * 0.5 + 0.5) * this.h * s };
  }
}

// -----------------------------------------------------------------------------
const noise = (x) => Math.sin(x) * 0.6 + Math.sin(x * 2.3 + 1.7) * 0.3 + Math.sin(x * 5.1 + 0.3) * 0.1;

let ramp = null;
function toonRamp() {
  if (!ramp) {
    ramp = new THREE.DataTexture(new Uint8Array([95, 175, 255]), 3, 1, THREE.RedFormat);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
    ramp.needsUpdate = true;
  }
  return ramp;
}

/**
 * The 16-bit look: quantize to a small per-channel palette with a 4x4 Bayer
 * ordered dither, so gradients and light shafts break into classic patterns.
 */
const RetroShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFlash: { value: new Color() },
    uFlashAmt: { value: 0 },
    uLevels: { value: 14 },
    uDither: { value: 0.9 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec3 uFlash; uniform float uFlashAmt, uLevels, uDither;
    varying vec2 vUv;
    float bayer4(vec2 p) {
      vec2 q = mod(floor(p), 4.0);
      int i = int(q.x) + int(q.y) * 4;
      const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
      return m[i] / 16.0;
    }
    vec3 toSRGB(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = mix(c, uFlash, uFlashAmt);
      c = toSRGB(c);
      float d = (bayer4(gl_FragCoord.xy) - 0.47) * uDither;
      c = floor(c * uLevels + d + 0.5) / uLevels;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

function makeConeMaterial(hex) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new Color(hex) }, uBoost: { value: 1 } },
    vertexShader: /* glsl */ `
      varying float vY; varying float vRim;
      void main(){
        vY = position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vRim = clamp(abs(dot(n, normalize(-mv.xyz))), 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uBoost; varying float vY; varying float vRim;
      void main(){
        float k = smoothstep(-5.3, 0.0, vY);
        gl_FragColor = vec4(uColor * k * 0.07 * vRim * vRim * uBoost, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
}

function pixelCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

function pixelTexture(c, nearest = true) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (nearest) {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
  }
  return tex;
}

/** Light canvas mat with a blue border and the center logo, like the SNES ring. */
function makeMatTexture(renderer) {
  const [c, g] = pixelCanvas(256, 256);
  g.fillStyle = '#6c7cc0';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#5e6cb0';
  for (let y = 0; y < 256; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < 256; x += 4) g.fillRect(x, y, 2, 2);
  g.fillStyle = '#182c90';
  g.fillRect(0, 0, 256, 14);
  g.fillRect(0, 242, 256, 14);
  g.fillRect(0, 0, 14, 256);
  g.fillRect(242, 0, 14, 256);
  g.fillStyle = '#f0f0f0';
  g.fillRect(14, 14, 228, 3);
  g.fillRect(14, 239, 228, 3);
  g.fillRect(14, 14, 3, 228);
  g.fillRect(239, 14, 3, 228);
  g.fillStyle = '#2040b8';
  g.beginPath();
  g.arc(128, 128, 40, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f8d030';
  g.font = `16px ${PIXEL_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('VB', 129, 129);
  const tex = pixelTexture(c, false);
  tex.magFilter = THREE.NearestFilter;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function makeApronTexture() {
  const [c, g] = pixelCanvas(256, 32);
  g.fillStyle = '#1830a0';
  g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#f0f0f0';
  g.fillRect(0, 2, 256, 2);
  g.fillRect(0, 28, 256, 2);
  g.font = `8px ${PIXEL_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#f8d030';
  g.fillText('VIRTUABOX  ★  WVBA', 128, 17);
  return pixelTexture(c);
}

function makeBoardTexture() {
  const [c, g] = pixelCanvas(160, 40);
  g.fillStyle = '#101010';
  g.fillRect(0, 0, 160, 40);
  g.fillStyle = '#383838';
  g.fillRect(0, 0, 160, 2);
  g.fillRect(0, 38, 160, 2);
  g.fillRect(0, 0, 2, 40);
  g.fillRect(158, 0, 2, 40);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `16px ${PIXEL_FONT}`;
  g.fillStyle = '#a01818';
  g.fillText('VIRTUABOX', 81, 16);
  g.fillStyle = '#f8d030';
  g.fillText('VIRTUABOX', 80, 15);
  g.font = `8px ${PIXEL_FONT}`;
  g.fillStyle = '#f0f0f0';
  g.fillText('WORLD CIRCUIT', 80, 31);
  return pixelTexture(c);
}

/** 32x32 hand-pixelled starburst with a black outline. */
function makeStarTexture() {
  const [c, g] = pixelCanvas(32, 32);
  const img = g.createImageData(32, 32);
  const put = (x, y, r, gg, b) => {
    const i = (y * 32 + x) * 4;
    img.data.set([r, gg, b, 255], i);
  };
  const inside = (x, y, grow) => {
    const dx = x - 15.5;
    const dy = y - 15.5;
    const a = Math.atan2(dy, dx);
    const r = Math.hypot(dx, dy);
    const spike = 6 + 9 * Math.pow(Math.abs(Math.cos(a * 4)), 6);
    return r < spike + grow;
  };
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const r = Math.hypot(x - 15.5, y - 15.5);
      if (inside(x, y, 0)) {
        if (r < 4) put(x, y, 255, 255, 255);
        else if (r < 7) put(x, y, 255, 255, 190);
        else put(x, y, 255, 255, 255);
      } else if (inside(x, y, 1.6)) {
        put(x, y, 0, 0, 0);
      }
    }
  }
  g.putImageData(img, 0, 0);
  return pixelTexture(c);
}
