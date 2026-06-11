export function extractStatusTextFromMarkdown(markdown: string): string | undefined {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('!['))

  const skip = new Set([
    'Post',
    'Thread',
    'Show this thread',
    'Read more on X',
    'X',
    'Twitter',
    'Sign in',
    'Log in',
    'Sign up',
  ])
  const body: string[] = []

  for (const line of lines) {
    if (line.startsWith('#')) continue
    if (skip.has(line)) continue
    if (line.match(/^@?\w+$/)) continue
    if (line.match(/^\d+(\.\d+)?[KMB]?\s*(replies|reposts|likes|views)/i)) continue
    body.push(line)
    if (body.join('\n').length > 500) break
  }

  const text = body.join('\n').trim()
  return text.length > 0 ? text : undefined
}
