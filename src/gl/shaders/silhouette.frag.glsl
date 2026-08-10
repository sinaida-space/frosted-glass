#version 300 es

// Silhouette distance field.
//
//   R = coverage 0..1  - feathered person mask, joint-bilateral upsampled from the
//                        256x256 MediaPipe mask and snapped onto the video's luminance
//                        edges, then firmed and dilated by one output pixel.
//   G = dz metres      - how far behind the pane this particular piece of the person is.
//                        0 = touching the glass, clamped to [0, 8].
//   B = attribution    - 1 where a landmark vouched for this pixel, 0 where dz is the
//                        "somewhere behind the face" fallback.
//   A = 1.0            - reserved.
//
// This pass writes geometry, never appearance: no colour, no blur (blur is task 6 and
// needs this texture sharp), no compositing.

in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"

uniform sampler2D uMask;      // R8 person confidence, y-down, covers the whole video frame
uniform sampler2D uVideo;     // RGBA8 camera frame, y-down (uploadVideo does NOT flip Y)
uniform sampler2D uProximity; // RGBA16F splat accumulation, already in screen space
uniform sampler2D uHistory;   // previous frame's output, same size, for temporal damping

// Video -> canvas `cover` fit, derived on the CPU from the video and canvas aspects.
uniform vec2 uVideoUvScale;
uniform vec2 uVideoUvOffset;
// 1 when the image is mirrored. Tracking already mirrors its NDC outputs, so this is the
// ONLY place the texture side is mirrored - flipping anywhere else double-mirrors.
uniform float uMirror;

uniform vec2 uMaskTexel;    // 1 / mask dimensions
uniform vec2 uOutTexel;     // 1 / output dimensions
uniform float uFallbackDz;  // faceDz + 0.30, used where no landmark reached this pixel
uniform float uHistoryBlend; // 0.25 normally; 0 on the first frame after a resize
uniform float uHasMask;      // 0 until the first segmentation result arrives

// Luminance tolerance of the joint bilateral filter. Taps whose video luma differs from
// the centre by much more than this are treated as belonging to a different surface and
// contribute almost nothing - that is what snaps the mask edge onto real finger edges.
#define BILATERAL_SIGMA 0.09

/**
 * Screen UV (y up, from the fullscreen triangle) -> video/mask texture UV (y down).
 * The mask is the segmenter's 256x256 output stretched over the whole video frame, so it
 * shares this mapping exactly.
 */
vec2 videoUv(vec2 screenUv) {
  vec2 uv = vec2(screenUv.x, 1.0 - screenUv.y);
  uv = uv * uVideoUvScale + uVideoUvOffset;
  uv.x = mix(uv.x, 1.0 - uv.x, uMirror);
  return uv;
}

float videoLuma(vec2 uv) {
  return luminance(texture(uVideo, uv).rgb);
}

/**
 * Joint bilateral upsample of the 256^2 mask, guided by the full-resolution video.
 * Five taps (centre + 4-neighbourhood at one mask texel), each weighted by a spatial
 * Gaussian times a luminance-similarity term, normalised by the weight sum.
 *
 * A plain bilinear read of the mask gives a soft edge that wobbles a whole mask texel
 * (about 7 screen pixels at 1080p) frame to frame; this pins it to the image.
 */
float refinedMask(vec2 screenUv) {
  const vec2 kOffset[5] = vec2[5](
    vec2( 0.0,  0.0),
    vec2( 1.0,  0.0),
    vec2(-1.0,  0.0),
    vec2( 0.0,  1.0),
    vec2( 0.0, -1.0)
  );
  // exp(-0.5) for the four unit-distance taps: the spatial half of the filter.
  const float kSpatial[5] = float[5](1.0, 0.60653066, 0.60653066, 0.60653066, 0.60653066);

  vec2 centre = videoUv(screenUv);
  float lumaCentre = videoLuma(centre);

  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 uv = centre + kOffset[i] * uMaskTexel;
    float m = texture(uMask, uv).r;
    float dl = videoLuma(uv) - lumaCentre;
    float w = kSpatial[i] * exp(-(dl * dl) / (BILATERAL_SIGMA * BILATERAL_SIGMA));
    sum += m * w;
    wsum += w;
  }
  return sum / max(wsum, 1e-5);
}

/** Refined mask firmed into a coverage value with a tight edge ramp. */
float coverageAt(vec2 screenUv) {
  return smoothstep(0.38, 0.62, refinedMask(screenUv));
}

void main() {
  // --- R: coverage --------------------------------------------------------
  // Dilate by one output pixel with a 4-tap max. The scatter pass downstream samples
  // just outside the silhouette; without this dilation the last half-covered pixel
  // reads as background and rings the whole figure with a bright one-pixel halo.
  float coverage = coverageAt(vUv);
  coverage = max(coverage, coverageAt(vUv + vec2(uOutTexel.x, 0.0)));
  coverage = max(coverage, coverageAt(vUv - vec2(uOutTexel.x, 0.0)));
  coverage = max(coverage, coverageAt(vUv + vec2(0.0, uOutTexel.y)));
  coverage = max(coverage, coverageAt(vUv - vec2(0.0, uOutTexel.y)));
  coverage *= uHasMask;

  // --- G/B: depth and attribution ----------------------------------------
  vec4 P = texture(uProximity, vUv);
  float attribution = saturate(P.g * 4.0);
  float dzSplat = P.r / max(P.g, 1e-4);

  // Where nothing splatted, P.g is 0 and the divide above yields 0 - which would read as
  // "touching the glass", the single most wrong answer available. Cross-fade to the
  // fallback on attribution instead, so unattributed limbs sit plausibly deep.
  float dz = mix(uFallbackDz, dzSplat, attribution);
  dz = clamp(dz, 0.0, 8.0);

  // Cheap temporal damping on depth only. Landmark confidence wobbles frame to frame and
  // an unstabilised dz makes the whole figure breathe; coverage is deliberately left
  // untouched so the silhouette edge stays crisp and responsive.
  float dzPrev = texture(uHistory, vUv).g;
  dz = mix(dz, dzPrev, uHistoryBlend);

  fragColor = vec4(coverage, dz, attribution, 1.0);
}
