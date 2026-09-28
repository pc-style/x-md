/**
 * Picks accounts x.md has never archived, waits until the key's search
 * allowance has room for all of them, then runs the benchmark.
 *
 *   bun bench/fresh.ts --count 3 --candidates a,b,c,... [--demo URL]
 */
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const count = Number(args.get('--count') ?? 3)
const candidates = (args.get('--candidates') ?? '').split(',').filter(Boolean)
const demo = args.get('--demo') ?? 'http://localhost:8787'
const key = process.env.X_MD_API_KEY
if (!key) { console.error('X_MD_API_KEY is not set'); process.exit(1) }
const headers = { Authorization: `Bearer ${key}` }
const NEEDED = 8 * count

/** A cached search answers from cache for free and still reports the key's remaining allowance. */
async function accountLeft(): Promise<{ left: number; reset: number }> {
  const response = await fetch('https://mdfromx.com/api/v1/search?q=%40karpathy%20-from%3Akarpathy&feed=latest&limit=100&format=json', { headers })
  const header = response.headers.get('ratelimit') ?? ''
  const match = /"account-key";r=(\d+);t=(\d+)/.exec(header)
  return match ? { left: Number(match[1]), reset: Number(match[2]) } : { left: 100, reset: 0 }
}

for (;;) {
  const { left, reset } = await accountLeft()
  console.log(`${new Date().toISOString()} account-key left ${left}, resets in ${reset}s`)
  if (left >= NEEDED) break
  await new Promise((r) => setTimeout(r, Math.min(Math.max(reset, 1), 20) * 1000))
}

const fresh: string[] = []
for (const handle of candidates) {
  const response = await fetch(`https://mdfromx.com/api/v1/profiles/${handle}/posts?index=true`, { headers })
  const { archive } = (await response.json()) as { archive: unknown }
  console.log(`${handle}: ${archive ? 'archived, skipping' : 'fresh'}`)
  if (!archive) fresh.push(handle)
  if (fresh.length === count) break
}
if (fresh.length < count) { console.error('not enough fresh accounts'); process.exit(1) }

const run = Bun.spawn(['bun', `${import.meta.dir}/run.ts`, '--handles', fresh.join(','), '--demo', demo, '--out', 'results'], { stdout: 'inherit', stderr: 'inherit' })
process.exit(await run.exited)
