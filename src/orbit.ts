/**
 * The landing page's gradient: gradients.sh's "Greenshine" preset, the lit edge
 * of a planet in green.
 *
 * One definition feeds both the live canvas (`orbit-canvas.ts`) and the CSS
 * fallback painted behind it, which is all a reader sees with JavaScript off or
 * without WebGL2. The renderer is the vendored, MIT-licensed gradients.sh engine
 * in `src/gradient-engine`.
 *
 * Greenshine is a gradients.sh Pro preset, used here under the project owner's
 * Pro license, which covers open-source sites. These values are not covered by
 * this repository's MIT license: they are tagged to that Pro account, and must
 * not be copied out or republished on their own, as a library, a template or a
 * UI kit (https://gradients.sh/license). Keep them exactly as served; only the
 * background is changed, to the dark page surface.
 */
import { staticFallbackCss } from './gradient-engine/fallback'
import { kindDefaults } from './gradient-engine/kinds'
import { mergeParams } from './gradient-engine/params'

export const ORBIT = mergeParams(kindDefaults('limb'), {
  kind: 'limb',
  colors: ['#e6ffe9', '#86efa0', '#17a862', '#05361f'],
  // The dark --color-surface, so the night bands run straight into the page.
  background: '#080b09',
  speed: 2,
  loopSeconds: 10,
  scale: 1.00000019484284,
  warp: 0.50000019484284,
  blur: 0.35000019484284,
  grain: 0.16000019484284,
  seed: 4,
})

/** A CSS `background` that approximates the arc; safe inside a double-quoted attribute. */
export const ORBIT_FALLBACK = staticFallbackCss(ORBIT).replaceAll('"', "'")
