-- Rule-based quality decision for every raw GPS fix (docs/MOBILITY_MAP_PLAN.md 4.4), independent of any fusion
-- version. Raw rows are never changed: a rejected fix keeps its row here with the reasons.
CREATE TABLE raw_location_qc (
  session_id        UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  qc_version        VARCHAR(16) NOT NULL,
  location_sequence BIGINT NOT NULL,
  "timestamp"       TIMESTAMPTZ NOT NULL,
  status            VARCHAR(10) NOT NULL CHECK (status IN ('ACCEPTED', 'SUSPECT', 'REJECTED')),
  reasons           TEXT[] NOT NULL DEFAULT '{}',
  details           JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, qc_version, location_sequence)
);
