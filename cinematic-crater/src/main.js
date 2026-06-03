// =============================================================================
// main.js — assembles the cinematic crater scene.
//   MVP core:  renderer + camera + terrain + key light + sun + bloom + god rays
//   Layered:   fog, ground haze, floating debris, the figure, full color grade
//   Motion:    slow camera orbit, rising debris, drifting haze, light shimmer
// =============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createTerrain } from './terrain.js';
import { createHaze } from './haze.js';
import { createDebris } from './debris.js';
import { createPostFX } from './postfx.js';

// -----------------------------------------------------------------------------
// Renderer — ACESFilmic tone mapping + soft shadows for the cinematic base.
// -----------------------------------------------------------------------------
// stencil:false -> depth is a standalone attachment (not packed DEPTH24_STENCIL8),
// which avoids the "read and write depth stencil cannot be the same image" blit
// error triggered when GodRays samples scene depth. AA is handled by SMAA in post.
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  stencil: false,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

// -----------------------------------------------------------------------------
// Scene + exponential fog (gives depth haze; ground mist is layered on top).
// -----------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x0c1118, 0.006);

// -----------------------------------------------------------------------------
// Camera + controls — slow auto-orbit for the floaty drift; drag/scroll to look.
// -----------------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(0, 20, 95);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 5, 0); // frame the basin floor + figure, with the light high above
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18; // very slow drift
controls.minDistance = 30;
controls.maxDistance = 130;
controls.maxPolarAngle = Math.PI * 0.62; // allow tilting down into the basin too

// -----------------------------------------------------------------------------
// KEY LIGHT + SUN — one bright source high above center.
//   * sunMesh: an emissive sphere; this is what GodRays + Bloom key off of.
//   * keyLight: a DirectionalLight from the same spot to light the terrain
//               and rim-light the figure.
// -----------------------------------------------------------------------------
const SUN_POS = new THREE.Vector3(0, 50, -22);

const sunMesh = new THREE.Mesh(
  new THREE.SphereGeometry(2.4, 32, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
);
sunMesh.position.copy(SUN_POS);
scene.add(sunMesh);

const keyLight = new THREE.DirectionalLight(0xeaf2ff, 4.8);
keyLight.position.copy(SUN_POS);
keyLight.target.position.set(0, -8, 0);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 10;
keyLight.shadow.camera.far = 160;
keyLight.shadow.camera.left = -60;
keyLight.shadow.camera.right = 60;
keyLight.shadow.camera.top = 60;
keyLight.shadow.camera.bottom = -60;
keyLight.shadow.bias = -0.0004;
scene.add(keyLight);
scene.add(keyLight.target);

// Low cold ambient so shadow areas read without going pure black.
scene.add(new THREE.AmbientLight(0x35506f, 0.7));
// Blue bounce from below to read the dust and basin floor.
const bounce = new THREE.HemisphereLight(0x4a6885, 0x0a0c10, 0.7);
scene.add(bounce);

// -----------------------------------------------------------------------------
// TERRAIN
// -----------------------------------------------------------------------------
const terrain = createTerrain();
scene.add(terrain);

// -----------------------------------------------------------------------------
// THE FIGURE — placeholder capsule standing in the basin, rim-lit by the key
// light so it reads as a bright silhouette. (Swap for a GLB: see README note.)
// -----------------------------------------------------------------------------
const FLOOR_Y = -14; // basin center sits ~ -BOWL_DEPTH from terrain.js
const figure = new THREE.Mesh(
  new THREE.CapsuleGeometry(1.1, 3.6, 8, 16),
  new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.7, metalness: 0.1 }),
);
figure.position.set(0, FLOOR_Y + 2.9, 0);
figure.castShadow = true;
scene.add(figure);

// -----------------------------------------------------------------------------
// HAZE + DEBRIS
// -----------------------------------------------------------------------------
const haze = createHaze();
scene.add(haze.group);

const debris = createDebris();
scene.add(debris.mesh);

// -----------------------------------------------------------------------------
// POST PROCESSING
// -----------------------------------------------------------------------------
const { composer } = createPostFX(renderer, scene, camera, sunMesh);

// -----------------------------------------------------------------------------
// MOTION — slow & floaty: rising debris, drifting haze, light shimmer.
// -----------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp to avoid jumps after tab-out
  const t = clock.getElapsedTime();

  // Light intensity shimmer — gentle flicker on key light + sun core.
  const shimmer = 1.0 + 0.06 * Math.sin(t * 1.7) + 0.03 * Math.sin(t * 4.3);
  keyLight.intensity = 4.8 * shimmer;
  sunMesh.scale.setScalar(1.0 + 0.04 * Math.sin(t * 2.1));

  haze.update(t);
  debris.update(dt);
  controls.update();

  composer.render();
}

animate();

// -----------------------------------------------------------------------------
// Resize
// -----------------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// Fade out the on-screen hint after a few seconds.
setTimeout(() => { const h = document.getElementById('hint'); if (h) h.style.opacity = '0'; }, 5000);
