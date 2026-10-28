#!/usr/bin/env bash
# One entry point for both hosting targets. Nothing account-specific lives in
# this repo: every account / domain / name is injected at deploy time via env
# vars, flags, or an untracked env file (default: ./.deploy.env.local).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<'USAGE'
Usage: ./deploy.sh <aws|cloudflare> [mode] [options]
       TARGET=<aws|cloudflare> ./deploy.sh [mode] [options]

Targets
  cloudflare   One Worker + Workers Static Assets (SPA, /videos, /packs) and
               POST /api/logs -> Workers Logs. No AWS resources.
  aws          CloudFormation: S3 + CloudFront (OAC) + API Gateway + Lambda
               POST /api/logs -> CloudWatch Logs (+ saved Insights queries).

Modes
  cloudflare:  all (default) | build | config | dry-run
  aws:         all (default) | stack | frontend | videos | packs | lambda |
               queries | invalidate | validate | dry-run

Common options
  --env-file FILE        Load KEY=VALUE settings first (default: .deploy.env.local
                         if it exists; it is gitignored). Real env vars win.
  -h, --help             Show this help.

Cloudflare options (env var in brackets)
  --account-id ID        [CLOUDFLARE_ACCOUNT_ID]  optional; otherwise wrangler login
                         decides (must have exactly one account, or set this).
  --worker-name NAME     [WORKER_NAME]   default: tesla-client-decode-poc
  --custom-domain HOST   [CUSTOM_DOMAIN] optional, e.g. poc.example.com (zone must
                         be on the same account). Without it the Worker is
                         published on <WORKER_NAME>.<subdomain>.workers.dev.
  Auth: `npx wrangler login` once, or CLOUDFLARE_API_TOKEN in the env.

AWS options (env var in brackets)
  --stack NAME           [STACK_NAME]   default: tesla-browser-client-decode-poc
  --region REGION        [AWS_REGION / AWS_DEFAULT_REGION]  default: us-east-1
  --profile PROFILE      [AWS_PROFILE]  standard AWS credential chain otherwise
  --log-group NAME       [LOG_GROUP_NAME]  default: /<stack>/browser
  --bucket-prefix PFX    [BUCKET_PREFIX]   optional; bucket becomes
                         <prefix>-<stack>. Default: CloudFormation-generated name.
  --expected-account ID  [EXPECTED_AWS_ACCOUNT]  optional guard: refuse to deploy
                         if the caller identity is a different account.

The browser always posts logs to the relative path /api/logs on both targets.

Examples
  ./deploy.sh cloudflare
  CUSTOM_DOMAIN=poc.example.com ./deploy.sh cloudflare
  ./deploy.sh cloudflare dry-run            # build + wrangler deploy --dry-run
  AWS_PROFILE=poc ./deploy.sh aws validate  # template validation only
  ./deploy.sh aws --expected-account 123456789012
USAGE
}

TARGET="${TARGET:-}"
MODE=""
ENV_FILE=""
declare -a OVR=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    aws|cloudflare) if [[ -z "$TARGET" ]]; then TARGET="$1"; else MODE="$1"; fi ;;
    --env-file) ENV_FILE="$2"; shift ;;
    --account-id) OVR+=("CLOUDFLARE_ACCOUNT_ID=$2"); shift ;;
    --worker-name) OVR+=("WORKER_NAME=$2"); shift ;;
    --custom-domain) OVR+=("CUSTOM_DOMAIN=$2"); shift ;;
    --stack) OVR+=("STACK_NAME=$2"); shift ;;
    --region) OVR+=("AWS_REGION=$2"); shift ;;
    --profile) OVR+=("AWS_PROFILE=$2"); shift ;;
    --log-group) OVR+=("LOG_GROUP_NAME=$2"); shift ;;
    --bucket-prefix) OVR+=("BUCKET_PREFIX=$2"); shift ;;
    --expected-account) OVR+=("EXPECTED_AWS_ACCOUNT=$2"); shift ;;
    -*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) [[ -z "$MODE" ]] && MODE="$1" || { echo "unexpected argument: $1" >&2; exit 2; } ;;
  esac
  shift
done

# Env file: only sets variables that are not already set in the environment.
ENV_FILE="${ENV_FILE:-${DEPLOY_ENV_FILE:-}}"
[[ -z "$ENV_FILE" && -f "$ROOT/.deploy.env.local" ]] && ENV_FILE="$ROOT/.deploy.env.local"
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE" >&2; exit 2; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"; line="${line#export }"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    v="${v%"${v##*[![:space:]]}"}"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    [[ -z "${!k+x}" ]] && export "$k=$v"
  done < "$ENV_FILE"
  echo "Loaded settings from $(basename "$ENV_FILE")"
fi
for kv in "${OVR[@]+"${OVR[@]}"}"; do export "$kv"; done

case "$TARGET" in
  cloudflare) exec "$ROOT/scripts/deploy-cloudflare.sh" "${MODE:-all}" ;;
  aws)        exec "$ROOT/scripts/deploy-aws.sh" "${MODE:-all}" ;;
  "") usage >&2; echo >&2; echo "error: choose a target: aws or cloudflare" >&2; exit 2 ;;
  *) echo "unknown target: $TARGET (aws|cloudflare)" >&2; exit 2 ;;
esac
