-- Local-first / delayed-upload support. Additive only: no raw value or timestamp is modified.
-- Server receive time already exists on every raw table as created_at (DEFAULT now()) and is used as "received_at".

-- ---- collection session: collection state, sync state and fusion state are separate concepts ----
ALTER TABLE collection_sessions
  ADD COLUMN interrupted            BOOLEAN NOT NULL DEFAULT false, -- client reported sensor continuity was interrupted
  ADD COLUMN finish_requested_at    TIMESTAMPTZ,                    -- server time session:finish was received (ended_at = client end)
  ADD COLUMN finalized_at           TIMESTAMPTZ,                    -- raw considered complete + final replay done
  ADD COLUMN last_captured_at       TIMESTAMPTZ,                    -- newest sensor timestamp received (any stream)
  ADD COLUMN last_received_at       TIMESTAMPTZ,                    -- server time of the newest committed batch
  ADD COLUMN out_of_order_batches   INTEGER NOT NULL DEFAULT 0,     -- batches containing samples older than already received data
  ADD COLUMN needs_reprocess        BOOLEAN NOT NULL DEFAULT false, -- realtime fusion is stale (delayed / out-of-order raw)
  ADD COLUMN fusion_state           VARCHAR(16) NOT NULL DEFAULT 'CLEAN'
                                      CHECK (fusion_state IN ('CLEAN', 'DIRTY', 'PROCESSING', 'FAILED')),
  ADD COLUMN fusion_lock_until      TIMESTAMPTZ,                    -- cross-process replay lock (API / CLI / automatic)
  ADD COLUMN sync_manifest          JSONB,                          -- session:syncComplete lastSequences + server comparison
  ADD COLUMN diagnostics            JSONB;                          -- client-reported background diagnostics (merged)

-- existing sessions: what we already received is what we have
UPDATE collection_sessions s SET
  last_captured_at = (SELECT max("timestamp") FROM location_samples l WHERE l.session_id = s.id),
  last_received_at = (SELECT max(received_at) FROM received_batches b WHERE b.session_id = s.id),
  finalized_at     = CASE WHEN s.status <> 'ACTIVE' THEN now() END;
UPDATE collection_sessions s SET last_captured_at = GREATEST(s.last_captured_at,
  (SELECT max("timestamp") FROM motion_samples m WHERE m.session_id = s.id),
  (SELECT max("timestamp") FROM altimeter_samples a WHERE a.session_id = s.id),
  (SELECT max("timestamp") FROM pedometer_samples p WHERE p.session_id = s.id));
CREATE INDEX collection_sessions_reprocess_idx ON collection_sessions (needs_reprocess) WHERE needs_reprocess;

-- ---- raw sample metadata (optional from the client; old rows get sensible defaults) ----
ALTER TABLE location_samples
  ADD COLUMN capture_source    VARCHAR(24) NOT NULL DEFAULT 'LIVE',   -- LIVE | HISTORICAL_RECOVERY
  ADD COLUMN app_state         VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN', -- FOREGROUND | BACKGROUND | UNKNOWN
  ADD COLUMN sensor_segment_id VARCHAR(64);
ALTER TABLE motion_samples
  ADD COLUMN capture_source    VARCHAR(24) NOT NULL DEFAULT 'LIVE',
  ADD COLUMN app_state         VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN sensor_segment_id VARCHAR(64);
ALTER TABLE altimeter_samples
  ADD COLUMN capture_source    VARCHAR(24) NOT NULL DEFAULT 'LIVE',
  ADD COLUMN app_state         VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN sensor_segment_id VARCHAR(64);                           -- relativeAltitude restarts from 0 per segment
ALTER TABLE pedometer_samples
  ADD COLUMN sequence          BIGINT,                                -- optional client sequence (dedupe stays (session, timestamp))
  ADD COLUMN capture_source    VARCHAR(24) NOT NULL DEFAULT 'LIVE',
  ADD COLUMN app_state         VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN sensor_segment_id VARCHAR(64);

ALTER TABLE received_batches
  ADD COLUMN capture_source  VARCHAR(24),
  ADD COLUMN app_state       VARCHAR(16),
  ADD COLUMN min_captured_at TIMESTAMPTZ,  -- oldest sensor timestamp in the batch
  ADD COLUMN max_captured_at TIMESTAMPTZ,
  ADD COLUMN out_of_order    BOOLEAN NOT NULL DEFAULT false;

-- ---- lifecycle diagnostic events (NOT fusion input) ----
CREATE TABLE collection_diagnostic_events (
  id               BIGSERIAL PRIMARY KEY,
  session_id       UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  event_id         UUID UNIQUE,              -- optional client id for idempotent resend
  event_type       VARCHAR(48) NOT NULL,     -- APP_BACKGROUND, MOTION_STOPPED, WEBSOCKET_CONNECTED, ...
  client_timestamp TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata         JSONB
);
CREATE INDEX collection_diagnostic_events_session_idx ON collection_diagnostic_events (session_id, client_timestamp);
