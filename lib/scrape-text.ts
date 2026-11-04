export function extractStatusTextFromMarkdown(markdown: string, statusId: string): string | undefined {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('!['))

  // Full X pages include navigation, author cards, metrics and replies. The
  // requested post's timestamp permalink ends its body, not the whole page.
  const title = lines.findIndex((line) => /^# .+ on (?:X|Twitter)(?::|$)/.test(line))
  const timestamp = lines.findIndex((line) =>
    line.match(/^\[[^\]]+\]\(https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/status\/(\d+)\/?(?:[?#][^)]*)?\)/)?.[1] === statusId,
  )
  if (title >= 0 && timestamp > title) {
    // Replies may have parent posts before them. Each post starts at its list
    // author marker; use the last one before the requested timestamp.
    const start = lines.findLastIndex((line, index) => index > title && index < timestamp &&
      /^- \[@\w+\]\(https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/?\)$/.test(line))
    const body = lines.slice(Math.max(title + 1, start), timestamp)
    // Strip only the leading author block. Links and headings in the post
    // itself must survive, as must text beyond the old 500-character budget.
    while (body.length && (
      /^#{1,6}\s+(?:Conversation|Post|Thread)$/.test(body[0]) ||
      /^(?:-\s*)?(?:\[[^\]]+\]\(https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?\)\s*)+$/.test(body[0])
    )) {
      const line = body.shift()!
      // The non-list handle closes the author card; later profile links are content.
      if (!line.startsWith('- ') && /\[@\w+\]\(/.test(line)) break
    }
    return body.join('\n')
  }

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
    if (line.match(/^@\w+$/)) continue
    if (line.match(/^\d+(\.\d+)?[KMB]?\s*(replies|reposts|likes|views)/i)) continue
    body.push(line)
    if (body.join('\n').length > 500) break
  }

  const text = body.join('\n').trim()
  return text.length > 0 ? text : undefined
}
