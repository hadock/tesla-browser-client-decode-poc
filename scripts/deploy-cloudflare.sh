#!/usr/bin/env bash
# Cloudflare target. Normally run via: ./deploy.sh cloudflare [all|build|config|dry-run]
# Inputs (env): WORKER_NAME, CUSTOM_DOMAIN (optional), CLOUDFLARE_ACCOUNT_ID (optional).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="$ROOT/cloudflare"
# wrangler needs a writable cache dir; without a package.json it would try /node_modules/.cache
export WRANGLER_CACHE_DIR="${WRANGLER_CACHE_DIR:-$CF/.wrangler/cache}"
DIST="$CF/dist"
MODE="${1:-all}"
export WORKER_NAME="${WORKER_NAME:-tesla-client-decode-poc}"
export CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

case "$MODE" in all|build|config|dry-run) ;; *) echo "cloudflare modes: all|build|config|dry-run" >&2; exit 2 ;; esac
[[ "$WORKER_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "invalid WORKER_NAME" >&2; exit 2; }
[[ -n "$CLOUDFLARE_ACCOUNT_ID" ]] || unset CLOUDFLARE_ACCOUNT_ID

gen_config() {
  python3 "$ROOT/tools/gen_wrangler.py" "$CF/wrangler.template.jsonc" "$CF/wrangler.jsonc"
  local acct="<wrangler login>"; [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && acct="<from env>"
  echo "==> cloudflare/wrangler.jsonc  worker=$WORKER_NAME  domain=${CUSTOM_DOMAIN:-<workers.dev>}  account=$acct"
}

build() {
  rm -rf "$DIST" && mkdir -p "$DIST/videos" "$DIST/packs"
  cp -R "$ROOT/frontend/." "$DIST/"
  cat > "$DIST/config.js" <<JS
/* Runtime config - generated at deploy time (cloudflare target) */
window.POC_CONFIG = {
  logsUrl: "/api/logs",
  webCodecsTimeoutMs: 10000,
  logTarget: "cloudflare",
  logGroup: "workers-logs:${WORKER_NAME}"
};
JS
  shopt -s nullglob
  for f in "$ROOT"/media/*.mp4; do cp "$f" "$DIST/videos/"; done
  for d in "$ROOT"/packs/*/; do
    slug=$(basename "$d"); mkdir -p "$DIST/packs/$slug"
    cp "$d/manifest.json" "$DIST/packs/$slug/"
    [ -d "$d/chunks" ] && cp -RL "$d/chunks" "$DIST/packs/$slug/"
    [ -d "$d/frames" ] && cp -RL "$d/frames" "$DIST/packs/$slug/"
    [ -f "$d/audio.pcm" ] && cp "$d/audio.pcm" "$DIST/packs/$slug/"
  done
  shopt -u nullglob
  cat > "$DIST/_headers" <<'H'
/videos/*
  Cache-Control: public, max-age=86400
  Accept-Ranges: bytes
/packs/*
  Cache-Control: public, max-age=86400
/*.js
  Cache-Control: no-cache
/
  Cache-Control: no-cache
H
  # Workers Static Assets limit: 25 MiB per file.
  big=$(find "$DIST" -type f -size +25M || true)
  [ -z "$big" ] || { echo "Files over 25 MiB: $big" >&2; exit 1; }
  if grep -rlE "cloudfront\.net|amazonaws\.com" "$DIST" --include=*.js --include=*.html --include=*.json; then
    echo "AWS URL found in dist" >&2; exit 1
  fi
  echo "==> dist: $(find "$DIST" -type f | wc -l) files, $(du -sh "$DIST" | cut -f1)"
}

gen_config
[[ "$MODE" == "config" ]] && exit 0
build
[[ "$MODE" == "build" ]] && exit 0
cd "$CF"
if [[ "$MODE" == "dry-run" ]]; then npx wrangler deploy --dry-run; exit 0; fi
npx wrangler deploy
echo
if [[ -n "$CUSTOM_DOMAIN" ]]; then echo "Live: https://$CUSTOM_DOMAIN/"; else echo "Live: the workers.dev URL printed above"; fi
echo "Logs: (cd cloudflare && npx wrangler tail $WORKER_NAME --format pretty --search <sessionId>)"
