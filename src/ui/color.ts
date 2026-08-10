/** sRGB <-> linear conversion for the colour picker.
 * GlassParams colour fields are LINEAR RGB, 0..1.
 * <input type="color"> hex values are sRGB, 0..255 per channel.
 * Uses the real piecewise sRGB transfer function (not a 2.2 gamma approximation).
 */

/** One sRGB channel (0..1) -> linear (0..1). */
export function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** One linear channel (0..1) -> sRGB (0..1). */
export function linearChannelToSRGB(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/** sRGB [r,g,b] 0..1 -> linear [r,g,b] 0..1. */
export function sRGBToLinear(rgb: [number, number, number]): [number, number, number] {
  return [srgbChannelToLinear(rgb[0]), srgbChannelToLinear(rgb[1]), srgbChannelToLinear(rgb[2])]
}

/** Linear [r,g,b] 0..1 -> sRGB [r,g,b] 0..1. */
export function linearToSRGB(rgb: [number, number, number]): [number, number, number] {
  return [linearChannelToSRGB(rgb[0]), linearChannelToSRGB(rgb[1]), linearChannelToSRGB(rgb[2])]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** #rrggbb (sRGB) -> linear [r,g,b] 0..1. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  return sRGBToLinear([r, g, b])
}

/** linear [r,g,b] 0..1 -> #rrggbb (sRGB). */
export function linearToHex(rgb: [number, number, number]): string {
  const [r, g, b] = linearToSRGB(rgb)
  const toByte = (c: number) => Math.round(clamp01(c) * 255)
  const hex = (c: number) => toByte(c).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}
