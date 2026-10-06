-- OpenCities Map 2025 discovery hides fused_positions when its session FK is
-- present. Keep the authoritative table intact and publish a FK-free mirror.
-- Copy constraints/indexes, but NOT defaults: id must not share the source sequence.
LOCK TABLE public.fused_positions IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.opencities_fused_positions
  (LIKE public.fused_positions INCLUDING CONSTRAINTS INCLUDING INDEXES);

COMMENT ON TABLE public.opencities_fused_positions IS
  'OpenCities read layer: automatically mirrors all published fusion versions without foreign keys. Geometry remains PointZ EPSG:4326 with source ellipsoidal/local height. Do not edit.';

CREATE FUNCTION public.sync_opencities_fused_positions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM public.opencities_fused_positions WHERE id = OLD.id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- Match by column name; future source-only columns do not break ingestion.
    INSERT INTO public.opencities_fused_positions
      SELECT (jsonb_populate_record(NULL::public.opencities_fused_positions, to_jsonb(NEW))).*;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER sync_opencities_fused_positions
AFTER INSERT OR UPDATE OR DELETE ON public.fused_positions
FOR EACH ROW EXECUTE FUNCTION public.sync_opencities_fused_positions();

CREATE FUNCTION public.truncate_opencities_fused_positions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE public.opencities_fused_positions;
  RETURN NULL;
END;
$$;

CREATE TRIGGER truncate_opencities_fused_positions
AFTER TRUNCATE ON public.fused_positions
FOR EACH STATEMENT EXECUTE FUNCTION public.truncate_opencities_fused_positions();

-- Backfill under the same lock/transaction as trigger installation.
INSERT INTO public.opencities_fused_positions SELECT * FROM public.fused_positions;
