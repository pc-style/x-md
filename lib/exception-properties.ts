export const exceptionKeys = ['$exception_list', '$exception_level', '$exception_type', '$exception_message', '$release_id']

const exceptionFrameProperties = new Set(['platform', 'filename', 'abs_path', 'function', 'module', 'lineno', 'colno', 'in_app', 'chunk_id'])
const exceptionMechanismProperties = new Set(['type', 'handled', 'synthetic'])

// Error text and stack frames can carry page URLs, absolute or relative; keep
// what comes before a query or fragment. Apostrophes are valid query content;
// preserve only a trailing one so single-quoted URLs keep their closing quote.
function stripUrlQueries(text: string) {
  return text.replace(/[?#][^\s"`<>]*/g, suffix => suffix.endsWith("'") ? "'" : '')
}

function scalarsFrom(value: unknown, allowed: Set<string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value)
    .filter(([property, content]) => allowed.has(property) && ['string', 'number', 'boolean'].includes(typeof content))
    .map(([property, content]) => [property, typeof content === 'string' ? stripUrlQueries(content) : content]))
}

export function sanitizeException(eventProperties: Record<string, unknown>) {
  for (const key of ['$exception_level', '$exception_type', '$exception_message', '$release_id']) {
    const value = eventProperties[key]
    if (typeof value === 'string') eventProperties[key] = stripUrlQueries(value)
    else delete eventProperties[key]
  }
  const list = eventProperties.$exception_list
  if (!Array.isArray(list)) { delete eventProperties.$exception_list; return }
  eventProperties.$exception_list = list.filter(entry => entry && typeof entry === 'object').map(entry => {
    const sanitized: Record<string, unknown> = {}
    if (typeof entry.type === 'string') sanitized.type = stripUrlQueries(entry.type)
    if (typeof entry.value === 'string') sanitized.value = stripUrlQueries(entry.value)
    const mechanism = scalarsFrom(entry.mechanism, exceptionMechanismProperties)
    if (mechanism) sanitized.mechanism = mechanism
    const frames = entry.stacktrace?.frames
    if (Array.isArray(frames)) {
      sanitized.stacktrace = {
        ...(entry.stacktrace.type === 'raw' && { type: 'raw' }),
        frames: frames.map(frame => scalarsFrom(frame, exceptionFrameProperties)).filter(Boolean),
      }
    }
    return sanitized
  })
}
