#!/usr/bin/env bash
# Build ./cloudflare/dist (frontend + videos + packs) and optionally deploy.
#   cloudflare/build.sh          # build only
#   cloudflare/build.sh deploy   # build + wrangler deploy
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"

rm -rf "$DIST" && mkdir -p "$DIST/videos" "$DIST/packs"
cp -R "$ROOT/frontend/." "$DIST/"
cat > "$DIST/config.js" <<'JS'
/* Runtime config — Cloudflare Worker build (cloudflare/build.sh) */
window.POC_CONFIG = {
  logsUrl: "/api/logs",
  webCodecsTimeoutMs: 10000,
  logGroup: "workers-logs:tesla-client-decode-poc"
};
JS
for f in "$ROOT"/media/*.mp4; do cp "$f" "$DIST/videos/"; done
for d in "$ROOT"/packs/*/; do
  slug=$(basename "$d"); mkdir -p "$DIST/packs/$slug"
  cp "$d/manifest.json" "$DIST/packs/$slug/"
  [ -d "$d/chunks" ] && cp -RL "$d/chunks" "$DIST/packs/$slug/"
  [ -d "$d/frames" ] && cp -RL "$d/frames" "$DIST/packs/$slug/"
  [ -f "$d/audio.pcm" ] && cp "$d/audio.pcm" "$DIST/packs/$slug/"
done
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
# Sanity: Workers Static Assets limit is 25 MiB per file.
big=$(find "$DIST" -type f -size +25M || true)
[ -z "$big" ] || { echo "Files over 25 MiB: $big" >&2; exit 1; }
grep -rl "cloudfront.net\|amazonaws.com" "$DIST" --include=*.js --include=*.html --include=*.json && { echo "AWS URL found in dist" >&2; exit 1; } || true
echo "dist: $(find "$DIST" -type f | wc -l) files, $(du -sh "$DIST" | cut -f1)"

if [ "${1:-}" = "deploy" ]; then
  cd "$HERE" && npx wrangler deploy
fi
