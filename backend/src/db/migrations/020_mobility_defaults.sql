-- QGIS writes explicit NULLs for fields left empty in its form, so column DEFAULTs never apply: the validation
-- trigger (BEFORE, i.e. ahead of NOT NULL checks) fills them in.
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
  NEW.kind := COALESCE(NEW.kind, CASE TG_TABLE_NAME WHEN 'corridors' THEN 'walkway' WHEN 'open_areas' THEN 'plaza' ELSE 'building_entrance' END);
  IF TG_TABLE_NAME = 'corridors' THEN
    NEW.width_m := COALESCE(NEW.width_m, 3);
    NEW.one_way := COALESCE(NEW.one_way, false);
  END IF;
  NEW.created_at := CASE WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, now()) ELSE OLD.created_at END;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
