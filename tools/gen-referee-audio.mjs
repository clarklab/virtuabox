#!/usr/bin/env node
// Offline referee voice assets: macOS's built-in Daniel voice, no API key.
// Requires `say` (macOS) and ffmpeg. The resulting MP3s play in any browser.
// Run: node tools/gen-referee-audio.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'audio');
const WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const temp = await mkdtemp(join(tmpdir(), 'virtuabox-referee-'));
await mkdir(OUT, { recursive: true });
try {
  for (const [i, word] of WORDS.entries()) {
    const input = join(temp, 'count.aiff');
    execFileSync('say', ['-v', 'Daniel', '-r', '170', '-o', input, `${word}!`]);
    // Keep a little lead/tail so clipped consonants never sound abrupt. A
    // separate file per word gives the game's one-second count exact timing.
    const pcm = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', input,
      '-af', 'highpass=f=110,lowpass=f=7000,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.012,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.045,areverse',
      '-ac', '1', '-ar', '44100', '-f', 'f32le', '-',
    ]);
    let peak = 0;
    for (let p = 0; p < pcm.length; p += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(p)));
    if (!peak) throw new Error(`Empty referee number: ${word}`);
    for (let p = 0; p < pcm.length; p += 4) pcm.writeFloatLE(pcm.readFloatLE(p) * 0.85 / peak, p);
    const output = join(OUT, `vo-count-${i + 1}.mp3`);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '1', '-i', '-',
      '-codec:a', 'libmp3lame', '-b:a', '96k', output,
    ], { input: pcm });
    console.log(`vo-count-${i + 1}.mp3: ${word}, ${(pcm.length / 4 / 44100).toFixed(2)}s`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
