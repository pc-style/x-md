/** The engine's own test for a CPU rasteriser (webgpu-device.ts), plus Windows' basic driver. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i

/**
 * Whether WebGL would run on the CPU. The engine refuses software adapters for
 * WebGPU but then falls back to WebGL, which on a machine without a usable GPU
 * is just as software-rendered: a full-width animated shader there costs
 * seconds of main-thread time (the throttled trace bench measured ~3.5 s of
 * TBT), so those readers keep the CSS fallbacks instead.
 */
function softwareRendered(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return true
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return SOFTWARE_RENDERER.test(renderer)
}

/** The chrome fills show only through their own letters, which needs a text mask. */
const textMask = () => CSS.supports('mask-clip', 'text') || CSS.supports('-webkit-mask-clip', 'text')
const TEXT_FILLS = new Set(['mark', 'name'])

/**
 * Full-band skies with no hard edge in them: at one canvas pixel per CSS pixel
 * they look the same on a high-density screen and cost less than half as much.
 */
const SOFT = new Set(['aurora', 'dawn'])

/**
 * Mounts the live gradients on every `canvas[data-gradient]`, each with the
 * definition of that name in `gradients.ts`.
 *
 * Loaded off the critical path: every canvas sits over something that already
 * paints (a CSS fallback, or the name's static fill), and fades in once the
 * engine has copied a real frame (`data-painted`). The engine pauses offscreen
 * and hidden canvases, renders a single still frame for reduced motion, and
 * keeps the fallback when WebGL2 is missing. The hero's arc gets the engine's
 * larger primary pixel budget. The engine and the presets are only downloaded
 * once they will be used.
 */
export async function setupGradients(root: HTMLElement) {
  const canvases = [...root.querySelectorAll<HTMLCanvasElement>('canvas[data-gradient]')].filter(
    (canvas) => !TEXT_FILLS.has(canvas.dataset.gradient ?? '') || textMask(),
  )
  if (!canvases.length || softwareRendered()) return
  const [{ mountGradient }, { GRADIENTS }] = await Promise.all([import('./gradient-engine/mount'), import('./gradients')])
  canvases.forEach((canvas, index) => {
    const name = canvas.dataset.gradient ?? ''
    const params = GRADIENTS[name]
    if (params) mountGradient(canvas, params, { primary: index === 0, maxDpr: SOFT.has(name) ? 1 : undefined })
  })
}
