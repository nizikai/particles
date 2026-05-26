# Project Journal

## Current State (2026-05-26)
- Active file: `index-gyro.html` (gyro/mobile variant).
- Visual target remains cool neon-cyan particles on near-black with directional light shafts.
- Bloom pass stays disabled (`ENABLE_BLOOM_PASS = false`) to avoid prior rectangular artifacting.

## Latest Change (De-Stack / Anti-Aurora pass)
- Addressed layered translucent/stacked look by reducing additive accumulation:
  - Forced `USE_MICRO_LAYER = false` (removes third additive particle sheet).
  - Reduced secondary haze layer footprint (`pointSize` and `alphaScale` lowered).
  - Reduced fragment aura/stream/spray alpha gain and color amplification.
  - Reduced cinematic blur/glow strength (`u_blurStrength`, blur mask/radius, streak/tight glow gains).
  - Kept core layer bright enough (`alphaScale` raised to `1.02`) so scene does not go flat.

## Verification
- Inline script syntax parse passes (`node vm.Script` check).
- Local dev server: `python3 -m http.server 5501`, page at `http://127.0.0.1:5501/index-gyro.html`.
- Headless WebGL captures are unreliable in this environment; final visual QA should be in a normal browser session.

## Next Tuning Knobs
- If still too “sheet-like”: lower haze `alphaScale` further (current `0.28`).
- If too dim after that: increase core `alphaScale` slightly (current `1.02`).
