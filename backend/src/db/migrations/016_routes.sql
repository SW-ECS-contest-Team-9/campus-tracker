-- Repeated-pass mobility map (docs/MOBILITY_MAP_PLAN.md 4.7–4.10). Everything here is derived from run snapshots
-- (fusion_run_positions); raw data and fusion results are only read.

-- A route: the stretch between two ends A and B (campus frame, geo/campus-frame.ts) and which fusion results feed it.
CREATE TABLE routes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  frame_id        VARCHAR(32) NOT NULL,
  a_x             DOUBLE PRECISION NOT NULL,
  a_y             DOUBLE PRECISION NOT NULL,
  b_x             DOUBLE PRECISION NOT NULL,
  b_y             DOUBLE PRECISION NOT NULL,
  radius_m        DOUBLE PRECISION NOT NULL DEFAULT 15,
  width_m         DOUBLE PRECISION NOT NULL DEFAULT 20,
  fusion_version  VARCHAR(32) NOT NULL DEFAULT 'fusion-v4',
  fusion_variant  VARCHAR(48),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One traversal of a route inside one run (the original list's "Raw Run").
CREATE TABLE route_passes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id    UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  run_id      UUID NOT NULL REFERENCES fusion_runs(id) ON DELETE RESTRICT, -- keeps the snapshot (fusion:prune skips it)
  session_id  UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  t_start     TIMESTAMPTZ NOT NULL,
  t_end       TIMESTAMPTZ NOT NULL,
  direction   VARCHAR(2) NOT NULL CHECK (direction IN ('AB', 'BA')),
  source      VARCHAR(8) NOT NULL CHECK (source IN ('AUTO', 'MANUAL')),
  excluded    BOOLEAN NOT NULL DEFAULT false,          -- excluded by hand
  -- result of the latest canonical build (similarity, flips, outliers)
  status      VARCHAR(10),
  reasons     TEXT[] NOT NULL DEFAULT '{}',
  flipped     BOOLEAN NOT NULL DEFAULT false,
  metrics     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_id, run_id, t_start)
);
CREATE INDEX route_passes_route_idx ON route_passes (route_id, t_start);

CREATE TABLE canonical_paths (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  algorithm       VARCHAR(32) NOT NULL,
  params          JSONB NOT NULL,
  params_hash     VARCHAR(32) NOT NULL,
  frame_id        VARCHAR(32) NOT NULL,
  fusion_version  VARCHAR(32) NOT NULL,
  fusion_variant  VARCHAR(48),
  pass_ids        UUID[] NOT NULL,
  passes          JSONB NOT NULL,       -- per-pass outcome of this build (status, reasons, similarity)
  metrics         JSONB NOT NULL,       -- length, iterations, medoid, zRelative, summary of sigma / confidence
  code_ref        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX canonical_paths_route_idx ON canonical_paths (route_id, created_at DESC);

CREATE TABLE canonical_points (
  canonical_path_id UUID NOT NULL REFERENCES canonical_paths(id) ON DELETE CASCADE,
  idx               INTEGER NOT NULL,
  s                 DOUBLE PRECISION NOT NULL,
  x                 DOUBLE PRECISION NOT NULL,
  y                 DOUBLE PRECISION NOT NULL,
  z                 DOUBLE PRECISION,       -- orthometric (or relative when the path's metrics say zRelative)
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  sample_count      INTEGER NOT NULL,
  sigma_xy          DOUBLE PRECISION,
  sigma_z           DOUBLE PRECISION,
  se_xy             DOUBLE PRECISION,
  half_width_m      DOUBLE PRECISION NOT NULL,
  confidence        DOUBLE PRECISION NOT NULL,
  low_samples       BOOLEAN NOT NULL,
  contributors      TEXT[] NOT NULL DEFAULT '{}',   -- route_passes ids
  PRIMARY KEY (canonical_path_id, idx)
);

CREATE TABLE validation_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  canonical_path_id UUID REFERENCES canonical_paths(id) ON DELETE SET NULL,
  algorithm       VARCHAR(32) NOT NULL,
  params_hash     VARCHAR(32) NOT NULL,
  fusion_version  VARCHAR(32) NOT NULL,
  fusion_variant  VARCHAR(48),
  method          VARCHAR(24) NOT NULL,
  metrics         JSONB NOT NULL,       -- pooled + per pass (without per-station errors)
  errors          JSONB NOT NULL,       -- per pass station errors (for drawing)
  bench_id        UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX validation_reports_route_idx ON validation_reports (route_id, created_at DESC);

CREATE TABLE bench_results (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite       TEXT NOT NULL,
  candidate   JSONB NOT NULL,           -- {version, variant, overrides}
  baseline_id UUID REFERENCES bench_results(id) ON DELETE SET NULL,
  metrics     JSONB NOT NULL,           -- per route + overall
  code_ref    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
