---
name: verify
description: How to run and visually verify the particles/showcase pages
---

# Verify: particles showcase

Static site, no build step. Serve the repo root and drive with playwright-cli.

```bash
python3 -m http.server 8734 &   # from repo root
export PWCLI="$HOME/.codex/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" open "http://localhost:8734/showcase/index.html"
```

## Intro timeline (from page load / Replay click)

- Preload holds ≥2s (`PRELOAD_MIN_MS`), then `beginIntro()` fires.
- From `introStart`: particle spawn 0–1.4s, hold until 2.0s, crossfade 2.0–4.6s, logo glass handoff at ct=0.1 (~2.26s).
- On **▶ Replay intro** (`#replayBtn`) there is no preload wait — intro starts at click.

## Capturing timed frames

`"$PWCLI" run-code` with `page.screenshot()` in a loop against `Date.now()` offsets works well; save to `.playwright-cli/`. FPS counter top-left confirms the render loop is alive.

## Hero → showcase transition (glitch wipe)

Transition window: `outroStart` 545vh → `showcaseStart` 650vh of a 1400vh track (scroll fractions ~0.39–0.46). It's a shader wipe (`wipePass` + `otherRT` opposite-state capture in `main.js`), not a DOM veil — drive `window.scrollTo` through that range and screenshot to see the boundary + chroma streaks.

## Worth checking after intro changes

- Replay twice in a row (mid-intro replay must reset cleanly).
- No opaque gold slab where the glass logo appears (the `logoRevealT` guard).
- No brightness/orange jump on the frame `finishIntroSequence()` fires (fog removal + haze/mist restore must be invisible).
- Console log (favicon.ico 404 is pre-existing noise).
