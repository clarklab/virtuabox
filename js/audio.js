// Audio: ElevenLabs-generated samples (./audio, see tools/gen-audio.mjs) for
// SFX, announcer and soundtrack, layered on a WebAudio synth. The synth also
// covers everything if the samples fail to load.

const BPM = 150;
const STEP = 60 / BPM / 4; // 16th note

// A-minor-ish progression: Am, F, G, Em (bass roots, MIDI)
const ROOTS = [45, 41, 43, 40];
const ARP = [0, 7, 12, 15, 12, 7, 3, 7];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const SAMPLES = [
  'hit-1', 'hit-2', 'hit-3', 'whoosh', 'clash', 'bell', 'bell-3', 'cheer', 'crowd', 'fall', 'slam', 'riser',
  'vo-fight', 'vo-ko', 'vo-champion', 'vo-time', 'vo-flawless', 'vo-down', 'vo-combo', 'vo-title',
  'vo-pete', 'vo-nova', 'vo-volt', 'music-fight',
];

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.intensity = 0;
    this.step = 0;
    this.onBeat = null;
    this.buffers = {};
    this.raw = {};
    this.track = null;
    // Fetch bytes right away; decoding waits for the AudioContext (user tap).
    this.fetching = Promise.all(SAMPLES.map(async (name) => {
      try {
        const res = await fetch(`audio/${name}.mp3`);
        if (res.ok) this.raw[name] = await res.arrayBuffer();
      } catch { /* offline or missing: synth fallback */ }
    }));
  }

  async #decodeAll() {
    await this.fetching;
    await Promise.all(Object.entries(this.raw).map(async ([name, bytes]) => {
      try {
        this.buffers[name] = await this.ctx.decodeAudioData(bytes.slice(0));
      } catch { /* ignore */ }
    }));
    if (this.buffers.crowd) this.#crowdLoop();
    if (this.buffers['music-fight']) this.#startTrack();
  }

  /** Play a decoded sample. Returns false if it isn't available. */
  play(name, { gain = 1, rate = 1, delay = 0, dest } = {}) {
    const buf = this.buffers[name];
    if (!this.ctx || !buf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest || this.sfx);
    src.start(this.ctx.currentTime + delay);
    return true;
  }

  voice(name, delay = 0) {
    return this.play(`vo-${name}`, { gain: 1.25, delay, dest: this.vo });
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);
    this.music = ctx.createGain();
    this.music.gain.value = 0.42;
    this.music.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.vo = ctx.createGain();
    this.vo.gain.value = 1;
    this.vo.connect(this.master);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.drive = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3.5);
    }
    this.drive.curve = curve;
    this.drive.connect(this.sfx);

    this.#crowdBed();
    this.#decodeAll();
    this.nextTime = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.#schedule(), 25);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    });
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.02);
  }

  /** 0 = title groove, 1 = planning, 2 = full fight, -1 = silence */
  setIntensity(i) {
    this.intensity = i;
    if (this.track) {
      const t = this.ctx.currentTime;
      const f = i >= 2 ? 18000 : i === 1 ? 5200 : 700;
      this.trackFilter.frequency.cancelScheduledValues(t);
      this.trackFilter.frequency.setTargetAtTime(f, t, 0.25);
      this.trackGain.gain.setTargetAtTime(i < 0 ? 0 : i === 0 ? 0.55 : 0.8, t, 0.3);
    }
  }

  /** Tape-stop the soundtrack for slow-motion knockouts. */
  slowmo(on) {
    if (!this.track) return;
    const t = this.ctx.currentTime;
    this.track.playbackRate.cancelScheduledValues(t);
    this.track.playbackRate.setTargetAtTime(on ? 0.55 : 1, t, on ? 0.12 : 0.3);
    this.trackFilter.frequency.setTargetAtTime(on ? 500 : 18000, t, 0.15);
  }

  #startTrack() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers['music-fight'];
    src.loop = true;
    this.trackFilter = ctx.createBiquadFilter();
    this.trackFilter.type = 'lowpass';
    this.trackFilter.frequency.value = 700;
    this.trackGain = ctx.createGain();
    this.trackGain.gain.value = 0;
    src.connect(this.trackFilter).connect(this.trackGain).connect(this.music);
    src.start();
    this.track = src;
    this.setIntensity(this.intensity);
  }

  // ---- music ---------------------------------------------------------------
  #schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      if (ctx) this.nextTime = ctx.currentTime + 0.05;
      return;
    }
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.#playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
    }
  }

  #playStep(step, t) {
    const lvl = this.intensity;
    if (lvl < 0) return;
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const root = ROOTS[bar];

    if (s16 % 4 === 0 && this.onBeat) {
      const delay = Math.max(0, (t - this.ctx.currentTime) * 1000);
      setTimeout(() => this.onBeat?.(s16 === 0), delay);
    }
    if (this.track) return;
    if (s16 % 4 === 0) this.#kick(t);
    if (lvl >= 1 && s16 % 2 === 1) this.#hat(t, s16 % 4 === 2 ? 0.05 : 0.03);
    if (lvl >= 1 && s16 % 4 === 2) this.#hat(t, 0.06, true);
    if (lvl >= 2 && (s16 === 4 || s16 === 12)) this.#clap(t);
    // rolling offbeat bass
    if (s16 % 2 === 1 || (lvl >= 2 && s16 % 4 === 0)) {
      const oct = s16 === 7 || s16 === 15 ? 12 : 0;
      this.#bass(t, mtof(root + oct), lvl >= 2 ? 900 : 520);
    }
    if (lvl >= 2) {
      const n = root + 24 + ARP[s16 % 8];
      this.#lead(t, mtof(n), s16 % 4 === 0 ? 0.05 : 0.03);
    } else if (lvl === 0 && s16 % 8 === 0) {
      this.#lead(t, mtof(root + 24 + (s16 ? 7 : 0)), 0.035, 0.35);
    }
  }

  #env(g, t, a, peak, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
  }

  #kick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.#env(g, t, 0.002, 0.9, 0.28);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.35);
  }

  #noiseHit(t, { dest, type = 'highpass', freq = 6000, q = 0.7, peak = 0.1, decay = 0.05, attack = 0.001 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.#env(g, t, attack, peak, decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
    return { f, g };
  }

  #hat(t, peak, open = false) {
    this.#noiseHit(t, { dest: this.music, freq: 8000, peak, decay: open ? 0.12 : 0.035 });
  }

  #clap(t) {
    this.#noiseHit(t, { dest: this.music, type: 'bandpass', freq: 1500, q: 0.8, peak: 0.35, decay: 0.14 });
    this.#noiseHit(t + 0.012, { dest: this.music, type: 'bandpass', freq: 1200, q: 0.9, peak: 0.25, decay: 0.1 });
  }

  #bass(t, f, cutoff) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f * 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(cutoff * 2.2, t);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.4, t + 0.12);
    const g = ctx.createGain();
    this.#env(g, t, 0.004, 0.22, 0.13);
    o.connect(lp);
    o2.connect(lp);
    lp.connect(g).connect(this.music);
    o.start(t); o2.start(t);
    o.stop(t + 0.2); o2.stop(t + 0.2);
  }

  #lead(t, f, peak, decay = 0.09) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const g = ctx.createGain();
    this.#env(g, t, 0.003, peak, decay);
    o.connect(lp).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  #crowdLoop() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.crowd;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(g).connect(this.crowdGain);
    src.start();
    this.crowdNoise.disconnect();
    this.crowdBase = 0.18;
    this.crowdGain.gain.setTargetAtTime(this.crowdBase, this.ctx.currentTime, 0.5);
  }

  #crowdBed() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.6;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.02;
    src.connect(bp).connect(this.crowdGain).connect(this.sfx);
    src.start();
    this.crowdNoise = bp;
  }

  // ---- sfx -------------------------------------------------------------------
  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  crowd(level = 0.5, hold = 0.6) {
    if (!this.ctx) return;
    const base = this.crowdBase ?? 0.02;
    const g = this.crowdGain.gain;
    const t = this.now;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(base + level * (this.buffers.crowd ? 0.9 : 0.18), t + 0.08);
    g.setTargetAtTime(base, t + hold, 0.5);
  }

  cheer(gain = 0.8) {
    this.play('cheer', { gain, rate: 0.95 + Math.random() * 0.1 });
  }

  whoosh(delay = 0) {
    if (!this.ctx) return;
    if (this.play('whoosh', { gain: 0.55, delay, rate: 1.05 + Math.random() * 0.3 })) return;
    const t = this.now + delay;
    const { f } = this.#noiseHit(t, { dest: this.sfx, type: 'bandpass', freq: 500, q: 1.2, peak: 0.25, decay: 0.16, attack: 0.05 });
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.18);
  }

  /** `power` ~0.8 jab .. 3 knockout; `body` picks the body-blow sample. */
  hit(power = 1, body = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    // synth sub-thump underneath everything for absurd weight
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140 + power * 20, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    this.#env(g, t, 0.002, Math.min(1, 0.35 + power * 0.25), 0.22 + power * 0.06);
    o.connect(g).connect(this.drive);
    o.start(t);
    o.stop(t + 0.45);
    const name = power >= 2 ? 'hit-3' : body ? 'hit-2' : 'hit-1';
    const played = this.play(name, { gain: Math.min(1.6, 0.8 + power * 0.25), rate: 0.9 + Math.random() * 0.2 });
    if (!played || power >= 2) {
      this.#noiseHit(t, { dest: this.sfx, type: 'lowpass', freq: 2400, peak: 0.6 * Math.min(1.5, power), decay: 0.09 });
      this.#noiseHit(t, { dest: this.sfx, type: 'highpass', freq: 3500, peak: 0.35, decay: 0.03 });
    }
    this.crowd(0.3 + power * 0.25, 0.4);
  }

  clash() {
    if (!this.ctx) return;
    if (this.play('clash', { gain: 1, rate: 0.95 + Math.random() * 0.1 })) return;
    const ctx = this.ctx;
    const t = this.now;
    for (const [f, p] of [[1180, 0.12], [1735, 0.09], [2460, 0.07], [3310, 0.05]]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f * (0.98 + Math.random() * 0.04);
      const g = ctx.createGain();
      this.#env(g, t, 0.001, p, 0.35);
      o.connect(g).connect(this.sfx);
      o.start(t);
      o.stop(t + 0.4);
    }
    this.#noiseHit(t, { dest: this.sfx, type: 'highpass', freq: 2500, peak: 0.4, decay: 0.08 });
  }

  bell(times = 1) {
    if (!this.ctx) return;
    if (this.play(times > 1 ? 'bell-3' : 'bell', { gain: 0.8 })) return;
    const ctx = this.ctx;
    for (let i = 0; i < times; i++) {
      const t = this.now + i * 0.22;
      for (const [r, p, d] of [[1, 0.28, 1.4], [2.76, 0.12, 0.8], [5.4, 0.07, 0.4], [8.93, 0.04, 0.25]]) {
        const o = ctx.createOscillator();
        o.frequency.value = 820 * r;
        const g = ctx.createGain();
        this.#env(g, t, 0.001, p, d);
        o.connect(g).connect(this.sfx);
        o.start(t);
        o.stop(t + d + 0.05);
      }
    }
  }

  slam() {
    if (!this.ctx) return;
    if (!this.play('slam', { gain: 1 })) this.hit(1.2);
  }

  riser() {
    this.play('riser', { gain: 0.6 });
  }

  ko() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 1.2);
    this.#env(g, t, 0.005, 0.8, 1.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    o.connect(lp).connect(g).connect(this.drive);
    o.start(t);
    o.stop(t + 1.4);
    if (!this.play('fall', { gain: 1.1, delay: 0.55 })) {
      this.#noiseHit(t, { dest: this.sfx, type: 'lowpass', freq: 900, peak: 0.9, decay: 0.9 });
    }
    this.cheer(1);
    this.crowd(1, 2.2);
  }

  tick(urgent = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = urgent ? 1760 : 1320;
    const g = ctx.createGain();
    this.#env(g, t, 0.001, urgent ? 0.1 : 0.05, 0.04);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.08);
  }

  select(i = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    o.type = 'square';
    const base = mtof(69 + [0, 3, 7, 10, 12][i % 5]);
    o.frequency.setValueAtTime(base, t);
    o.frequency.exponentialRampToValueAtTime(base * 2, t + 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    const g = ctx.createGain();
    this.#env(g, t, 0.002, 0.12, 0.09);
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.14);
  }

  buzz() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 110;
    const g = ctx.createGain();
    this.#env(g, t, 0.005, 0.25, 0.35);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.45);
  }

  fanfare() {
    if (!this.ctx) return;
    [69, 73, 76, 81, 76, 81].forEach((n, i) => {
      const t = this.now + i * 0.11;
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(n);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2800;
      const g = ctx.createGain();
      this.#env(g, t, 0.005, 0.12, i === 5 ? 0.8 : 0.12);
      o.connect(lp).connect(g).connect(this.sfx);
      o.start(t);
      o.stop(t + 1);
    });
  }
}
