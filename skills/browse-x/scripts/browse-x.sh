#!/usr/bin/env bash
set -euo pipefail

X_API_BASE="${X_API_BASE:-${X_MD_API_BASE:-https://x.pcstyle.dev}}"

usage() {
  cat >&2 <<'EOF'
Usage:
  browse-x.sh <x-status-or-profile-url> [options]
  browse-x.sh status <x-status-url> [options]
  browse-x.sh profile <handle> [options]
  browse-x.sh search <query> [options]
  browse-x.sh followers <handle> [options]
  browse-x.sh following <handle> [options]

Output: --json, --full, --compact, --format markdown|obsidian, --headers
Lists:  --page 1-10, --limit 1-20, --cursor <cursor>, --feed latest|top|photos|videos|users|media
Status: --thread off|full|conversation|2-100, --userinfo off|author|all,
        --context full|thread, --replies top|recent|off
Other:  --nocache, --help

X_API_BASE overrides https://x.pcstyle.dev.
EOF
  exit "${1:-2}"
}

fail() { printf 'browse-x: %s\n' "$*" >&2; exit 2; }
need_value() { [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"; }
set_scalar() {
  local name="$1" value="$2" option="$3" is_set old
  eval "is_set=\${$name+x}"
  if [[ "$is_set" == x ]]; then
    eval "old=\${$name}"
    [[ "$old" == "$value" ]] || fail "$option was supplied with conflicting values ('$old' and '$value')"
    return
  fi
  printf -v "$name" '%s' "$value"
}

[[ $# -gt 0 ]] || usage
[[ "$1" != -h && "$1" != --help ]] || usage 0

command_name=""
target=""
case "$1" in
  status|profile|search|followers|following)
    command_name="$1"
    [[ $# -ge 2 ]] || fail "$1 requires a target"
    target="$2"
    shift 2
    ;;
  http://*|https://*) target="$1"; shift ;;
  *) fail "expected a command or public X URL (got '$1')" ;;
esac

show_headers=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) json_requested=1; shift ;;
    --full) set_scalar full_value true --full/--compact; shift ;;
    --compact) set_scalar full_value false --full/--compact; shift ;;
    --headers) show_headers=1; shift ;;
    --nocache) nocache_requested=1; shift ;;
    --format|--page|--limit|--cursor|--feed|--thread|--userinfo|--context|--replies)
      need_value "$1" "${2:-}"
      name="${1#--}"
      set_scalar "${name}_value" "$2" "$1"
      shift 2
      ;;
    -h|--help) usage 0 ;;
    *) fail "unknown option '$1'" ;;
  esac
done

[[ ! ${format_value+x} || "$format_value" =~ ^(markdown|obsidian|json)$ ]] || fail "--format must be markdown, obsidian, or json"
[[ ! ${page_value+x} || "$page_value" =~ ^([1-9]|10)$ ]] || fail "--page must be an integer from 1 to 10"
[[ ! ${limit_value+x} || ( "$limit_value" =~ ^[0-9]+$ && "$limit_value" -ge 1 && "$limit_value" -le 20 ) ]] || fail "--limit must be an integer from 1 to 20"
[[ ! ${feed_value+x} || "$feed_value" =~ ^(latest|top|photos|videos|users|media)$ ]] || fail "--feed must be latest, top, photos, videos, users, or media"
[[ ! ${thread_value+x} || "$thread_value" =~ ^(off|full|conversation|[0-9]+)$ ]] || fail "--thread must be off, full, conversation, or an integer from 2 to 100"
if [[ ${thread_value+x} && "$thread_value" =~ ^[0-9]+$ ]]; then
  [[ "$thread_value" -ge 2 && "$thread_value" -le 100 ]] || fail "--thread must be off, full, conversation, or an integer from 2 to 100"
fi
[[ ! ${userinfo_value+x} || "$userinfo_value" =~ ^(off|author|all)$ ]] || fail "--userinfo must be off, author, or all"
[[ ! ${context_value+x} || "$context_value" =~ ^(full|thread)$ ]] || fail "--context must be full or thread"
[[ ! ${replies_value+x} || "$replies_value" =~ ^(top|recent|off)$ ]] || fail "--replies must be top, recent, or off"

if [[ ${json_requested+x} && ${format_value+x} && "$format_value" != json ]]; then
  fail "--json conflicts with --format $format_value"
fi
if [[ ${json_requested+x} ]]; then format_value=json; fi
accept="text/markdown"
[[ ${format_value:-} == json ]] && accept="application/json"

handle="${target#@}"
case "$command_name" in
  status)
    resource=status
    endpoint="${X_API_BASE}/api/convert"
    target_param="url=$target"
    ;;
  profile) resource=profile; endpoint="${X_API_BASE}/${handle}" ;;
  search)
    resource=search
    endpoint="${X_API_BASE}/search"
    target_param="q=$target"
    ;;
  followers|following) resource=list; endpoint="${X_API_BASE}/${handle}/${command_name}" ;;
  "")
    case "$target" in
      */status/[0-9]*|*/status/[0-9]*/)
        resource=status
        endpoint="${X_API_BASE}/api/convert"
        target_param="url=$target"
        ;;
      https://x.com/*|https://www.x.com/*|https://twitter.com/*|https://www.twitter.com/*)
        path="${target#*://}"; path="${path#*/}"; handle="${path%%[/?#]*}"
        [[ -n "$handle" ]] || fail "profile URL must contain a handle"
        resource=profile
        endpoint="${X_API_BASE}/${handle}"
        ;;
      *) fail "only public x.com or twitter.com status/profile URLs are supported" ;;
    esac
    ;;
esac

if [[ "$resource" != status && ( ${thread_value+x} || ${userinfo_value+x} || ${context_value+x} || ${replies_value+x} ) ]]; then
  fail "status options are only valid for status requests"
fi
if [[ "$resource" != status && ${format_value:-markdown} == obsidian ]]; then
  fail "--format obsidian is only valid for status requests"
fi
[[ "$resource" == search || ! ${feed_value+x} ]] || fail "--feed is only valid for search"
[[ "$resource" != status || ( ! ${page_value+x} && ! ${limit_value+x} && ! ${cursor_value+x} && ! ${feed_value+x} ) ]] || fail "list options are not valid for status requests"

params=()
[[ ! ${target_param+x} ]] || params+=(--data-urlencode "$target_param")
for name in format full page limit cursor feed thread userinfo context replies; do
  value_name="${name}_value"
  eval "is_set=\${$value_name+x}"
  if [[ "$is_set" == x ]]; then
    eval "value=\${$value_name}"
    params+=(--data-urlencode "$name=$value")
  fi
done
[[ ! ${nocache_requested+x} ]] || params+=(--data-urlencode "nocache=true")

body_file="$(mktemp)"
header_file="$(mktemp)"
auth_file="$(mktemp)"
trap 'rm -f "$body_file" "$header_file" "$auth_file"' EXIT

# Optional API key (private; not documented in the public API). Higher, per-key
# search allowance. Set X_MD_API_KEY in the environment to use one. The header is
# passed through a private temp file so the secret never appears in `ps` output.
auth=()
if [[ -n "${X_MD_API_KEY:-}" ]]; then
  printf 'header = "Authorization: Bearer %s"\n' "$X_MD_API_KEY" > "$auth_file"
  auth=(-K "$auth_file")
fi

http_code="$(curl -sS -G "$endpoint" ${params[@]+"${params[@]}"} ${auth[@]+"${auth[@]}"} \
  -H "Accept: $accept" -D "$header_file" -o "$body_file" -w '%{http_code}')" || {
  printf 'browse-x: request to %s failed\n' "$X_API_BASE" >&2
  exit 1
}

if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
  printf 'browse-x: HTTP %s from %s\n' "$http_code" "$endpoint" >&2
  # Surface rate-limit / auth signal so the caller (and its agent) sees it immediately.
  grep -iE '^(retry-after|x-ratelimit-[a-z]+|x-api-key-status):' "$header_file" >&2 || true
  cat "$body_file" >&2
  printf '\n' >&2
  [[ "$http_code" == 429 ]] && exit 3
  exit 1
fi

if [[ "$show_headers" -eq 1 ]]; then cat "$header_file"; fi
cat "$body_file"
[[ ! -s "$body_file" || "$(tail -c 1 "$body_file" | wc -l | tr -d ' ')" == 1 ]] || printf '\n'
