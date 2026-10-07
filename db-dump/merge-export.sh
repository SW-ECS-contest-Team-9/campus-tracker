#!/usr/bin/env bash
# Builds a merge bundle: tracking raw data, fusion results and the editor's road/place network from this
# machine's DB, in a form that is ADDED to another server's existing data (nothing there is replaced).
# Import on the other machine with ./db-dump/merge-import.sh. For a full replace use restore.sh instead.
#
#   ./db-dump/merge-export.sh [output.sql.gz]       # default db-dump/campus-merge-<date>.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."

env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
DB_USER="$(env_get POSTGRES_USER)"; DB_USER="${DB_USER:-campus}"
DB_NAME="$(env_get POSTGRES_DB)"; DB_NAME="${DB_NAME:-campus}"
OUT="${1:-db-dump/campus-merge-$(date +%F).sql.gz}"

# opencities_fused_positions is rebuilt by a trigger; ocm_diag_*, editor_leases and the QGIS layers
# (corridors / open_areas / portals / edits) are not carried over.
TABLES=(
  public.schema_migrations
  public.collectors public.devices
  public.spatial_map_versions public.campus_areas public.campus_buildings public.building_metadata
  public.terrain_versions public.scene_versions public.scene_buildings
  public.collection_sessions public.received_batches
  public.location_samples public.motion_samples public.altimeter_samples public.pedometer_samples
  public.event_markers public.collection_diagnostic_events public.raw_location_qc
  public.fused_positions public.spatial_gps_decisions public.fusion_sensor_events
  public.fusion_runs public.fusion_run_positions public.fusion_run_fixes public.fusion_run_events
  public.routes public.route_passes public.canonical_paths public.canonical_points public.validation_reports public.bench_results
  mobility.network_nodes mobility.road_segments mobility.places mobility.editor_mutations mobility.editor_changes
)

{
  echo '\set ON_ERROR_STOP on'
  echo '\o /dev/null'
  echo 'BEGIN;'
  echo 'DROP SCHEMA IF EXISTS merge_in CASCADE;'
  echo 'CREATE SCHEMA merge_in;'
  for t in "${TABLES[@]}"; do echo "CREATE TABLE merge_in.${t#*.} (LIKE $t);"; done
  # rows go to the staging tables; sequence positions of this machine must not reach the target
  docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --data-only --no-owner $(printf -- '-t %s ' "${TABLES[@]}") \
    | sed -E -e 's/^COPY (public|mobility)\.([a-z_]+) \(/COPY merge_in.\2 (/' -e '/^SELECT pg_catalog\.setval\(/d'
  cat db-dump/merge.sql
  echo 'DROP SCHEMA merge_in CASCADE;'
  echo 'COMMIT;'
} | gzip -9 > "$OUT"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
