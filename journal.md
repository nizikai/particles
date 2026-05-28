# Project Journal

## Current State (2026-05-28)
- Active file: `index-gyro.html`.
- Desktop visuals/default tuning preserved.
- Mobile still uses cinematic postprocess with bloom disabled by touch gate.

## Latest Changes (Gyro Tuner + Panel Visibility)
- Added new Style Tuner section: `Gyro Camera`.
- New live sliders wired into runtime gyro behavior:
  - `gyroSensitivity`
  - `gyroInfluence`
  - `gyroSmoothing`
  - `gyroDamping`
- Refactored gyro controls from fixed constants to runtime variables so slider changes apply immediately.
- Limited style tuner panel footprint to top-only area:
  - Panel now capped to `max-height: 40dvh`.
  - Internal scroll moved to `.style-tuner-body`.
  - Mobile media rule keeps the same `40dvh` cap.

## Verification
- Inline script parse check passes (`node vm.Script`).

## Next Check
- Validate on real phone that tuner occupies only top 40% and gyro sliders respond live without jitter spikes.
