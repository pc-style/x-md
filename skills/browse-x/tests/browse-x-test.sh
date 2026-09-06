#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
script="$root/skills/browse-x/scripts/browse-x.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CURL_ARGS"
header=""; body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -D) header="$2"; shift 2 ;;
    -o) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'HTTP/1.1 %s Test\r\nX-Source: stub\r\n\r\n' "${CURL_CODE:-200}" >"$header"
if [[ "${CURL_CODE:-200}" == 404 ]]; then
  printf 'not found' >"$body"
else
  printf 'ok' >"$body"
fi
printf '%s' "${CURL_CODE:-200}"
EOF
chmod +x "$tmp/curl"
export PATH="$tmp:$PATH" CURL_ARGS="$tmp/args" X_API_BASE="https://example.test"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_usage() {
  set +e; "$script" "$@" >"$tmp/out" 2>"$tmp/err"; code=$?; set -e
  [[ $code -eq 2 ]] || fail "expected exit 2 for: $* (got $code)"
}

out="$($script status 'https://x.com/a/status/1' --thread full --thread full --format json --headers)"
grep -qx 'https://example.test/api/convert' "$CURL_ARGS" || fail 'wrong status endpoint'
[[ $(grep -c '^thread=full$' "$CURL_ARGS") -eq 1 ]] || fail 'thread parameter duplicated'
[[ $(grep -c '^format=json$' "$CURL_ARGS") -eq 1 ]] || fail 'format parameter duplicated'
grep -qx 'Accept: application/json' "$CURL_ARGS" || fail 'JSON Accept header missing'
[[ "$out" == *'X-Source: stub'* && "$out" == *ok ]] || fail '--headers did not print headers and body'

$script search 'from:test release' --feed media --page 3 --limit 10 --compact >/dev/null
grep -qx 'https://example.test/search' "$CURL_ARGS" || fail 'wrong search endpoint'
for arg in 'q=from:test release' 'feed=media' 'page=3' 'limit=10' 'full=false' 'Accept: text/markdown'; do
  grep -qx "$arg" "$CURL_ARGS" || fail "missing argument: $arg"
done

expect_usage status 'https://x.com/a/status/1' --json --format markdown
expect_usage search test --full --compact
expect_usage search test --limit 4 --limit 5
for feed in latest top photos videos users; do
  $script search test --feed "$feed" --limit 20 >/dev/null
  grep -qx "feed=$feed" "$CURL_ARGS" || fail "missing feed: $feed"
done
expect_usage search test --limit 21
expect_usage search test --page 11
expect_usage search test --feed newest
expect_usage profile test --thread full
expect_usage profile test --format obsidian

set +e
export CURL_CODE=404
"$script" profile test >"$tmp/out" 2>"$tmp/err"
code=$?
set -e
[[ $code -eq 1 ]] || fail "expected non-2xx exit 1 (got $code)"
grep -q 'not found' "$tmp/err" || fail 'non-2xx body missing from stderr'

printf 'browse-x shell tests passed\n'
