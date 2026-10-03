CREATE TABLE event_markers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marker_id            UUID NOT NULL UNIQUE,     -- generated on the iPhone, idempotency key
  session_id           UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  "timestamp"          TIMESTAMPTZ NOT NULL,
  type                 VARCHAR(32) NOT NULL,     -- entrance, intersection, stairStart, ... (free string)
  note                 TEXT,
  latitude             DOUBLE PRECISION NOT NULL,
  longitude            DOUBLE PRECISION NOT NULL,
  altitude             DOUBLE PRECISION,
  ellipsoidal_altitude DOUBLE PRECISION,
  horizontal_accuracy  DOUBLE PRECISION,
  vertical_accuracy    DOUBLE PRECISION,
  geom                 geometry(PointZ, 4326) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX event_markers_session_idx ON event_markers (session_id, "timestamp");
CREATE INDEX event_markers_geom_idx ON event_markers USING GIST (geom);
