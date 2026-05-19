# Project Journal

## Current State (2026-05-19)
- Main scene file: index.html (single-file Three.js r128 globals).
- GLB model source is scene.glb with fallback obelisks if load fails.
- Logo pose is locked to:
  - pos=(-0.060, 0.030, -0.620)
  - rot=(-0.612, 6.720, 0.353)
- Scene palette is warm golden-orange across lights, particles, fog/background, bloom glow, shafts, and model emissive.
- Performance profile is desktop-safe (reduced DPR/grid/bloom, adaptive quality, micro layer only on higher-core desktop).
- Cursor interaction is tuned for "scoop and throw sand":
  - Larger hover footprint and higher velocity carry for more noticeable displacement/inertia feel.
  - Stronger leading-edge scoop pull and trailing wake throw.
  - Smoothed cursor velocity feed was increased so motion influences particles more aggressively.
  - Hover color/alpha weighting was reduced further to avoid over-saturated hotspot clipping.
  - Hover release now uses a short decay tail so particles ease out instead of snapping when cursor exits.
- Selected collision style baseline: dramatic molten-wrap with multi-anchor model collision.
  - Collision now uses three anchors (left, center, right) to match the logo silhouette instead of a 2-point approximation.
  - Center collision artifact/dead-zone is reduced by lowering synthetic seam bridge influence.
  - Dramatic spray/heat remains, while flow-wrap around the center slab is more physically coherent.

## Runtime Notes
- Run from local server (http://127.0.0.1:5501/index.html), not file://.
- Key toggles: P = pose edit, F = perf HUD.
