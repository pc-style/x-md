import type { Plugin } from 'vite'

/**
 * Inlines each public page's own stylesheet into its HTML.
 *
 * The whole stylesheet is inlined rather than a hand-picked critical slice. It
 * is one 7 kB brotli file covering every page, so the two are the same size on
 * the wire; inlining removes a whole render-blocking round trip from every cold
 * load (150 ms of it on a Slow 4G connection) and removes every chance of a
 * flash of unstyled content from a mis-classified rule.
 *
 * `admin.html` keeps its link: it is not one of the pages anyone loads cold, and
 * its markup is built at runtime rather than pre-rendered.
 */
export function inlineStylesheetPlugin(): Plugin {
  const inlined = new Set<string>()
  return {
    name: 'x-md-inline-stylesheet',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle || ctx.filename.endsWith('admin.html')) return html

        // The deleted file must never be a lazy chunk's preload dependency, or
        // loading that chunk fetches a 404 and rejects the import: the shared
        // stylesheet has a chunk of its own for that reason (`vite.config.ts`).
        const sheets: string[] = []
        const stripped = html.replace(
          /<link rel="stylesheet" crossorigin href="([^"]+)">\s*/g,
          (tag, href: string) => {
            const asset = bundle[href.replace(/^\//, '')]
            if (!asset || asset.type !== 'asset' || typeof asset.source !== 'string') return tag
            inlined.add(href.replace(/^\//, ''))
            sheets.push(asset.source)
            return ''
          },
        )
        if (!sheets.length) return html

        // Where the stylesheet link was: in the head, before the pre-rendered body.
        return stripped.replace('</head>', `<style>${sheets.join('\n')}</style></head>`)
      },
    },
    // Every page inlines its stylesheet, so the standalone file would only sit
    // in dist/ and on the CDN taking up room. Drop it once the HTML that would
    // have referenced it is final.
    generateBundle(_options, bundle) {
      for (const file of inlined) {
        if (bundle[file]?.type === 'asset') delete bundle[file]
      }
    },
  }
}