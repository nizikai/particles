# Preloader: wireframe blueprint reveal

## Context

The current preloader (`showcase/index.html`, `showcase/style.css`, `showcase/main.js`) shows a black screen with a "Nizi Labs" wordmark, gated on asset loading (logo/ground/column GLTFs + webfont) plus a 2s minimum display time, then an iris-mask reveal (growing soft-edged circle) straight onto the fully rendered scene.

The user wants the reveal itself to feel more like the hero object materializing, based on two reference images: a glowing white wireframe/blueprint render of a model (with a few floating disconnected wireframe fragments and small numeric labels near vertices) that resolves into the same object fully textured and lit. The images themselves (an igloo) are not relevant — only the *style* (wireframe-glow → full render) applies, to our actual hero scene.

## Sequence

1. **0 → ~2000ms** — black screen + "Nizi Labs" wordmark (unchanged from current implementation).
2. **Iris opens (~1300ms, unchanged mechanic)** — reveals the hero scene in **wireframe form** instead of its final materials: glowing white edge-lines of the logo/ground/column geometry, bloom temporarily boosted, plus 4 small floating wireframe shard fragments (each with a faint numeric label) drifting near the model.
3. **Hold (~900ms)** — wireframe scene sits as-is so it reads before changing again.
4. **Crossfade (~900ms)** — real materials fade in while the wireframe group, shards, and labels fade out; bloom eases back down to its normal level. Shards/labels are disposed at the end; ground/column materials return to their original opaque state.

Total time added versus the current preloader: ~1.8s (the hold + crossfade are new).

## Wireframe representation

For each real object that exists once its GLTF has loaded (logo glass slabs, ground, column), build a parallel `THREE.LineSegments` using `THREE.EdgesGeometry` on the same source geometry, with a bright white `LineBasicMaterial`, parented/transformed identically to the real mesh so it lines up exactly.

During the wireframe phase:
- Real meshes are hidden (or opacity 0).
- Wireframe copies are visible.
- The existing `UnrealBloomPass` strength (`config.bloom`, normally 0.15) is temporarily raised to ~0.6–0.8 so the white edges actually glow rather than reading as flat lines.

If a given GLTF failed to load (existing fallback/warning paths already handle this), its wireframe duplicate simply doesn't exist — the phase still runs with whatever loaded successfully, matching the current preloader's existing resilience (it never blocks indefinitely on one asset).

## Floating shards + labels

A small independent group of exactly **4** loose wireframe fragments (simple triangle/tetrahedron shapes, same white glowing edge-line look, geometrically unrelated to the real model), placed within a loose sphere near the model, each with its own slow independent drift/rotation.

**All 4** shards get a small billboarded numeric label: a `THREE.Sprite` with a tiny canvas-drawn 2-digit number, faint opacity, assigned once at creation (static, not animated).

Shards and labels exist only for the duration of the wireframe phase — created when it starts, faded out and disposed (geometry + material + textures) at the end of the crossfade. Not part of the permanent hero scene.

## Crossfade + bloom

Driven by an eased timer piggybacked on the existing `tick()` render loop (same pattern as the current iris-mask animation — no new `requestAnimationFrame` loop):
- Real materials: opacity 0 → 1.
- Wireframe group + shards + labels: opacity 1 → 0.
- Bloom strength: punched-up value → `config.bloom` (0.15).

All three interpolate over the same ~900ms window so "the glow calming down" and "the materials resolving" read as one motion.

After the crossfade completes:
- Wireframe group hidden (not necessarily disposed — geometry can be cheaply kept hidden since it's small, or disposed; implementation's call).
- Shards + labels fully disposed.
- Ground/column materials' `transparent` flag reset to their original (opaque) state — no lingering transparency-sort cost for the rest of the session.

## Edge cases

- **Mobile**: no extra scaling needed — 4 shards is already cheap; the bloom bump is a post-process shader cost (already present in the pipeline), not new geometry, so it behaves the same on mobile as today's bloom pass already does.
- **Partial load failure**: covered above under "Wireframe representation" — the phase degrades gracefully per-asset, consistent with current preloader behavior (`markLoaded` fires regardless of which specific assets succeeded, backed by the existing 8s hard-timeout fallback).
- **One-shot cost**: shards/labels/wireframe copies are created fresh each load and torn down after the crossfade — zero persistent overhead added to the rest of the session once the intro finishes.

## Verification

- `node --check main.js` for syntax.
- Serve `showcase/` locally, drive with Playwright:
  - Screenshot during the wireframe-hold window (reuse the in-page-timer technique already used to verify the iris mask) to confirm glowing wireframe geometry + 4 labeled shards render correctly.
  - Screenshot after the crossfade completes to confirm the final scene is visually identical to today's end-state, with no leftover transparency artifacts or stray wireframe/shard objects left in the scene graph (spot-check via `scene.children` count/composition in an `eval` call).
