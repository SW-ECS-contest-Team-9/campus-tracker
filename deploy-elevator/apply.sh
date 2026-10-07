#!/usr/bin/env bash
# Elevator roads (structure "elevator": two vertices at the same x,y, different z) for the campus network editor.
# Copy this folder to the server and run it against the CampusTracker-Server checkout:
#
#   ./apply.sh [repo]            # patch the code, add migration 024, run db:migrate   (default repo: parent of this folder)
#   ./apply.sh --check [repo]    # only test whether the patches apply; changes nothing
#   ./apply.sh --revert [repo]   # take the code patches back out (the DB migration stays; it is harmless without the code)
#
# Safe to run twice: already-applied patches are detected and skipped. Restart the backend afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=apply
case "${1:-}" in --check) MODE=check; shift ;; --revert) MODE=revert; shift ;; esac
REPO="$(cd "${1:-$HERE/..}" && pwd)"
[ -f "$REPO/backend/src/modules/editor/editor.service.ts" ] || { echo "not a CampusTracker-Server checkout: $REPO" >&2; exit 1; }
command -v patch >/dev/null || { echo "the 'patch' command is required" >&2; exit 1; }
cd "$REPO"
echo "repo: $REPO   mode: $MODE"

PATCHES=(backend.patch frontend.patch)
state() {  # applied | pending | conflict
  if patch -p1 -R --dry-run -s -f < "$HERE/$1" >/dev/null 2>&1; then echo applied
  elif patch -p1 --dry-run -s -f < "$HERE/$1" >/dev/null 2>&1; then echo pending
  else echo conflict; fi
}

bad=0
for p in "${PATCHES[@]}"; do
  s="$(state "$p")"; echo "  $p: $s"
  [ "$s" = conflict ] && bad=1
done
if [ "$bad" = 1 ]; then
  echo "A patch does not fit this checkout (the files differ from the ones it was made against). Nothing was changed." >&2
  exit 1
fi
[ "$MODE" = check ] && exit 0

if [ "$MODE" = revert ]; then
  for p in "${PATCHES[@]}"; do [ "$(state "$p")" = applied ] && patch -p1 -R -s -f < "$HERE/$p" && echo "  reverted $p"; done
  echo "Code reverted. Migration 024 was left in place. Restart the backend."
  exit 0
fi

for p in "${PATCHES[@]}"; do [ "$(state "$p")" = pending ] && patch -p1 -s -f < "$HERE/$p" && echo "  applied $p"; done
cp "$HERE/024_elevator_roads.sql" backend/src/db/migrations/024_elevator_roads.sql
echo "  migration file copied"
echo "running db:migrate ..."
npm run db:migrate
echo
echo "Done. Restart the backend (npm run dev restarts by itself when it watches the files; a built server needs npm run build + restart)."
echo "Reload the editor page to get the new structure option."
