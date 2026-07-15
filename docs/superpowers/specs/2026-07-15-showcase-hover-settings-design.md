# Per-section hover & water settings for the showcase (column) section

**Date:** 2026-07-15 · **Status:** approved (louder showcase defaults)

## Problem

The cursor-hover spotlight (preloader dots) and the glass-water stir share one set
of config values between the hero logo and the showcase cards' glass slabs. The
showcase reads much subtler at the same numbers: dot point-size shrinks with view
depth, and the card's opaque artwork sits in front of its slab, so the additive
dots composite over mid-bright art instead of dark glass. The user wants the two
sections independently tunable, with the showcase louder out of the box.

## Decision

Full duplication (user choice) via **flat `sc*`-prefixed config keys** — keeps the
flat `config` object so the Copy-settings button and `bindSlider` wiring work
unchanged. Rejected: nested `config.hero/showcase` groups (breaks Copy settings +
every slider binding for no functional gain); multiplier overlay (user wants full
control).

## Changes (all in `showcase/main.js` + `showcase/index.html`)

1. **Config:** 13 new keys, showcase twins of:
   `hoverIntensity, hoverRadius, hoverDotSize, hoverFade` (Cursor hover) and
   `netDensity, netSize, waveSpeed, waveLife, waveStrength, splashSize,
   settleRate, glowGain, waveMotion` (Glass water).
   Defaults: same as hero except **scHoverDotSize 5** (hero 3), **scGlowGain 7**
   (hero 5), **scNetSize 14** (hero 10).
2. **Water:** each net gets an `isCard` flag at build (`makeGlassNet` callers know
   which they are). `updateGlassNets` resolves every tunable through the net's
   section (small helper reading `config[isCard ? "sc" + Key : key]`).
   `makeGlassNet` takes the section's `netDensity` for its sample count.
3. **Spotlight:** cards get their own material clone (`hoverCardMat`) — the single
   shared material is currently why the sections cannot differ. `tick()` drives
   the hero material from hero keys and the card material from `sc*` keys; the
   dwell-fade target uses the active section's own fade time.
4. **Panel:** new **"Showcase hover"** section after "Glass water" with the 13
   twin sliders (same ranges as their hero counterparts).

## Out of scope

The card dots' build-time 8× edge density and surface fill stay hardcoded (shape
choice, not a tuning value). Mobile behavior unchanged.

## Verification

Browser (playwright-cli) on both sections: hero behaves identically at defaults;
showcase spotlight/water visibly stronger; edge glow, dwell fade (per-section
times), and water sleep/reset still work; Copy settings emits all new keys;
console clean; 60 fps.
