# Tweets are just markdown now

30-second x-md launch film, 1920×1080 at 30 fps. Uses Hyperframes and one seekable
GSAP timeline. This second cut replaces the original's long text holds with a
moving post matrix, browser interaction, data extraction, and an agent workflow.
It follows the [reference](https://x.com/Miguel07Code/status/2095931337811042640)
more closely: perspective moves, quick interface changes, grids, and drawn data
connections, in x-md's warm-paper and green palette. No reference footage or
audio is embedded.

## Run locally

From the repository root, install the site's locked dependencies with `bun install`.
Then, from `video/markdown-now`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run stills
bun run render
```

Output: `renders/x-md-meaningful-love.mp4`. Earlier cuts are preserved as
`renders/x-md-markdown-now.mp4` and `renders/x-md-markdown-now-v2.mp4`.
The render needs Node 22+, local Chrome,
and FFmpeg. It does not need API keys or a cloud service. No dev server is required.
Run CLI commands through `bun run hf` to disable automatic updates, skill installs,
and telemetry. Never use `hyperframes init` or its global skill updater here.

## Edit

- `index.html`: copy, illustrative product UI, scene durations, and labeled timeline.
- `film.css`: layouts; colors come from the site's `src/tokens.css`.
- `prepare.ts`: copies local GSAP, compiles site tokens, and prepares the soundtrack.

| Time | Scene |
| --- | --- |
| 0–4.5 | Close-up pulls back into a moving post matrix |
| 4.5–9 | Cursor changes the domain; browser transforms into Markdown |
| 9–13.5 | Tracking box and drawn connections map post content to Markdown |
| 13.5–19.5 | Camera pans through threads, profiles, and search interfaces |
| 19.5–26 | Source nodes converge into x.md, then an agent terminal |
| 26–30 | x.md and x.pcstyle.dev |

No narration; the film works muted. The user-selected soundtrack is
**Silo — meaningful love (instrumental)**, using the existing local
`video/audio-src.mp3` (identified by `video/meta.txt`). The excerpt starts at
6.748 seconds, after the spoken intro, and runs for 30 seconds at its original
pitch and tempo with a 1.2-second ending fade. It replaces the synthesized score.
The source recording is not bundled here; a fresh checkout needs that local file.
Music rights are separate from the project's code license; confirm permission
before publishing the video. All post and agent content is illustrative, with no
fabricated counts or endorsements.

Checks and captured frames live in `renders/v2-check.txt` and `renders/v2-stills/`.
The layout audit permits the intro's opaque title overlays and camera travel
outside scene edges. Inspect the rendered frames as well as the check result.

Satoshi Regular/Bold are from [Fontshare](https://www.fontshare.com/fonts/satoshi),
served through its public font API. Their files are bundled for offline rendering.
Only `hyperframes-core` and `hyperframes-animation` are installed in the repository's
`.agents/skills`. No global skills or other video projects were changed.
