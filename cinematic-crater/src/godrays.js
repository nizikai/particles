// =============================================================================
// godrays.js — custom radial-blur god rays as a pmndrs Effect.
// Instead of pmndrs' depth-masked GodRaysEffect (which forces the EffectComposer
// to share a depth texture across its ping-pong buffers and floods some ANGLE
// backends with per-frame blit warnings), we mask the bright source by
// LUMINANCE and smear it radially outward from the light's screen position.
// No depth texture -> clean console, and full control over the shaft falloff.
// =============================================================================

import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';

const SAMPLES = 64;

const fragment = /* glsl */ `
  uniform vec2  lightScreenPos; // sun position in screen UV space
  uniform float exposure;
  uniform float decay;
  uniform float density;
  uniform float weight;
  uniform float threshold;      // luminance below this is ignored
  uniform float clampMax;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 texCoord = uv;
    // Step from the current pixel toward the light, summing bright samples.
    vec2 delta = (uv - lightScreenPos) * (density / float(${SAMPLES}));
    float illumination = 1.0;
    vec3 rays = vec3(0.0);

    for (int i = 0; i < ${SAMPLES}; i++) {
      texCoord -= delta;
      vec3 s = texture(inputBuffer, texCoord).rgb;
      // Keep only bright pixels (the sun + bloomed core) -> shaft, not a smear.
      float lum = max(max(s.r, s.g), s.b);
      s *= smoothstep(threshold, 1.0, lum);
      s *= illumination * weight;
      rays += s;
      illumination *= decay;
    }
    rays = min(rays * exposure, clampMax);
    // Additively layer the rays over the scene.
    outputColor = vec4(inputColor.rgb + rays, inputColor.a);
  }
`;

export class RadialGodRaysEffect extends Effect {
  constructor({
    exposure = 0.5,
    decay = 0.94,
    density = 0.8,
    weight = 0.5,
    threshold = 0.55,
    clampMax = 1.2,
  } = {}) {
    super('RadialGodRaysEffect', fragment, {
      // CONVOLUTION: this effect samples many neighboring texels, so pmndrs gives
      // it its own pass and exposes `inputBuffer`. No DEPTH attribute -> no shared
      // depth texture -> no blit warning.
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['lightScreenPos', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['exposure', new THREE.Uniform(exposure)],
        ['decay', new THREE.Uniform(decay)],
        ['density', new THREE.Uniform(density)],
        ['weight', new THREE.Uniform(weight)],
        ['threshold', new THREE.Uniform(threshold)],
        ['clampMax', new THREE.Uniform(clampMax)],
      ]),
    });

    this._lightWorldPos = new THREE.Vector3();
    this._projected = new THREE.Vector3();
  }

  // Call each frame with the sun's world position + active camera so the rays
  // emanate from the light's current screen location.
  setLightPosition(worldPos, camera) {
    this._projected.copy(worldPos).project(camera);
    const u = this.uniforms.get('lightScreenPos').value;
    u.set(this._projected.x * 0.5 + 0.5, this._projected.y * 0.5 + 0.5);
  }
}
