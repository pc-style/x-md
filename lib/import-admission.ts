import { randomUUID } from 'node:crypto'
import { ConvertError } from './errors.js'
import { redisConfig, redisPipeline } from './redis.js'

// Bound expensive fresh walks across serverless instances. Archive-only reads
// do not acquire a slot. Leases outlive the route's 120-second deadline.
// Each caller (an address or an API key) holds at most one lease, and
// anonymous callers share all but KEYED_RESERVED slots, so neither one address
// nor a few anonymous walkers can lock keyed callers out.
export const IMPORT_MAX_ACTIVE = 3
const KEYED_RESERVED = 1
const PER_OWNER = 1
const LEASE_MS = 150_000
const KEY = 'import:active:v1'

/** Who a walk is charged to. Walks without one (scripts, benchmarks) are trusted and uncapped per caller. */
export interface ImportOwner { kind: 'ip' | 'key'; id: string }

const local = new Map<string, string>()
// Members are `<owner>|<uuid>`; anonymous owners start with `ip:`.
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local leases = redis.call('ZRANGE', KEYS[1], 0, -1)
local anonymous, mine = 0, 0
for _, lease in ipairs(leases) do
  if string.sub(lease, 1, 3) == 'ip:' then anonymous = anonymous + 1 end
  if string.sub(lease, 1, #ARGV[6]) == ARGV[6] then mine = mine + 1 end
end
if #leases >= tonumber(ARGV[3]) then return 0 end
if ARGV[6] ~= '' and mine >= tonumber(ARGV[8]) then return 0 end
if ARGV[7] == '1' and anonymous >= tonumber(ARGV[3]) - tonumber(ARGV[9]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1`

const busy = () => new ConvertError(503, 'Fresh import capacity is busy. Retry after the indicated delay.', 'import_busy', 5)

export async function withImportSlot<T>(work: () => Promise<T>, owner?: ImportOwner): Promise<T> {
  const prefix = owner ? `${owner.kind}:${owner.id}|` : ''
  const id = `${prefix}${randomUUID()}`
  const anonymous = owner?.kind === 'ip'
  const config = redisConfig()
  if (config) {
    let admitted = false
    try {
      const [reply] = await redisPipeline<number>(config, [['EVAL', ACQUIRE, 1, KEY, Date.now(), Date.now() + LEASE_MS, IMPORT_MAX_ACTIVE, id, LEASE_MS, prefix, anonymous ? '1' : '0', PER_OWNER, KEYED_RESERVED]])
      admitted = reply?.result === 1 && !reply.error
    } catch { /* Fail closed: do not turn a store outage into unbounded fan-out. */ }
    if (!admitted) throw busy()
  } else {
    const leases = [...local.values()]
    const mine = prefix ? leases.filter((lease) => lease === prefix).length : 0
    const anonymousLeases = leases.filter((lease) => lease.startsWith('ip:')).length
    if (leases.length >= IMPORT_MAX_ACTIVE || mine >= PER_OWNER || (anonymous && anonymousLeases >= IMPORT_MAX_ACTIVE - KEYED_RESERVED)) throw busy()
    local.set(id, prefix)
  }
  try { return await work() } finally {
    local.delete(id)
    // Awaited: the caller's next walk (a backfill after a top-up) must not compete with its own lease.
    if (config) {
      try { await redisPipeline(config, [['ZREM', KEY, id]]) } catch { /* The lease expires. */ }
    }
  }
}

const histories = new Set<string>()
/** Serialize archive planning and index writes for one handle across instances. */
export async function withHistoryLock<T>(handle: string, work: () => Promise<T>): Promise<T> {
  const key = `import:history-lock:${handle.toLowerCase()}`
  const token = randomUUID()
  const config = redisConfig()
  let admitted: boolean
  if (config) {
    try {
      const [reply] = await redisPipeline<string>(config, [['SET', key, token, 'NX', 'PX', LEASE_MS]])
      admitted = reply?.result === 'OK' && !reply.error
    } catch { admitted = false }
  } else {
    admitted = !histories.has(key)
    if (admitted) histories.add(key)
  }
  if (!admitted) throw new ConvertError(503, 'An import for this handle is already running. Retry shortly.', 'import_busy', 5)
  try { return await work() } finally {
    histories.delete(key)
    if (config) {
      try { await redisPipeline(config, [['EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, key, token]]) } catch { /* The lease expires. */ }
    }
  }
}
