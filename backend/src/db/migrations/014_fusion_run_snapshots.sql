-- Immutable result snapshot per fusion run (docs/MOBILITY_MAP_PLAN.md 4.2). fused_positions stays the PUBLISHED
-- result per version (realtime, preview, marker snapping); every replay additionally keeps its own outputs here,
-- so a re-run of the same version (new revision, parameter variant) no longer erases the previous result.
ALTER TABLE fusion_runs
  ADD COLUMN revision   INTEGER,
  ADD COLUMN variant    VARCHAR(48),                      -- NULL = the registered config
  ADD COLUMN overrides  JSONB,                            -- changed parameters of the variant
  ADD COLUMN mode       VARCHAR(16) NOT NULL DEFAULT 'SENSOR_TIME', -- SENSOR_TIME | AS_RECEIVED
  ADD COLUMN code_ref   TEXT,                             -- git HEAD (+dirty hash of the fusion code)
  ADD COLUMN published  BOOLEAN NOT NULL DEFAULT true,    -- this run's outputs were written to fused_positions
  ADD COLUMN pinned     BOOLEAN NOT NULL DEFAULT false,   -- kept by fusion:prune (baselines, canonical path inputs)
  ADD COLUMN snapshot   BOOLEAN NOT NULL DEFAULT false;   -- fusion_run_positions rows exist

-- Trajectory of a run in the campus frame (geo/campus-frame.ts). FORWARD = realtime-equivalent filter,
-- FINAL = stored result (finalize/smoother when the version has one; otherwise equal to FORWARD and not duplicated).
CREATE TABLE fusion_run_positions (
  run_id               UUID NOT NULL REFERENCES fusion_runs(id) ON DELETE CASCADE,
  stage                VARCHAR(8) NOT NULL CHECK (stage IN ('FORWARD', 'FINAL')),
  seq                  INTEGER NOT NULL,
  "timestamp"          TIMESTAMPTZ NOT NULL,
  latitude             DOUBLE PRECISION NOT NULL,
  longitude            DOUBLE PRECISION NOT NULL,
  x                    DOUBLE PRECISION NOT NULL,   -- campus frame East, m
  y                    DOUBLE PRECISION NOT NULL,   -- campus frame North, m
  h                    DOUBLE PRECISION,            -- orthometric height (null: no absolute height)
  z_rel                DOUBLE PRECISION,            -- engine relative height (barometric)
  sigma_h              DOUBLE PRECISION,
  heading              DOUBLE PRECISION,
  source               VARCHAR(32) NOT NULL,
  z_datum_source       VARCHAR(16),
  z_datum_sigma        DOUBLE PRECISION,
  height_above_ground  DOUBLE PRECISION,
  building_name        TEXT,
  gps_used             BOOLEAN,
  gps_sequence         BIGINT,
  stationary           BOOLEAN,
  PRIMARY KEY (run_id, stage, seq)
);

-- The algorithm's decision for every raw GPS fix of the run (not just the last fix of an output window).
CREATE TABLE fusion_run_fixes (
  run_id            UUID NOT NULL REFERENCES fusion_runs(id) ON DELETE CASCADE,
  location_sequence BIGINT NOT NULL,
  "timestamp"       TIMESTAMPTZ NOT NULL,
  forward_used      BOOLEAN NOT NULL,
  forward_reason    VARCHAR(48),
  innovation_m      DOUBLE PRECISION,
  final_weight      DOUBLE PRECISION,              -- smoother robust weight (v4), null if no smoother
  final_residual_m  DOUBLE PRECISION,
  PRIMARY KEY (run_id, location_sequence)
);

-- Engine events of a run (steps, stairs, heading segments, re-anchors, ground contacts, ...).
CREATE TABLE fusion_run_events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES fusion_runs(id) ON DELETE CASCADE,
  "timestamp" TIMESTAMPTZ NOT NULL,
  event_type  VARCHAR(32) NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX fusion_run_events_run_idx ON fusion_run_events (run_id, "timestamp");
CREATE INDEX fusion_runs_variant_idx ON fusion_runs (session_id, algorithm_version, variant, created_at DESC);

-- Synthetic sessions (backend/src/sim) are excluded from real statistics and benchmarks by default.
ALTER TABLE collection_sessions ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT false;
