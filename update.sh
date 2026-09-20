#!/usr/bin/env bash
#
# Update a Docker deployment to the latest commit on this branch:
# pull, rebuild, restart, then wait until the server reports healthy.
#
# Usage:
#   ./update.sh              pull, rebuild, restart
#   ./update.sh --prune      also delete dangling images afterwards
#   ./update.sh --no-pull    rebuild and restart what is already checked out
#
set -euo pipefail

cd "$(dirname "$0")"

PULL=1
PRUNE=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --prune)   PRUNE=1 ;;
    -h|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Compose moved from a separate binary to a docker subcommand; support both.
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose was not found. Install it, then run this again." >&2
  exit 1
fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "$PULL" -eq 1 ]; then
  # A dirty tree means a pull could fail halfway or clobber local edits, so
  # stop early and let the operator decide. .env is gitignored and unaffected.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "You have uncommitted changes. Commit, stash or discard them first:" >&2
    git status --short >&2
    exit 1
  fi

  before="$(git rev-parse HEAD)"
  say "Pulling the latest code"
  git pull --ff-only
  after="$(git rev-parse HEAD)"

  if [ "$before" = "$after" ]; then
    say "Already up to date at $(git rev-parse --short HEAD) — rebuilding anyway"
  else
    say "Updated $(git rev-parse --short "$before") -> $(git rev-parse --short "$after")"
    git --no-pager log --oneline "$before..$after"
  fi
fi

say "Rebuilding and restarting"
compose up -d --build

# Read the host port the same way compose does, so the health check and the
# printed URL follow whatever is set in .env.
PORT="$(grep -E '^[[:space:]]*HOST_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
PORT="${PORT:-8787}"

say "Waiting for the server to come up on port $PORT"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/v1/health" 2>/dev/null; then
    echo "Healthy after ${i}s."
    printf '\nRunning at http://localhost:%s — database and sign-in were kept.\n' "$PORT"
    if [ "$PRUNE" -eq 1 ]; then
      say "Removing dangling images"
      docker image prune -f
    fi
    exit 0
  fi
  sleep 1
done

echo "The server did not report healthy within 60s. Recent logs:" >&2
compose logs --tail 40 bookmarks >&2
exit 1
