---
title: Agent skill
description: Give your coding agent a small, read-only tool for X.
sidebar:
  order: 6
---

## Install browse-x

```bash
bunx skills add pc-style/x-md -g -y --skill browse-x
```

The skill calls the hosted service. It does not need a local x.md checkout, X login, or provider key.

## Use the CLI

From a checkout, run the included script:

```bash
skills/browse-x/scripts/browse-x.sh search 'typescript' --feed latest
skills/browse-x/scripts/browse-x.sh search 'design' --feed photos --limit 10
skills/browse-x/scripts/browse-x.sh search 'vercel' --feed users --json
skills/browse-x/scripts/browse-x.sh profile vercel --full
skills/browse-x/scripts/browse-x.sh status 'https://x.com/trq212/status/2052809885763747935' --thread off
```

| Option | Effect |
| --- | --- |
| `--json` | Structured response |
| `--full` | Expanded metadata |
| `--limit 1-20` | Browse result count |
| `--cursor TOKEN` | Continue a browse result |
| `--page 1-10` | Walk to a numbered page |
| `--headers` | Print response headers |
| `--nocache` | Bypass application caching |

The script exits with `2` for invalid arguments and `1` for network or API errors.

## Read docs as Markdown

Each documentation page has a **Copy as Markdown** action. The [documentation manifest](https://x.pcstyle.dev/llms.txt) is also available for tools.

Requested URLs and queries are sent to the hosted service and its data providers. Keep secrets out of queries and URLs.
