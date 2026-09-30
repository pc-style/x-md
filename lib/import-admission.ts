import { randomUUID } from 'node:crypto'
import { ConvertError } from './errors.js'
import { redisConfig, redisPipeline } from './redis.js'

// Bound expensive fresh walks across serverless instances. Archive-only reads
// do not acquire a slot. Leases outlive the route's 120-second deadline.
const MAX_ACTIVE = 2
const LEASE_MS = 150_000
const KEY = 'import:active:v1'
const local = new Set<string>()
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1`

export async function withImportSlot<T>(work: () => Promise<T>): Promise<T> {
  const id = randomUUID()
  const config = redisConfig()
  if (config) {
    let admitted = false
    try {
      const [reply] = await redisPipeline<number>(config, [['EVAL', ACQUIRE, 1, KEY, Date.now(), Date.now() + LEASE_MS, MAX_ACTIVE, id, LEASE_MS]])
      admitted = reply?.result === 1 && !reply.error
    } catch { /* Fail closed: do not turn a store outage into unbounded fan-out. */ }
    if (!admitted) throw new ConvertError(503, 'Fresh import capacity is busy. Retry after the indicated delay.', 'import_busy', 5)
  } else {
    if (local.size >= MAX_ACTIVE) throw new ConvertError(503, 'Fresh import capacity is busy. Retry after the indicated delay.', 'import_busy', 5)
    local.add(id)
  }
  try { return await work() } finally {
    local.delete(id)
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
