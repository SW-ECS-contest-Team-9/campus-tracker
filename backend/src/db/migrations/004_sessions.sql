CREATE TABLE collection_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- server session id
  client_session_id   UUID NOT NULL UNIQUE,                         -- local session UUID generated on the iPhone
  collector_id        UUID NOT NULL REFERENCES collectors(id),
  device_id           UUID NOT NULL REFERENCES devices(id),
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  status              VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'FINISHED', 'INTERRUPTED')),
  sensor_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX collection_sessions_collector_started_idx ON collection_sessions (collector_id, started_at DESC);
CREATE INDEX collection_sessions_status_idx ON collection_sessions (status);
CREATE INDEX collection_sessions_device_idx ON collection_sessions (device_id);

-- One row per telemetry:batch ever committed. batch_id UNIQUE is the idempotency key:
-- a retried batch hits ON CONFLICT and is ACKed as success without inserting samples again.
CREATE TABLE received_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL UNIQUE,
  session_id        UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  client_created_at TIMESTAMPTZ,
  location_count    INTEGER NOT NULL DEFAULT 0,
  motion_count      INTEGER NOT NULL DEFAULT 0,
  altimeter_count   INTEGER NOT NULL DEFAULT 0,
  pedometer_count   INTEGER NOT NULL DEFAULT 0,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX received_batches_session_idx ON received_batches (session_id, received_at);
