-- fusion-v2.1 diagnostics (nullable: v1/v2 rows keep NULL) + run counters / validation warnings.
ALTER TABLE fused_positions
  ADD COLUMN gps_quality         VARCHAR(16),  -- EXCELLENT | GOOD | MARGINAL | POOR | UNUSABLE
  ADD COLUMN pdr_applied         BOOLEAN,      -- pedometer moved XY in this window (false: see pdr_reject_reason)
  ADD COLUMN pdr_reject_reason   VARCHAR(32),  -- NO_HEADING | NOT_INITIALIZED | NEGATIVE_DELTA | NOT_FINITE | OVERSPEED_CLAMPED
  ADD COLUMN relative_altitude   DOUBLE PRECISION, -- raw CMAltimeter relativeAltitude at output time
  ADD COLUMN reanchored          BOOLEAN,
  ADD COLUMN reanchor_reason     VARCHAR(32),  -- GPS_CLUSTER | GPS_TRACK | DIVERGENCE
  ADD COLUMN divergence_detected BOOLEAN;

ALTER TABLE fusion_runs
  ADD COLUMN reanchor_count   INTEGER,
  ADD COLUMN divergence_count INTEGER,
  ADD COLUMN warnings         JSONB;           -- post-run sanity validation (fusion.validation.ts)
