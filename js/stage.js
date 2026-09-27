import * as THREE from './vendor/three.js';
import { neonLine, edgeLines, setLineResolution } from './boxer.js';

const { Vector3, Color } = THREE;

export const PLAYER_Z = 0.46;
export const OPP_Z = -0.46;
export const PLAYER_SCALE = 0.9; // Little-Mac-sized so the opponent reads above your head
const RING = 2.5; // half-size of the ring, posts sit on the corners

const _v = new Vector3();
const _v2 = new Vector3();
// fight camera: height, distance behind the player, look-at height
const CAM = (new URLSearchParams(location.search).get('cam') || '2.75,3.0,1.3,-0.3,28').split(',').map(Number);
const SHOT_HFOV = { fight: CAM[4] || 30, attract: 62, intro: 44, ko: 56, results: 56 };

const hdr = (hex, k) => new Color(hex).multiplyScalar(k);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Stage {
  constructor(container) {
    this.container = container;
    this.quality = 1;
    this.maxDpr = 2;
    this.time = 0;

    const renderer = (this.renderer = new THREE.WebGLRenderer({
      antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false,
    }));
    renderer.setClearColor(0x030008, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.id = 'gl';
    container.prepend(renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0020, 10, 42);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 250);

    // Composer buffers stay single-sampled: bloom composites additively into
    // its input, which breaks on MSAA targets (three invalidates them after
    // resolve, so tiled mobile GPUs flash black). MSAA lives in the scene pass.
    this.composer = new THREE.EffectComposer(renderer);
    this.composer.addPass(new MSAARenderPass(this.scene, this.camera, 4));
    this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.45, 0.78);
    this.composer.addPass(this.bloom);
    this.final = new THREE.ShaderPass(FinalShader);
    this.composer.addPass(this.final);

    this.#buildWorld();
    this.#buildFx();

    // camera state
    this.cam = {
      pos: new Vector3(0, 3, 7), look: new Vector3(0, 1.2, 0), fov: 55,
      shot: 'attract', shotT: 0, rate: 3, yaw: 0, dolly: 0, lift: 0, focus: null, hfov: 60, hfovNow: 60,
    };
    this.trauma = 0;
    this.fovKick = 0;
    this.aberr = 0;
    this.flashAmt = 0;
    this.hype = 0;
    this.pulse = 0;
    this.slowOrbit = 0;

    this.captureCanvas = document.createElement('canvas');
    this.captureWanted = false;

    this.frameTimes = [];
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  // ---------------------------------------------------------------------------
  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const dpr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, this.maxDpr) * this.quality);
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    setLineResolution(w * dpr, h * dpr, dpr);
    this.#pointScale();
  }

  /** Vertical FOV that keeps a horizontal FOV of `hfov` degrees whatever the aspect. */
  #vfov(hfov) {
    const v = 2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / this.camera.aspect) * (180 / Math.PI);
    return Math.min(70, Math.max(35, v));
  }

  #pointScale() {
    const pxScale = (this.h * this.dpr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    for (const m of this.pointMats) m.uniforms.uScale.value = pxScale;
  }

  /** Adaptive resolution: keep 60fps on phones by trading pixels for frames. */
  #adapt(realDt) {
    const ft = this.frameTimes;
    ft.push(realDt);
    if (ft.length < 90) return;
    const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
    ft.length = 0;
    if (avg > 0.024 && this.quality > 0.5) {
      this.quality = Math.max(0.5, this.quality - 0.15);
      this.resize();
    } else if (avg < 0.0135 && this.quality < 1 && !this.upgraded) {
      this.quality = Math.min(1, this.quality + 0.15);
      this.upgraded = this.quality >= 1;
      this.resize();
    }
  }

  // ---------------------------------------------------------------------------
  #buildWorld() {
    const scene = this.scene;
    this.pointMats = [];

    // sky dome
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(180, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { uTop: { value: new Color(0x020008) }, uHorizon: { value: new Color(0x2a0548) }, uGlow: { value: new Color(0xff2bd6) } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uHorizon, uGlow; varying vec3 vDir;
          void main(){
            float h = vDir.y;
            vec3 c = mix(uHorizon, uTop, smoothstep(-0.02, 0.45, h));
            c += uGlow * exp(-abs(h - 0.01) * 22.0) * 0.35;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    sky.renderOrder = -10;
    scene.add(sky);

    // stars
    {
      const n = 500;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const y = 0.08 + Math.random() * 0.9;
        const r = Math.sqrt(1 - y * y);
        pos.set([Math.cos(a) * r * 150, y * 150, Math.sin(a) * r * 150], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfaaff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8, depthWrite: false }));
      stars.renderOrder = -9;
      scene.add(stars);
    }

    // synthwave sun behind the opponent
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        fog: false, depthWrite: false, transparent: true,
        uniforms: { uTime: { value: 0 } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; varying vec2 vUv;
          void main(){
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            float glow = exp(-max(r - 0.62, 0.0) * 6.0) * 0.5;
            vec3 top = vec3(1.6, 0.62, 0.08), bot = vec3(1.1, 0.04, 0.62);
            vec3 col = mix(bot, top, smoothstep(0.1, 0.95, vUv.y));
            float inside = step(r, 0.62);
            float y = vUv.y;
            if (y < 0.56) {
              float k = (0.56 - y) / 0.56;
              float band = fract(y * 16.0 + uTime * 0.35);
              inside *= step(k * 0.75, band);
            }
            vec3 c = col * inside + vec3(0.7, 0.08, 0.4) * glow * (1.0 - inside);
            gl_FragColor = vec4(c, max(inside, glow));
          }`,
      }),
    );
    this.sun.scale.setScalar(46);
    this.sun.position.set(0, 7, -95);
    this.sun.renderOrder = -8;
    scene.add(this.sun);

    // endless scrolling grid floor
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.ShaderMaterial({
        fog: false,
        uniforms: { uTime: { value: 0 }, uPulse: { value: 0 }, uColor: { value: hdr('#b026ff', 1.4) } },
        vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: /* glsl */ `
          uniform float uTime, uPulse; uniform vec3 uColor; varying vec3 vW;
          void main(){
            vec2 q = vW.xz * 0.5 + vec2(0.0, uTime * 0.9);
            vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
            float line = 1.0 - min(min(g.x, g.y), 1.0);
            float d = length(vW.xz);
            float fade = exp(-d * 0.028);
            float near = smoothstep(3.0, 4.2, max(abs(vW.x), abs(vW.z)));
            vec3 c = uColor * line * (0.55 + uPulse * 0.9) * fade * near;
            c += vec3(0.05, 0.0, 0.09) * fade;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.62;
    scene.add(this.floor);

    // ring platform + mat
    const plat = new THREE.BoxGeometry(RING * 2 + 0.5, 0.6, RING * 2 + 0.5, 4, 1, 4);
    plat.translate(0, -0.3, 0);
    const platMesh = new THREE.Mesh(plat, new THREE.MeshBasicMaterial({ color: 0x07021a }));
    scene.add(platMesh);
    const platLines = new THREE.LineSegments2(edgeLines(plat), neonLine(hdr('#ff2bd6', 1.8), 2.2));
    scene.add(platLines);

    const mat = new THREE.Mesh(
      new THREE.PlaneGeometry(RING * 2 + 0.5, RING * 2 + 0.5),
      new THREE.MeshBasicMaterial({ map: makeMatTexture(this.renderer) }),
    );
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.002;
    scene.add(mat);

    // posts + ropes
    const postGeo = new THREE.CylinderGeometry(0.07, 0.09, 1.45, 6, 3, true);
    postGeo.translate(0, 0.725, 0);
    const postEdges = edgeLines(postGeo);
    const postFill = new THREE.MeshBasicMaterial({ color: 0x080016 });
    const postLine = neonLine(hdr('#ffffff', 1.1), 1.6);
    const capMat = new THREE.MeshBasicMaterial({ color: hdr('#ffe53d', 3) });
    const capGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => new Vector3(x * RING, 0, z * RING));
    for (const c of corners) {
      const post = new THREE.Mesh(postGeo, postFill);
      post.position.copy(c);
      const pl = new THREE.LineSegments2(postEdges, postLine);
      pl.position.copy(c);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.copy(c).setY(1.5);
      scene.add(post, pl, cap);
    }
    this.ropeMats = [];
    [[0.5, '#22e5ff'], [0.86, '#ffffff'], [1.22, '#ff2bd6']].forEach(([y, col]) => {
      const pts = [];
      for (const c of [...corners, corners[0]]) pts.push(c.x * 0.99, y, c.z * 0.99);
      const g = new THREE.LineGeometry();
      g.setPositions(pts);
      const m = neonLine(hdr(col, 0.55), 2.4);
      m.userData.base = hdr(col, 0.55);
      this.ropeMats.push(m);
      scene.add(new THREE.Line2(g, m));
    });

    // spotlight cones
    this.cones = [];
    const coneGeo = new THREE.ConeGeometry(1.7, 10, 28, 1, true);
    coneGeo.translate(0, -5, 0);
    [['#ff2bd6', -3.5, -3], ['#22e5ff', 3.5, -3], ['#b026ff', -3.5, 3.5], ['#3dff72', 3.5, 3.5]].forEach(([col, x, z], i) => {
      const m = new THREE.Mesh(coneGeo, makeConeMaterial(col));
      m.position.set(x, 10, z);
      m.userData.phase = i * 1.7;
      m.renderOrder = 5;
      this.cones.push(m);
      scene.add(m);
    });

    // crowd: thousands of point-people with camera flashes
    {
      const n = 3600;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      const pal = ['#ff2bd6', '#22e5ff', '#ffe53d', '#3dff72', '#b026ff', '#ffffff'].map((c) => new Color(c));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 6.2 + Math.pow(Math.random(), 0.8) * 9;
        // squarish arena: stretch radius toward the corners
        const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
        const rr = r * (0.75 + 0.25 * sq);
        const row = Math.floor((r - 6.2) / 0.7);
        pos.set([Math.cos(a) * rr, -0.3 + row * 0.42 + Math.random() * 0.12, Math.sin(a) * rr], i * 3);
        const c = pal[Math.floor(Math.random() * pal.length)];
        const k = 0.35 + Math.random() * 0.5;
        col.set([c.r * k, c.g * k, c.b * k], i * 3);
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uHype: { value: 0 }, uScale: { value: 500 } },
        vertexShader: /* glsl */ `
          attribute vec3 aColor; attribute float aSeed;
          uniform float uTime, uHype, uScale;
          varying vec3 vColor;
          void main(){
            vec3 p = position;
            p.y += max(0.0, sin(uTime * (9.0 + aSeed * 5.0) + aSeed * 40.0)) * (0.03 + uHype * 0.22);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float slot = floor(uTime * 12.0);
            float h = fract(sin(aSeed * 917.3 + slot * 13.17) * 43758.5453);
            float flash = step(0.9975 - uHype * 0.012, h);
            float fade = exp(-length(p.xz) * 0.035);
            vColor = aColor * (0.6 + 0.4 * sin(uTime * 2.5 + aSeed * 30.0)) * fade + vec3(flash * 5.0);
            gl_PointSize = (0.11 + flash * 0.22) * uScale / max(-mv.z, 0.2);
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          void main(){
            float d = length(gl_PointCoord - 0.5);
            if (d > 0.5) discard;
            gl_FragColor = vec4(vColor * (1.0 - smoothstep(0.15, 0.5, d)), 1.0);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      this.pointMats.push(m);
      this.crowd = new THREE.Points(g, m);
      this.crowd.renderOrder = 4;
      scene.add(this.crowd);
    }

    // rising embers
    {
      const n = 260;
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pos.set([(Math.random() - 0.5) * 16, Math.random() * 7, (Math.random() - 0.5) * 16], i * 3);
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uScale: { value: 500 } },
        vertexShader: /* glsl */ `
          attribute float aSeed; uniform float uTime, uScale; varying float vA; varying float vS;
          void main(){
            vec3 p = position;
            p.y = mod(p.y + uTime * (0.25 + aSeed * 0.5), 7.0);
            p.x += sin(uTime * 0.7 + aSeed * 20.0) * 0.3;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            vA = sin(p.y / 7.0 * 3.14159);
            vS = aSeed;
            gl_PointSize = (0.025 + aSeed * 0.03) * uScale / max(-mv.z, 0.2);
          }`,
        fragmentShader: /* glsl */ `
          varying float vA; varying float vS;
          void main(){
            float d = length(gl_PointCoord - 0.5);
            vec3 c = mix(vec3(2.0, 0.3, 1.6), vec3(0.3, 1.6, 2.0), step(0.5, vS));
            gl_FragColor = vec4(c * (1.0 - smoothstep(0.0, 0.5, d)) * max(vA, 0.0), 1.0);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      this.pointMats.push(m);
      this.embers = new THREE.Points(g, m);
      this.embers.renderOrder = 6;
      scene.add(this.embers);
    }

    // giant neon sign
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 2.25),
      new THREE.MeshBasicMaterial({ map: makeSignTexture(), color: new Color(2.2, 2.2, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    sign.position.set(0, 5.4, -11);
    sign.renderOrder = 3;
    this.sign = sign;
    scene.add(sign);
  }

  // ---------------------------------------------------------------------------
  #buildFx() {
    // sparks + glows share one additive point pool
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
      uniforms: { uScale: { value: 500 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        uniform float uScale; varying vec3 vColor; varying float vAlpha;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aAlpha > 0.0 ? min(aSize * uScale / max(-mv.z, 0.2), 512.0) : 0.0;
          vColor = aColor; vAlpha = aAlpha;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vAlpha;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.pointMats.push(m);
    this.sparks = new THREE.Points(g, m);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 60;
    this.scene.add(this.sparks);

    // shockwave rings
    const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
    this.rings = Array.from({ length: 8 }, () => {
      const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: new Color(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false,
      }));
      r.visible = false;
      r.renderOrder = 61;
      r.userData = { t: 0, dur: 0.35, size: 1 };
      this.scene.add(r);
      return r;
    });

    // Punch-Out style impact stars
    const starTex = makeStarTexture();
    this.stars = Array.from({ length: 6 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, color: new Color(), blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, fog: false }));
      s.visible = false;
      s.renderOrder = 62;
      s.userData = { t: 0, dur: 0.22, size: 1 };
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
    const col = hdr(colorHex, 2.2);
    const soft = hdr(colorHex, 0.9);
    const white = new Color(3, 3, 3);
    const n = Math.floor(24 + power * 30);
    for (let i = 0; i < n; i++) {
      _v.randomDirection().multiplyScalar(1.5 + Math.random() * 5 * Math.sqrt(power));
      _v.z += 1.2 * Math.sign(pos.z - this.camera.position.z) * -0.2;
      this.spawn(pos, _v, Math.random() < 0.3 ? white : col, 0.015 + Math.random() * 0.03, 0.25 + Math.random() * 0.45);
    }
    // core flash + halo
    this.spawn(pos, _v.set(0, 0, 0), white, 0.1 + power * 0.04, 0.09, 0);
    this.spawn(pos, _v.set(0, 0, 0), soft, 0.22 + power * 0.08, 0.16, 0);
    this.ring(pos, col, 0.3 + power * 0.16);
    if (power > 1.4) this.ring(pos, white, 0.25 + power * 0.25, 0.5);
    this.star(pos, col, 0.16 + power * 0.08);

    this.shake(0.28 + power * 0.18);
    this.fovKick = -3 - power * 2.5;
    this.aberr = Math.min(0.03, this.aberr + 0.008 + power * 0.005);
    this.flash(soft, Math.min(0.1, 0.02 + power * 0.025));
    this.hype = Math.min(1, this.hype + 0.35 * power);
    for (const m of this.ropeMats) m.color.setScalar(1.6);
  }

  clash(pos) {
    const cyan = new Color(1, 2.6, 3);
    const white = new Color(3, 3, 3);
    for (let i = 0; i < 70; i++) {
      _v.randomDirection();
      _v.z *= 0.3;
      _v.multiplyScalar(2 + Math.random() * 5);
      this.spawn(pos, _v, Math.random() < 0.5 ? white : cyan, 0.015 + Math.random() * 0.03, 0.2 + Math.random() * 0.35, 0.6);
    }
    this.spawn(pos, _v.set(0, 0, 0), white, 0.22, 0.14, 0);
    this.ring(pos, cyan, 0.55, 0.3);
    this.ring(pos, white, 0.3, 0.25);
    this.star(pos, cyan, 0.28);
    this.shake(0.35);
    this.fovKick = -2;
    this.aberr = 0.02;
    this.flash(cyan, 0.08);
  }

  ring(pos, color, size, dur = 0.35) {
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
    s.material.rotation = Math.random() * Math.PI;
    s.userData.t = 0;
    s.userData.size = size;
  }

  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  flash(color, amt) {
    this.final.uniforms.uFlash.value.copy(color);
    this.flashAmt = Math.max(this.flashAmt, amt);
  }

  beat(strength = 1) {
    this.pulse = Math.max(this.pulse, 0.6 * strength);
  }

  // ---------------------------------------------------------------------------
  /**
   * Camera shots: 'attract' | 'fight' | 'intro' | 'ko' | 'results'.
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
    const fight = () => {
      const [cy, cr, ly, cx = 0] = CAM;
      const yaw = c.yaw + Math.sin(t * 0.4) * 0.03;
      const r = cr - c.dolly;
      pos.set(cx + Math.sin(yaw) * r, cy + c.lift, PLAYER_Z + Math.cos(yaw) * r);
      look.set(Math.sin(yaw) * -0.3, ly + c.lift * 0.3, OPP_Z + 0.05);
    };
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
      default:
        fight();
    }
    const k = snap ? 1 : damp(c.rate, dt);
    c.pos.lerp(pos, k);
    c.look.lerp(look, k);
  }

  // ---------------------------------------------------------------------------
  update(dt, realDt) {
    this.time += realDt;
    const t = this.time;
    this.#adapt(realDt);

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
      const drag = Math.exp(-3.2 * pd);
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
      const e = 1 - Math.pow(1 - k, 3);
      r.scale.setScalar(0.05 + e * r.userData.size);
      r.material.opacity = 1 - k;
      r.lookAt(this.camera.position);
    }
    for (const st of this.stars) {
      if (!st.visible) continue;
      st.userData.t += realDt;
      const k = st.userData.t / st.userData.dur;
      if (k >= 1) { st.visible = false; continue; }
      st.scale.setScalar(st.userData.size * Math.sin(Math.min(1, k * 1.3) * Math.PI) + 0.01);
      st.material.rotation += realDt * 3;
    }

    // world animation
    this.pulse *= Math.exp(-realDt * 6);
    this.hype *= Math.exp(-realDt * 0.9);
    this.crowd.material.uniforms.uTime.value = t;
    this.crowd.material.uniforms.uHype.value = this.hype;
    this.embers.material.uniforms.uTime.value = t;
    this.floor.material.uniforms.uTime.value = t;
    this.floor.material.uniforms.uPulse.value = this.pulse;
    this.sun.material.uniforms.uTime.value = t;
    this.sign.material.color.setScalar(1.8 + this.pulse * 1.5 + Math.sin(t * 23) * 0.08);
    for (const m of this.ropeMats) m.color.lerp(m.userData.base, damp(5, realDt));
    for (const c of this.cones) {
      const ph = c.userData.phase;
      c.rotation.z = Math.sin(t * 0.5 + ph) * 0.28;
      c.rotation.x = Math.cos(t * 0.37 + ph) * 0.22;
      c.material.uniforms.uBoost.value = 1 + this.pulse * 0.6 + this.hype * 0.8;
    }

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
    if (tr > 0) cam.rotateZ(tr * 0.06 * noise(t * 17 + 11));
    this.fovKick *= Math.exp(-realDt * 9);
    this.cam.hfovNow += (this.cam.hfov - this.cam.hfovNow) * damp(this.cam.rate, realDt);
    const fov = this.#vfov(this.cam.hfovNow) * (1 + this.fovKick / 50);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
      this.#pointScale();
    }

    // post
    this.aberr += (0.0018 - this.aberr) * damp(6, realDt);
    this.flashAmt *= Math.exp(-realDt * 10);
    const u = this.final.uniforms;
    u.uAberr.value = this.aberr;
    u.uFlashAmt.value = this.flashAmt;
    this.bloom.strength = 0.8 + this.pulse * 0.2 + this.flashAmt * 0.8;
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
    return { x: (_v.x * 0.5 + 0.5) * this.w, y: (-_v.y * 0.5 + 0.5) * this.h };
  }
}

// -----------------------------------------------------------------------------
/** Renders the scene into its own multisampled target, then copies it out. */
class MSAARenderPass extends THREE.Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
    this.copy = new THREE.FullScreenQuad(new THREE.MeshBasicMaterial({
      map: this.rt.texture, depthTest: false, depthWrite: false, toneMapped: false,
    }));
  }

  setSize(w, h) {
    this.rt.setSize(w, h);
  }

  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.copy.render(renderer);
  }
}

const noise = (x) => Math.sin(x) * 0.6 + Math.sin(x * 2.3 + 1.7) * 0.3 + Math.sin(x * 5.1 + 0.3) * 0.1;

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAberr: { value: 0.002 },
    uFlash: { value: new Color() },
    uFlashAmt: { value: 0 },
    uVig: { value: 1.25 },
    uScan: { value: 0.07 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uAberr, uFlashAmt, uVig, uScan; uniform vec3 uFlash;
    varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * uAberr * (1.0 + r2 * 5.0);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(gl_FragCoord.y * 1.5708));
      col *= clamp(1.0 - r2 * uVig, 0.0, 1.0);
      col += uFlash * uFlashAmt;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
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
        float k = smoothstep(-10.0, 0.0, vY);
        float a = k * k * 0.06 * vRim * vRim * uBoost;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
}

function makeMatTexture(renderer) {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(512, 512, 60, 512, 512, 720);
  grad.addColorStop(0, '#1a0a44');
  grad.addColorStop(1, '#07021a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = 'rgba(120, 90, 255, 0.35)';
  g.lineWidth = 2;
  for (let i = 0; i <= 1024; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(1024, i); g.stroke();
  }
  g.shadowColor = '#ff2bd6';
  g.shadowBlur = 24;
  g.strokeStyle = '#ff5ae0';
  g.lineWidth = 10;
  g.strokeRect(40, 40, 944, 944);
  g.shadowColor = '#22e5ff';
  g.strokeStyle = '#6ff0ff';
  g.lineWidth = 6;
  g.beginPath(); g.arc(512, 512, 170, 0, Math.PI * 2); g.stroke();
  g.font = '900 92px Orbitron, "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(160, 255, 200, 0.55)';
  g.shadowColor = '#3dff72';
  g.fillText('VB', 512, 516);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function makeSignTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic 900 150px Orbitron, "Arial Black", sans-serif';
  for (const [blur, col, w] of [[40, '#ff2bd6', 14], [16, '#ff5ae0', 8], [0, '#ffd6f6', 3]]) {
    g.shadowColor = col;
    g.shadowBlur = blur;
    g.strokeStyle = col;
    g.lineWidth = w;
    g.strokeText('VIRTUABOX', 512, 132);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStarTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  const spikes = 8;
  g.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 ? 16 : 62;
    const a = (i / (spikes * 2)) * Math.PI * 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 62);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
