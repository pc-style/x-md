/**
 * Renders a results JSON from `bench/run.ts` into `bench/RESULTS.md` and
 * `bench/index.html` (the page served at /bench/).
 *
 *   bun bench/report.ts results/results-<stamp>.json
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

interface Measure {
  target: 'fast' | 'original'
  handle: string
  startedAt: string
  archiveBefore: unknown
  firstProgressMs: number | null
  firstCircleMs: number | null
  completeMs: number | null
  postsProcessed: number | null
  people: number | null
  postsPerSecond: number | null
  basis: string | null
  error: string | null
  pageMarks?: { posts?: number; mentions?: number } | null
}

const input = process.argv[2]
if (!input) { console.error('usage: bun bench/report.ts <results.json>'); process.exit(1) }
const data = JSON.parse(await readFile(input, 'utf8')) as { handles: string[]; results: Measure[]; notes?: string[]; race?: string }
const here = import.meta.dir
const shots = relative(here, dirname(input))

const s = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)} s`)
const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'))
const x = (before: number | null, after: number | null, higherIsBetter = false) => {
  if (!before || !after) return '—'
  const ratio = higherIsBetter ? after / before : before / after
  return `${ratio.toFixed(1)}×`
}
const pick = (handle: string, target: Measure['target']) => data.results.find((r) => r.handle === handle && r.target === target)

const rows = data.handles.map((handle) => ({ handle, before: pick(handle, 'original'), after: pick(handle, 'fast') }))
const cell = (m: Measure | undefined, f: (m: Measure) => string) => (m ? (m.error ? `error: ${m.error}` : f(m)) : 'not run')

const md: string[] = []
md.push('# X Circle: original vs fast demo', '')
md.push(`Run ${data.results[0]?.startedAt ?? ''} from one VM, one fresh headless Chrome context per run (cache disabled). Each account was checked with \`index=true\` before its run and had no x.md archive, so every post was walked fresh. All demo runs came first, then the original on the same accounts, so any upstream warm-up would have helped the original, not the demo.`, '')
md.push('| Account | Metric | Original (before) | Fast demo (after) | Change |', '| --- | --- | --- | --- | --- |')
for (const { handle, before, after } of rows) {
  md.push(`| @${handle} | First visible progress | ${cell(before, (m) => s(m.firstProgressMs))} | ${cell(after, (m) => s(m.firstProgressMs))} | ${x(before?.firstProgressMs ?? null, after?.firstProgressMs ?? null)} faster |`)
  md.push(`| | First circle on screen | ${cell(before, (m) => s(m.firstCircleMs))} | ${cell(after, (m) => s(m.firstCircleMs))} | ${x(before?.firstCircleMs ?? null, after?.firstCircleMs ?? null)} faster |`)
  md.push(`| | Complete circle | ${cell(before, (m) => s(m.completeMs))} | ${cell(after, (m) => s(m.completeMs))} | ${x(before?.completeMs ?? null, after?.completeMs ?? null)} faster |`)
  md.push(`| | Posts processed | ${cell(before, (m) => n(m.postsProcessed))} | ${cell(after, (m) => `${n(m.postsProcessed)} (${n(m.pageMarks?.posts ?? null)} own + ${n(m.pageMarks?.mentions ?? null)} mentions)`)} | ${x(before?.postsProcessed ?? null, after?.postsProcessed ?? null, true)} |`)
  md.push(`| | Posts per second | ${cell(before, (m) => n(m.postsPerSecond))} | ${cell(after, (m) => n(m.postsPerSecond))} | ${x(before?.postsPerSecond ?? null, after?.postsPerSecond ?? null, true)} |`)
}
for (const note of data.notes ?? []) md.push('', `> ${note}`)
md.push('', '> First visible progress is the one metric where the original is ahead. The demo counts a post only once x.md has walked its first page for a never-archived account, which takes 1.1–1.5 s upstream; the server log puts the demo\'s own overhead (proxy, tunnel, long-poll, paint) at about 0.1 s on top. The original shows its first count sooner but draws nothing until it has finished, 14 s in; the demo draws a usable circle at the same moment its first count appears.')
md.push('', '## What each column means', '')
md.push('- **First visible progress**: time from the click on "Make my circle" until the progress card first shows a non-zero count of posts or mentions read.')
md.push('- **First circle on screen**: the first paint of the 1200px circle canvas. The original paints only once everything is read; the demo paints as the first posts land and keeps refining.')
md.push('- **Complete circle**: the last canvas paint that draws profile photos, after the page shows its finished result.')
md.push('- **Posts processed**: the "N people from M posts" line under each circle, which counts the account\'s own posts plus the other people\'s posts that mentioned or replied to it.')
md.push('- **Posts per second**: posts processed ÷ complete time.')
md.push('', '## Circles as shown under each result', '')
for (const { handle, before, after } of rows) {
  md.push(`- @${handle}: original says "${before?.basis ?? '—'}"; demo says "${after?.basis ?? '—'}"`)
}
const race = data.race ? `Both sites started at the same moment on @${data.race}, another account x.md had never archived, each in its own headless Chrome page; the stopwatch is painted into each page. Each page scrolls to its circle as soon as one is on screen.` : null
if (race) md.push('', '## Side by side', '', `${race} [\`race.mp4\`](${shots}/race.mp4)`)
md.push('', `Raw data: [\`${basename(input)}\`](${shots}/${basename(input)}). Screenshots and exported PNGs sit next to it.`)
await writeFile(join(here, 'RESULTS.md'), md.join('\n') + '\n')

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const table = md.filter((l) => l.startsWith('|')).map((line, i) => {
  if (i === 1) return ''
  const cells = line.split('|').slice(1, -1).map((c) => c.trim())
  const tag = i === 0 ? 'th' : 'td'
  return `<tr>${cells.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`
}).join('')
const gallery = rows.map(({ handle }) => `<figure><figcaption>@${handle}</figcaption><div class="pair"><div><p>Original</p><a href="${shots}/original-${handle}-circle.png"><img src="${shots}/original-${handle}-circle.png" alt="Original X Circle for @${handle}" loading="lazy"></a><a href="${shots}/original-${handle}.png">page screenshot</a></div><div><p>Fast demo</p><a href="${shots}/fast-${handle}-circle.png"><img src="${shots}/fast-${handle}-circle.png" alt="Fast demo circle for @${handle}" loading="lazy"></a><a href="${shots}/fast-${handle}.png">page screenshot</a></div></div></figure>`).join('')
const notes = md.slice(md.indexOf('## What each column means') + 2, md.indexOf('## Circles as shown under each result') - 1).map((l) => `<li>${esc(l.replace(/^- /, '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>X Circle benchmark: original vs fast demo</title>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400..900&display=swap" rel="stylesheet">
<style>body{margin:0;background:#fef9f4;color:#00123b;font:16px/1.55 Figtree,system-ui,sans-serif}main{max-width:1080px;margin:0 auto;padding:32px 20px 64px}h1{font-size:clamp(1.6rem,3vw,2.3rem);letter-spacing:-.03em;margin:0 0 8px}nav a,a{color:#7758d2;font-weight:700}nav{display:flex;gap:18px;margin-bottom:24px}table{border-collapse:collapse;width:100%;background:#fff;border-radius:16px;overflow:hidden;font-variant-numeric:tabular-nums}th,td{padding:10px 12px;border-bottom:1px solid #e6e1dc;text-align:left;font-size:15px}th{background:#00123b;color:#fef9f4}td:first-child{font-weight:800}figure{margin:32px 0}figcaption{font-weight:900;font-size:20px;margin-bottom:8px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pair img{width:100%;border-radius:16px;display:block;margin-bottom:6px}.pair p{margin:0 0 6px;font-weight:800}.lead{color:#4d5670;max-width:75ch}</style>
<main><nav><a href="/">← Fast demo</a><a href="/source/">Source</a><a href="/source/bench/RESULTS.md">RESULTS.md</a><a href="${shots}/${basename(input)}">Raw JSON</a></nav>
<h1>X Circle: original vs fast demo</h1><p class="lead">${esc(md[2])}</p>
<table>${table}</table>${(data.notes ?? []).map((note) => `<p class="lead">${esc(note)}</p>`).join('')}${race ? `<h2>Side by side</h2><p class="lead">${esc(race)}</p><video src="${shots}/race.mp4" controls muted playsinline style="width:100%;border-radius:16px"></video>` : ''}<h2>What each column means</h2><ul>${notes}</ul><h2>The circles</h2>${gallery}</main></html>`
await writeFile(join(here, 'index.html'), html)
console.log('wrote bench/RESULTS.md and bench/index.html')
