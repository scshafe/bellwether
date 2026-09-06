#!/bin/sh
# scripts/conductor-gate.sh — the release gate Mission Control's Conductor runs
# before and after deploying this repository. The manifest names ONE verb per
# stage; the logic lives here so the manifest stays a list of commands and the
# gate can be run by hand from the repository root.
#
#   install                     dev dependencies (npm ci only when package-lock.json changed)
#   test                        typecheck, then the suite (which builds first), NODE_ENV unset
#   verify HEALTH_URL SIDECAR HOST   after deploy: the health URL answers and
#                               the tailscale sidecar serves HOST to the tailnet only
#
# The Conductor runs each verb via /bin/sh -c in its own per-commit worktree of
# this repository, with a ten-minute cap per command.
set -eu
cd "$(dirname "$0")/.."
verb="${1:-}"
shift || true
case "$verb" in
  install)
    # The Conductor links node_modules to the primary checkout's so installs
    # persist across runs; make that target exist before installing into it.
    if [ -L node_modules ] && [ ! -e node_modules ]; then mkdir -p "$(readlink node_modules)"; fi
    stamp_file=node_modules/.conductor-lock-sha256
    stamp="$(sha256sum package-lock.json | cut -c1-64)"
    if [ -d node_modules ] && [ "$(cat "$stamp_file" 2>/dev/null || true)" = "$stamp" ]; then
      echo "conductor-gate: node_modules matches package-lock.json; install skipped"
    else
      env -u NODE_ENV npm ci --no-audit --no-fund
      printf '%s' "$stamp" > "$stamp_file"
    fi
    echo "conductor-gate: install ok ($(node -v))"
    ;;
  test)
    env -u NODE_ENV npm run typecheck
    env -u NODE_ENV npm test
    ;;
  verify)
    url="${1:?verify needs the health URL}"
    sidecar="${2:?verify needs the tailscale sidecar container name}"
    host="${3:?verify needs the tailnet host the sidecar must serve}"
    curl -fsS --max-time 8 "$url" > /dev/null
    status="$(docker exec "$sidecar" tailscale funnel status 2>&1)"
    printf '%s\n' "$status" | grep -q "^https://$host (tailnet only)" \
      || { echo "conductor-gate: $sidecar does not serve https://$host tailnet-only:" >&2; printf '%s\n' "$status" >&2; exit 1; }
    if printf '%s\n' "$status" | grep -qi "funnel on"; then
      echo "conductor-gate: Funnel is ON for $host — the tailnet-only rule forbids it" >&2
      printf '%s\n' "$status" >&2
      exit 1
    fi
    echo "conductor-gate: verify ok — $url answers, $host tailnet only"
    ;;
  *)
    echo "usage: scripts/conductor-gate.sh install|test|verify HEALTH_URL SIDECAR HOST" >&2
    exit 64
    ;;
esac
