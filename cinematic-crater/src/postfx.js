// =============================================================================
// postfx.js — the cinematic post chain (pmndrs 'postprocessing').
// Order matters. We render the scene, optionally blur with DOF, then in one
// merged EffectPass apply: GodRays -> Bloom -> ColorGrade -> ChromaticAberration
// -> Vignette -> Noise. ACESFilmic tone mapping lives on the renderer.
// Returns { composer, godRays }.
// =============================================================================

import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  GodRaysEffect,
  BloomEffect,
  ChromaticAberrationEffect,
  VignetteEffect,
  NoiseEffect,
  Effect,
  BlendFunction,
  KernelSize,
} from 'postprocessing';

// ---- Custom color grade: desaturate + cold tint + gentle contrast ----------
const gradeFragment = /* glsl */ `
  uniform float saturation;
  uniform float contrast;
  uniform vec3  tint;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 c = inputColor.rgb;
    // Desaturate toward luminance.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, saturation);
    // Cold tint (push toward blue-grey).
    c *= tint;
    // Soft contrast around mid grey.
    c = (c - 0.5) * contrast + 0.5;
    outputColor = vec4(c, inputColor.a);
  }
`;

class ColorGradeEffect extends Effect {
  constructor({ saturation = 0.45, contrast = 1.08, tint = new THREE.Color(0.86, 0.92, 1.0) } = {}) {
    super('ColorGradeEffect', gradeFragment, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['saturation', new THREE.Uniform(saturation)],
        ['contrast', new THREE.Uniform(contrast)],
        ['tint', new THREE.Uniform(tint)],
      ]),
    });
  }
}

export function createPostFX(renderer, scene, camera, sunMesh) {
  // No multisampling: on some Chrome/ANGLE backends an MSAA depth-stencil
  // resolve floods the console with "read and write depth stencil cannot be
  // the same image" every frame (GodRays needs scene depth). We render at
  // devicePixelRatio (up to 2x) for supersampling-style edge smoothing instead.
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType, // HDR headroom so bloom blows out cleanly
    multisampling: 0,
  });
  composer.addPass(new RenderPass(scene, camera));

  // --- God rays: radial blur masked to the bright sun mesh -----------------
  const godRays = new GodRaysEffect(camera, sunMesh, {
    height: 480,
    kernelSize: KernelSize.SMALL,
    density: 0.96,
    decay: 0.93,
    weight: 0.6,
    exposure: 0.55,
    samples: 60,
    clampMax: 1.0,
    blur: true,
  });

  // --- Bloom: hard glow on the brightest pixels (the light core) -----------
  const bloom = new BloomEffect({
    intensity: 2.4,
    luminanceThreshold: 0.62,
    luminanceSmoothing: 0.25,
    mipmapBlur: true,
    radius: 0.85,
  });

  const colorGrade = new ColorGradeEffect();

  const chromaticAberration = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(0.0009, 0.0011),
    radialModulation: true,
    modulationOffset: 0.3,
  });

  const vignette = new VignetteEffect({ offset: 0.4, darkness: 0.55 });

  const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY });
  noise.blendMode.opacity.value = 0.16; // film grain strength

  // Convolution effects (GodRays, Bloom, radial ChromaticAberration) each sample
  // neighboring texels, so pmndrs forbids merging them into one pass — they get
  // their own EffectPass. Simple per-pixel effects (grade, vignette, grain) are
  // merged into a single pass for efficiency.
  composer.addPass(new EffectPass(camera, godRays));
  composer.addPass(new EffectPass(camera, bloom));
  composer.addPass(new EffectPass(camera, colorGrade, vignette, noise));
  composer.addPass(new EffectPass(camera, chromaticAberration));

  // GodRays reads the scene depth texture. The composer attaches that SAME
  // texture to the ping-pong *output* (write) buffer too, so a frame's blit
  // reads and writes the same depth-stencil image — which ANGLE rejects with a
  // per-frame console warning. The output buffer never needs scene depth (god
  // rays keep their own reference), so we strip depth from it. Re-applied on
  // resize because EffectComposer.setSize touches the buffers.
  const dropOutputDepth = () => {
    const out = composer.outputBuffer;
    if (out) { out.depthTexture = null; out.depthBuffer = false; }
  };
  dropOutputDepth();

  return { composer, godRays, dropOutputDepth };
}
