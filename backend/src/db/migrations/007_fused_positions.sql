-- Derived data: sensor-fusion output. Raw *_samples tables are never modified by fusion.
-- The same raw session can be (re)processed by several algorithm versions side by side.
CREATE TABLE fused_positions (
  id                      BIGSERIAL PRIMARY KEY,
  session_id              UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  fusion_sequence         BIGINT NOT NULL,
  "timestamp"             TIMESTAMPTZ NOT NULL,
  latitude                DOUBLE PRECISION NOT NULL,
  longitude               DOUBLE PRECISION NOT NULL,
  ellipsoidal_altitude    DOUBLE PRECISION,           -- WGS84 ellipsoid height, null if no vertical origin
  local_x                 DOUBLE PRECISION,           -- meters East of the session origin
  local_y                 DOUBLE PRECISION,           -- meters North
  local_z                 DOUBLE PRECISION,           -- meters Up
  heading_degrees         DOUBLE PRECISION,           -- 0 = North, 90 = East (clockwise)
  horizontal_confidence   DOUBLE PRECISION NOT NULL,  -- heuristic 0..1 quality score, not a probability
  vertical_confidence     DOUBLE PRECISION NOT NULL,
  overall_confidence      DOUBLE PRECISION NOT NULL,
  gps_horizontal_accuracy DOUBLE PRECISION,           -- accuracy of the last GPS fix used
  gps_vertical_accuracy   DOUBLE PRECISION,
  position_source         VARCHAR(32) NOT NULL,       -- GPS_ANCHORED | GPS_CORRECTED | FUSED | PDR_PREDICTED
  algorithm_version       VARCHAR(32) NOT NULL,       -- fusion-v1, ...
  -- X = longitude, Y = latitude, Z = ellipsoidal height (or the fused local Z estimate if unknown)
  geom                    geometry(PointZ, 4326) NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, algorithm_version, fusion_sequence)
);
CREATE INDEX fused_positions_session_time_idx ON fused_positions (session_id, algorithm_version, "timestamp");
CREATE INDEX fused_positions_geom_idx ON fused_positions USING GIST (geom);
