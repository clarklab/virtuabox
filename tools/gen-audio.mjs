#!/usr/bin/env node
// Generates the game's audio assets with ElevenLabs (sound effects, announcer
// lines and the soundtrack) into ./audio. Existing files are skipped, so it's
// safe to re-run after tweaking a prompt (delete the file you want redone).
//
//   ELEVENLABS_API_KEY=... node tools/gen-audio.mjs
//
// The key is read from the environment only. Never commit it.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('Set ELEVENLABS_API_KEY');
  process.exit(1);
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'audio');
const API = 'https://api.elevenlabs.io';
const ANNOUNCER = 'pNInz6obpgDQGcFmaJgB'; // "Adam" premade voice

const SFX = {
  'hit-1': [0.5, 'Punchy boxing glove punch to the face, tight meaty thwack with a crisp leather slap, arcade fighting game impact, dry, no reverb'],
  'hit-2': [0.5, 'Heavy boxing glove body blow to the ribs, deep punchy thud, fighting game impact sound effect, dry'],
  'hit-3': [1.2, 'Brutal knockout uppercut impact, massive bass boom with a sharp crack, cinematic fighting game super hit'],
  whoosh: [0.5, 'Very fast punch swing whoosh, short sharp air swipe, fighting game'],
  clash: [0.8, 'Two boxing gloves slamming together with an electric neon zap and a metallic clang, sci-fi arcade impact'],
  bell: [1.5, 'Single boxing ring bell ding, bright brass bell, clean'],
  'bell-3': [2.2, 'Boxing ring bell rung three times fast, ding ding ding, arena'],
  cheer: [3, 'Big arena crowd erupting in cheers and screams after a huge knockout punch'],
  crowd: [8, 'Indoor boxing arena crowd ambience, steady excited murmur and distant chatter, no applause spikes, loopable'],
  fall: [1.5, 'Heavy body falling flat onto a boxing ring canvas, big thud with ring ropes rattling'],
  slam: [1.2, 'Heavy landing slam with electric crackle and a bass drop, video game fighter entrance'],
  riser: [1, 'Short synth whoosh riser building into an impact, arcade game transition'],
};

const VO = {
  'vo-fight': 'FIGHT!',
  'vo-ko': 'K.O.!!',
  'vo-champion': 'NEW! CHAMPION!',
  'vo-time': 'TIME!',
  'vo-flawless': 'FLAWLESS!',
  'vo-down': "YOU'RE DOWN!",
  'vo-combo': 'COMBO!',
  'vo-title': 'VIRTUABOX!',
  'vo-pete': 'PIXEL PETE!',
  'vo-nova': 'NOVA KID!',
  'vo-volt': 'MEGAVOLT!',
};

const MUSIC = {
  'music-fight': [
    125000,
    'Relentless high-energy synthwave and drum and bass hybrid for a neon arcade boxing video game. 150 BPM, punchy four-on-the-floor kick, pulsing sawtooth bass, fast retro 80s arpeggios, huge gated snares, adrenaline, no intro fade, instrumental, no vocals.',
  ],
};

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function post(path, body, file) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  return buf.length;
}

const jobs = [];
for (const [name, [dur, text]] of Object.entries(SFX)) {
  jobs.push([name, (f) => post('/v1/sound-generation?output_format=mp3_44100_128', { text, duration_seconds: dur, prompt_influence: 0.55 }, f)]);
}
for (const [name, text] of Object.entries(VO)) {
  jobs.push([name, (f) => post(`/v1/text-to-speech/${ANNOUNCER}?output_format=mp3_44100_128`, {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.3, similarity_boost: 0.8, style: 0.85, use_speaker_boost: true },
  }, f)]);
}
for (const [name, [ms, prompt]] of Object.entries(MUSIC)) {
  jobs.push([name, (f) => post('/v1/music?output_format=mp3_44100_96', { prompt, music_length_ms: ms, model_id: 'music_v1', force_instrumental: true }, f)]);
}

await mkdir(OUT, { recursive: true });
let failed = 0;
const queue = jobs.slice();
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const [name, run] = queue.shift();
    const file = join(OUT, `${name}.mp3`);
    if (await exists(file)) { console.log('skip', name); continue; }
    try {
      const bytes = await run(file);
      console.log('ok  ', name, `${(bytes / 1024).toFixed(0)}KB`);
    } catch (e) {
      failed++;
      console.error('FAIL', name, e.message);
    }
  }
}));
process.exit(failed ? 1 : 0);
