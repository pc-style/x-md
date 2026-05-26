#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
X_MD_ROOT="${X_MD_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

if [[ ! -f "$X_MD_ROOT/scripts/read-x.ts" ]]; then
  echo "read-x.sh: x-md repo not found at X_MD_ROOT=$X_MD_ROOT" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "read-x.sh: bun is required (https://bun.sh)" >&2
  exit 1
fi

exec bun "$X_MD_ROOT/scripts/read-x.ts" "$@"
