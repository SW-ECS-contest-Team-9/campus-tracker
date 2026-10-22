-- A bounded per-session HealthKit walking-step-length prior. The raw Health samples stay on device.
-- Migration 024 is an existing local worktree change; do not edit or replace it.
ALTER TABLE collection_sessions
  ADD COLUMN stride_calibration JSONB,
  ADD COLUMN stride_calibration_status VARCHAR(16) NOT NULL DEFAULT 'FALLBACK'
    CHECK (stride_calibration_status IN ('ACCEPTED', 'FALLBACK')),
  ADD COLUMN stride_calibration_reason VARCHAR(32) DEFAULT 'MISSING';

ALTER TABLE fusion_runs
  ADD COLUMN input_hash VARCHAR(64);

CREATE INDEX fusion_runs_input_idx
  ON fusion_runs (session_id, algorithm_version, input_hash, status, published);
