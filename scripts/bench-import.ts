
import { importProfilePosts } from '../lib/import.ts'
const [handle, since, max, conc] = process.argv.slice(2)
const t0 = Date.now()
const r = await importProfilePosts({ handle, since: since ? new Date(since) : undefined, maxPosts: Number(max ?? 500), concurrency: Number(conc ?? 16) })
const replies = r.posts.filter(p => p.replying_to).length, reposts = r.posts.filter(p => p.reposted_by).length
console.log(JSON.stringify({ ...r.meta, replies, reposts, wall_ms: Date.now() - t0, authors: [...new Set(r.posts.map(p => p.author?.screen_name))].length }))
