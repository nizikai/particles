# Project Journal

## Current State (2026-06-02)
- Active work: `index-scene.html`.
- Scene uses Three.js `0.128` CDN scripts and local GLBs:
  - `scene.glb`: main obelisk/logo model.
  - `model.glb`: widened under-particle terrain/ground.

## Latest Changes
- Added a GLB-local additive particle veil around `scene.glb` so particles visibly wrap the main model.
- Added `model.glb` as a separate underlay loaded before the particle ocean.
- `model.glb` is centered, darkened, flattened vertically, and non-uniformly widened on X/Z to read as ground beneath the whole scene.
- `model.glb` references missing `tex_u0_v0_diffuse.jpg`; loader now substitutes a generated detailed terrain texture instead of a flat 1px texture.
- The generated diffuse map is reused as a subtle bump map so the widened ground keeps visible surface variation under the particles.
- Added an on-page `model.glb` editor panel with live X/Y/Z move sliders and W/H/D scale sliders.
- Locked `model.glb` editor defaults to `pos -1.12, -1.90, -2.59` and `scale 2.52, 1.07, 1.99`.

## Verification
- Inline script parse check passes.
- Local server verification at `http://127.0.0.1:5500/index-scene.html`.
- Playwright desktop and mobile screenshots render successfully.
- Editor slider binding verified by changing W from `1.75` to `2.30` at runtime and confirming the readout updates.
- Desktop Playwright rAF sample after locked values: avg `16.65ms`, approx `60.1 FPS`, p95 `17.4ms`.
- Network confirms `scene.glb` and `model.glb` both load with `200 OK`.
- Browser console clean after load in verified runs.

## Notes
- The particle ocean is still the primary bright layer; `model.glb` should stay visually subdued to avoid bloom washout.
