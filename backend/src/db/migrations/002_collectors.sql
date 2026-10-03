CREATE TABLE collectors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_code VARCHAR(32) NOT NULL UNIQUE,   -- e.g. C01 (what the iPhone types in)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
