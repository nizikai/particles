// =============================================================================
// haze.js — layered ground mist.
// A handful of large, soft, additive-blended horizontal planes hovering just
// above the basin floor. Each uses an FBM shader to carve a wispy, drifting
// cloud that fades at the plane edges. Combined with scene.fog (set in main.js)
// this gives the dusty, volumetric atmosphere. Returns { group, update }.
// =============================================================================

import * as THREE from 'three';
import { glslNoise } from './shaders/glsl-noise.js';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3  uColor;
  uniform float uScale;
  uniform vec2  uDrift;

  ${glslNoise}

  void main() {
    // Two FBM layers drifting at slightly different rates => roiling mist.
    vec2 p = vUv * uScale + uDrift * uTime;
    float n  = fbm(p);
    n += 0.5 * fbm(p * 2.1 - uDrift * uTime * 0.6);
    n = n * 0.5 + 0.5;                 // -> [0,1]
    float mist = smoothstep(0.45, 0.95, n);

    // Fade out toward the plane edges so the quad is invisible.
    vec2 c = vUv - 0.5;
    float edge = smoothstep(0.5, 0.15, length(c));

    float a = mist * edge * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

export function createHaze() {
  const group = new THREE.Group();
  const layers = [];

  // Cold, slightly blue-grey mist to match the desaturated grade.
  const color = new THREE.Color(0x6c7a8a);

  const configs = [
    { y: -6,  size: 200, opacity: 0.10, scale: 2.5, drift: [0.010, 0.004] },
    { y: -2,  size: 170, opacity: 0.12, scale: 3.2, drift: [-0.008, 0.006] },
    { y: 3,   size: 150, opacity: 0.10, scale: 4.0, drift: [0.006, -0.005] },
    { y: 9,   size: 130, opacity: 0.07, scale: 5.0, drift: [-0.005, 0.003] },
  ];

  for (const cfg of configs) {
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime:    { value: 0 },
        uOpacity: { value: cfg.opacity },
        uColor:   { value: color },
        uScale:   { value: cfg.scale },
        uDrift:   { value: new THREE.Vector2(cfg.drift[0], cfg.drift[1]) },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(cfg.size, cfg.size), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = cfg.y;
    group.add(mesh);
    layers.push(mat);
  }

  function update(t) {
    for (const mat of layers) mat.uniforms.uTime.value = t;
  }

  return { group, update };
}
