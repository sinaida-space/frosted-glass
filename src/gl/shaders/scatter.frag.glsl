#version 300 es
// scatter.frag.glsl - depth-varying frosted scatter.
//
// Frosted glass is a thin diffuser. A point of light dz metres behind it leaves the far
// face as a cone and lands on the near face as a disc whose radius grows with dz. So the
// blur radius belongs to the SOURCE pixel, and every source pixel has a different one.
// That is a scatter, and a fragment shader can only gather.
//
// Gathering with the destination pixel's own radius produces the wrong picture twice over:
// a far torso never bleeds across a near hand's pixels (hard, false edge), and a
// variable-radius gather at 128 px is O(r^2) and does not run.
//
// The way out is a MIP pyramid plus a per-pixel level chosen by fixed-point iteration on
// the MIPPED depth: a pixel standing inside a wide blur region reads its neighbourhood's
// depth instead of its own, and therefore asks for the neighbourhood's radius.
//
// Output, RGBA16F at render resolution:
//   R = scattered coverage 0..1
//   G = scattered depth, metres behind the pane
//   B = contact factor, 1 at the glass - task 7's wet-contact highlight reads this
//   A = 1.0

in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"

uniform sampler2D uSource;    // mipmapped pyramid: R=cov, G=cov*dz, B=cov, A=dz
uniform vec2 uResolution;     // render resolution in pixels
uniform float uScatter;       // params.scatter, diffuser strength 0..1
uniform float uMaxScatterPx;  // params.maxScatterPx, cap at 1080p
uniform float uContactSharpness; // params.contactSharpness 0..1
uniform float uMaxLod;        // highest level the pyramid actually has

// QUALITY is injected by the pass: 1 = full, 0 = one refinement round and no lobe taps.
#ifndef QUALITY
#define QUALITY 1
#endif

/**
 * Gaussian-equivalent sigma, in level-0 pixels, of one trilinear read at level L.
 *
 * MEASURED, not assumed. The spec carried 0.75 as a working guess. Probing this exact
 * pyramid - RGBA16F, mipmapped, 1913x1071 (deliberately NPOT and odd on both axes) - with
 * a step edge swept across eight positions spanning 256 px, so that no level's texel grid
 * stays in phase with the edge, and taking the second moment of the edge derivative:
 *
 *   L        1     1.5    2     2.5    3     3.5    4     4.5    5     6     7     8
 *   sigma/2^L  .39  .58   .55   .56   .49   .54   .48   .47   .40   .40   .40   .49
 *
 * Mean 0.48 over the range the radius model actually uses. Half-integer levels sit a little
 * wider than integer ones because trilinear blends two levels there; integer levels above 4
 * settle at 0.40. 0.48 is the value that makes the end-to-end pass land on the radius it was
 * asked for (measured again on the finished pass, not just on the pyramid).
 *
 * The old 0.75 would have made every requested sigma come out about 1.5x too wide, i.e. a
 * palm at 5 cm blurred like one at 8 cm, which is precisely the illusion this pass exists
 * to protect.
 */
const float SIGMA_PER_LOD = 0.48;

float sigmaOfLod(float L) {
  return pow(2.0, L) * SIGMA_PER_LOD;
}

float lodOfSigma(float s) {
  return clamp(log2(max(s, 1e-3) / SIGMA_PER_LOD), 0.0, uMaxLod);
}

/**
 * Pixels of blur per metre of depth, at 1080p, at scatter = 1.
 *
 * This is the constant that decides how thick the glass reads. Together with
 * contactRange below it is the entire tuning surface of the look: at the default
 * scatter = 0.55 a hand 5 cm off the pane spreads about 4 px and a torso 90 cm back
 * spreads about 74 px, which is the near-sharp / far-milk split the reference stills show.
 */
const float SCATTER_PX_PER_METRE = 150.0;

float sigmaFor(float dz) {
  // Radii are authored at 1080p and scale with the actual buffer height, so the look is
  // the same on a small window as on a projector.
  float scale = uResolution.y / 1080.0;

  // The linear diffuser law: radius proportional to distance behind the pane.
  float s = uScatter * dz * SCATTER_PX_PER_METRE * scale;

  // Contact focus. Real frosted glass snaps sharp in the last few centimetres because the
  // scatter cone has no room to open. Without this the fingertips of a pressed palm stay
  // slightly soft and the whole illusion of touching the pane goes.
  float contactRange = mix(0.15, 0.02, uContactSharpness);
  s *= smoothstep(0.0, contactRange, dz);

  // Hard cap, so a far wall does not cost the whole pyramid.
  return min(s, uMaxScatterPx * scale);
}

/**
 * Depth of one pyramid sample.
 *
 * Where the region holds any person, the coverage-weighted mean G/R is the depth of that
 * person. Where it holds none, G/R is 0/0 and the unweighted A channel - the silhouette
 * pass's push-pull-filled depth field, which is defined at every pixel - answers instead.
 * That second branch is what lets a background pixel beside a distant torso know it is
 * inside a wide-blur region at all.
 */
float depthAt(vec4 s) {
  float bodyness = saturate(s.r * 8.0);
  float dzWeighted = s.g / max(s.r, 1e-4);
  return mix(s.a, dzWeighted, bodyness);
}

/**
 * One read of the pyramid, with the mip's square box character broken up.
 *
 * A single trilinear tap carries the box filter's corners, and on a large blur that shows
 * as a faint square halo around the figure. Four extra taps on a 45-degree cross at
 * 0.5 sigma round the lobe off.
 *
 * `sigmaPx` is the sigma this read is actually ASKING FOR, not sigmaOfLod(lod). The two
 * differ wherever lod hits a clamp, and the case that matters is scatter = 0: there the
 * requested sigma is 0 but lod clamps to 0, whose nominal sigma is 0.48 px, and taps at
 * 0.17 px would quietly stop the pass being pixel-exact. Measured: with sigmaOfLod(lod),
 * 4320 pixels of a 1920x1080 frame differed from the source at scatter = 0.
 *
 * The cross is ROTATED BY A PER-PIXEL HASH, not fixed to the diagonals. A mip level is a
 * box filter with COMPACT support, and that support ends on the level's own texel grid -
 * so the blur around a figure stops dead on a screen-axis-aligned line. Measured on the
 * torso at 0.9 m: coverage was exactly 0.0 out to x = 315 and 0.0167 at x = 320, a step
 * out of nothing, drawn as a straight vertical edge 120 px from the body. Fixed offsets
 * only move that line; a random rotation smears it across a band the width of the tap
 * radius, so it stops being a line at all. The radius is unchanged, so the calibration
 * above still holds.
 */
vec4 sampleLobe(vec2 uv, float lod, float sigmaPx) {
  vec4 c = textureLod(uSource, uv, lod);
#if QUALITY >= 1
  // A 4-fold symmetric cross repeats every 90 degrees, so a quarter turn is a full period.
  float a = hash12(gl_FragCoord.xy) * (PI * 0.5);
  // Built in PIXELS and converted to UV per axis, so the cross stays square on a
  // non-square buffer.
  vec2 p1 = vec2(cos(a), sin(a)) * (0.5 * sigmaPx);
  vec2 u1 = p1 / uResolution;
  vec2 u2 = vec2(-p1.y, p1.x) / uResolution;
  vec4 t1 = textureLod(uSource, uv + u1, lod);
  vec4 t2 = textureLod(uSource, uv - u1, lod);
  vec4 t3 = textureLod(uSource, uv + u2, lod);
  vec4 t4 = textureLod(uSource, uv - u2, lod);
  return c * 0.34 + (t1 + t2 + t3 + t4) * 0.165;
#else
  return c;
#endif
}

void main() {
  // --- this pixel's own answer, at full sharpness -------------------------
  vec4 s0 = textureLod(uSource, vUv, 0.0);
  float ownDz = depthAt(s0);
  float ownSigma = sigmaFor(ownDz);
  float ownLod = lodOfSigma(ownSigma);

  // --- the iteration: re-read depth at the current scale, re-derive the scale ---
  // Damped at 0.7. Undamped, the update flip-flops along the boundary between a near hand
  // and a far torso - each round overshoots to the other side's depth - and the seam
  // shimmers frame to frame even when nothing moves.
  float lod = ownLod;
  float wideSigma = ownSigma;
#if QUALITY >= 1
  const int ROUNDS = 2;
#else
  const int ROUNDS = 1;
#endif
  for (int i = 0; i < ROUNDS; i++) {
    vec4 sn = textureLod(uSource, vUv, lod);
    float dzN = depthAt(sn);
    wideSigma = sigmaFor(dzN);
    lod = mix(lod, lodOfSigma(wideSigma), 0.7);
  }

  // --- consistency clamp: what is actually in reach, and what is it entitled to? ---
  // The level above says how far the light at this pixel is ALLOWED to have spread. It
  // never checks what actually spread here. Left alone, a background pixel whose filled
  // depth is large gathers wide and drags in a palm pressed against the glass 100 px away
  // - measured as a 5% coverage tail reaching 110 px around a hand at 5 cm, identical with
  // the torso removed from the scene, so it was purely the hand being smeared outward.
  //
  // So read the body that is actually in reach and ask what IT is entitled to. A hand at
  // 5 cm cannot throw coverage 100 px however deep its surroundings are. Downward only:
  // widening here would re-open the oscillation the damping exists to stop.
  //
  // Gated on there being anything in reach at all. Where the probe reads exactly zero
  // coverage - beyond the compact support of the mip level - bodyDz is 0/0, bodyLod
  // collapses to 0, and the clamp would drop a pixel from lod 6.6 to lod 2 for no reason.
  // That is not harmless: it also collapses the tap radius below, so the lobe taps stop
  // reaching back into the support and the blur ends on a hard, straight, texel-aligned
  // line. Measured before the gate: coverage exactly 0.0 at x = 315 and 0.0160 at x = 320
  // beside a torso at 0.9 m.
  {
    vec4 probe = textureLod(uSource, vUv, lod);
    float bodyDz = probe.g / max(probe.r, 1e-4);
    float bodyLod = lodOfSigma(sigmaFor(bodyDz));
    float inReach = saturate(probe.r * 1000.0);
    lod = mix(lod, min(lod, bodyLod), 0.7 * inReach);
    wideSigma = min(wideSigma, sigmaOfLod(lod));
  }

  // --- anti-leak guard ----------------------------------------------------
  // The iteration is deliberately willing to widen a pixel's radius to its neighbourhood's.
  // That is right for a background pixel next to a torso and wrong for a palm pressed to
  // the glass in front of that torso: left alone, the hand would be smeared by what is
  // behind it and the fingers would fuse. Where the iteration asked for MORE blur than the
  // pixel's own depth wants, lean back toward the pixel's own answer, by contactSharpness.
  vec4 s = sampleLobe(vUv, lod, min(sigmaOfLod(lod), wideSigma));
  float guard = saturate((lod - ownLod) * 0.8) * uContactSharpness;
  if (guard > 0.001) {
    // Only the minority of pixels sitting in front of something deeper pay for this.
    vec4 sharp = sampleLobe(vUv, ownLod, min(sigmaOfLod(ownLod), ownSigma));
    s = mix(sharp, s, 1.0 - guard);
  }

  float coverage = saturate(s.r);
  float dz = depthAt(s);

  // Contact factor: 1 against the glass, 0 by 10 cm. Task 7 turns this into the wet
  // near-contact highlight and the Beer-Lambert darkening at the pane.
  float contact = 1.0 - smoothstep(0.0, 0.10, dz);

  fragColor = vec4(coverage, dz, contact, 1.0);
}
