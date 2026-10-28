#!/usr/bin/env bash
# Deploy the client-decode PoC: CloudFormation + S3 sync + CloudFront.
# Auth: export AWS_* from AWS_POC_CREDENTIALS_JSON (nested credentials shape).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="${STACK_NAME:-tesla-browser-client-decode-poc}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
MODE="${1:-all}"

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
  aws cloudformation deploy     --stack-name "$STACK"     --template-file "$ROOT/infra/template.yaml"     --parameter-overrides ProjectName="$STACK"     --no-fail-on-empty-changeset     --region "$REGION"
}

stack_out() {
  local key="$1"
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION"     --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
}

upload_frontend() {
  local bucket="$1"
  echo "==> Upload frontend → s3://$bucket/"
  aws s3 sync "$ROOT/frontend/" "s3://$bucket/"     --delete     --exclude "videos/*"     --cache-control "public,max-age=60"     --region "$REGION"
  # HTML always revalidated
  aws s3 cp "$ROOT/frontend/index.html" "s3://$bucket/index.html"     --cache-control "no-cache,no-store,must-revalidate"     --content-type "text/html; charset=utf-8"     --region "$REGION"
  aws s3 cp "$ROOT/frontend/catalog.json" "s3://$bucket/catalog.json"     --cache-control "no-cache"     --content-type "application/json"     --region "$REGION"
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
    # frames may be a symlink
    frames="$slug_dir/frames"
    aws s3 sync "$frames/" "s3://$bucket/packs/$slug/frames/" \
      --content-type "image/jpeg" --cache-control "public,max-age=86400" --region "$REGION"
  done
}

upload_videos() {
  local bucket="$1"
  echo "==> Upload videos → s3://$bucket/videos/"
  for f in "$ROOT"/media/*.mp4; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f")
    echo "  $base"
    aws s3 cp "$f" "s3://$bucket/videos/$base"       --content-type "video/mp4"       --cache-control "public,max-age=86400"       --region "$REGION"
  done
}

invalidate() {
  local dist="$1"
  echo "==> CloudFront invalidate /* on $dist"
  aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*"     --query 'Invalidation.Id' --output text
}

case "$MODE" in
  all|stack|frontend|videos|packs|invalidate) ;;
  *) echo "usage: $0 [all|stack|frontend|videos|packs|invalidate]" >&2; exit 2 ;;
esac

if [[ "$MODE" == "all" || "$MODE" == "stack" ]]; then
  deploy_stack
fi

BUCKET=$(stack_out BucketName)
DIST=$(stack_out DistributionId)
DOMAIN=$(stack_out DistributionDomain)
URL=$(stack_out SiteURL)
echo "Bucket=$BUCKET Dist=$DIST URL=$URL"

if [[ "$MODE" == "all" || "$MODE" == "frontend" ]]; then
  upload_frontend "$BUCKET"
fi
if [[ "$MODE" == "all" || "$MODE" == "videos" ]]; then
  upload_videos "$BUCKET"
fi
if [[ "$MODE" == "all" || "$MODE" == "packs" ]]; then
  upload_packs "$BUCKET"
fi
if [[ "$MODE" == "all" || "$MODE" == "frontend" || "$MODE" == "invalidate" ]]; then
  invalidate "$DIST"
fi

echo
echo "Live: $URL"
echo "Videos: $URL/videos/patricia.mp4"
