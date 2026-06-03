// =============================================================================
// terrain.js — the crater / valley basin.
//   * High-subdivision PlaneGeometry, displaced per-vertex by layered FBM.
//   * Shaped into a bowl: center dips down, edges rise into jagged ridges.
//   * Vertex colors paint a brighter "snowy" basin floor vs. dark rock walls.
//   * A procedural normal map adds fine carved striations.
// CPU displacement is used (not a vertex shader) so MeshStandardMaterial gets
// correct normals for free via computeVertexNormals().
// =============================================================================

import * as THREE from 'three';
import { Noise } from './lib/noise.js';

const SIZE = 220;        // world units across
const SEGMENTS = 256;    // subdivisions per side (256 = ~66k verts)
const BASIN_RADIUS = 30; // radius of the flat-ish snowy floor
const MAX_RADIUS = 110;  // where ridges peak
const BOWL_DEPTH = 14;   // how far the center sinks
const RIDGE_HEIGHT = 34; // how tall the rim ridges get

export function createTerrain() {
  const noise = new Noise(2024);

  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2); // lay flat in XZ plane, +Y up

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const rock = new THREE.Color(0x3c434e);  // cold grey rock (reads under key light)
  const snow = new THREE.Color(0xb4c0cc);  // desaturated bright basin floor

  // ---- Displacement pass --------------------------------------------------
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const dist = Math.sqrt(x * x + z * z);
    const rn = THREE.MathUtils.clamp(dist / MAX_RADIUS, 0, 1); // 0 center .. 1 edge

    // Bowl profile: scoop the center down, level out by the basin edge.
    const bowl = THREE.MathUtils.smoothstep(rn, 0.0, 0.55);
    let h = -BOWL_DEPTH * (1.0 - bowl);

    // Jagged rim ridges — only appear toward the edges (weighted by rn).
    const ridge = noise.ridged(x * 0.012, z * 0.012, 5);
    h += ridge * RIDGE_HEIGHT * Math.pow(rn, 1.6);

    // Medium rolling detail everywhere.
    h += noise.fbm(x * 0.03, z * 0.03, 4) * 3.0;

    // Fine high-frequency crunch.
    h += noise.fbm(x * 0.12, z * 0.12, 3) * 0.8;

    pos.setY(i, h);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals(); // correct normals for lighting

  // ---- Color pass (needs final normals to read slope) ---------------------
  const nrm = geo.attributes.normal;
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const dist = Math.sqrt(x * x + z * z);
    const slope = nrm.getY(i); // 1 = flat, 0 = vertical wall

    // Snow settles on flat, low floor near the basin center.
    const flatness = THREE.MathUtils.smoothstep(slope, 0.7, 0.95);
    const lowness = 1.0 - THREE.MathUtils.smoothstep(y, -BOWL_DEPTH, 2.0);
    const central = 1.0 - THREE.MathUtils.smoothstep(dist, BASIN_RADIUS * 0.6, BASIN_RADIUS * 1.6);
    const snowAmt = flatness * Math.max(lowness * 0.6, central);

    tmp.copy(rock).lerp(snow, THREE.MathUtils.clamp(snowAmt, 0, 1));
    colors[i * 3 + 0] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // ---- Material -----------------------------------------------------------
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
    normalMap: makeStriationNormalMap(noise),
    normalScale: new THREE.Vector2(0.6, 0.6),
    flatShading: false,
  });
  material.normalMap.wrapS = material.normalMap.wrapT = THREE.RepeatWrapping;
  material.normalMap.repeat.set(8, 8);

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

// Generate a tiling normal map from FBM height via finite differences (Sobel-ish).
function makeStriationNormalMap(noise, res = 256) {
  const data = new Uint8Array(res * res * 4);
  const freq = 0.08;
  const strength = 2.0;

  const height = (x, y) =>
    noise.fbm(x * freq, y * freq, 4) + 0.5 * noise.fbm(x * freq * 3.0, y * freq * 0.5, 3);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      // Sample neighbors (wrap for tiling).
      const hL = height((x - 1 + res) % res, y);
      const hR = height((x + 1) % res, y);
      const hD = height(x, (y - 1 + res) % res);
      const hU = height(x, (y + 1) % res);
      const nx = (hL - hR) * strength;
      const ny = (hD - hU) * strength;
      const nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      const idx = (y * res + x) * 4;
      data[idx + 0] = (nx / len * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny / len * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz / len * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
