# X Circle: original vs fast demo

Run 2026-09-28T06:19:42.074Z from one VM, one fresh headless Chrome context per run (cache disabled). Each account was checked with `index=true` before its run and had no x.md archive, so every post was walked fresh. All demo runs came first, then the original on the same accounts, so any upstream warm-up would have helped the original, not the demo.

| Account | Metric | Original (before) | Fast demo (after) | Change |
| --- | --- | --- | --- | --- |
| @rsms | First visible progress | 0.71 s | 1.64 s | 0.4× faster |
| | First circle on screen | 14.29 s | 1.62 s | 8.8× faster |
| | Complete circle | 14.47 s | 9.92 s | 1.5× faster |
| | Posts processed | 525 | 1,097 (997 own + 100 mentions) | 2.1× |
| | Posts per second | 36.3 | 110.6 | 3.0× |
| @tobi | First visible progress | 1.08 s | 1.23 s | 0.9× faster |
| | First circle on screen | 14.02 s | 1.22 s | 11.5× faster |
| | Complete circle | 14.11 s | 11.49 s | 1.2× faster |
| | Posts processed | 385 | 790 (736 own + 54 mentions) | 2.1× |
| | Posts per second | 27.3 | 68.7 | 2.5× |
| @shl | First visible progress | 0.97 s | 1.18 s | 0.8× faster |
| | First circle on screen | 14.20 s | 1.17 s | 12.1× faster |
| | Complete circle | 14.43 s | 10.41 s | 1.4× faster |
| | Posts processed | 457 | 717 (590 own + 127 mentions) | 1.6× |
| | Posts per second | 31.7 | 68.9 | 2.2× |

> The original first answered @tobi with "There is no X account with that username. Check the spelling and try again." (a transient lookup failure on its side; the account exists and the demo read it). Its row is the immediate retry at 2026-09-28T06:22:20.374Z. Both runs are kept in the raw JSON.

> First visible progress is the one metric where the original is ahead. The demo counts a post only once x.md has walked its first page for a never-archived account, which takes 1.1–1.5 s upstream; the server log puts the demo's own overhead (proxy, tunnel, long-poll, paint) at about 0.1 s on top. The original shows its first count sooner but draws nothing until it has finished, 14 s in; the demo draws a usable circle at the same moment its first count appears.

## What each column means

- **First visible progress**: time from the click on "Make my circle" until the progress card first shows a non-zero count of posts or mentions read.
- **First circle on screen**: the first paint of the 1200px circle canvas. The original paints only once everything is read; the demo paints as the first posts land and keeps refining.
- **Complete circle**: the last canvas paint that draws profile photos, after the page shows its finished result.
- **Posts processed**: the "N people from M posts" line under each circle, which counts the account's own posts plus the other people's posts that mentioned or replied to it.
- **Posts per second**: posts processed ÷ complete time.

## Circles as shown under each result

- @rsms: original says "50 people from 525 posts since 7 Sept 2026."; demo says "50 people from 1,097 posts since 31 May 2026."
- @tobi: original says "50 people from 385 posts since 9 Aug 2026."; demo says "50 people from 790 posts since 31 May 2026."
- @shl: original says "50 people from 457 posts since 18 Jun 2026."; demo says "50 people from 717 posts since 1 Jun 2026."

## Side by side

Both sites started at the same moment on @hillelogram, another account x.md had never archived, each in its own headless Chrome page; the stopwatch is painted into each page. Each page scrolls to its circle as soon as one is on screen. [`race.mp4`](results/race.mp4)

Raw data: [`results.json`](results/results.json). Screenshots and exported PNGs sit next to it.
