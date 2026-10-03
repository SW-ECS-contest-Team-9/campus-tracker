CREATE TABLE spatial_map_versions (
  id             TEXT PRIMARY KEY,
  source_sha256  TEXT NOT NULL,
  srid           INTEGER NOT NULL CHECK (srid = 5186),
  active         BOOLEAN NOT NULL DEFAULT false,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX spatial_map_one_active_idx ON spatial_map_versions (active) WHERE active;

CREATE TABLE campus_areas (
  map_version_id TEXT NOT NULL REFERENCES spatial_map_versions(id) ON DELETE CASCADE,
  feature_id     TEXT NOT NULL,
  geom           geometry(MultiPolygon, 5186) NOT NULL,
  area_m2        DOUBLE PRECISION,
  PRIMARY KEY (map_version_id, feature_id)
);
CREATE INDEX campus_areas_geom_idx ON campus_areas USING GIST (geom);

CREATE TABLE campus_buildings (
  map_version_id TEXT NOT NULL REFERENCES spatial_map_versions(id) ON DELETE CASCADE,
  building_id    TEXT NOT NULL,
  building_name  TEXT,
  geom           geometry(MultiPolygon, 5186) NOT NULL,
  PRIMARY KEY (map_version_id, building_id)
);
CREATE INDEX campus_buildings_geom_idx ON campus_buildings USING GIST (geom);

CREATE TABLE spatial_gps_decisions (
  session_id             UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  algorithm_version      VARCHAR(32) NOT NULL,
  location_sequence      BIGINT NOT NULL,
  "timestamp"            TIMESTAMPTZ NOT NULL,
  spatial_map_version_id TEXT REFERENCES spatial_map_versions(id),
  campus_status          VARCHAR(32) NOT NULL,
  anchor_accepted        BOOLEAN NOT NULL,
  reason                 VARCHAR(48) NOT NULL,
  horizontal_accuracy    DOUBLE PRECISION,
  boundary_distance_m    DOUBLE PRECISION,
  building_id            TEXT,
  building_name          TEXT,
  decided_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, algorithm_version, location_sequence)
);

ALTER TABLE collection_sessions
  ADD COLUMN spatial_map_version_id TEXT REFERENCES spatial_map_versions(id);
UPDATE collection_sessions SET spatial_map_version_id = (
  SELECT id FROM spatial_map_versions WHERE active LIMIT 1
);

ALTER TABLE fused_positions
  ADD COLUMN spatial_map_version_id TEXT REFERENCES spatial_map_versions(id),
  ADD COLUMN spatial_status VARCHAR(32),
  ADD COLUMN building_id TEXT,
  ADD COLUMN building_name TEXT,
  ADD COLUMN building_match_status VARCHAR(32),
  ADD COLUMN spatial_segment_id INTEGER;
