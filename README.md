# VIRTUABOX

Up down all around. A two-minute, mobile-first boxing game with a classic
16-bit Nintendo look: a green wireframe boxer versus cel-shaded pixel
fighters in a 3D ring rendered at SNES resolution, a Punch-Out-style split
screen with a SNES controller underneath, and a turn-based read-and-react
fight loop.

![VIRTUABOX](og.jpg)

## How it plays

Every exchange is two turns, each a single decision with instant payoff.

1. **THEIR TURN — read the tell.** The opponent winds up and the glove that's
   about to fire flashes `!`. Make one read before it lands:
   - hook from the left → **SLIP RIGHT**, hook from the right → **SLIP LEFT**
   - jab → **DUCK**
   - body blow → **BLOCK**

   A perfect read makes them whiff, earns a **★** and leaves them wide open.
   Blocking the wrong punch takes chip damage; reading wrong gets you tagged
   and costs a star.
2. **YOUR TURN — hit the openings.** They guard two of four targets (head or
   body, left or right). Punch an open target to land; each hit shifts their
   guard and shortens the next window, so you chain up to a 4-hit **FLURRY**.
   Hit a glove and your turn ends. After a perfect read they're wide open
   (**COUNTER!**); after you got tagged they tighten up to a single opening.
3. **★ SUPER.** Tap the star in the middle of the pad for an unblockable
   uppercut: 16 damage per star you've banked.

KO all three fighters before the **2:00** clock runs out.

| Fighter | Tells | Tricks |
| --- | --- | --- |
| PIXEL PETE | slow, honest | loves the jab; hints teach the reads |
| NOVA KID | fast | double attacks, feints that switch the flashing glove late |
| MEGAVOLT | lightning | feints, guards that shift mid-turn, and a MEGA UPPERCUT (slip it, never duck it) |

Everyone speeds up as they get hurt, and feinters feint more if you keep
reading too early.

Controls: the D-pad defends, the colored pad punches. You can also play on
the ring itself: swipe left/right/down/up to slip/duck/block, tap where you
want to punch, flick up for the super. Keyboard: arrows to defend, `Q` `W`
`A` `S` to punch, `Space` for the super, `Enter` to start.

When the match ends you get a score card PNG (with a frame captured from your
knockout, and a grid of every read and punch) to share through the native
share sheet, or to save/copy on desktop.

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
js/main.js              game flow: their turn / your turn loop, input, tells + targets, HUD, results
js/rules.js             attacks, reads, guards, damage/score constants, opponent AI
js/boxer.js             procedural boxers (toon + ink outline, or green ghost wireframe), 2-bone IK, tells, guards, slips, punches, KOs
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
