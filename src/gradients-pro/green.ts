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
 * The converter's beams (`border-beam.ts`): the same green, more saturated in
 * the middle, so the light reads as colour along the border rather than
 * white. It only ever runs on the hero's dark band.
 */
export const BEAM: readonly string[] = ['#0e3d28', '#1f9e62', '#5ff0a8', '#f2fff8']

/**
 * The cards' light (`spotlight-grid.ts`) falls under their text, so it stays
 * close to each surface. Spotlight Grid's light peaks at 0.66, so it reaches
 * the third stop at most; there, at the canvas's 0.8 opacity, every text
 * colour on the cards that meets 4.5:1 unlit still does. Each card takes the
 * ramp for its own surface, so the code panes use the dark one in either theme.
 */
export const CARD_LIGHT: Record<ColorScheme, readonly string[]> = {
  dark: ['#07130e', '#0b1d14', '#0f281b', '#153524'],
  light: ['#f5faf7', '#edf6f0', '#e3f1e8', '#d6ebdf'],
}
