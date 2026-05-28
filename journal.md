# Project Journal

## Current State (2026-05-28)
- Active file: `index-gyro.html`.
- Desktop and mobile use separate default profiles.
- Bloom/post controls are exposed in Style Tuner.

## Latest Changes
- Mobile defaults: high-intensity preset applied in `MOBILE_STYLE_OVERRIDES` (desktop base unchanged).
- Runtime mobile low-FPS fallback added:
  - Trigger: FPS `< 30` for ~`2000ms` on touch devices.
  - Action: disables bloom and reduces `coreAlphaScale`, `hazeAlphaScale`, `maxSizeMul`.
  - One-way per session (`runtimeFallbackState.applied`) to prevent oscillation.
- Low-tier devices still skip full postprocessing via `FORCE_SKIP_POSTPROCESSING`.

## Verification
- Inline script parse check passes (`node vm.Script`).

## Next Check
- Real-phone validation: confirm mobile startup look matches preset and fallback activates only under sustained low FPS.
