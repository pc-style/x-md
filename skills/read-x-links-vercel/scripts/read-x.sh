#!/usr/bin/env bash
set -euo pipefail

X_MD_API_BASE="${X_MD_API_BASE:-https://x.pcstyle.dev}"

usage() {
  echo "Usage: read-x.sh <x-status-url> [--format markdown|obsidian] [--thread off|full|N] [--userinfo off|author|all] [--json] [--nocache]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage

url=""
format=""
thread=""
userinfo=""
accept="text/markdown"
nocache=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --format) format="$2"; shift 2 ;;
    --thread) thread="$2"; shift 2 ;;
    --userinfo) userinfo="$2"; shift 2 ;;
    --json) accept="application/json"; shift ;;
    --nocache) nocache="1"; shift ;;
    http://*|https://*)
      if [[ -n "$url" ]]; then
        echo "read-x.sh: only one status URL allowed" >&2
        exit 2
      fi
      url="$1"
      shift
      ;;
    *)
      echo "read-x.sh: unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$url" ]] || usage

curl_args=(
  -sS -G "${X_MD_API_BASE}/api/convert"
  --data-urlencode "url=${url}"
  -H "Accept: ${accept}"
  -w "\n%{http_code}"
)

[[ -n "$format" ]] && curl_args+=(--data-urlencode "format=${format}")
[[ -n "$thread" ]] && curl_args+=(--data-urlencode "thread=${thread}")
[[ -n "$userinfo" ]] && curl_args+=(--data-urlencode "userinfo=${userinfo}")
[[ -n "$nocache" ]] && curl_args+=(--data-urlencode "nocache=1")

response="$(curl "${curl_args[@]}")"
http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$http_code" != "200" ]]; then
  echo "read-x.sh: HTTP $http_code from ${X_MD_API_BASE}" >&2
  echo "$body" >&2
  if [[ "$body" == *syndication_error* ]]; then
    echo "read-x.sh: try read-x-links-local for this post" >&2
  fi
  exit 1
fi

if [[ "$accept" == "application/json" ]]; then
  if command -v jq >/dev/null 2>&1; then
    echo "$body" | jq -r '.markdown // .'
    if echo "$body" | jq -e '.error' >/dev/null 2>&1; then
      exit 1
    fi
  else
    echo "$body"
  fi
else
  printf '%s\n' "$body"
fi
