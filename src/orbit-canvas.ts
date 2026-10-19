/** The engine's own test for a CPU rasteriser (webgpu-device.ts), plus Windows' basic driver. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i

/**
 * Whether WebGL would run on the CPU. The engine refuses software adapters for
 * WebGPU but then falls back to WebGL, which on a machine without a usable GPU
 * is just as software-rendered: a full-width animated shader there costs
 * seconds of main-thread time (the throttled trace bench measured ~3.5 s of
 * TBT), so those readers keep the CSS arc instead.
 */
function softwareRendered(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return true
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return SOFTWARE_RENDERER.test(renderer)
}

/**
 * Mounts the live Orbit gradient on every `canvas[data-orbit]`.
 *
 * Loaded off the critical path: the sky already paints `ORBIT_FALLBACK`, and the
 * canvas fades in over it once the engine has copied a real frame
 * (`data-painted`). The engine pauses offscreen and hidden canvases, renders a
 * single still frame for reduced motion, and keeps the fallback when WebGL2 is
 * missing. The first canvas is the hero and gets the engine's larger primary
 * pixel budget. The engine and the preset are only downloaded once they will
 * be used.
 */
export async function setupOrbit(root: HTMLElement) {
  const canvases = root.querySelectorAll<HTMLCanvasElement>('canvas[data-orbit]')
  if (!canvases.length || softwareRendered()) return
  const [{ mountGradient }, { ORBIT }] = await Promise.all([import('./gradient-engine/mount'), import('./orbit')])
  canvases.forEach((canvas, index) => {
    mountGradient(canvas, ORBIT, { primary: index === 0 })
  })
}
