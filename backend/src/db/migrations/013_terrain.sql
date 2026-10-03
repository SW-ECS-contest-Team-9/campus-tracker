-- Terrain DEM as the absolute height reference (Z datum) + building metadata. Additive only.
-- Heights are orthometric (Korean vertical datum, Incheon MSL); ellipsoidal = orthometric + geoid_separation_m.

CREATE TABLE terrain_versions (
  id                  text PRIMARY KEY,
  source_sha256       text NOT NULL,
  srid                integer NOT NULL CHECK (srid = 5186),
  vertical_datum      text NOT NULL,                 -- KVD_INCHEON_MSL
  geoid_separation_m  double precision NOT NULL,     -- N at the campus (KNGeoid18)
  geoid_source        text NOT NULL,
  origin_x            double precision NOT NULL,     -- south-west corner of cell (0,0), EPSG:5186
  origin_y            double precision NOT NULL,
  resolution_m        real NOT NULL,
  width               integer NOT NULL,
  height              integer NOT NULL,
  heights             bytea NOT NULL,                -- Float32 LE, row-major from the south-west, NaN = no data
  sigma               bytea NOT NULL,                -- Float32 LE, 1-sigma height uncertainty per cell (m)
  modified_mask       bytea NOT NULL,                -- 1 byte per cell: 1 = terrain likely changed since the survey
  active              boolean NOT NULL DEFAULT false,
  imported_at         timestamptz NOT NULL DEFAULT now(),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb   -- source hashes, QA report, clip extent
);
CREATE UNIQUE INDEX terrain_one_active_idx ON terrain_versions (active) WHERE active;

-- Pinned per session (like the spatial map) so replays stay reproducible.
ALTER TABLE collection_sessions ADD COLUMN terrain_version_id text REFERENCES terrain_versions(id);

-- Building register (GIS건물통합정보 AL_D010) + the university campus map, per campus map building.
CREATE TABLE building_metadata (
  map_version_id               text NOT NULL,
  building_id                  text NOT NULL,
  display_name                 text,
  register_label               text,              -- e.g. "M동(사회교육원 및 도서관)"
  register_use                 text,
  register_ground_floors       integer,
  register_underground_floors  integer,
  register_height_m            double precision,
  register_approved_on         date,
  register_source_id           text,
  campus_floor_labels          text[] NOT NULL DEFAULT '{}',   -- floors named on the university campus map
  campus_latitude              double precision,
  campus_longitude             double precision,
  metadata                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (map_version_id, building_id),
  FOREIGN KEY (map_version_id, building_id) REFERENCES campus_buildings (map_version_id, building_id) ON DELETE CASCADE
);

-- fusion outputs: absolute height diagnostics (fusion-v4 rev 2+; NULL for other versions)
ALTER TABLE fused_positions
  ADD COLUMN terrain_height       double precision,   -- DEM orthometric height under the position
  ADD COLUMN height_above_ground  double precision,   -- orthometric height - terrain height
  ADD COLUMN z_datum_source       varchar(16),        -- TERRAIN | GPS | NONE
  ADD COLUMN z_datum_sigma        double precision;
