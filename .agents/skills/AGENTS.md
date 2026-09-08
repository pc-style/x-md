# Project-only video skills

Hyperframes skills in this directory are used only for x-md video production.
Never run `hyperframes init`, `hyperframes skills`, `hyperframes skills update`,
or a global skill installer: they may install into user-level agent folders.
Use the pinned local CLI through `bun run hf` in `video/markdown-now`.
Do not install additional workflows unless the current task actually needs them.

The two upstream bundles, `hyperframes-core` and `hyperframes-animation`, came
from heygen-com/hyperframes revision dc9fb673203dda0a2c0951f3b698cf8cd0ea8d61.
They contain no MCP server definitions. Their optional audit scripts are not
needed by this film; do not allow dependency bootstrapping from those scripts.
Upstream's three Node test-runner files are omitted: they test the upstream
monorepo, depend on uninstalled sibling skills, and conflict with x-md's Vitest
discovery. Preserve this omission when refreshing these two skill bundles.
