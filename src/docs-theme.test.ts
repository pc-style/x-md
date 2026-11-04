import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import config from '../blume.config'

// The docs are dark by default (AGENTS.md). Blume only sets `data-theme` from its
// inline script, so without JavaScript every `[data-theme=dark]` rule was
// skipped and the docs rendered light. patches/blume@*.patch prerenders the
// configured mode on <html>; a Blume upgrade that drops the patch fails here.
test('Blume layouts prerender the configured dark theme for readers without JavaScript', () => {
  expect(config.theme?.mode).toBe('dark')
  for (const layout of ['RootLayout', 'PageLayout']) {
    const source = readFileSync(resolve(import.meta.dirname, `../node_modules/blume/src/components/layout/${layout}.astro`), 'utf8')
    expect(source).toMatch(/<html data-theme=\{themeMode === "system" \? undefined : themeMode\}/)
  }
})
