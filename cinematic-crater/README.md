# Cinematic Crater

A lone figure in a dark crater, a vertical god-ray beam from a brilliant light
above, debris rising toward it, drifting haze, and a cold near-monochrome grade.
Built with **Vite + three** and the pmndrs **postprocessing** library.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build && npm run preview
```

Drag to look, scroll to dolly. The camera also slow-orbits on its own.

## Structure

| File | Responsibility |
| --- | --- |
| `src/main.js` | Scene assembly, lights, figure, motion loop |
| `src/terrain.js` | FBM-displaced bowl terrain, snowy floor, normal map |
| `src/haze.js` | Additive ground-mist planes (FBM shader) |
| `src/debris.js` | InstancedMesh rocks rising/orbiting toward the light |
| `src/postfx.js` | EffectComposer: GodRays, Bloom, grade, CA, vignette, grain |
| `src/lib/noise.js` | CPU simplex + FBM (terrain & rocks) |
| `src/shaders/glsl-noise.js` | GLSL simplex + FBM string (haze) |

## Notes / knobs

- **Grade:** tweak `ColorGradeEffect` defaults in `postfx.js` (`saturation`,
  `contrast`, `tint`) for more/less monochrome and warmth.
- **God rays / bloom:** `density`, `decay`, `weight`, `exposure` on `GodRaysEffect`;
  `intensity` / `luminanceThreshold` on `BloomEffect`.
- **Terrain shape:** `BOWL_DEPTH`, `RIDGE_HEIGHT`, `BASIN_RADIUS` in `terrain.js`.
- **Performance:** lower `SEGMENTS` (terrain) or `COUNT` (debris). For DOF,
  add a `DepthOfFieldEffect` in its own `EffectPass` (omitted by default — it
  conflicts with the shared depth buffer and floods the console).

## Swapping the capsule for a GLB figure

In `main.js`, replace the capsule block with:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
new GLTFLoader().load('/figure.glb', (gltf) => {
  const m = gltf.scene;
  m.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  m.position.set(0, FLOOR_Y, 0);
  scene.add(m);
});
```

Put `figure.glb` in `public/` so Vite serves it at `/figure.glb`.
