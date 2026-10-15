-- Core Motion sea-level altitude is an independent, optional raw stream.
CREATE TABLE absolute_altitude_samples (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  altitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  precision DOUBLE PRECISION,
  vertical_reference VARCHAR(24) NOT NULL DEFAULT 'APPLE_MSL',
  invalid_reason VARCHAR(200),
  sensor_segment_id VARCHAR(64),
  capture_source VARCHAR(24) NOT NULL DEFAULT 'LIVE',
  app_state VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);
CREATE INDEX absolute_altitude_session_time_idx ON absolute_altitude_samples(session_id, "timestamp");
ALTER TABLE received_batches ADD COLUMN absolute_altitude_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fusion_runs ADD COLUMN raw_absolute_altitude_count INTEGER;
