#version 300 es
precision highp float;

// A loose shard is a piece of the pane that is still a piece of the pane: it shows the
// image it broke off with, it catches the light along its cut edges, and it dims as it
// falls toward the viewer and out of the light the pane was sitting in.

in vec2 vRestUv;
in float vAlpha;
in float vZ;
in float vEdge;

uniform sampler2D uGlass;

out vec4 fragColor;

void main() {
  vec3 col = texture(uGlass, vRestUv).rgb;

  // Cut edges are bright: a fresh glass edge is a lens onto whatever is behind it.
  // vEdge is 0 at the seed and 1 on the boundary, so this is a rim, not an outline.
  float rim = smoothstep(0.90, 1.0, vEdge);
  col += rim * 0.22;

  // Leaving the light. The pane is lit from the front; a shard tumbling toward the viewer
  // turns out of that lighting, and without this the falling glass reads as paper.
  col *= 1.0 / (1.0 + vZ * 0.9);

  fragColor = vec4(col * vAlpha, vAlpha);
}
