# Project Journal

## Current State (2026-05-27)
- Active file: `index-gyro.html`.
- Goal: keep mobile and desktop visuals closer in perceived glow/brightness.
- Bloom remains disabled on touch (`ENABLE_BLOOM_PASS = !isTouch`) to avoid prior bloom artifacts.

## Latest Change (Mobile Glow Parity)
- Root cause: mobile path was fully skipping postprocessing, so cinematic glow grading never ran.
- Updated tier config so `usePostprocessing` is enabled for `medium` and `high` tiers.
- Updated `initComposer()` guard to skip postprocessing only when `FORCE_SKIP_POSTPROCESSING` is true (low-tier path).
- Resulting behavior:
  - Low-tier devices: direct render (no postprocessing).
  - Medium/High mobile: cinematic postprocess enabled, bloom still off.
  - Desktop: unchanged bloom/cinematic behavior.

## Verification
- Inline script parse check passes (`node vm.Script`).

## Next Check
- Validate on real phone + desktop side-by-side for glow parity and FPS stability.
