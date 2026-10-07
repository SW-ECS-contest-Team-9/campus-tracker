-- Merge step of a merge bundle (see merge-export.sh). Runs inside the bundle's transaction after the dumped
-- rows were loaded into staging tables merge_in.<table>. Adds what the target does not have yet and never
-- updates or deletes target rows, so it can be run again.
--
--   collectors / devices   matched by collector code / (collector, client device id); staged references are remapped
--   sessions               only sessions the target does not have (by id or client session id), with all their
--                          raw samples, markers, QC and fusion results
--   serial ids             not carried over; the target's sequences assign new ones
--   map / terrain / scene  inserted only when that version id is missing (inactive if the target has an active one)
--   routes                 only routes the target does not have (by id or name), with passes / canonical paths / reports
--   roads, nodes, places   added by id; an object the target already has keeps the target's state
SET search_path TO public;

DO $$
DECLARE diff text;
BEGIN
  SELECT string_agg(name, ', ') INTO diff FROM (
    (SELECT name FROM merge_in.schema_migrations EXCEPT SELECT name FROM public.schema_migrations)
    UNION ALL
    (SELECT name FROM public.schema_migrations EXCEPT SELECT name FROM merge_in.schema_migrations)) d;
  IF diff IS NOT NULL THEN
    RAISE EXCEPTION 'schema differs between the dump and this database (migrations: %). Bring both to the same code and run npm run db:migrate, then export again.', diff;
  END IF;
END $$;

CREATE TABLE merge_in.report (ord serial, tbl text, in_dump bigint, added bigint);

CREATE FUNCTION merge_in.put(tbl text, cond text DEFAULT 'true', skip text[] DEFAULT '{}', ord text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  src text := 'merge_in.' || quote_ident(split_part(tbl, '.', 2));
  cols text;
  n_src bigint;
  n_ins bigint;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols FROM pg_attribute
   WHERE attrelid = tbl::regclass AND attnum > 0 AND NOT attisdropped AND attname <> ALL (skip);
  EXECUTE format('SELECT count(*) FROM %s', src) INTO n_src;
  EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM %s s WHERE %s %s ON CONFLICT DO NOTHING',
                 tbl, cols, cols, src, cond, CASE WHEN ord IS NULL THEN '' ELSE 'ORDER BY ' || ord END);
  GET DIAGNOSTICS n_ins = ROW_COUNT;
  INSERT INTO merge_in.report (tbl, in_dump, added) VALUES (tbl, n_src, n_ins);
END $$;

-- ---- collectors, devices: reuse the target's rows for the same code / device ----
UPDATE merge_in.devices d SET collector_id = t.id
  FROM merge_in.collectors sc JOIN public.collectors t USING (collector_code)
 WHERE d.collector_id = sc.id AND t.id <> sc.id;
UPDATE merge_in.collection_sessions s SET collector_id = t.id
  FROM merge_in.collectors sc JOIN public.collectors t USING (collector_code)
 WHERE s.collector_id = sc.id AND t.id <> sc.id;
SELECT merge_in.put('public.collectors');

UPDATE merge_in.collection_sessions s SET device_id = t.id
  FROM merge_in.devices sd JOIN public.devices t ON t.collector_id = sd.collector_id AND t.client_device_id = sd.client_device_id
 WHERE s.device_id = sd.id AND t.id <> sd.id;
SELECT merge_in.put('public.devices');

-- ---- map / terrain / scene versions the sessions point at ----
CREATE TABLE merge_in.new_map AS SELECT id FROM merge_in.spatial_map_versions WHERE id NOT IN (SELECT id FROM public.spatial_map_versions);
CREATE TABLE merge_in.new_scene AS SELECT id FROM merge_in.scene_versions WHERE id NOT IN (SELECT id FROM public.scene_versions);
UPDATE merge_in.spatial_map_versions SET active = false WHERE EXISTS (SELECT FROM public.spatial_map_versions WHERE active);
UPDATE merge_in.terrain_versions SET active = false WHERE EXISTS (SELECT FROM public.terrain_versions WHERE active);
UPDATE merge_in.scene_versions SET active = false WHERE EXISTS (SELECT FROM public.scene_versions WHERE active);
SELECT merge_in.put('public.spatial_map_versions');
SELECT merge_in.put('public.campus_areas', 's.map_version_id IN (SELECT id FROM merge_in.new_map)');
SELECT merge_in.put('public.campus_buildings', 's.map_version_id IN (SELECT id FROM merge_in.new_map)');
SELECT merge_in.put('public.building_metadata', 's.map_version_id IN (SELECT id FROM merge_in.new_map)');
SELECT merge_in.put('public.terrain_versions');
SELECT merge_in.put('public.scene_versions');
SELECT merge_in.put('public.scene_buildings', 's.scene_version_id IN (SELECT id FROM merge_in.new_scene)');

-- ---- sessions the target does not have, with everything that hangs off them ----
CREATE TABLE merge_in.new_sess AS
  SELECT s.id FROM merge_in.collection_sessions s
   WHERE NOT EXISTS (SELECT FROM public.collection_sessions t WHERE t.id = s.id OR t.client_session_id = s.client_session_id);
ALTER TABLE merge_in.new_sess ADD PRIMARY KEY (id);
CREATE TABLE merge_in.new_run AS SELECT r.id FROM merge_in.fusion_runs r WHERE r.session_id IN (SELECT id FROM merge_in.new_sess);
ALTER TABLE merge_in.new_run ADD PRIMARY KEY (id);
ANALYZE merge_in.new_sess;
ANALYZE merge_in.new_run;

SELECT merge_in.put('public.collection_sessions', 's.id IN (SELECT id FROM merge_in.new_sess)');
SELECT merge_in.put('public.received_batches', 's.session_id IN (SELECT id FROM merge_in.new_sess)');
SELECT merge_in.put('public.location_samples', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.motion_samples', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.altimeter_samples', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.pedometer_samples', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.event_markers', 's.session_id IN (SELECT id FROM merge_in.new_sess)');
SELECT merge_in.put('public.collection_diagnostic_events', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.raw_location_qc', 's.session_id IN (SELECT id FROM merge_in.new_sess)');
-- the row trigger on fused_positions fills opencities_fused_positions
SELECT merge_in.put('public.fused_positions', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.spatial_gps_decisions', 's.session_id IN (SELECT id FROM merge_in.new_sess)');
SELECT merge_in.put('public.fusion_sensor_events', 's.session_id IN (SELECT id FROM merge_in.new_sess)', '{id}', 's.id');
SELECT merge_in.put('public.fusion_runs', 's.id IN (SELECT id FROM merge_in.new_run)');
SELECT merge_in.put('public.fusion_run_positions', 's.run_id IN (SELECT id FROM merge_in.new_run)');
SELECT merge_in.put('public.fusion_run_fixes', 's.run_id IN (SELECT id FROM merge_in.new_run)');
SELECT merge_in.put('public.fusion_run_events', 's.run_id IN (SELECT id FROM merge_in.new_run)', '{id}', 's.id');

-- ---- routes, passes, canonical paths, validation, bench ----
CREATE TABLE merge_in.new_route AS
  SELECT s.id FROM merge_in.routes s WHERE NOT EXISTS (SELECT FROM public.routes t WHERE t.id = s.id OR t.name = s.name);
SELECT merge_in.put('public.routes', 's.id IN (SELECT id FROM merge_in.new_route)');
SELECT merge_in.put('public.route_passes', 's.route_id IN (SELECT id FROM merge_in.new_route)
  AND EXISTS (SELECT FROM public.collection_sessions t WHERE t.id = s.session_id) AND EXISTS (SELECT FROM public.fusion_runs t WHERE t.id = s.run_id)');
SELECT merge_in.put('public.canonical_paths', 's.route_id IN (SELECT id FROM merge_in.new_route)');
SELECT merge_in.put('public.canonical_points', 's.canonical_path_id IN (SELECT p.id FROM merge_in.canonical_paths p WHERE p.route_id IN (SELECT id FROM merge_in.new_route))');
SELECT merge_in.put('public.validation_reports', 's.route_id IN (SELECT id FROM merge_in.new_route)');
SELECT merge_in.put('public.bench_results');

-- ---- road / place network drawn in the editor ----
SELECT merge_in.put('mobility.network_nodes');
SELECT merge_in.put('mobility.road_segments');
SELECT merge_in.put('mobility.places');
SELECT merge_in.put('mobility.editor_mutations');
SELECT merge_in.put('mobility.editor_changes', 'NOT EXISTS (SELECT FROM mobility.editor_changes t WHERE t.change_set_id = s.change_set_id)', '{id}', 's.id');

\o
\echo
\echo merged (in_dump = rows in the bundle, added = rows new to this database):
SELECT tbl AS "table", in_dump, added, in_dump - added AS already_here_or_skipped FROM merge_in.report ORDER BY ord;
\echo sessions skipped because this database already has them:
SELECT s.id, s.started_at FROM merge_in.collection_sessions s WHERE s.id NOT IN (SELECT id FROM merge_in.new_sess) ORDER BY 2;
\echo routes skipped because this database already has that id or name:
SELECT s.name FROM merge_in.routes s WHERE s.id NOT IN (SELECT id FROM merge_in.new_route) ORDER BY 1;
