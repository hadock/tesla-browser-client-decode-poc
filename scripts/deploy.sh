#!/usr/bin/env bash
# Deploy the client-decode PoC: CloudFormation + Lambda zip + S3 sync + Insights queries + CloudFront.
# Auth: export AWS_* from AWS_POC_CREDENTIALS_JSON (nested credentials shape).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="${STACK_NAME:-tesla-browser-client-decode-poc}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
MODE="${1:-all}"
LOG_GROUP_NAME="/${STACK}/browser"
QUERY_FAIL_NAME="tesla-client-decode-car-failures"
QUERY_SESSION_NAME="tesla-client-decode-session"
QUERY_HB_NAME="tesla-client-decode-heartbeat"

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need aws
need python3

echo "Stack=$STACK Region=$REGION Mode=$MODE"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Account=$ACCOUNT"
if [[ "$ACCOUNT" != "<AWS_ACCOUNT_ID>" ]]; then
  echo "Refusing to deploy to unexpected account $ACCOUNT" >&2
  exit 1
fi

deploy_stack() {
  echo "==> CloudFormation deploy"
  aws cloudformation deploy \
    --stack-name "$STACK" \
    --template-file "$ROOT/infra/template.yaml" \
    --parameter-overrides ProjectName="$STACK" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --region "$REGION"
}

stack_out() {
  local key="$1"
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
}

update_lambda() {
  local fn="$1"
  echo "==> Update Lambda code: $fn"
  local tmp
  tmp=$(mktemp -d)
  cp "$ROOT/backend/logs/handler.py" "$tmp/handler.py"
  python3 - "$tmp" <<'PYZ'
import sys, zipfile
from pathlib import Path
d = Path(sys.argv[1])
with zipfile.ZipFile(d / "handler.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.write(d / "handler.py", "handler.py")
PYZ
  aws lambda update-function-code \
    --function-name "$fn" \
    --zip-file "fileb://$tmp/handler.zip" \
    --region "$REGION" \
    --query '{FunctionName:FunctionName,CodeSize:CodeSize,LastModified:LastModified}' \
    --output json
  aws lambda wait function-updated --function-name "$fn" --region "$REGION" || true
  rm -rf "$tmp"
}

write_config() {
  cat > "$ROOT/frontend/config.js" <<EOF
/* Runtime config — written by deploy.sh */
window.POC_CONFIG = {
  logsUrl: "/api/logs",
  webCodecsTimeoutMs: 10000,
  logGroup: "${LOG_GROUP_NAME}"
};
EOF
}

upload_frontend() {
  local bucket="$1"
  write_config
  echo "==> Upload frontend → s3://$bucket/ (preserving packs/* videos/*)"
  aws s3 sync "$ROOT/frontend/" "s3://$bucket/" \
    --delete \
    --exclude "videos/*" \
    --exclude "packs/*" \
    --cache-control "public,max-age=60" \
    --region "$REGION"
  aws s3 cp "$ROOT/frontend/index.html" "s3://$bucket/index.html" \
    --cache-control "no-cache,no-store,must-revalidate" \
    --content-type "text/html; charset=utf-8" \
    --region "$REGION"
  aws s3 cp "$ROOT/frontend/catalog.json" "s3://$bucket/catalog.json" \
    --cache-control "no-cache" \
    --content-type "application/json" \
    --region "$REGION"
  aws s3 cp "$ROOT/frontend/app.js" "s3://$bucket/app.js" \
    --cache-control "no-cache" \
    --content-type "application/javascript; charset=utf-8" \
    --region "$REGION"
  aws s3 cp "$ROOT/frontend/config.js" "s3://$bucket/config.js" \
    --cache-control "no-cache" \
    --content-type "application/javascript; charset=utf-8" \
    --region "$REGION"
}

upload_packs() {
  local bucket="$1"
  local packs="$ROOT/packs"
  if [[ ! -d "$packs" ]]; then
    echo "==> No packs/ dir — skipping pack fallback upload"
    return 0
  fi
  echo "==> Upload Drive pack fallback → s3://$bucket/packs/"
  for slug_dir in "$packs"/*; do
    [[ -d "$slug_dir" ]] || continue
    slug=$(basename "$slug_dir")
    echo "  pack $slug"
    aws s3 cp "$slug_dir/manifest.json" "s3://$bucket/packs/$slug/manifest.json" \
      --content-type "application/json" --cache-control "no-cache" --region "$REGION"
    aws s3 cp "$slug_dir/audio.pcm" "s3://$bucket/packs/$slug/audio.pcm" \
      --content-type "application/octet-stream" --cache-control "public,max-age=86400" --region "$REGION"
    frames="$slug_dir/frames"
    aws s3 sync "$frames/" "s3://$bucket/packs/$slug/frames/" \
      --content-type "image/jpeg" --cache-control "public,max-age=86400" --region "$REGION"
    if [[ -d "$slug_dir/chunks" ]]; then
      # multi-frame chunks (tools/build_chunks.py): ~35 requests/clip instead of 700
      aws s3 sync "$slug_dir/chunks/" "s3://$bucket/packs/$slug/chunks/" --delete \
        --content-type "application/octet-stream" --cache-control "public,max-age=86400" --region "$REGION"
    fi
  done
}

upload_videos() {
  local bucket="$1"
  echo "==> Upload videos → s3://$bucket/videos/"
  for f in "$ROOT"/media/*.mp4; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f")
    echo "  $base"
    aws s3 cp "$f" "s3://$bucket/videos/$base" \
      --content-type "video/mp4" \
      --cache-control "public,max-age=86400" \
      --region "$REGION"
  done
}

invalidate() {
  local dist="$1"
  echo "==> CloudFront invalidate /* on $dist"
  aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" \
    --query 'Invalidation.Id' --output text
}

put_query() {
  local name="$1"
  local query="$2"
  local desc="$3"
  echo "==> PutQueryDefinition name=$name logGroup=$LOG_GROUP_NAME"
  local existing
  existing=$(aws logs describe-query-definitions --region "$REGION" \
    --query-definition-name-prefix "$name" \
    --query "queryDefinitions[?name=='$name'].queryDefinitionId" --output text 2>/dev/null || true)
  local -a args=(
    logs put-query-definition
    --region "$REGION"
    --name "$name"
    --query-string "$query"
    --log-group-names "$LOG_GROUP_NAME"
  )
  if [[ -n "${existing:-}" && "$existing" != "None" ]]; then
    echo "  updating existing id=$existing"
    args+=(--query-definition-id "$existing")
  fi
  local out
  out=$(aws "${args[@]}" --output json)
  local qid
  qid=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["queryDefinitionId"])' <<<"$out")
  echo "  id=$qid"
  mkdir -p "$ROOT/.deploy"
  printf '%s\n' "$qid" > "$ROOT/.deploy/${name}.id"
  printf '%s\n' "$query" > "$ROOT/.deploy/${name}.query"
  printf '%s\n' "$desc" > "$ROOT/.deploy/${name}.desc"
  echo "$qid"
}

ensure_queries() {
  local fail_query session_query
  fail_query=$(cat <<'Q'
fields @timestamp, sessionId, event, stage, path, clip, msg, level
| filter event in ["timeout", "decoder_error", "pack_fallback", "error", "rebuffer", "clock"] or level = "error" or stage like /fail|timeout|error/
| sort @timestamp desc
| limit 200
Q
)
  session_query=$(cat <<'Q'
fields @timestamp, sessionId, event, stage, path, clip, msg, level, ua
| filter sessionId = "PASTE_SESSION_ID_HERE"
| sort @timestamp asc
| limit 500
Q
)
  local hb_query
  hb_query=$(cat <<'Q'
fields @timestamp, sessionId, clip, due, shown, lagMs, maxLagMs, bufAheadMs, aheadTargetMs, paintFps, loadP50, loadP95, kbps, inflight, liveImgs, liveBlobUrls, heapMB, rebuffers, rebufferMs, stallMs, loopGapMaxMs, longTaskMaxMs, clock
| filter event = "heartbeat" and path = "pack"
| sort @timestamp asc
| limit 1000
Q
)
  put_query "$QUERY_HB_NAME" "$hb_query" \
    "Pack player heartbeat trend: lag / buffer depth / load p50,p95 / live images + blob URLs / heap / rebuffers (add | filter sessionId = ... to narrow)"
  put_query "$QUERY_FAIL_NAME" "$fail_query" \
    "Car decode failure patterns (timeout / decoder_error / pack_fallback / error)"
  put_query "$QUERY_SESSION_NAME" "$session_query" \
    "Single-session drill-down — paste sessionId from page HUD into the filter"
}

test_logs_api() {
  local site="$1"
  echo "==> Smoke-test POST $site/api/logs"
  local body
  body=$(python3 - <<'PY'
import json, time, uuid
sid = "deploy-smoke-" + uuid.uuid4().hex[:8]
print(json.dumps({
  "sessionId": sid,
  "lines": [{
    "ts": int(time.time()*1000),
    "level": "info",
    "event": "probe",
    "stage": "deploy-smoke",
    "path": "—",
    "clip": None,
    "sessionId": sid,
    "ua": "deploy.sh",
    "msg": "deploy smoke test"
  }]
}))
PY
)
  local code
  code=$(curl -sS -o /tmp/poc-log-resp.json -w "%{http_code}" \
    -X POST "$site/api/logs" \
    -H "content-type: application/json" \
    --data-binary "$body" || echo "000")
  echo "  HTTP $code body=$(cat /tmp/poc-log-resp.json 2>/dev/null || true)"
  if [[ "$code" != "200" ]]; then
    echo "WARN: log ingest smoke test did not return 200 (CF may still be propagating)" >&2
  fi
}

case "$MODE" in
  all|stack|frontend|videos|packs|invalidate|lambda|queries) ;;
  *) echo "usage: $0 [all|stack|frontend|videos|packs|invalidate|lambda|queries]" >&2; exit 2 ;;
esac

if [[ "$MODE" == "all" || "$MODE" == "stack" ]]; then
  deploy_stack
fi

BUCKET=$(stack_out BucketName)
DIST=$(stack_out DistributionId)
DOMAIN=$(stack_out DistributionDomain)
URL=$(stack_out SiteURL)
FN=$(stack_out LogIngestFnName)
LG=$(stack_out BrowserLogGroup)
echo "Bucket=$BUCKET Dist=$DIST URL=$URL Fn=$FN LogGroup=$LG"

if [[ "$MODE" == "all" || "$MODE" == "lambda" || "$MODE" == "stack" ]]; then
  if [[ -n "$FN" && "$FN" != "None" ]]; then
    update_lambda "$FN"
  else
    echo "WARN: LogIngestFnName output missing" >&2
  fi
fi

if [[ "$MODE" == "all" || "$MODE" == "queries" || "$MODE" == "stack" ]]; then
  ensure_queries
fi

if [[ "$MODE" == "all" || "$MODE" == "frontend" ]]; then
  upload_frontend "$BUCKET"
fi
if [[ "$MODE" == "all" || "$MODE" == "videos" ]]; then
  upload_videos "$BUCKET"
fi
if [[ "$MODE" == "packs" ]]; then
  upload_packs "$BUCKET"
fi
if [[ "$MODE" == "all" || "$MODE" == "frontend" || "$MODE" == "invalidate" ]]; then
  invalidate "$DIST"
fi

if [[ "$MODE" == "all" || "$MODE" == "frontend" ]]; then
  sleep 5
  test_logs_api "$URL"
fi

echo
echo "Live: $URL"
echo "Log group: $LG"
echo "Force pack: ${URL}?pack=1"
FAIL_ID=$(cat "$ROOT/.deploy/${QUERY_FAIL_NAME}.id" 2>/dev/null || echo "?")
SESS_ID=$(cat "$ROOT/.deploy/${QUERY_SESSION_NAME}.id" 2>/dev/null || echo "?")
echo "Insights query: $QUERY_FAIL_NAME id=$FAIL_ID"
echo "Insights query: $QUERY_SESSION_NAME id=$SESS_ID"
echo "Console Insights: https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#logsV2:logs-insights"
echo "CLI example:"
echo "  aws logs start-query --region $REGION --log-group-name '$LOG_GROUP_NAME' --start-time \$(date -d '1 hour ago' +%s) --end-time \$(date +%s) --query-string \"\$(cat $ROOT/.deploy/${QUERY_FAIL_NAME}.query)\""
