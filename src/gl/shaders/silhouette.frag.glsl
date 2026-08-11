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
uniform sampler2D uProximity;       // RGBA16F splat accumulation, already in screen space
uniform sampler2D uProximityFilled; // same, after the push-pull hole fill
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
#define BILATERAL_RADIUS 3.0

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
 * Five taps - the nearest mask texel plus its 4-neighbourhood - each weighted by a
 * spatial Gaussian times a luminance-similarity term, normalised by the weight sum.
 *
 * A plain bilinear read of the mask gives a soft edge that wobbles a whole mask texel
 * (about 7 screen pixels at 1080p) frame to frame; this pins it to the image.
 *
 * The taps are SNAPPED TO MASK TEXEL CENTRES, and that is the part that makes this work
 * at all. uMask is a LINEAR-filtered texture, so reading it anywhere off a texel centre
 * returns a value that has already been bilinearly blended across the very edge this
 * filter exists to recover. Every tap would then be pre-smeared, the weights would be
 * reweighting mush, and the output would land within a fraction of a percent of a plain
 * bilinear upsample - measurably so. Snapping makes each tap a true mask sample, and the
 * luminance term then picks which of those samples this output pixel actually belongs to.
 *
 * The spatial term uses the real sub-texel distance from the output pixel to each tap
 * centre rather than a fixed kernel, so with a flat guide the filter degrades gracefully
 * into ordinary interpolation instead of a one-texel blur.
 */
float refinedMask(vec2 screenUv) {
  const vec2 kOffset[5] = vec2[5](
    vec2( 0.0,  0.0),
    vec2( 1.0,  0.0),
    vec2(-1.0,  0.0),
    vec2( 0.0,  1.0),
    vec2( 0.0, -1.0)
  );

  vec2 centre = videoUv(screenUv);
  float lumaCentre = videoLuma(centre);

  // Position of this output pixel in mask-texel units, and the nearest texel centre.
  vec2 texelPos = centre / uMaskTexel - 0.5;
  vec2 nearest = floor(texelPos + 0.5);

  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 tap = nearest + kOffset[i] * BILATERAL_RADIUS;
    vec2 uv = (tap + 0.5) * uMaskTexel;

    float m = texture(uMask, uv).r;

    vec2 d = tap - texelPos;
    float spatial = exp(-0.5 * dot(d, d) / (BILATERAL_RADIUS * BILATERAL_RADIUS));

    float dl = videoLuma(uv) - lumaCentre;
    float range = exp(-(dl * dl) / (BILATERAL_SIGMA * BILATERAL_SIGMA));

    float w = spatial * range;
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
  // Attribution is read from the RAW accumulation, not the filled one: B has to keep
  // reporting whether a landmark actually vouched for this pixel, and after the fill
  // every pixel near a body carries weight.
  float attribution = saturate(texture(uProximity, vUv).g * 4.0);

  // Depth comes from the FILLED accumulation. Where landmarks reached, the fill leaves
  // their answer untouched; where they did not - forearms, elbows, shoulders, hair, the
  // outer half of an edge-on palm - it carries in the depth of the nearest attributed
  // region instead of a constant, so there is no cliff at the wrist.
  vec4 F = texture(uProximityFilled, vUv);
  float dzFilled = F.r / max(F.g, 1e-4);

  // The constant survives only as the root of the pyramid: on a frame with no landmarks
  // at all, F.g is still zero everywhere and the divide above yields 0, which would read
  // as "touching the glass" - the single most wrong answer available.
  float filled = saturate(F.g * 4.0);
  float dz = mix(uFallbackDz, dzFilled, filled);
  dz = clamp(dz, 0.0, 8.0);

  // Cheap temporal damping on depth only. Landmark confidence wobbles frame to frame and
  // an unstabilised dz makes the whole figure breathe; coverage is deliberately left
  // untouched so the silhouette edge stays crisp and responsive.
  float dzPrev = texture(uHistory, vUv).g;
  dz = mix(dz, dzPrev, uHistoryBlend);

  fragColor = vec4(coverage, dz, attribution, 1.0);
}
