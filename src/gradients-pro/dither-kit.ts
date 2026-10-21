// gradients.sh Pro · licensed to aSfr5hJDvmXsLCCPcmVsZdRBfRJCGrW0 (p***@duck.com) · 2026-10-21 · https://gradients.sh/license

/**
 * The gradients.sh dither kit: the shared core of the Pro interactive elements.
 *
 * Every element draws light the same way. A field (0..1 per cell) is mapped
 * onto a short palette ramp, and each cell picks one ramp stop with an 8x8
 * Bayer threshold. Cells are drawn one canvas pixel each and upscaled with
 * `image-rendering: pixelated`, so a few thousand cells cost almost nothing
 * and the edges of the light resolve into crisp pixels instead of a blur.
 */

/** 8x8 Bayer matrix, as thresholds in (0, 1). */
const BAYER8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36,
  14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
].map((v) => (v + 0.5) / 64);

/** The Bayer threshold for cell (x, y). */
export function bayer(x: number, y: number): number {
  return BAYER8[(((y % 8) + 8) % 8) * 8 + (((x % 8) + 8) % 8)] ?? 0.5;
}

export type ColorScheme = "light" | "dark";
export type DitherPaletteName = "ultramarine" | "ember" | "mono";

/** Four stops from the faintest light to the hottest. */
type Ramp = readonly [string, string, string, string];

/**
 * Curated ramps. Dark ramps climb toward white; light ramps climb toward ink,
 * so the light reads on white surfaces too.
 */
export const DITHER_PALETTES: Record<
  DitherPaletteName,
  Record<ColorScheme, Ramp>
> = {
  ember: {
    dark: ["#5a2414", "#c4532c", "#f2a07c", "#ffe6d6"],
    light: ["#fbd9c8", "#f2a07c", "#e0643c", "#a8401f"],
  },
  mono: {
    dark: ["#2a2a30", "#5c5c66", "#a3a3ad", "#f4f4f6"],
    light: ["#e2e2e6", "#b4b4bc", "#6b6b74", "#1d1d21"],
  },
  ultramarine: {
    dark: ["#1a2580", "#3a5bff", "#93a4ff", "#eef0ff"],
    light: ["#d7ddff", "#93a4ff", "#3a5bff", "#1f2fb0"],
  },
};

/** A curated palette name, or your own ramp from faint to hot (CSS colours, `var(--x)` included). */
export type DitherPalette = DitherPaletteName | readonly string[];

export type Rgba = readonly [number, number, number, number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];

let probeCanvas: CanvasRenderingContext2D | null = null;

/** Any CSS colour, `var(--x)` included, as 0-255 RGBA, resolved against `scope`. */
export function resolveColor(css: string, scope: Element): Rgba {
  let value = css;
  if (css.includes("var(")) {
    const probe = document.createElement("span");
    probe.style.color = css;
    probe.style.display = "none";
    scope.append(probe);
    value = getComputedStyle(probe).color;
    probe.remove();
  }
  probeCanvas ??= document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  if (!probeCanvas) return TRANSPARENT;
  probeCanvas.clearRect(0, 0, 1, 1);
  probeCanvas.fillStyle = "#00000000";
  probeCanvas.fillStyle = value;
  probeCanvas.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probeCanvas.getImageData(
    0,
    0,
    1,
    1
  ).data;
  return [r, g, b, a];
}

/** The palette's stops for this scheme, resolved to RGBA. */
export function resolveRamp(
  palette: DitherPalette,
  scheme: ColorScheme,
  scope: Element
): Rgba[] {
  const colors =
    typeof palette === "string" ? DITHER_PALETTES[palette][scheme] : palette;
  return colors.map((color) => resolveColor(color, scope));
}

/** The ramp's hottest stop as a CSS colour, for borders and text accents. */
export function paletteAccent(
  palette: DitherPalette,
  scheme: ColorScheme,
  stop = 2
): string {
  const colors =
    typeof palette === "string" ? DITHER_PALETTES[palette][scheme] : palette;
  return colors[Math.min(stop, colors.length - 1)] ?? "currentColor";
}

/**
 * Picks the ramp stop for a field value with the cell's Bayer threshold.
 * Index 0 means "no light"; 1..n are ramp stops.
 */
export function stopIndex(
  value: number,
  stops: number,
  x: number,
  y: number
): number {
  const scaled = Math.min(Math.max(value, 0), 1) * stops;
  const base = Math.floor(scaled);
  return Math.min(stops, base + (scaled - base > bayer(x, y) ? 1 : 0));
}

/**
 * A canvas that draws one pixel per cell. Size it to its box with `fit`, then
 * `paint` a field; the browser upscales the cells without smoothing.
 */
export class DitherSurface {
  readonly canvas: HTMLCanvasElement;
  readonly cell: number;
  private readonly ctx: CanvasRenderingContext2D | null;
  private image: ImageData | null = null;
  cols = 0;
  rows = 0;

  constructor(canvas: HTMLCanvasElement, cell: number) {
    this.canvas = canvas;
    this.cell = Math.max(1, Math.round(cell));
    this.ctx = canvas.getContext("2d");
    canvas.style.imageRendering = "pixelated";
  }

  /** Matches the surface to a box in CSS pixels. Returns true when the size changed. */
  fit(width: number, height: number): boolean {
    const cols = Math.max(1, Math.ceil(width / this.cell));
    const rows = Math.max(1, Math.ceil(height / this.cell));
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.canvas.style.width = `${cols * this.cell}px`;
    this.canvas.style.height = `${rows * this.cell}px`;
    this.image = this.ctx?.createImageData(cols, rows) ?? null;
    return true;
  }

  /**
   * Paints `field(col, row)` (0..1) through the ramp. `base` fills cells with
   * no light; leave it out for transparency. `ox`/`oy` shift the Bayer grid so
   * neighbouring surfaces line up.
   */
  paint(
    ramp: readonly Rgba[],
    field: (col: number, row: number) => number,
    options: { base?: Rgba; ox?: number; oy?: number } = {}
  ): void {
    const { image, ctx } = this;
    if (!image || !ctx) return;
    const { base = TRANSPARENT, ox = 0, oy = 0 } = options;
    const data = image.data;
    const stops = ramp.length;
    let o = 0;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = stopIndex(field(col, row), stops, col + ox, row + oy);
        const color = i === 0 ? base : (ramp[i - 1] ?? base);
        data[o] = color[0];
        data[o + 1] = color[1];
        data[o + 2] = color[2];
        data[o + 3] = color[3];
        o += 4;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  /**
   * Paints only the listed cells (indices into the cols x rows grid); every
   * other cell is transparent. Cheap for thin shapes such as borders.
   */
  paintCells(
    ramp: readonly Rgba[],
    cells: Uint32Array,
    value: (k: number) => number
  ): void {
    const { image, ctx } = this;
    if (!image || !ctx) return;
    const data = image.data;
    data.fill(0);
    const stops = ramp.length;
    for (let k = 0; k < cells.length; k++) {
      const index = cells[k] ?? 0;
      const col = index % this.cols;
      const row = (index - col) / this.cols;
      const i = stopIndex(value(k), stops, col, row);
      const color = ramp[i - 1];
      if (i === 0 || !color) continue;
      const o = index * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = color[3];
    }
    ctx.putImageData(image, 0, 0);
  }

  /**
   * Paints sampled image luminance through the ramp, with `base` for the
   * darkest cells. `reveal` (0..1) dissolves cells away in Bayer order,
   * sweeping left to right, so the real image underneath shows through.
   * `invert` maps dark image areas to the hot end, for light themes.
   */
  paintImage(
    ramp: readonly Rgba[],
    luminance: Float32Array,
    options: { base: Rgba; reveal: number; invert: boolean }
  ): void {
    const { image, ctx } = this;
    if (!image || !ctx) return;
    const { base, reveal, invert } = options;
    const data = image.data;
    const stops = ramp.length;
    const sweep = 0.6;
    let o = 0;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const local = reveal * (1 + sweep) - (sweep * col) / this.cols;
        if (reveal >= 1 || bayer(col, row) < local) {
          data[o + 3] = 0;
        } else {
          const lum = luminance[row * this.cols + col] ?? 0;
          // A gentle S-curve keeps faces and edges readable at 4-5 levels.
          const t = invert ? 1 - lum : lum;
          const v = t * t * (3 - 2 * t);
          const i = stopIndex(v, stops, col, row);
          const color = i === 0 ? base : (ramp[i - 1] ?? base);
          data[o] = color[0];
          data[o + 1] = color[1];
          data[o + 2] = color[2];
          data[o + 3] = 255;
        }
        o += 4;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  clear(): void {
    this.ctx?.clearRect(0, 0, this.cols, this.rows);
  }
}

/**
 * Samples an image's luminance once per cell (cover-fit to cols x rows).
 * Throws when the image is cross-origin without CORS, so callers can fall
 * back to showing the plain image.
 */
export function sampleLuminance(
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  cols: number,
  rows: number
): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const out = new Float32Array(cols * rows);
  if (!ctx || image.naturalWidth === 0) return out;
  const scale = Math.max(cols / image.naturalWidth, rows / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (cols - w) / 2, (rows - h) / 2, w, h);
  const data = ctx.getImageData(0, 0, cols, rows).data;
  for (let i = 0; i < out.length; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    out[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  // Auto-levels: stretch the 2nd-98th percentile to the full range, so a few
  // ramp stops still separate a dim photo's shapes.
  const sorted = Float32Array.from(out).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
  const span = Math.max(hi - lo, 0.05);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(Math.max(((out[i] ?? 0) - lo) / span, 0), 1);
  }
  return out;
}

/**
 * A 0..1 value that eases toward a target on requestAnimationFrame and calls
 * `draw` on every step. Interruptible: a new target continues from the
 * current value.
 */
export class Tween {
  value: number;
  private target: number;
  private from = 0;
  private start = 0;
  private frame = 0;
  private readonly draw: (value: number) => void;
  duration: number;

  constructor(options: {
    initial: number;
    duration: number;
    draw: (value: number) => void;
  }) {
    this.value = options.initial;
    this.target = options.initial;
    this.duration = options.duration;
    this.draw = options.draw;
  }

  /** Eases to `target`; `instant` jumps there (reduced motion). */
  to(target: number, instant = false): void {
    this.target = target;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (instant || this.duration <= 0 || this.value === target) {
      this.value = target;
      this.draw(target);
      return;
    }
    this.from = this.value;
    this.start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - this.start) / this.duration);
      // Ease-out (quart): fast response, soft landing.
      const eased = 1 - (1 - t) ** 4;
      this.value = this.from + (this.target - this.from) * eased;
      this.draw(this.value);
      this.frame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.frame = requestAnimationFrame(step);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

/** Smooth falloff from 1 at the centre to 0 at `radius`. */
export function falloff(distance: number, radius: number): number {
  const t = Math.min(Math.max(1 - distance / radius, 0), 1);
  return t * t * (3 - 2 * t);
}

// x-md: the React hooks (useColorScheme, useReducedMotion) are left out; the
// scheme helpers below are exported for the vanilla ports instead.

/** The page's colour scheme: a `dark`/`light` class or `data-theme` on `<html>`, else the system setting. */
export function readScheme(): ColorScheme {
  const root = document.documentElement;
  if (root.classList.contains("dark") || root.dataset.theme === "dark")
    return "dark";
  if (root.classList.contains("light") || root.dataset.theme === "light")
    return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Calls `onChange` whenever the page's colour scheme may have changed. */
export function subscribeScheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["class", "data-theme", "style"],
    attributes: true,
  });
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

void [0.12500001652159, "⁣​​​​​​‌​‌​​​​‌​‌​‌​‌‌‌‌‌⁣"];
