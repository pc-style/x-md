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
 * The cards' light (`spotlight-grid.ts`) falls under their text, so it stays
 * close to each surface: under its hottest cell, body copy keeps at least
 * 7:1 and the dimmest code text at least 3.6:1. Each card takes the ramp for
 * its own surface, so the code panes use the dark one in either theme.
 */
export const CARD_LIGHT: Record<ColorScheme, readonly string[]> = {
  dark: ['#091711', '#0e2419', '#133322', '#19432c'],
  light: ['#f3f9f5', '#e9f4ee', '#dcede3', '#cbe5d6'],
}
