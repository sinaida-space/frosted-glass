// common.glsl - shared include for all fragment passes.
// Resolved via resolveIncludes() (see src/gl/program.ts): `#include "common.glsl"`.
//
// NOTE on vUv / vNdc: the shared fullscreen-triangle vertex shader (src/gl/program.ts)
// outputs `vUv` (0..1 across the viewport) and `vNdc` (-1..1 clip-space position) as
// varyings. This file does not redeclare them - each fragment shader that includes this
// module must declare its own matching `in vec2 vUv;` / `in vec2 vNdc;` before use.

#define PI 3.14159265359

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }

// --- Hashing ---------------------------------------------------------------

// Single-value hash of a 2D input, in [0, 1). Deterministic, no external seed state.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Two-value hash of a 2D input, each component in [0, 1).
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// --- Noise -------------------------------------------------------------

// Bilinearly-interpolated value noise in [0, 1], deterministic per input (no tiling
// wraparound assumed - callers control periodicity, if any, upstream).
float valueNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep interpolant

  float a = hash12(i + vec2(0.0, 0.0));
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 5-octave fractal Brownian motion built on valueNoise2. Deterministic for a given
// input; not designed to tile.
float fbm2(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * valueNoise2(p * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

// --- Colour -------------------------------------------------------------

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 sRGBToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

// --- Dithering -------------------------------------------------------------

// 8x8 Bayer ordered-dither threshold in [0, 1) for the given integer pixel coordinate.
float bayer8(vec2 fragCoord) {
  const float bayer[64] = float[64](
     0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
    48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
    12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
    60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
     3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
    51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
    15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
    63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
  );
  ivec2 p = ivec2(mod(fragCoord, 8.0));
  int idx = p.y * 8 + p.x;
  return bayer[idx] / 64.0;
}

// Cheap stand-in for a blue-noise texture lookup: hash-based dither value in [0, 1)
// used to break up banding in low bit-depth output without a bound noise texture.
float blueNoiseDither(vec2 fragCoord) {
  return hash12(fragCoord);
}
