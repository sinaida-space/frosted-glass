#version 300 es

// Instanced shard geometry. One instance per shard, FAN_VERTS + 2 vertices each drawn as
// a TRIANGLE_FAN: the seed, the boundary, then the first boundary point again to close it.
//
// The boundary offsets differ per shard AND per vertex, so they cannot be an instance
// attribute; they live in a NEAREST-sampled RG float texture, one row per shard, and are
// read with texelFetch(gl_VertexID, gl_InstanceID). What IS per-instance is only the
// transform, which is the part that changes every frame.

layout(location = 0) in vec3 aM0; // model matrix column 0 - divisor 1
layout(location = 1) in vec3 aM1; // column 1               - divisor 1
layout(location = 2) in vec3 aM2; // column 2 (translation) - divisor 1
layout(location = 3) in vec4 aRest; // restCentroid.xy, alpha, z - divisor 1

uniform sampler2D uGeom;
uniform int uFanVerts;
/** 1 while rendering the hole mask: draw the cell where it came FROM, not where it is. */
uniform float uUseRest;

out vec2 vRestUv;
out float vAlpha;
out float vZ;
/** 0 at the shard's seed, 1 on its boundary - the edge highlight rides on this. */
out float vEdge;

void main() {
  int vid = gl_VertexID == 0 ? 0 : 1 + ((gl_VertexID - 1) % uFanVerts);
  vec2 offset = vid == 0 ? vec2(0.0) : texelFetch(uGeom, ivec2(vid - 1, gl_InstanceID), 0).xy;

  vEdge = vid == 0 ? 0.0 : 1.0;
  vAlpha = aRest.z;
  vZ = aRest.w;

  // The shard carries the piece of image it broke off with, so the texture coordinate is
  // the REST position - sampling at the current position would make a falling shard look
  // like a hole travelling over a static picture.
  vec2 rest = aRest.xy + offset;
  vRestUv = rest * 0.5 + 0.5;

  vec2 current = (mat3(aM0, aM1, aM2) * vec3(offset, 1.0)).xy;
  gl_Position = vec4(mix(current, rest, uUseRest), 0.0, 1.0);
}
