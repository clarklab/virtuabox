import * as THREE from './vendor/three.js';
import { pixelLine, outlineMaterial, setLineResolution } from './boxer.js';
import { buildVenues, VENUE_CONFIG } from './venues.js';

const { Vector3, Color } = THREE;

export const PLAYER_Z = 0.46;
export const OPP_Z = -0.46;
export const PLAYER_SCALE = 0.9; // Little-Mac-sized so the opponent reads above your head
const RING = 2.5; // half-size of the ring, posts sit on the corners
const PIXEL_ROWS = 232; // target vertical resolution, SNES-ish (224..240)
const PIXEL_FONT = '"Press Start 2P", monospace';

const _v = new Vector3();
const _v2 = new Vector3();
const _shadow = new Vector3();

// fight camera: height, distance behind the player, look-at height, x offset, horizontal fov
const CAM = (new URLSearchParams(location.search).get('cam') || '2.2,3.3,1.4,-0.22,28').split(',').map(Number);
const SHOT_HFOV = { fight: CAM[4] || 30, attract: 58, intro: 48, ko: 51, results: 50 };

const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Stage {
  constructor(container) {
    this.container = container;
    this.time = 0;
    this.reducedMotion = false;
    this.fighters = [null, null];

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
    this.ambient = new THREE.HemisphereLight(0xdde4ff, 0x302838, 0.95);
    this.scene.add(this.ambient);
    const key = (this.keyLight = new THREE.DirectionalLight(0xffffff, 1.65));
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
    this.venue('pete');

    this.captureCanvas = document.createElement('canvas');
    this.captureWanted = false;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  /** Settings and camera effects share one reduced-motion switch. */
  setMotion(reduced) {
    this.reducedMotion = !!reduced;
    if (this.reducedMotion) {
      this.trauma = this.fovKick = this.flashAmt = this.pulse = 0;
      this.retro.uniforms.uFlashAmt.value = 0;
      for (const c of this.cones) c.rotation.set(0, 0, 0);
      for (const r of this.rings) r.visible = false;
      for (const star of this.stars) star.visible = false;
      this.sp.life.fill(0);
      this.sp.alpha.fill(0);
      this.sparks.geometry.attributes.aAlpha.needsUpdate = true;
      if (this.cam.shot === 'custom') this.shot('fight', { snap: true });
    }
  }

  /** Called when opponents change; no scene traversal or allocation per frame. */
  trackFighters(player, opponent) {
    this.fighters[0] = player;
    this.fighters[1] = opponent;
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
    this.sky = sky;

    // arena floor + tiered stands
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ color: 0x14143a }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.62;
    scene.add(floor);
    this.floor = floor;
    const stands = new THREE.Mesh(
      new THREE.CylinderGeometry(15.5, 7.2, 7.5, 32, 10, true),
      new THREE.MeshBasicMaterial({ color: 0x0c0c26, side: THREE.BackSide }),
    );
    stands.position.y = 3.1;
    scene.add(stands);
    this.stands = stands;

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
    this.apronMats = platMesh.material;
    const mat = new THREE.Mesh(
      new THREE.PlaneGeometry(RING * 2 + 0.5, RING * 2 + 0.5),
      new THREE.MeshBasicMaterial({ map: makeMatTexture(this.renderer) }),
    );
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.002;
    scene.add(mat);
    this.ringCanvas = mat;
    this.venueTextures = {};

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
    const arenaRig = (this.arenaRig = new THREE.Group());
    scene.add(arenaRig);
    const trussMat = new THREE.MeshBasicMaterial({ color: 0x3a3a58 });
    for (const [sx, sz, len, rot] of [[0, -1, 7, 0], [0, 1, 7, 0], [-1, 0, 7, 1], [1, 0, 7, 1]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.12), trussMat);
      bar.position.set(sx * 3.5, 5.2, sz * 3.5);
      bar.rotation.y = rot * Math.PI / 2;
      arenaRig.add(bar);
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
      arenaRig.add(b);
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
        uniforms: { uTime: { value: 0 }, uHype: { value: 0 }, uScale: { value: 300 }, uMotion: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute vec3 aColor; attribute float aSeed;
          uniform float uTime, uHype, uScale, uMotion;
          varying vec3 vColor;
          void main(){
            vec3 p = position;
            p.y += step(0.0, sin(uTime * (7.0 + aSeed * 4.0) + aSeed * 40.0)) * (0.02 + uHype * 0.16) * uMotion;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float slot = floor(uTime * 10.0);
            float h = fract(sin(aSeed * 917.3 + slot * 13.17) * 43758.5453);
            float flash = step(0.9965 - uHype * 0.012, h) * uMotion;
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

    // training gym dressing: heavy bags on chains and a banner instead of the jumbotron
    const gym = (this.gym = new THREE.Group());
    gym.visible = false;
    this.bags = [];
    const bagGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.15, 12, 3);
    const capGeo = new THREE.CylinderGeometry(0.22, 0.3, 0.12, 12);
    capGeo.translate(0, 0.63, 0);
    const chainMat = pixelLine('#8890a8', 1);
    [[-5.3, -2.2, '#c82020'], [5.5, -2.8, '#2848c8'], [-4.4, -6.2, '#383848'], [4.0, -6.8, '#c82020']].forEach(([x, z, col], i) => {
      const bag = new THREE.Group();
      bag.position.set(x, 4.6, z);
      const body = new THREE.Group();
      body.position.y = -3.25;
      body.add(new THREE.Mesh(bagGeo, toon(col)), new THREE.Mesh(bagGeo, ink));
      body.add(new THREE.Mesh(capGeo, toon('#202028')), new THREE.Mesh(capGeo, ink));
      const chain = new THREE.LineGeometry();
      chain.setPositions([0, 0, 0, 0, -2.6, 0]);
      bag.add(body, new THREE.Line2(chain, chainMat));
      bag.userData.phase = i * 1.7;
      this.bags.push(bag);
      gym.add(bag);
    });
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 2),
      new THREE.MeshBasicMaterial({ map: makeGymTexture(), fog: false }),
    );
    banner.position.set(0, 2.4, -7.16);
    banner.scale.set(0.82, 0.72, 1);
    gym.add(banner);
    scene.add(gym);

    this.venueGroups = buildVenues(scene);
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    this.contactShadows = [0, 1].map(() => {
      const material = new THREE.ShaderMaterial({
        uniforms: { uOpacity: { value: 0.27 } },
        vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'uniform float uOpacity; varying vec2 vUv; void main(){float r=length((vUv-0.5)*2.0);float a=(1.0-smoothstep(0.15,1.0,r))*uOpacity;gl_FragColor=vec4(0.035,0.045,0.07,a);}',
        transparent: true, depthWrite: false,
      });
      const shadow = new THREE.Mesh(shadowGeo, material);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.007;
      shadow.visible = false;
      shadow.renderOrder = 1;
      scene.add(shadow);
      return shadow;
    });
  }

  /** 'arena' aliases the dome; venueName always exposes the canonical key. */
  venue(name) {
    const key = name === 'arena' ? 'volt' : VENUE_CONFIG[name] ? name : 'pete';
    const theme = VENUE_CONFIG[key];
    const gym = key === 'gym', dome = key === 'volt';
    this.venueName = key;
    this.venueTheme = theme;
    for (const [id, group] of Object.entries(this.venueGroups)) group.visible = id === key;
    this.gym.visible = gym;
    this.crowd.visible = dome;
    this.stands.visible = dome;
    this.arenaRig.visible = dome;
    this.board.visible = dome && this.cam?.shot !== 'attract';
    this.sky.material.uniforms.uTop.value.set(theme.top);
    this.sky.material.uniforms.uHorizon.value.set(theme.horizon);
    this.scene.fog.color.set(theme.fog);
    this.scene.fog.near = key === 'nova' ? 21 : 12;
    this.scene.fog.far = key === 'nova' ? 65 : 34;
    this.floor.material.color.set(theme.floor);
    this.ambient.color.set(theme.skyLight);
    this.ambient.groundColor.set(theme.groundLight);
    this.keyLight.color.set(theme.keyLight);
    this.ropeMats.forEach((m, i) => { m.userData.base.set(theme.ropes[i]); m.color.copy(m.userData.base); });
    this.cones.forEach((c, i) => {
      c.visible = dome && i < 2;
      c.material.uniforms.uColor.value.set(theme.beam);
    });
    for (const bulb of this.bulbs) bulb.material.color.set(theme.bulb);
    if (!this.venueTextures[key]) this.venueTextures[key] = { mat: makeMatTexture(this.renderer, theme), apron: makeApronTexture(theme) };
    const textures = this.venueTextures[key];
    this.ringCanvas.material.map = textures.mat;
    for (let i = 0; i < this.apronMats.length; i++) {
      if (i === 2 || i === 3) this.apronMats[i].color.set(theme.border);
      else this.apronMats[i].map = textures.apron;
    }
  }

  /**
   * Render a head-and-shoulders portrait of `root` at `size` pixels through the
   * same palette/dither pass as the ring, so menu art matches the 3D models.
   * `facing` is +1 when the boxer faces +z (the opponent), -1 for the player.
   */
  portrait(root, head, facing = 1, { size = 48, bg = 0x101058, dist = 1.15, fov = 36 } = {}) {
    const vis = this.scene.children.map((o) => o.visible);
    this.scene.children.forEach((o) => { o.visible = o === root || !!o.isLight; });
    const clear = this.renderer.getClearColor(new Color());
    this.renderer.setClearColor(bg, 1);
    const cam = this.camera;
    const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };
    const flash = this.retro.uniforms.uFlashAmt.value;
    this.retro.uniforms.uFlashAmt.value = 0;

    this.renderer.setSize(size, size, false);
    this.composer.setSize(size, size);
    setLineResolution(size, size, 1);
    cam.aspect = 1;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.position.set(head.x + 0.14 * facing, head.y + 0.05, head.z + dist * facing);
    cam.lookAt(head.x, head.y + 0.01, head.z);
    this.composer.render();
    const [c, g] = pixelCanvas(size, size);
    g.drawImage(this.renderer.domElement, 0, 0);

    this.scene.children.forEach((o, i) => { o.visible = vis[i]; });
    this.renderer.setClearColor(clear, 1);
    this.retro.uniforms.uFlashAmt.value = flash;
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    this.resize();
    return c;
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
        uniform float uScale; varying vec3 vColor; varying float vAlive;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // shrink in whole-pixel steps as the spark dies
          float px = floor(aSize * uScale / max(-mv.z, 0.2) * (0.35 + 0.65 * aAlpha) + 0.5);
          gl_PointSize = aAlpha > 0.0 ? clamp(px, 1.0, 64.0) : 0.0;
          vColor = aColor;
          vAlive = aAlpha;
        }`,
      // A zero point size may be clamped to one pixel by WebGL; discard dead
      // particles explicitly so old confetti never becomes permanent snow.
      fragmentShader: /* glsl */ `varying vec3 vColor; varying float vAlive; void main(){ if(vAlive <= 0.0) discard; gl_FragColor = vec4(vColor, 1.0); }`,
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
    if (this.reducedMotion) return;
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
    if (!this.reducedMotion) for (const m of this.ropeMats) m.color.setScalar(1);
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

  /** SUPER charge: sparks spiral into the glove; each `level` (1..3) grows the aura. */
  charge(pos, level) {
    const pal = [new Color('#ffffff'), new Color('#f8e060'), new Color('#f8a800')];
    const n = 26 + level * 16;
    for (let i = 0; i < n; i++) {
      _v.randomDirection().multiplyScalar(0.5 + Math.random() * 0.5);
      _v2.copy(pos).add(_v);
      const life = 0.26 + Math.random() * 0.14;
      _v.multiplyScalar(-1.2 / life);
      this.spawn(_v2, _v, pal[i % 3], 0.016 + 0.008 * level, life, 0);
    }
    this.ring(pos, pal[1], 0.22 + level * 0.12, 0.36);
    this.star(pos, pal[0], 0.18 + level * 0.1);
    this.shake(0.1 + level * 0.08);
    this.flash(pal[1], 0.07 + level * 0.04);
    this.hype = Math.min(1, this.hype + 0.3);
  }

  /** The SUPER connects: a geyser of sparks, stacked shockwaves and a white-out. */
  superHit(pos, level) {
    this.impact(pos, '#f8d830', 3);
    const pal = [new Color('#ffffff'), new Color('#f8e060'), new Color('#f8a800'), new Color('#58f858')];
    for (let i = 0; i < 80 + level * 40; i++) {
      _v.set((Math.random() - 0.5) * 2.4, 2 + Math.random() * 6, (Math.random() - 0.5) * 2.4);
      this.spawn(pos, _v, pal[i % 4], 0.024 + Math.random() * 0.022, 0.5 + Math.random() * 0.6, 0.7);
    }
    [0.55, 0.85, 1.2].forEach((sz, i) => this.ring(pos, pal[i % 3], sz * (0.75 + level * 0.15), 0.3 + i * 0.14));
    this.star(pos, pal[0], 0.9);
    this.flash(pal[0], 0.55);
    this.shake(1);
    this.fovKick = -16;
    this.hype = 1;
  }

  /** A dodged punch: a white swish where your head used to be. */
  whiff(pos) {
    const white = new Color('#ffffff');
    const pale = new Color('#a0e8ff');
    for (let i = 0; i < 18; i++) {
      _v.randomDirection();
      _v.y *= 0.4;
      _v.multiplyScalar(1 + Math.random() * 2);
      this.spawn(pos, _v, i % 3 ? pale : white, 0.016, 0.18 + Math.random() * 0.15, 0);
    }
    this.ring(pos, white, 0.3, 0.22);
    this.shake(0.12);
  }

  /** Knockout confetti rains from the rafters. */
  confetti(count = 220) {
    const pal = ['#e83030', '#3060e8', '#f8d030', '#30b848', '#f0f0f0', '#f048b0'].map((c) => new Color(c));
    for (let i = 0; i < count; i++) {
      _v2.set((Math.random() - 0.5) * 6, 4 + Math.random() * 2.5, (Math.random() - 0.5) * 6);
      _v.set((Math.random() - 0.5) * 1.5, -Math.random(), (Math.random() - 0.5) * 1.5);
      this.spawn(_v2, _v, pal[i % pal.length], 0.035, 2.5 + Math.random() * 1.5, 0.12);
    }
  }

  ring(pos, color, size, dur = 0.3) {
    if (this.reducedMotion) return;
    const r = this.rings.find((x) => !x.visible) || this.rings[0];
    r.visible = true;
    r.position.copy(pos);
    r.material.color.copy(color);
    r.userData.t = 0;
    r.userData.dur = dur;
    r.userData.size = size;
  }

  star(pos, color, size) {
    if (this.reducedMotion) return;
    const s = this.stars.find((x) => !x.visible) || this.stars[0];
    s.visible = true;
    s.position.copy(pos);
    s.material.color.copy(color);
    s.material.rotation = Math.floor(Math.random() * 4) * (Math.PI / 4);
    s.userData.t = 0;
    s.userData.size = size;
  }

  shake(amount) {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  flash(color, amt) {
    if (this.reducedMotion) return;
    this.retro.uniforms.uFlash.value.copy(color);
    this.flashAmt = Math.max(this.flashAmt, amt);
  }

  beat(strength = 1) {
    if (this.reducedMotion) return;
    this.pulse = Math.max(this.pulse, 0.6 * strength);
  }

  // ---------------------------------------------------------------------------
  /**
   * Camera shots: 'attract' | 'fight' | 'intro' | 'ko' | 'results' | 'custom'.
   * opts.yaw / opts.dolly / opts.lift nudge the fight shot per exchange.
   */
  shot(name, opts = {}) {
    const c = this.cam;
    if (this.reducedMotion && name === 'custom') name = 'fight';
    c.shot = name;
    c.shotT = 0;
    c.rate = opts.rate ?? 4;
    c.yaw = opts.yaw ?? 0;
    c.dolly = opts.dolly ?? 0;
    c.lift = opts.lift ?? 0;
    c.focus = opts.focus ?? null;
    c.hfov = this.reducedMotion && name === 'fight' ? SHOT_HFOV.fight : opts.hfov ?? SHOT_HFOV[name] ?? 50;
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
        const a = this.reducedMotion ? 0.35 : 0.35 + Math.sin(t * 0.075) * 0.48;
        pos.set(Math.sin(a) * 5.5, 2.7, Math.cos(a) * 5.5);
        look.set(0, 1.15, 0);
        break;
      }
      case 'intro': {
        // Establish the room, then settle on the challenger. The final view
        // keeps their full crest and gloves in frame even on a narrow screen.
        const k = this.reducedMotion ? 1 : Math.min(1, Math.max(0, c.shotT - 0.4) / 1.8);
        const e = k * k * (3 - 2 * k);
        const fx = c.focus?.x ?? 0, fy = c.focus?.y ?? 1.6, fz = c.focus?.z ?? OPP_Z;
        pos.set(3.15 - e * 2.7, 3.15 - e * 1.08, 5.1 - e * 2.22);
        look.set(fx, 1.3 + (fy - 0.12 - 1.3) * e, -2.1 + (fz + 2.1) * e);
        break;
      }
      case 'ko': {
        const fx = c.focus?.x ?? 0, fz = c.focus?.z ?? OPP_Z;
        const side = c.yaw >= 0 ? 1 : -1;
        const settle = this.reducedMotion ? 1 : Math.min(1, c.shotT / 0.8);
        pos.set(fx + side * (2.6 - settle * 0.18), 1.55, fz + side * 1.6);
        look.set(fx, 0.4, fz - side * 0.82);
        break;
      }
      case 'custom':
        pos.copy(c.customPos);
        look.copy(c.customLook);
        break;
      case 'results': {
        pos.set(2.45, 2.1, 4.05);
        look.set(0, 1.1, 0);
        break;
      }
      default: {
        const [cy, cr, ly, cx = 0] = CAM;
        const yaw = this.reducedMotion ? 0 : c.yaw;
        const lift = this.reducedMotion ? 0 : Math.min(0.14, Math.max(-0.1, c.lift));
        const r = cr - (this.reducedMotion ? 0 : Math.min(0.08, c.dolly));
        pos.set(cx + Math.sin(yaw) * r, cy + lift, PLAYER_Z + Math.cos(yaw) * r);
        look.set(Math.sin(yaw) * -0.3, ly + lift * 0.3, OPP_Z + 0.05);
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
    this.crowd.material.uniforms.uHype.value = this.reducedMotion ? 0 : this.hype;
    this.crowd.material.uniforms.uMotion.value = this.reducedMotion ? 0 : 1;
    for (const m of this.ropeMats) m.color.lerp(m.userData.base, damp(5, realDt));
    for (const c of this.cones) {
      const ph = c.userData.phase;
      c.rotation.z = this.reducedMotion ? 0 : Math.sin(t * 0.23 + ph) * 0.08;
      c.rotation.x = this.reducedMotion ? 0 : Math.cos(t * 0.19 + ph) * 0.06;
      c.material.uniforms.uBoost.value = this.reducedMotion ? 0.65 : 0.8 + this.pulse * 0.1 + this.hype * 0.12;
    }
    this.board.visible = this.cam.shot !== 'attract' && this.venueName === 'volt';
    if (this.gym.visible) for (const b of this.bags) b.rotation.z = this.reducedMotion ? 0 : Math.sin(t * 0.65 + b.userData.phase) * 0.025;
    for (let i = 0; i < this.contactShadows.length; i++) {
      const fighter = this.fighters[i], shadow = this.contactShadows[i];
      shadow.visible = !!fighter && fighter.root.visible;
      if (!fighter) continue;
      const fall = Math.min(1, Math.abs(fighter.rig.rotation.x) / 1.5);
      const height = Math.max(0, fighter.rig.position.y);
      _shadow.set(fighter.rig.position.x, 0, fighter.rig.position.z - fall * 0.62).applyMatrix4(fighter.root.matrixWorld);
      shadow.position.set(_shadow.x, 0.007, _shadow.z);
      shadow.scale.set((0.66 + fall * 0.28) * fighter.bulk, 0.57 + fall * 1.05, 1);
      shadow.material.uniforms.uOpacity.value = Math.max(0.035, 0.26 - height * 0.1);
    }

    // camera
    this.#shotTarget(realDt);
    const cam = this.camera;
    cam.position.copy(this.cam.pos);
    if (this.reducedMotion) this.trauma = this.fovKick = this.flashAmt = 0;
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
    uLevels: { value: 16 },
    uDither: { value: 0.55 },
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
        gl_FragColor = vec4(uColor * k * 0.018 * vRim * vRim * uBoost, 1.0);
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
function makeMatTexture(renderer, theme = VENUE_CONFIG.volt) {
  const [c, g] = pixelCanvas(256, 256);
  g.fillStyle = theme.canvas;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = theme.fleck;
  for (let y = 0; y < 256; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < 256; x += 8) g.fillRect(x, y, 1, 1);
  g.fillStyle = theme.border;
  g.fillRect(0, 0, 256, 14);
  g.fillRect(0, 242, 256, 14);
  g.fillRect(0, 0, 14, 256);
  g.fillRect(242, 0, 14, 256);
  g.fillStyle = '#d5d8d2';
  g.fillRect(14, 14, 228, 3);
  g.fillRect(14, 239, 228, 3);
  g.fillRect(14, 14, 3, 228);
  g.fillRect(239, 14, 3, 228);
  // An understated seal and corner marks leave a clean field behind the feet.
  g.fillStyle = theme.mark;
  g.beginPath();
  g.arc(128, 128, 37, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = theme.border; g.lineWidth = 2;
  g.beginPath(); g.arc(128, 128, 41, 0, Math.PI * 2); g.stroke();
  g.fillStyle = theme.accent;
  g.font = `15px ${PIXEL_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('VB', 129, 129);
  g.font = `7px ${PIXEL_FONT}`;
  g.fillStyle = theme.border;
  g.fillText(theme.name, 128, 58, 186);
  g.font = `5px ${PIXEL_FONT}`;
  g.fillText('WORLD VIRTUAL BOXING', 128, 200, 176);
  g.fillStyle = theme.accent;
  for (const x of [21, 218]) for (const y of [21, 218]) g.fillRect(x, y, 17, 17);
  const tex = pixelTexture(c, false);
  tex.magFilter = THREE.NearestFilter;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function makeApronTexture(theme = VENUE_CONFIG.volt) {
  const [c, g] = pixelCanvas(256, 32);
  g.fillStyle = theme.border;
  g.fillRect(0, 0, 256, 32);
  g.fillStyle = theme.mark;
  g.fillRect(0, 2, 256, 2);
  g.fillRect(0, 28, 256, 2);
  g.font = `8px ${PIXEL_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = theme.accent;
  g.fillText(theme.name, 128, 17, 235);
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

function makeGymTexture() {
  const [c, g] = pixelCanvas(160, 40);
  g.fillStyle = '#e8e0c8';
  g.fillRect(0, 0, 160, 40);
  g.fillStyle = '#c82020';
  g.fillRect(0, 0, 160, 4);
  g.fillRect(0, 36, 160, 4);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `16px ${PIXEL_FONT}`;
  g.fillStyle = '#181818';
  g.fillText('POPS GYM', 80, 16);
  g.font = `8px ${PIXEL_FONT}`;
  g.fillStyle = '#c82020';
  g.fillText('NO PAIN \u00b7 NO GAIN', 80, 30);
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
