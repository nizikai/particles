# Project Journal

## Current State (2026-05-29)
- Active file: `index-test.html`.
- Stack overflow root cause fixed during GLB post-load processing.

## Latest Fix
- Resolved recursive traversal/mutation bug:
  - previous flow added edge-glow meshes while `model.traverse(...)` was running
  - this caused repeated re-entry on newly attached meshes and `Maximum call stack size exceeded`
- New flow:
  - first collect source meshes in `modelMeshes`
  - then apply material + attach glow in a separate loop
- Timeout behavior remains:
  - absolute timeout `25000ms`, inactivity `12000ms`
  - fallback can be replaced by late GLB success

## Existing Guards
- Version-safe physical material builder for Three.js `0.128` compatibility.
- Startup watchdog disables heavy postprocessing if first frames stall.
- Runtime error hooks (`error`, `unhandledrejection`) + render-loop try/catch.

## Verification
- Inline script parse check passes.

## Remaining Risk
- CDN script latency can still delay overall startup.
