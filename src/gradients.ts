/**
 * The landing page's gradients, by the name their canvases carry
 * (`canvas[data-gradient]`):
 *
 * - `orbit`: gradients.sh's "Greenshine" preset, the lit edge of a planet in
 *   green, under the hero and the closing call to action.
 * - `thread`: gradients.sh's "Green Thread" preset, one filament of the same
 *   green light, behind the statement in the middle of the page.
 * - `name`: liquid chrome inside the closing "mdfrom", in the site's own greens.
 *
 * Each definition feeds both the live canvas (`gradient-canvas.ts`) and, where
 * the markup needs one, the CSS fallback painted behind it, which is all a
 * reader sees with JavaScript off or without WebGL2. The renderer is the
 * vendored, MIT-licensed gradients.sh engine in `src/gradient-engine`.
 *
 * Greenshine and Green Thread are gradients.sh Pro presets, used here under
 * the project owner's Pro license, which covers open-source sites. Their
 * values are not covered by this repository's MIT license: they are tagged to
 * that Pro account, and must not be copied out or republished on their own, as
 * a library, a template or a UI kit (https://gradients.sh/license). Keep them
 * exactly as served; only the background is changed, to the dark page surface.
 * The name's fill is this project's own setting of the engine's MIT chrome
 * kind.
 */
import { staticFallbackCss } from './gradient-engine/fallback'
import { kindDefaults } from './gradient-engine/kinds'
import { mergeParams } from './gradient-engine/params'
import type { GradientParams } from './gradient-engine/types'

/** The dark --color-surface, so the night bands run straight into the page. */
const SURFACE = '#080b09'

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

export const THREAD = mergeParams(kindDefaults('spectrum'), {
  kind: 'spectrum',
  colors: ['#e6ffe9', '#86efa0', '#17a862'],
  background: SURFACE,
  speed: 0.32000160386738,
  scale: 1.00000160386738,
  warp: 0.40000160386738,
  blur: 0.45000160386738,
  grain: 0.08000160386738,
})

/**
 * Lit like the arc below it: the studio light is a bright accent and the
 * highlight near white, over a deep green rather than black, so no part of a
 * letter sinks into the band.
 */
export const NAME_FILL = mergeParams(kindDefaults('chrome'), {
  kind: 'chrome',
  colors: ['#4fd08f', '#f4fff8', '#9ff0c4'],
  background: '#0d5233',
  speed: 0.5,
  loopSeconds: 20,
  scale: 0.8,
  warp: 0.3,
  blur: 0.3,
  grain: 0,
  seed: 11,
  interaction: { pointer: 0, scroll: 0.2 },
})

export const GRADIENTS: Record<string, GradientParams> = { orbit: ORBIT, thread: THREAD, name: NAME_FILL }

/** CSS `background`s that approximate the bands; safe inside a double-quoted attribute. */
export const ORBIT_FALLBACK = staticFallbackCss(ORBIT).replaceAll('"', "'")
export const THREAD_FALLBACK = staticFallbackCss(THREAD).replaceAll('"', "'")
