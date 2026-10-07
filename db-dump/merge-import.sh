#!/usr/bin/env bash
# Adds a merge bundle (merge-export.sh) to this machine's DB. Existing rows stay as they are; the whole
# import is one transaction, so a failure leaves the database untouched. Safe to run twice.
#
#   npm run db:up && npm run db:migrate             # same code / migrations as the exporting machine
#   ./db-dump/merge-import.sh                       # newest db-dump/campus-merge-*.sql.gz -> POSTGRES_DB from .env
#   ./db-dump/merge-import.sh <bundle.sql.gz> [db]
set -euo pipefail
cd "$(dirname "$0")/.."

env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
DB_USER="$(env_get POSTGRES_USER)"; DB_USER="${DB_USER:-campus}"
DB_NAME="$(env_get POSTGRES_DB)"; DB_NAME="${2:-${DB_NAME:-campus}}"
BUNDLE="${1:-$(ls -t db-dump/campus-merge-*.sql.gz 2>/dev/null | head -1)}"
[ -f "$BUNDLE" ] || { echo "bundle not found: ${BUNDLE:-db-dump/campus-merge-*.sql.gz}" >&2; exit 1; }

echo "bundle: $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
echo "target: database \"$DB_NAME\" (rows are added, nothing is replaced)"
gunzip -c "$BUNDLE" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 \
  || { echo "import failed, nothing was changed" >&2; exit 1; }
echo "done. restart the server (npm run dev) so it reads the merged data."
