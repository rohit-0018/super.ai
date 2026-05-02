#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────────────
# scripts/deploy.sh — Render deploy helper
#
# Wraps the Render REST API (https://api.render.com/v1) so Claude Code (or
# you, manually) can trigger and watch deploys without leaving the terminal.
# Service IDs are read from .render.json (gitignored).
#
# Setup (one-time):
#   1. Render Dashboard → Account → API Keys → Create
#   2. export RENDER_API_KEY=rnd_xxxxxxxxxxxx  (or add to .env / shell rc)
#   3. ./scripts/deploy.sh init    # auto-discovers services and writes .render.json
#
# Usage:
#   ./scripts/deploy.sh init                     # auto-discover service IDs
#   ./scripts/deploy.sh list                     # show known services + last deploy status
#   ./scripts/deploy.sh status [service]         # show last 5 deploys for one service
#   ./scripts/deploy.sh trigger api              # trigger deploy of api service
#   ./scripts/deploy.sh trigger web              # ditto for web
#   ./scripts/deploy.sh trigger both             # trigger api + web
#   ./scripts/deploy.sh watch <deployId>         # poll deploy until terminal state
#
# .render.json format (created by `init`):
#   {
#     "api": "srv-abcd…",
#     "web": "srv-efgh…"
#   }
# ───────────────────────────────────────────────────────────────────────────

set -euo pipefail

API_BASE="https://api.render.com/v1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/.render.json"

# Pull RENDER_API_KEY from env or .env
if [[ -z "${RENDER_API_KEY:-}" && -f "$ROOT/.env" ]]; then
  set +u
  export RENDER_API_KEY=$(grep -E '^RENDER_API_KEY=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  set -u
fi

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  echo "✗ RENDER_API_KEY not set."
  echo "  Get one at https://dashboard.render.com/u/settings#api-keys"
  echo "  Then: export RENDER_API_KEY=rnd_xxx  (or add to .env)"
  exit 1
fi

curl_render() {
  curl -fsSL \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@"
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "✗ jq is required. Install with: brew install jq"
    exit 1
  fi
}

# ─── init ────────────────────────────────────────────────────────────────
cmd_init() {
  require_jq
  echo "▶ discovering services from Render API…"
  local list
  list=$(curl_render "$API_BASE/services?limit=50")

  # Map names → service IDs. Looks for any service whose name contains "qwai"
  # and tags it as "api" (web service running NestJS) or "web" (static site).
  local api_id web_id
  api_id=$(echo "$list" | jq -r '.[] | select(.service.name | test("api"; "i")) | .service.id' | head -1)
  web_id=$(echo "$list" | jq -r '.[] | select(.service.name | test("web"; "i")) | .service.id' | head -1)

  if [[ -z "$api_id" || -z "$web_id" ]]; then
    echo "⚠ couldn't auto-match. Listing all services so you can pick:"
    echo "$list" | jq -r '.[] | "  \(.service.id)  \(.service.type)  \(.service.name)"'
    echo "Set $CFG manually with:"
    echo '  { "api": "srv-XXX", "web": "srv-YYY" }'
    exit 1
  fi

  cat > "$CFG" <<EOF
{
  "api": "$api_id",
  "web": "$web_id"
}
EOF
  echo "✓ wrote $CFG"
  echo "    api → $api_id"
  echo "    web → $web_id"
}

load_cfg() {
  if [[ ! -f "$CFG" ]]; then
    echo "✗ $CFG not found. Run: $0 init"
    exit 1
  fi
  require_jq
  API_ID=$(jq -r '.api' "$CFG")
  WEB_ID=$(jq -r '.web' "$CFG")
}

resolve_service() {
  case "$1" in
    api|API|backend) echo "$API_ID" ;;
    web|WEB|frontend) echo "$WEB_ID" ;;
    srv-*) echo "$1" ;;
    *) echo "✗ unknown service '$1' — use api / web / srv-XXX" >&2; exit 1 ;;
  esac
}

# ─── list ────────────────────────────────────────────────────────────────
cmd_list() {
  load_cfg
  for svc in api web; do
    local id
    id=$(resolve_service "$svc")
    local name status last
    name=$(curl_render "$API_BASE/services/$id" | jq -r '.name')
    last=$(curl_render "$API_BASE/services/$id/deploys?limit=1" | jq -r '.[0].deploy | "\(.id)  \(.status)  \(.commit.message // "")  \(.createdAt)"')
    printf "%-6s  %-22s  %-12s  %s\n" "$svc" "$name" "$id" "$last"
  done
}

# ─── status ──────────────────────────────────────────────────────────────
cmd_status() {
  load_cfg
  local svc="${1:-api}"
  local id
  id=$(resolve_service "$svc")
  echo "▶ recent deploys for $svc ($id):"
  curl_render "$API_BASE/services/$id/deploys?limit=5" \
    | jq -r '.[] | .deploy | "\(.createdAt)  \(.status)  \(.id)  \(.commit.message // "" | .[0:60])"'
}

# ─── trigger ─────────────────────────────────────────────────────────────
cmd_trigger() {
  load_cfg
  local target="${1:-}"
  if [[ -z "$target" ]]; then echo "usage: $0 trigger api|web|both"; exit 1; fi

  local services=()
  case "$target" in
    api) services=("api") ;;
    web) services=("web") ;;
    both|all) services=("api" "web") ;;
    *) echo "✗ unknown target '$target'"; exit 1 ;;
  esac

  for svc in "${services[@]}"; do
    local id
    id=$(resolve_service "$svc")
    echo "▶ triggering deploy on $svc ($id)…"
    local resp
    resp=$(curl_render -X POST "$API_BASE/services/$id/deploys" -d '{}')
    local deploy_id
    deploy_id=$(echo "$resp" | jq -r '.id')
    if [[ -z "$deploy_id" || "$deploy_id" == "null" ]]; then
      echo "✗ failed: $resp"
      exit 1
    fi
    local status
    status=$(echo "$resp" | jq -r '.status')
    echo "✓ $svc deploy queued: $deploy_id ($status)"
    echo "  watch with: $0 watch $deploy_id"
  done
}

# ─── watch ───────────────────────────────────────────────────────────────
cmd_watch() {
  load_cfg
  local deploy_id="${1:-}"
  if [[ -z "$deploy_id" ]]; then echo "usage: $0 watch <deployId>"; exit 1; fi

  # Find which service this deploy belongs to so we can hit the right URL.
  # Render's /v1/deploys/{id} doesn't exist; we have to query by service.
  local svc_id status prev=""
  for cand in "$API_ID" "$WEB_ID"; do
    if curl -fsSL -H "Authorization: Bearer $RENDER_API_KEY" \
        "$API_BASE/services/$cand/deploys/$deploy_id" >/dev/null 2>&1; then
      svc_id="$cand"; break
    fi
  done
  if [[ -z "${svc_id:-}" ]]; then
    echo "✗ couldn't find $deploy_id under api or web"; exit 1
  fi

  echo "▶ watching $deploy_id on service $svc_id (Ctrl+C to stop)…"
  while true; do
    status=$(curl_render "$API_BASE/services/$svc_id/deploys/$deploy_id" | jq -r '.status')
    if [[ "$status" != "$prev" ]]; then
      printf "  [%s] %s\n" "$(date '+%H:%M:%S')" "$status"
      prev="$status"
    fi
    case "$status" in
      live|build_failed|update_failed|deactivated|canceled) break ;;
    esac
    sleep 5
  done
  if [[ "$status" == "live" ]]; then
    echo "✓ deploy live"
    exit 0
  else
    echo "✗ deploy ended in: $status"
    exit 1
  fi
}

# ─── main ────────────────────────────────────────────────────────────────
case "${1:-}" in
  init)    shift; cmd_init "$@" ;;
  list)    shift; cmd_list "$@" ;;
  status)  shift; cmd_status "$@" ;;
  trigger) shift; cmd_trigger "$@" ;;
  watch)   shift; cmd_watch "$@" ;;
  *)
    cat <<EOF
Render deploy helper.

Commands:
  init                       — auto-discover service IDs from Render API
  list                       — show api + web with last deploy status
  status [api|web]           — show 5 recent deploys for one service
  trigger api|web|both       — kick off a new deploy (latest commit)
  watch <deployId>           — poll until terminal state (live / failed)

Setup:
  export RENDER_API_KEY=rnd_xxx   (from dashboard.render.com → Account → API Keys)
  ./scripts/deploy.sh init
EOF
    ;;
esac
