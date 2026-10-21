/**
 * The landing page's gradients, by the name their canvases carry
 * (`canvas[data-gradient]`). The page is one night of green light, a different
 * phenomenon in each dark band:
 *
 * - `aurora`: curtains of aurora over the hero, from gradients.sh's "Kiruna".
 * - `orbit`: the lit edge of a planet under the hero copy, gradients.sh's
 *   "Greenshine". The aurora hangs above it.
 * - `eclipse`: a dark sun with a jade corona rising under the statement in the
 *   middle of the page, from gradients.sh's "Jade Eclipse".
 * - `dawn`: green light rising behind the closing name, from "Green Dawn".
 * - `glass`: an arc of light seen through fluted glass, in the card for
 *   installing the skill, from "Green Room".
 * - `mark` and `name`: liquid chrome inside the headline's "markdown" and the
 *   closing "mdfrom", in the site's own greens.
 *
 * Each definition feeds both the live canvas (`gradient-canvas.ts`) and, where
 * the markup needs one, the CSS fallback painted behind it, which is all a
 * reader sees with JavaScript off or without WebGL2. The renderer is the
 * vendored, MIT-licensed gradients.sh engine in `src/gradient-engine`.
 *
 * Greenshine, Jade Eclipse, Green Dawn and Green Room are gradients.sh Pro
 * presets (Kiruna is free), customized here under the project owner's Pro
 * license, which covers open-source sites. Values carried over from a Pro
 * preset are not covered by this repository's MIT license: they are tagged to
 * that Pro account, and must not be copied out or republished on their own,
 * as a library, a template or a UI kit (https://gradients.sh/license). Each
 * says which values it changed; the rest are as served. The chrome fills are
 * this project's own settings of the engine's MIT chrome kind.
 */
import { staticFallbackCss } from './gradient-engine/fallback'
import { kindDefaults } from './gradient-engine/kinds'
import { mergeParams } from './gradient-engine/params'
import type { GradientParams } from './gradient-engine/types'

/** The dark --color-surface, so the night bands run straight into the page. */
const SURFACE = '#080b09'

/**
 * Kiruna's curtains in the site's greens, running from a mint hem up into a
 * deep teal, slower than served and without the pointer's pull, so they read
 * as a sky behind the copy rather than a show in front of it.
 */
export const AURORA = mergeParams(kindDefaults('aurora'), {
  kind: 'aurora',
  colors: ['#b4f7d0', '#5fe39a', '#139a5e', '#06343a'],
  background: SURFACE,
  speed: 0.55,
  loopSeconds: 16,
  scale: 0.8,
  warp: 0.45,
  grain: 0.12,
  seed: 106,
  interaction: { pointer: 0, scroll: 0.2 },
})

/** Greenshine as served, on the page's surface. */
export const ORBIT = mergeParams(kindDefaults('limb'), {
  kind: 'limb',
  colors: ['#e6ffe9', '#86efa0', '#17a862', '#05361f'],
  background: SURFACE,
  speed: 2,
  loopSeconds: 10,
  scale: 1.00000019484284,
  warp: 0.50000019484284,
  blur: 0.35000019484284,
  grain: 0.16000019484284,
  seed: 4,
})

/**
 * Jade Eclipse with a slightly smaller disc (scale: the shader divides the
 * radius by it), so the disc clears the statement above it, on the page's
 * surface.
 */
export const ECLIPSE = mergeParams(kindDefaults('radial-glow'), {
  kind: 'radial-glow',
  colors: ['#dcfff4', '#55e6bd', '#0e9a7e', '#04332b'],
  background: SURFACE,
  speed: 0.78000000271338,
  loopSeconds: 10,
  scale: 1.1,
  warp: 0.35000000271338,
  blur: 0.35000000271338,
  grain: 0.18000000271338,
  seed: 12,
})

/**
 * Green Dawn with a larger dome (scale down from 1.35: the shader divides the
 * radius by it), on the page's surface, and no pointer pull.
 */
export const DAWN = mergeParams(kindDefaults('rise'), {
  kind: 'rise',
  colors: ['#e6ffe9', '#86efa0', '#17a862', '#05361f'],
  background: SURFACE,
  speed: 1.07000073226306,
  loopSeconds: 13,
  scale: 1.1,
  warp: 0.25000073226306,
  blur: 0.50000073226306,
  grain: 0.10000073226306,
  seed: 11,
  interaction: { pointer: 0, scroll: 0.15000073226306 },
})

/** Green Room, slowed (speed) for a card, on the page's surface. */
export const GLASS = mergeParams(kindDefaults('fluted'), {
  kind: 'fluted',
  colors: ['#05261b', '#0d6e4c', '#46cf93', '#e8fff4'],
  background: SURFACE,
  speed: 1.1,
  loopSeconds: 13,
  scale: 1.00000153838714,
  warp: 0.40000153838714,
  blur: 0.50000153838714,
  grain: 0.16000153838714,
  seed: 2,
})

/**
 * Pale, silvered chrome: the name stands on the dawn's green, so its metal is
 * lighter than the sky behind it, with a near-white highlight and a mid green
 * in its folds rather than a dark one, so no part of a letter sinks into the
 * band.
 */
export const NAME_FILL = mergeParams(kindDefaults('chrome'), {
  kind: 'chrome',
  colors: ['#8af0bd', '#ffffff', '#d9ffea'],
  background: '#2a8a5c',
  speed: 0.5,
  loopSeconds: 20,
  scale: 0.8,
  warp: 0.3,
  blur: 0.3,
  grain: 0,
  seed: 11,
  interaction: { pointer: 0, scroll: 0.2 },
})

/**
 * The headline's word in a greener metal. It is the headline's text, so even
 * its darkest folds (the background colour, darkened up to about a fifth by
 * the kind's vignette in the box's corners) stay above 3:1 on the sky.
 */
export const MARK_FILL = mergeParams(NAME_FILL, {
  colors: ['#5fe0a0', '#ffffff', '#b4ffd8'],
  background: '#2f9e68',
  scale: 0.55,
  seed: 23,
})

export const GRADIENTS: Record<string, GradientParams> = {
  aurora: AURORA,
  orbit: ORBIT,
  eclipse: ECLIPSE,
  dawn: DAWN,
  glass: GLASS,
  mark: MARK_FILL,
  name: NAME_FILL,
}

/** CSS `background`s that approximate the skies; safe inside a double-quoted attribute. */
const fallback = (params: GradientParams) => staticFallbackCss(params).replaceAll('"', "'")
export const ORBIT_FALLBACK = fallback(ORBIT)
export const ECLIPSE_FALLBACK = fallback(ECLIPSE)
export const DAWN_FALLBACK = fallback(DAWN)

/**
 * The fluted kind's stand-in is a diagonal band that would cross the card's
 * copy, so the card's is drawn here instead: the reeds over an arc of light
 * low in the card, as the live gradient shows it.
 */
export const GLASS_FALLBACK = [
  'repeating-linear-gradient(90deg, rgb(255 255 255 / 0.05) 0 1px, transparent 1px 4.5%)',
  'radial-gradient(70% 42% at 50% 96%, color-mix(in oklab, #46cf93 70%, transparent), color-mix(in oklab, #0d6e4c 40%, transparent) 55%, transparent 80%)',
  SURFACE,
].join(', ')
