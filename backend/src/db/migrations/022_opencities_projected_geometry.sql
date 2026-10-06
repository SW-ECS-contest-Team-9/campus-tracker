-- Project only the OpenCities mirror. Source coordinates and Z datum stay intact.
-- Lock source before mirror, matching the trigger's normal lock order.
LOCK TABLE public.fused_positions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.opencities_fused_positions
  ALTER COLUMN geom TYPE geometry(PointZ, 5186)
  USING ST_Transform(geom, 5186);

CREATE OR REPLACE FUNCTION public.sync_opencities_fused_positions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  projected public.opencities_fused_positions;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM public.opencities_fused_positions WHERE id = OLD.id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- Replace geometry before populating the record (its typmod is now 5186).
    projected := jsonb_populate_record(
      NULL::public.opencities_fused_positions,
      to_jsonb(NEW) || jsonb_build_object('geom', ST_Transform(NEW.geom, 5186))
    );
    INSERT INTO public.opencities_fused_positions SELECT projected.*;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON TABLE public.opencities_fused_positions IS
  'OpenCities read layer: FK-free automatic mirror of published fusion. Geometry PointZ EPSG:5186; source ellipsoidal/local Z unchanged. Latitude/longitude attributes remain degrees. Do not edit.';
