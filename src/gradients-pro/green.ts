import type { ColorScheme } from './dither-kit'

/**
 * The site's green as dither ramps, from the faintest light to the hottest,
 * for the gradients.sh Pro lights. Dark climbs toward white; light climbs
 * toward the deep accent, so the light still reads on the paper surface.
 */
export const GREEN: Record<ColorScheme, readonly string[]> = {
  dark: ['#123a27', '#2f8a5a', '#7fd7a8', '#eafaf0'],
  light: ['#d6ebdf', '#8cc7a6', '#146c43', '#0c4a2f'],
}

/**
 * The cards' light (`spotlight-grid.ts`) falls under their text, so its
 * hottest stop stays a mid green in both schemes and the copy keeps its
 * contrast where the light is brightest.
 */
export const CARD_LIGHT: Record<ColorScheme, readonly string[]> = {
  dark: ['#0f2b1e', '#1d5639', '#2c7d52', '#4fa877'],
  light: ['#e6f2eb', '#c9e4d4', '#a3d1b7', '#78b993'],
}
