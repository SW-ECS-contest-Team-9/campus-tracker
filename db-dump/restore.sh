#!/usr/bin/env bash
# Restores a full campus DB dump (tracking raw data, fusion results, road/place network, terrain, scene, migrations)
# into the docker compose PostGIS container. The target database is DROPPED and recreated.
#
#   npm run db:up                                   # container must be running; stop `npm run dev` first
#   ./db-dump/restore.sh                            # newest db-dump/*.dump -> POSTGRES_DB from .env
#   ./db-dump/restore.sh db-dump/<file>.dump [db]   # explicit dump / target database
set -euo pipefail
cd "$(dirname "$0")/.."

env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
DB_USER="$(env_get POSTGRES_USER)"; DB_USER="${DB_USER:-campus}"
DB_NAME="$(env_get POSTGRES_DB)"; DB_NAME="${2:-${DB_NAME:-campus}}"
DUMP="${1:-$(ls -t db-dump/*.dump 2>/dev/null | head -1)}"
[ -f "$DUMP" ] || { echo "dump file not found: ${DUMP:-db-dump/*.dump}" >&2; exit 1; }

psql() { docker compose exec -T db psql -U "$DB_USER" -v ON_ERROR_STOP=1 "$@"; }

echo "dump:   $DUMP ($(du -h "$DUMP" | cut -f1))"
echo "target: database \"$DB_NAME\" in container campus-collector-db (everything in it will be replaced)"
if [ "${RESTORE_YES:-}" != "1" ]; then
  read -r -p "type the database name to continue: " answer
  [ "$answer" = "$DB_NAME" ] || { echo "aborted"; exit 1; }
fi

psql -d postgres -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid()" >/dev/null
psql -d postgres -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" -c "CREATE DATABASE \"$DB_NAME\" TEMPLATE template0"
docker compose exec -T db pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges --exit-on-error < "$DUMP"
psql -d "$DB_NAME" -q -c "ANALYZE"

echo "restored. row counts:"
psql -d "$DB_NAME" -At -F ' ' -c "
  SELECT 'migrations', count(*) FROM schema_migrations
  UNION ALL SELECT 'sessions', count(*) FROM collection_sessions
  UNION ALL SELECT 'location_samples', count(*) FROM location_samples
  UNION ALL SELECT 'motion_samples', count(*) FROM motion_samples
  UNION ALL SELECT 'fused_positions', count(*) FROM fused_positions
  UNION ALL SELECT 'fusion_runs', count(*) FROM fusion_runs
  UNION ALL SELECT 'road_segments', count(*) FROM mobility.road_segments
  UNION ALL SELECT 'places', count(*) FROM mobility.places"
echo "next: npm run db:migrate && npm run dev"
