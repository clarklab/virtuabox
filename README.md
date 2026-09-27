# VIRTUABOX

Up down all around. A two-minute, mobile-first boxing game with a classic
16-bit Nintendo look: a green wireframe boxer versus cel-shaded pixel
fighters in a 3D ring rendered at SNES resolution, a Punch-Out-style split
screen, and rock-paper-scissors mind games at 60fps.

![VIRTUABOX](og.jpg)

## How it plays

1. Each round you call **4 punches**, one per slot, from a 2×2 pad:
   **JAB** ↖, **HOOK** ↗, **UPPER** ↘, **BODY** ↙.
2. Every punch **beats the next one clockwise** (JAB › HOOK › UPPER › BODY › JAB).
   Diagonals **trade** (both land). The same punch **clashes** (gloves collide).
3. The opponent's **intel** reveals some of their punches before you lock in.
   Chain wins for combo multipliers, and KO all three fighters before the
   **2:00** clock runs out.

| Fighter | Style | Intel | Shot clock |
| --- | --- | --- | --- |
| PIXEL PETE | Pattern boxer who loves the jab | 2 punches | 8s |
| NOVA KID | Copycat who repeats your last combo | 1 punch | 7s |
| MEGAVOLT | Counter-puncher who reads your habits | 1 punch | 6s |

When the match ends you get a score card PNG (with a frame captured from your
knockout) to share through the native share sheet, or to save/copy on desktop.

Keyboard: `Q` jab, `W` hook, `A` body, `S` upper, `Backspace` to undo,
`Enter` to start.

## The 16-bit look

- The 3D scene renders at roughly 232 rows (SNES territory) and is upscaled by a
  whole number with `image-rendering: pixelated`, so every pixel is square.
- A post pass quantizes to a small per-channel palette with a 4×4 Bayer ordered
  dither, so light shafts and gradients break into classic dither patterns.
- Opponents are cel-shaded (3-step toon ramp) with constant-width ink outlines.
  You are a see-through green wireframe with a bold outline, like the Super
  Punch-Out!! reference.
- The UI uses Press Start 2P, SNES menu windows, and Super Famicom colored face
  buttons for the punch pad.

## Run it

It's a static site with no build step. Serve the folder with any web server:

```sh
python3 -m http.server 8080
# or: npx serve .
```

Then open http://localhost:8080 (on a phone, use your machine's LAN IP).

## Layout

```
index.html              page shell, HUD, deck, overlays, meta/OG tags
styles.css              mobile-first layout (portrait split, landscape side-by-side)
js/main.js              game flow: rounds, exchanges, scoring, HUD, results
js/rules.js             move wheel, damage/score constants, opponent AI
js/boxer.js             procedural boxers (toon + ink outline, or green ghost wireframe), 2-bone IK, punch/hit/KO animations
js/stage.js             three.js arena at ~232 rows, 16-bit palette + ordered-dither pass, pixel FX, camera shots
js/audio.js             ElevenLabs samples + WebAudio synth fallback
js/share.js             1080×1352 pixel-art share card + share text
js/vendor/three.js      tree-shaken three.js r186 bundle (generated)
audio/                  generated SFX, announcer lines and soundtrack (mp3)
icons/, og.jpg          pixel-art favicon + PWA icons, social preview (generated)
manifest.webmanifest    installable PWA manifest
tools/                  asset/bundle generators
```

## Regenerating assets

```sh
# three.js bundle (after adding new THREE.* symbols to js/)
npm i --no-save three@0.186.1 esbuild && node tools/build-vendor.mjs

# pixel icons (SVG + PNG) + og.jpg (renders the real 3D scene headlessly)
npm i --no-save playwright-core && node tools/render-assets.mjs

# SFX, announcer and music via ElevenLabs (delete a file to regenerate it)
ELEVENLABS_API_KEY=... node tools/gen-audio.mjs
```

Never commit API keys; `tools/gen-audio.mjs` only reads the key from the
environment.

The `og:image` tag uses a relative path. Some link unfurlers need an absolute
URL, so point it at the deployed `og.jpg` once the site has a home.

Debug query params: `?cam=y,dist,lookY,x,hfov` tunes the fight camera,
`?ts=0.2` slows time, `?dtcap=0.25` lets slow headless browsers keep pace.
