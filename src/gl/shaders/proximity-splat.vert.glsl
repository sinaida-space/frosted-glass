#version 300 es

// Instanced point splat, one instance per contributing landmark (hand joints, face,
// torso). Four vertices per instance form a screen-aligned quad around the splat
// centre; the quad is expanded from gl_VertexID so no per-vertex attribute buffer is
// needed - every attribute below is per-instance (divisor 1).
//
// Positions arrive already in SCREEN NDC (-1..1, y up). All mirroring and the
// video->canvas cover-fit correction happen once, on the CPU, in SilhouettePass.

layout(location = 0) in vec2 aCenter;  // splat centre, screen NDC
layout(location = 1) in vec2 aRadius;  // half-extent, screen NDC (x pre-divided by aspect
                                       // so the splat is a circle in pixels, not an ellipse)
layout(location = 2) in vec3 aDepthWeightConf; // x = dz metres behind glass, y = weight, z = confidence

out vec2 vLocal;   // -1..1 across the quad; length() is the normalised distance from centre
out float vDz;
out float vWeight;
out float vConf;

void main() {
  // gl_VertexID 0..3 -> (-1,-1), (1,-1), (-1,1), (1,1): the TRIANGLE_STRIP winding of a quad.
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;

  vLocal = corner;
  vDz = aDepthWeightConf.x;
  vWeight = aDepthWeightConf.y;
  vConf = aDepthWeightConf.z;

  gl_Position = vec4(aCenter + corner * aRadius, 0.0, 1.0);
}
