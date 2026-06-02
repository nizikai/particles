// =============================================================================
// debris.js — a few hundred small rocks slowly rising & orbiting toward the
// light. One InstancedMesh draw call. Each instance gets its own radius, angle,
// rise speed, spin and scale, giving parallax-by-depth (far rocks are smaller /
// slower). Rocks recycle to the bottom once they pass the light height.
// Returns { mesh, update }.
// =============================================================================

import * as THREE from 'three';
import { Noise } from './lib/noise.js';

const COUNT = 320;
const TOP_Y = 70;     // ~light height; rocks reset after passing this
const BOTTOM_Y = -10; // where rocks respawn

// Build one irregular low-poly rock by jittering an icosahedron's vertices.
function makeRockGeometry(noise) {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const d = 1.0 + 0.45 * noise.fbm(v.x * 2.0, v.z * 2.0 + v.y, 3);
    v.multiplyScalar(d);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function createDebris() {
  const noise = new Noise(77);
  const geo = makeRockGeometry(noise);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1b1f24,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;

  // Per-instance state.
  const rocks = [];
  const dummy = new THREE.Object3D();

  for (let i = 0; i < COUNT; i++) {
    rocks.push(spawn(THREE.MathUtils.lerp(BOTTOM_Y, TOP_Y, Math.random())));
    writeMatrix(i);
  }
  mesh.instanceMatrix.needsUpdate = true;

  function spawn(y) {
    const radius = 6 + Math.random() * 70;       // distance from beam axis
    return {
      radius,
      angle: Math.random() * Math.PI * 2,
      y,
      // Far rocks are smaller and rise slower => depth parallax.
      scale: THREE.MathUtils.lerp(0.15, 1.4, 1 - radius / 80) * (0.5 + Math.random()),
      riseSpeed: THREE.MathUtils.lerp(3.5, 1.0, radius / 80) * (0.6 + Math.random() * 0.8),
      orbitSpeed: (Math.random() - 0.5) * 0.15,
      spin: new THREE.Vector3(Math.random(), Math.random(), Math.random())
        .multiplyScalar(0.4 + Math.random() * 0.6),
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
    };
  }

  function writeMatrix(i) {
    const r = rocks[i];
    // Spiral inward slightly as rocks rise toward the light.
    const radius = r.radius * (0.4 + 0.6 * (1 - (r.y - BOTTOM_Y) / (TOP_Y - BOTTOM_Y)));
    dummy.position.set(Math.cos(r.angle) * radius, r.y, Math.sin(r.angle) * radius);
    dummy.rotation.copy(r.rot);
    dummy.scale.setScalar(r.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  function update(dt) {
    for (let i = 0; i < COUNT; i++) {
      const r = rocks[i];
      r.y += r.riseSpeed * dt;
      r.angle += r.orbitSpeed * dt;
      r.rot.x += r.spin.x * dt;
      r.rot.y += r.spin.y * dt;
      r.rot.z += r.spin.z * dt;
      if (r.y > TOP_Y) rocks[i] = spawn(BOTTOM_Y); // recycle
      writeMatrix(i);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, update };
}
