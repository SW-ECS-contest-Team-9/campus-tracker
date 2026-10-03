-- Sparse decision and state-change history for sensor-led fusion versions, including runs with no position output.
CREATE TABLE fusion_sensor_events (
  id                BIGSERIAL PRIMARY KEY,
  session_id        UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  algorithm_version VARCHAR(32) NOT NULL,
  "timestamp"       TIMESTAMPTZ NOT NULL,
  event_type        VARCHAR(48) NOT NULL,
  details           JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fusion_sensor_events_session_idx
  ON fusion_sensor_events (session_id, algorithm_version, "timestamp", id);
