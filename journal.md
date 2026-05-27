# Project Journal

## Current State (2026-05-27)
- Active file: `index-gyro.html`.
- Desktop visuals/default tuning unchanged.
- Mobile (iOS/Android touch): cinematic postprocess enabled, Unreal bloom still disabled.

## Latest Changes
- Mobile style defaults locked via `MOBILE_STYLE_OVERRIDES` (user-provided tuner values).
- Gyro sensitivity increased by 1.5x by reducing tilt normalization range:
  - `GYRO_TILT_RANGE = (isIPhoneX ? 18 : 22) / 1.5`

## Verification
- Inline script parse check passes (`node vm.Script`).

## Next Check
- Real-device pass: confirm small tilt now moves camera more (target: ~1.5x response) and no jitter regressions.
