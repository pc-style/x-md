import { expect, test } from 'vitest'
import config from '../blume.config'
import { withTheme } from '../scripts/prerender-docs-theme'

// Blume's page head, trimmed: its theme script carries the configured mode.
const page = (mode: string) =>
  `<!DOCTYPE html><html dir="ltr" lang="en"><head><script data-mode="${mode}">(()=>{/* "<html" */})()</script></head><body></body></html>`

// The docs are dark by default (AGENTS.md), and Blume only sets data-theme from
// its inline script, so the build stamps the mode onto each page's root.
test('docs pages ship the configured dark theme for readers without JavaScript', () => {
  expect(config.theme?.mode).toBe('dark')
  const dark = withTheme(page('dark'))
  expect(dark).toBe(page('dark').replace('<html dir', '<html data-theme="dark" dir'))
  // Rebuilding over built pages changes nothing.
  expect(withTheme(dark)).toBe(dark)
  expect(withTheme(page('light'))).toContain('<html data-theme="light" dir')
  // `system` can only be resolved by the browser.
  expect(withTheme(page('system'))).toBe(page('system'))
})
