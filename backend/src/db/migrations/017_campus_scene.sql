-- Rough campus 3D model for the preview map (docs/CAMPUS_3D_PREVIEW_PLAN.md). Source: a QGIS GeoPackage
-- (buildings with heights and their basis). Base/roof are recomputed on the terrain DEM fusion uses, so the drawn
-- ground and the fusion height datum are the same surface. Versions are kept; one is active.
CREATE TABLE scene_versions (
  id                 TEXT PRIMARY KEY,                 -- campus3d-<sha8 of the GeoPackage>
  source_sha256      TEXT NOT NULL,
  terrain_version_id TEXT NOT NULL REFERENCES terrain_versions(id),
  map_version_id     TEXT NOT NULL REFERENCES spatial_map_versions(id),
  height_mode        VARCHAR(16) NOT NULL,             -- RECOMPUTED (on the terrain DEM) | ABSOLUTE (roof_m/base_m as given)
  active             BOOLEAN NOT NULL DEFAULT false,
  imported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb -- validation report
);
CREATE UNIQUE INDEX scene_one_active_idx ON scene_versions (active) WHERE active;

CREATE TABLE scene_buildings (
  scene_version_id TEXT NOT NULL REFERENCES scene_versions(id) ON DELETE CASCADE,
  building_id      TEXT NOT NULL,                       -- campus_buildings.building_id (same footprint)
  name             TEXT,
  height_m         DOUBLE PRECISION NOT NULL,           -- building height above its ground (register or estimate)
  height_source    VARCHAR(16) NOT NULL,                -- REGISTER | ESTIMATE
  register_id      TEXT,
  ground_floors    INTEGER,
  base_m           DOUBLE PRECISION NOT NULL,           -- orthometric (Incheon MSL)
  roof_m           DOUBLE PRECISION NOT NULL,
  terrain_min_m    DOUBLE PRECISION,
  terrain_max_m    DOUBLE PRECISION,
  source_base_m    DOUBLE PRECISION,                    -- values in the GeoPackage (its own DEM)
  source_roof_m    DOUBLE PRECISION,
  note             TEXT,
  geom             geometry(MultiPolygon, 5186) NOT NULL,
  PRIMARY KEY (scene_version_id, building_id)
);
