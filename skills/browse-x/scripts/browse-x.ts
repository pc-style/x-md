type Resource = 'status' | 'profile' | 'search' | 'list'
type Output = { write: (value: string) => void }

class CliError extends Error {
  readonly code: 0 | 1 | 2 | 3

  constructor(
    message: string,
    code: 0 | 1 | 2 | 3,
  ) {
    super(message)
    this.code = code
  }
}

const usage = `Usage:
  browse-x.ts <x-status-or-profile-url> [options]
  browse-x.ts status <x-status-url> [options]
  browse-x.ts profile <handle> [options]
  browse-x.ts search <query> [options]
  browse-x.ts followers <handle> [options]
  browse-x.ts following <handle> [options]

Output: --json, --full, --compact, --format markdown|obsidian, --headers
Lists:  --page 1-10, --limit 1-20, --cursor <cursor>, --feed latest|top|photos|videos|users|media
Status: --thread off|full|conversation|2-100, --userinfo off|author|all,
        --context full|thread, --replies top|recent|off
Other:  --nocache, --help

X_API_BASE overrides https://x.pcstyle.dev.
`

const fail = (message: string): never => {
  throw new CliError(`browse-x: ${message}`, 2)
}

const setOption = (options: Map<string, string>, name: string, value: string, option: string) => {
  const old = options.get(name)
  if (old !== undefined && old !== value) {
    fail(`${option} was supplied with conflicting values ('${old}' and '${value}')`)
  }
  options.set(name, value)
}

const requireValue = (args: string[], index: number, option: string) => {
  const value = args[index + 1]
  if (!value) fail(`${option} requires a value`)
  return value
}

const validate = (options: Map<string, string>) => {
  const value = (name: string) => options.get(name)
  if (value('format') && !/^(markdown|obsidian|json)$/.test(value('format') as string)) {
    fail('--format must be markdown, obsidian, or json')
  }
  if (value('page') && !/^(?:[1-9]|10)$/.test(value('page') as string)) {
    fail('--page must be an integer from 1 to 10')
  }
  if (value('limit') && !/^(?:[1-9]|1[0-9]|20)$/.test(value('limit') as string)) {
    fail('--limit must be an integer from 1 to 20')
  }
  if (value('feed') && !/^(latest|top|photos|videos|users|media)$/.test(value('feed') as string)) {
    fail('--feed must be latest, top, photos, videos, users, or media')
  }
  if (value('thread') && !/^(off|full|conversation|(?:[2-9]|[1-9][0-9]|100))$/.test(value('thread') as string)) {
    fail('--thread must be off, full, conversation, or an integer from 2 to 100')
  }
  if (value('userinfo') && !/^(off|author|all)$/.test(value('userinfo') as string)) {
    fail('--userinfo must be off, author, or all')
  }
  if (value('context') && !/^(full|thread)$/.test(value('context') as string)) fail('--context must be full or thread')
  if (value('replies') && !/^(top|recent|off)$/.test(value('replies') as string)) fail('--replies must be top, recent, or off')
  if (options.has('json') && value('format') && value('format') !== 'json') fail(`--json conflicts with --format ${value('format')}`)
}

const parse = (args: string[]) => {
  if (args.length === 0) throw new CliError(usage, 2)
  if (args[0] === '-h' || args[0] === '--help') throw new CliError(usage, 0)
  let command = ''
  let target = ''
  const first = args[0]
  if (/^(status|profile|search|followers|following)$/.test(first)) {
    command = first
    if (args[1] === '-h' || args[1] === '--help') throw new CliError(usage, 0)
    target = args[1] ?? fail(`${first} requires a target`)
    args = args.slice(2)
  } else if (/^https?:\/\//.test(first)) {
    target = first
    args = args.slice(1)
  } else fail(`expected a command or public X URL (got '${first}')`)

  const options = new Map<string, string>()
  let headers = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json' || arg === '--nocache') options.set(arg.slice(2), 'true')
    else if (arg === '--full') setOption(options, 'full', 'true', '--full/--compact')
    else if (arg === '--compact') setOption(options, 'full', 'false', '--full/--compact')
    else if (arg === '--headers') headers = true
    else if (/^--(format|page|limit|cursor|feed|thread|userinfo|context|replies)$/.test(arg)) {
      const value = requireValue(args, index, arg)
      setOption(options, arg.slice(2), value, arg)
      index += 1
    } else if (arg === '-h' || arg === '--help') throw new CliError(usage, 0)
    else fail(`unknown option '${arg}'`)
  }
  validate(options)
  if (options.has('json')) options.set('format', 'json')
  return { command, target, options, headers }
}

const publicHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])

const publicUrl = (target: string) => {
  try {
    const url = new URL(target)
    return /^https?:$/.test(url.protocol) && publicHosts.has(url.hostname.toLowerCase()) ? url : undefined
  } catch {
    return undefined
  }
}

const isStatusUrl = (url: URL | undefined) => Boolean(url && /^\/[^/]+\/status\/[0-9]+\/?$/.test(url.pathname))

const request = (parsed: ReturnType<typeof parse>, base: string) => {
  const { command, target, options } = parsed
  const handle = encodeURIComponent(target.replace(/^@/, ''))
  const targetUrl = publicUrl(target)
  let resource: Resource = 'status'
  let endpoint = ''
  let targetParam: [string, string] | undefined
  if (command === 'status') {
    if (!isStatusUrl(targetUrl)) fail('status requires a public x.com or twitter.com status URL')
    resource = 'status'; endpoint = `${base}/api/convert`; targetParam = ['url', target]
  } else if (command === 'profile') {
    resource = 'profile'; endpoint = `${base}/${handle}`
  } else if (command === 'search') {
    resource = 'search'; endpoint = `${base}/search`; targetParam = ['q', target]
  } else if (command === 'followers' || command === 'following') {
    resource = 'list'; endpoint = `${base}/${handle}/${command}`
  } else if (isStatusUrl(targetUrl)) {
    resource = 'status'; endpoint = `${base}/api/convert`; targetParam = ['url', target]
  } else if (targetUrl) {
    if (!/^\/[^/]+\/?$/.test(targetUrl.pathname)) fail('only public x.com or twitter.com status/profile URLs are supported')
    const handleFromUrl = targetUrl.pathname.split('/').filter(Boolean)[0]
    if (!handleFromUrl) fail('profile URL must contain a handle')
    resource = 'profile'; endpoint = `${base}/${encodeURIComponent(handleFromUrl)}`
  } else fail('only public x.com or twitter.com status/profile URLs are supported')

  const statusOptions = ['thread', 'userinfo', 'context', 'replies']
  if (resource !== 'status' && statusOptions.some((name) => options.has(name))) fail('status options are only valid for status requests')
  if (resource !== 'status' && options.get('format') === 'obsidian') fail('--format obsidian is only valid for status requests')
  if (resource !== 'search' && options.has('feed')) fail('--feed is only valid for search')
  if (resource === 'status' && ['page', 'limit', 'cursor', 'feed'].some((name) => options.has(name))) fail('list options are not valid for status requests')

  const url = new URL(endpoint)
  if (targetParam) url.searchParams.set(targetParam[0], targetParam[1])
  for (const name of ['format', 'full', 'page', 'limit', 'cursor', 'feed', 'thread', 'userinfo', 'context', 'replies']) {
    const value = options.get(name)
    if (value !== undefined) url.searchParams.set(name, value)
  }
  if (options.has('nocache')) url.searchParams.set('nocache', 'true')
  return { url, accept: options.get('format') === 'json' ? 'application/json' : 'text/markdown' }
}

export const run = async (
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  output: Output = { write: (value) => process.stdout.write(value) },
) => {
  const parsed = parse(args)
  const { url, accept } = request(parsed, env.X_API_BASE || env.X_MD_API_BASE || 'https://x.pcstyle.dev')
  const headers: Record<string, string> = { Accept: accept }
  if (env.X_MD_API_KEY) headers.Authorization = `Bearer ${env.X_MD_API_KEY}`
  let response: Response
  try {
    response = await fetcher(url, { headers })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(`browse-x: request to ${url.origin} failed: ${reason}\n`, 1)
  }
  const body = await response.text()
  if (!response.ok) {
    const signals = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-api-key-status']
      .flatMap((name) => response.headers.has(name) ? [`${name}: ${response.headers.get(name)}`] : [])
      .join('\n')
    const details = [signals, body].filter(Boolean).join('\n')
    throw new CliError(
      `browse-x: HTTP ${response.status} from ${url.origin}${url.pathname}${details ? `\n${details}` : ''}\n`,
      response.status === 429 ? 3 : 1,
    )
  }
  if (parsed.headers) {
    output.write(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}\r\n`)
    response.headers.forEach((value, key) => output.write(`${key}: ${value}\r\n`))
    output.write('\r\n')
  }
  output.write(body)
  if (body.length > 0 && !body.endsWith('\n')) output.write('\n')
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/browse-x.ts')) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    const cliError = error instanceof CliError ? error : new CliError(`browse-x: ${String(error)}\n`, 1)
    process.stderr.write(cliError.message.endsWith('\n') ? cliError.message : `${cliError.message}\n`)
    process.exitCode = cliError.code
  })
}
