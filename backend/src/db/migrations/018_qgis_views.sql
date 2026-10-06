-- QGIS layers with the SAME heights the web preview draws (docs/CAMPUS_3D_PREVIEW_PLAN.md):
-- all Z values are orthometric (Incheon MSL) on EPSG:5186, matching the terrain DEM and the campus 3D scene.
-- The base tables keep their own Z (fused/raw geom Z = WGS84 ellipsoidal height, ~23 m higher than MSL);
-- loading those directly into a QGIS 3D view puts every point one building too high.
-- In QGIS: Add PostGIS layer -> schema "qgis" -> 3D symbol with Altitude clamping = Absolute.
CREATE EXTENSION IF NOT EXISTS postgis_raster; -- server DEM export as GeoTIFF (qgis:sync)
CREATE SCHEMA IF NOT EXISTS qgis;

-- geoid separation N of the terrain version a session is pinned to (else the active one)
CREATE OR REPLACE VIEW qgis.session_geoid AS
SELECT s.id AS session_id, COALESCE(tp.geoid_separation_m, ta.geoid_separation_m) AS geoid_n
  FROM collection_sessions s
  LEFT JOIN terrain_versions tp ON tp.id = s.terrain_version_id
  LEFT JOIN terrain_versions ta ON ta.active;

-- fused positions: web rule (trajectory.ts fusedCartesian): ellipsoidal - N, else ground + 1 m (phone height)
CREATE OR REPLACE VIEW qgis.fused_positions AS
SELECT f.id, f.session_id, f.algorithm_version, f.fusion_sequence, f."timestamp", f.position_source AS source,
       f.z_datum_source, f.height_above_ground, f.building_name, f.horizontal_uncertainty,
       z.h AS msl_height_m, z.rule AS height_rule,
       ST_Transform(ST_SetSRID(ST_MakePoint(f.longitude, f.latitude, z.h), 4326), 5186)::geometry(PointZ, 5186) AS geom
  FROM fused_positions f
  JOIN qgis.session_geoid g ON g.session_id = f.session_id
  CROSS JOIN LATERAL (SELECT CASE
           WHEN f.ellipsoidal_altitude IS NOT NULL THEN f.ellipsoidal_altitude - g.geoid_n
           WHEN f.terrain_height IS NOT NULL THEN f.terrain_height + 1
           ELSE f.local_z END AS h,
         CASE WHEN f.ellipsoidal_altitude IS NOT NULL THEN 'ELLIPSOIDAL_MINUS_GEOID'
              WHEN f.terrain_height IS NOT NULL THEN 'GROUND_PLUS_PHONE' ELSE 'RELATIVE' END AS rule) z;

-- raw Core Location fixes: web rule (trajectory.ts heightOf): phone MSL altitude, else ellipsoidal - N
CREATE OR REPLACE VIEW qgis.location_samples AS
SELECT l.id, l.session_id, l.sequence, l."timestamp", l.horizontal_accuracy, l.vertical_accuracy,
       q.status AS qc_status, array_to_string(q.reasons, ',') AS qc_reasons,
       COALESCE(l.altitude, l.ellipsoidal_altitude - g.geoid_n) AS msl_height_m,
       ST_Transform(ST_SetSRID(ST_MakePoint(l.longitude, l.latitude, COALESCE(l.altitude, l.ellipsoidal_altitude - g.geoid_n, 0)), 4326), 5186)::geometry(PointZ, 5186) AS geom
  FROM location_samples l
  JOIN qgis.session_geoid g ON g.session_id = l.session_id
  LEFT JOIN raw_location_qc q ON q.session_id = l.session_id AND q.qc_version = 'qc-v1' AND q.location_sequence = l.sequence;

-- markers: snapped to the fusion-v4 track like the preview (interpolated between the fused points around the
-- marker time; nearest point across a gap > 10 s), else the phone's own position and altitude
CREATE OR REPLACE VIEW qgis.event_markers AS
SELECT m.id, m.session_id, m.marker_id, m."timestamp", m.type, m.note,
       (snap.lon IS NOT NULL) AS snapped_to_fusion,
       COALESCE(snap.h, m.altitude, m.ellipsoidal_altitude - g.geoid_n) AS msl_height_m,
       ST_Transform(ST_SetSRID(ST_MakePoint(COALESCE(snap.lon, m.longitude), COALESCE(snap.lat, m.latitude),
         COALESCE(snap.h, m.altitude, m.ellipsoidal_altitude - g.geoid_n, 0)), 4326), 5186)::geometry(PointZ, 5186) AS geom
  FROM event_markers m
  JOIN qgis.session_geoid g ON g.session_id = m.session_id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN a.t IS NULL OR b.t IS NULL OR b.t - a.t > 10 THEN COALESCE(CASE WHEN a.t IS NULL THEN NULL WHEN b.t IS NULL OR abs(a.t - mt) <= abs(b.t - mt) THEN a.lon END, b.lon)
                ELSE a.lon + (b.lon - a.lon) * (mt - a.t) / NULLIF(b.t - a.t, 0) END AS lon,
           CASE WHEN a.t IS NULL OR b.t IS NULL OR b.t - a.t > 10 THEN COALESCE(CASE WHEN a.t IS NULL THEN NULL WHEN b.t IS NULL OR abs(a.t - mt) <= abs(b.t - mt) THEN a.lat END, b.lat)
                ELSE a.lat + (b.lat - a.lat) * (mt - a.t) / NULLIF(b.t - a.t, 0) END AS lat,
           CASE WHEN a.t IS NULL OR b.t IS NULL OR b.t - a.t > 10 THEN COALESCE(CASE WHEN a.t IS NULL THEN NULL WHEN b.t IS NULL OR abs(a.t - mt) <= abs(b.t - mt) THEN a.h END, b.h)
                ELSE a.h + (b.h - a.h) * (mt - a.t) / NULLIF(b.t - a.t, 0) END AS h
      FROM (SELECT extract(epoch FROM m."timestamp") AS mt) x
      LEFT JOIN LATERAL (SELECT extract(epoch FROM f."timestamp") t, f.longitude lon, f.latitude lat, f.ellipsoidal_altitude - g.geoid_n h
                           FROM fused_positions f WHERE f.session_id = m.session_id AND f.algorithm_version = 'fusion-v4' AND f.ellipsoidal_altitude IS NOT NULL
                            AND f."timestamp" <= m."timestamp" ORDER BY f."timestamp" DESC LIMIT 1) a ON true
      LEFT JOIN LATERAL (SELECT extract(epoch FROM f."timestamp") t, f.longitude lon, f.latitude lat, f.ellipsoidal_altitude - g.geoid_n h
                           FROM fused_positions f WHERE f.session_id = m.session_id AND f.algorithm_version = 'fusion-v4' AND f.ellipsoidal_altitude IS NOT NULL
                            AND f."timestamp" > m."timestamp" ORDER BY f."timestamp" LIMIT 1) b ON true
     WHERE a.t IS NOT NULL OR b.t IS NOT NULL) snap ON true;

-- the active campus 3D scene (base/roof recomputed on the server DEM): extrude roof_m - base_m from base_m
CREATE OR REPLACE VIEW qgis.scene_buildings AS
SELECT row_number() OVER (ORDER BY b.building_id)::int AS id, b.building_id, b.name, b.height_m, b.height_source,
       b.ground_floors, b.base_m, b.roof_m, b.roof_m - b.base_m AS extrusion_m, b.note, b.geom
  FROM scene_buildings b JOIN scene_versions v ON v.id = b.scene_version_id AND v.active;

-- canonical paths (Lab): z is already orthometric
CREATE OR REPLACE VIEW qgis.canonical_points AS
SELECT row_number() OVER (ORDER BY p.canonical_path_id, p.idx)::bigint AS id, p.canonical_path_id, r.name AS route, p.idx, p.s,
       p.sample_count, p.sigma_xy, p.half_width_m, p.confidence,
       ST_Transform(ST_SetSRID(ST_MakePoint(p.longitude, p.latitude, COALESCE(p.z, 0)), 4326), 5186)::geometry(PointZ, 5186) AS geom
  FROM canonical_points p JOIN canonical_paths c ON c.id = p.canonical_path_id JOIN routes r ON r.id = c.route_id;
