# Project Journal

## Current State (2026-07-15)
- Active area: `showcase2/`, showcase card hover motion.
- Hovered cards lift forward by 0.35 local Z units.
- Lift timing is explicit and symmetric:
  - `CARD_HOVER_DURATION = 0.35s` for entry and leave.
  - Progress advances 0→1 on entry and reverses 1→0 on leave.
  - `easeInOutCubic` shapes the actual Z offset.
  - Mid-transition hover changes reverse smoothly from current progress.
- Click-focused cards suppress the hover lift.
- Water-particle displacement remains capped to 1.5 grid cells and clamped to slab bounds.
- Responsive glass and post-preloader depth occlusion remain enabled.

## Verification
- `git diff --check` passes.
- `node --check showcase2/main.js` passes.
- `showcase2/` remains untracked in Git.
