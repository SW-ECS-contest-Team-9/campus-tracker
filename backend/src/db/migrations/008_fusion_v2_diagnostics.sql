-- fusion-v2 diagnostics on fused_positions (nullable: fusion-v1 rows keep NULL) + reprocessing history.
ALTER TABLE fused_positions
  ADD COLUMN gps_used               BOOLEAN,          -- a fix in this output window was used (true) / rejected (false); NULL = no fix
  ADD COLUMN gps_reject_reason      VARCHAR(32),      -- POOR_ACCURACY | STATIONARY_LOCK | PHYSICAL_JUMP | INNOVATION_TOO_LARGE | INVALID_ACCURACY
  ADD COLUMN gps_sequence           BIGINT,           -- location_samples.sequence of the last fix considered
  ADD COLUMN innovation_distance    DOUBLE PRECISION, -- meters between predicted position and that fix
  ADD COLUMN stationary             BOOLEAN,
  ADD COLUMN heading_source         VARCHAR(32),      -- NONE | GPS_COURSE | GPS_DISPLACEMENT
  ADD COLUMN horizontal_uncertainty DOUBLE PRECISION; -- heuristic, meters

-- One row per replay of a session with one algorithm version (API, CLI or automatic).
CREATE TABLE fusion_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  algorithm_version   VARCHAR(32) NOT NULL,
  status              VARCHAR(16) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  trigger             VARCHAR(32) NOT NULL,       -- api | cli | auto-finish | auto-rebuild | auto-backlog
  config              JSONB NOT NULL,             -- exact config used, for reproducing / comparing results
  config_hash         VARCHAR(64) NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  raw_location_count  INTEGER,
  raw_motion_count    INTEGER,
  raw_altimeter_count INTEGER,
  raw_pedometer_count INTEGER,
  output_count        INTEGER,
  gps_accepted_count  INTEGER,
  gps_rejected_count  INTEGER,
  metrics             JSONB,                      -- debug metrics (NOT accuracy: there is no ground truth)
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fusion_runs_session_idx ON fusion_runs (session_id, algorithm_version, created_at DESC);
