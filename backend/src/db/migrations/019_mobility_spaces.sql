-- Hand-drawn mobility spaces (docs/MOBILITY_MAP_PLAN.md item 11): edited DIRECTLY in QGIS (PostGIS layers,
-- backend/scripts/qgis/add_mobility_layers.py) and shown live in the preview.
--   corridors  : walkways / corridors / stairs as centerlines with a width
--   open_areas : plazas and other free-movement polygons
--   portals    : entrances, stair ends, junctions connecting spaces
-- Geometry is EPSG:5186 (2D). elevation_m = absolute MSL height for indoor/elevated features; NULL = on the ground.
-- Every save is validated (QGIS shows the error and keeps the edit buffer), stamped, logged in mobility.edits
-- and announced with NOTIFY mobility_changed (the backend relays it to the preview).
CREATE SCHEMA IF NOT EXISTS mobility;

CREATE TABLE mobility.corridors (
  id          SERIAL PRIMARY KEY,
  name        TEXT,
  kind        TEXT NOT NULL DEFAULT 'walkway'
              CHECK (kind IN ('walkway', 'sidewalk', 'indoor_corridor', 'stairs', 'ramp', 'crosswalk', 'road_shoulder', 'other')),
  width_m     DOUBLE PRECISION NOT NULL DEFAULT 3 CHECK (width_m > 0 AND width_m <= 50),
  elevation_m DOUBLE PRECISION,
  building_id TEXT,
  floor       TEXT,
  one_way     BOOLEAN NOT NULL DEFAULT false,      -- true: only in the drawing direction
  note        TEXT,
  geom        geometry(LineString, 5186) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX corridors_geom_idx ON mobility.corridors USING GIST (geom);

CREATE TABLE mobility.open_areas (
  id          SERIAL PRIMARY KEY,
  name        TEXT,
  kind        TEXT NOT NULL DEFAULT 'plaza' CHECK (kind IN ('plaza', 'courtyard', 'lobby', 'parking', 'other')),
  elevation_m DOUBLE PRECISION,
  building_id TEXT,
  floor       TEXT,
  note        TEXT,
  geom        geometry(Polygon, 5186) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX open_areas_geom_idx ON mobility.open_areas USING GIST (geom);

CREATE TABLE mobility.portals (
  id          SERIAL PRIMARY KEY,
  name        TEXT,
  kind        TEXT NOT NULL DEFAULT 'building_entrance'
              CHECK (kind IN ('building_entrance', 'plaza_entrance', 'stair_start', 'stair_end', 'elevator', 'junction', 'other')),
  elevation_m DOUBLE PRECISION,
  building_id TEXT,
  floor       TEXT,
  note        TEXT,
  geom        geometry(Point, 5186) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX portals_geom_idx ON mobility.portals USING GIST (geom);

-- every insert / update / delete, with the row before and after (geometry as WKT)
CREATE TABLE mobility.edits (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name TEXT NOT NULL,
  op         TEXT NOT NULL,
  feature_id INTEGER NOT NULL,
  db_user    TEXT NOT NULL DEFAULT current_user,
  old_row    JSONB,
  new_row    JSONB
);

CREATE OR REPLACE FUNCTION mobility.validate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.geom IS NULL OR ST_IsEmpty(NEW.geom) THEN
    RAISE EXCEPTION 'mobility.%: empty geometry', TG_TABLE_NAME;
  END IF;
  IF NOT ST_IsValid(NEW.geom) THEN
    RAISE EXCEPTION 'mobility.% id %: invalid geometry (%)', TG_TABLE_NAME, NEW.id, ST_IsValidReason(NEW.geom);
  END IF;
  IF TG_TABLE_NAME = 'corridors' AND ST_Length(NEW.geom) < 1 THEN
    RAISE EXCEPTION 'mobility.corridors id %: shorter than 1 m', NEW.id;
  END IF;
  IF TG_TABLE_NAME = 'open_areas' AND ST_Area(NEW.geom) < 4 THEN
    RAISE EXCEPTION 'mobility.open_areas id %: smaller than 4 m²', NEW.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM terrain_versions t WHERE t.active
                   AND ST_Covers(ST_MakeEnvelope(t.origin_x, t.origin_y, t.origin_x + t.width * t.resolution_m, t.origin_y + t.height * t.resolution_m, 5186), NEW.geom)) THEN
    RAISE EXCEPTION 'mobility.% id %: outside the campus terrain area (check the layer CRS: EPSG:5186)', TG_TABLE_NAME, NEW.id;
  END IF;
  NEW.name := NULLIF(btrim(NEW.name), '');
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mobility.log_and_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o JSONB := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'geom' || jsonb_build_object('geom', ST_AsText(OLD.geom)) END;
  n JSONB := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'geom' || jsonb_build_object('geom', ST_AsText(NEW.geom)) END;
  fid INTEGER := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  INSERT INTO mobility.edits (table_name, op, feature_id, old_row, new_row) VALUES (TG_TABLE_NAME, TG_OP, fid, o, n);
  PERFORM pg_notify('mobility_changed', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'id', fid)::text);
  RETURN NULL;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['corridors', 'open_areas', 'portals'] LOOP
    EXECUTE format('CREATE TRIGGER %I_validate BEFORE INSERT OR UPDATE ON mobility.%I FOR EACH ROW EXECUTE FUNCTION mobility.validate()', t, t);
    EXECUTE format('CREATE TRIGGER %I_log AFTER INSERT OR UPDATE OR DELETE ON mobility.%I FOR EACH ROW EXECUTE FUNCTION mobility.log_and_notify()', t, t);
  END LOOP;
END $$;
