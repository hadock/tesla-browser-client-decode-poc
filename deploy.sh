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
  cloudflare   One Worker + Workers Static Assets (SPA, /videos, /packs).
               With ENABLE_LOGS=1 the page also posts debug logs to
               POST /api/logs -> Workers Logs. No AWS resources.
  aws          CloudFormation: S3 + CloudFront (OAC). That is all playback needs.
               With ENABLE_LOGS=1 it adds HTTP API + Lambda + log group for
               POST /api/logs -> CloudWatch Logs (+ saved Insights queries).

Modes
  cloudflare:  all (default) | build | config | dry-run
  aws:         all (default) | stack | frontend | videos | packs | lambda |
               queries | invalidate | validate | dry-run

Common options
  --env-file FILE        Load KEY=VALUE settings first (default: .deploy.env.local
                         if it exists; it is gitignored). Real env vars win.
  --enable-logs          [ENABLE_LOGS=1] browser posts debug logs to /api/logs
                         (AWS: also creates the log Lambda/API/log group).
  --no-logs              [ENABLE_LOGS=0] default. Playback is fully client-side;
                         logs stay in the browser console + on-page Debug panel.
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

Logging is optional (ENABLE_LOGS, default 0). When on, the browser posts to the
relative path /api/logs on both targets; when off it never calls it.

Examples
  ./deploy.sh cloudflare
  CUSTOM_DOMAIN=poc.example.com ./deploy.sh cloudflare
  ./deploy.sh cloudflare dry-run            # build + wrangler deploy --dry-run
  AWS_PROFILE=poc ./deploy.sh aws validate  # template validation only
  ./deploy.sh aws --expected-account 123456789012   # S3 + CloudFront only
  ENABLE_LOGS=1 ./deploy.sh aws                       # + Lambda log endpoint
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
    --enable-logs) OVR+=("ENABLE_LOGS=1") ;;
    --no-logs) OVR+=("ENABLE_LOGS=0") ;;
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

# Normalise ENABLE_LOGS to 1/0 (default 0 = no remote logging).
case "$(printf '%s' "${ENABLE_LOGS:-0}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) export ENABLE_LOGS=1 ;;
  0|false|no|off|"") export ENABLE_LOGS=0 ;;
  *) echo "ENABLE_LOGS must be 1 or 0 (got: ${ENABLE_LOGS})" >&2; exit 2 ;;
esac

case "$TARGET" in
  cloudflare) exec "$ROOT/scripts/deploy-cloudflare.sh" "${MODE:-all}" ;;
  aws)        exec "$ROOT/scripts/deploy-aws.sh" "${MODE:-all}" ;;
  "") usage >&2; echo >&2; echo "error: choose a target: aws or cloudflare" >&2; exit 2 ;;
  *) echo "unknown target: $TARGET (aws|cloudflare)" >&2; exit 2 ;;
esac
