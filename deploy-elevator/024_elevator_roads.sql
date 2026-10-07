-- Elevators: a road that only changes height (two vertices stacked in plan). Until now a road needed 5 cm of XY length.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'mobility.road_segments'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%st_length(geom)%' OR pg_get_constraintdef(oid) ILIKE '%indoor_corridor%')
  LOOP
    EXECUTE format('ALTER TABLE mobility.road_segments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE mobility.road_segments
  ADD CONSTRAINT road_segments_structure_check
    CHECK (structure IN ('ordinary', 'sidewalk', 'crossing', 'stairs', 'ramp', 'indoor_corridor', 'elevator')),
  ADD CONSTRAINT road_segments_length_check
    CHECK (CASE WHEN structure = 'elevator' THEN ST_3DLength(geom) >= 0.5 ELSE ST_Length(geom) >= 0.05 END),
  ADD CONSTRAINT road_segments_elevator_access_check
    CHECK (structure <> 'elevator' OR vehicle_access <> 'allowed');
