# Project Journal

## Current State (2026-05-28)
- Active file: `index-gyro.html`.
- Desktop and mobile use separate default profiles.
- Bloom/post controls remain fully exposed in Style Tuner.

## Latest Change (Mobile-Only Preset Applied)
- Updated `MOBILE_STYLE_OVERRIDES` to the new user-provided preset:
  - Exposure/post: `toneMappingExposure 2.14`, `cinematicExposure 2.06`, `gamma 0.86`
  - Particles: `coreAlphaScale 5`, `hazeAlphaScale 3`, `maxSizeMul 3`, `auraStrength 0`, `fogDensity 0`
  - Glow/bloom: `tightGlowMix 2.27`, `streakGlowMix 2.34`, `glowSpread 0.2`, `glowThreshold 0`, `bloomStrength 2.14`, `bloomRadius 1.16`, `bloomThreshold 0.6`
  - Obelisk: `obeliskEmissiveIntensity 0.01`, `obeliskRoughness 0.35`
  - Gyro: `gyroSensitivity 3`, `gyroInfluence 2`, `gyroSmoothing 0.1`, `gyroDamping 0.98`
- Desktop base `styleState` was not changed.
- Mobile-specific cinematic fields not included in the JSON (`cinematicSaturation`, `cinematicSharpness`, `cinematicBlurStrength`) were kept at their existing mobile defaults.

## Verification
- Inline script parse check passes (`node vm.Script`).

## Next Check
- Validate on real phone that startup look matches this mobile preset and desktop remains on its separate defaults.
