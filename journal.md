# Project Journal

## Current State (2026-05-19)
- Main scene file: index.html (single-file Three.js r128 globals).
- GLB model source is scene.glb with fallback obelisks if load fails.
- Logo pose is locked to:
  - pos=(-0.130, 0.120, -0.620)
  - rot=(-0.612, 6.720, 0.353)
- Scene palette is warm golden-orange across lights, particles, fog/background, bloom glow, shafts, and model emissive.
- Performance profile is desktop-safe (reduced DPR/grid/bloom, adaptive quality, micro layer only on higher-core desktop).
- Cursor interaction is tuned for "scoop and throw sand":
  - Larger hover footprint and higher base force.
  - Stronger leading-edge scoop pull and trailing wake throw.
  - Added smoothed cursor velocity feed to shader for clearer motion response while hovering.
- Selected collision style baseline: molten-heavy, natural wrap around the model.
  - Tightened collision influence radius so contact happens closer to actual obelisk silhouettes.
  - Prioritized tangential side-slip and downstream carry over explosive outward bursts.
  - Softened spray brightness/alpha spikes while keeping warm impact readability.

## Runtime Notes
- Run from local server (http://127.0.0.1:5501/index.html), not file://.
- Key toggles: P = pose edit, F = perf HUD.
