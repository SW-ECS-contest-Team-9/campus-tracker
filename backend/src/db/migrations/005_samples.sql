-- Raw sensor samples. Everything the iPhone reports is stored as-is (including iOS "invalid"
-- sentinels such as negative accuracy/speed/course). Filtering happens later, not here.

CREATE TABLE location_samples (
  id                   BIGSERIAL PRIMARY KEY,
  session_id           UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  sequence             BIGINT NOT NULL,
  "timestamp"          TIMESTAMPTZ NOT NULL,
  latitude             DOUBLE PRECISION NOT NULL,
  longitude            DOUBLE PRECISION NOT NULL,
  altitude             DOUBLE PRECISION,            -- CLLocation.altitude (above mean sea level)
  ellipsoidal_altitude DOUBLE PRECISION,            -- CLLocation.ellipsoidalAltitude (WGS84 ellipsoid)
  horizontal_accuracy  DOUBLE PRECISION,
  vertical_accuracy    DOUBLE PRECISION,
  speed                DOUBLE PRECISION,
  speed_accuracy       DOUBLE PRECISION,
  course               DOUBLE PRECISION,
  course_accuracy      DOUBLE PRECISION,
  floor_level          INTEGER,                     -- CLLocation.floor?.level
  -- X = longitude, Y = latitude, Z = height. Z policy: see telemetry.repository.ts
  geom                 geometry(PointZ, 4326) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);
CREATE INDEX location_samples_geom_idx ON location_samples USING GIST (geom);

CREATE TABLE motion_samples (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  sequence            BIGINT NOT NULL,
  "timestamp"         TIMESTAMPTZ NOT NULL,
  user_acceleration_x DOUBLE PRECISION,
  user_acceleration_y DOUBLE PRECISION,
  user_acceleration_z DOUBLE PRECISION,
  rotation_rate_x     DOUBLE PRECISION,
  rotation_rate_y     DOUBLE PRECISION,
  rotation_rate_z     DOUBLE PRECISION,
  gravity_x           DOUBLE PRECISION,
  gravity_y           DOUBLE PRECISION,
  gravity_z           DOUBLE PRECISION,
  attitude_roll       DOUBLE PRECISION,
  attitude_pitch      DOUBLE PRECISION,
  attitude_yaw        DOUBLE PRECISION,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE TABLE altimeter_samples (
  id                BIGSERIAL PRIMARY KEY,
  session_id        UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  sequence          BIGINT NOT NULL,
  "timestamp"       TIMESTAMPTZ NOT NULL,
  relative_altitude DOUBLE PRECISION,   -- meters, relative to the first altimeter sample
  pressure          DOUBLE PRECISION,   -- kPa
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

-- Pedometer has no sequence in the iOS contract; (session_id, timestamp) is the sample-level
-- idempotency key instead (CMPedometerData updates are cumulative and never share a timestamp).
CREATE TABLE pedometer_samples (
  id               BIGSERIAL PRIMARY KEY,
  session_id       UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  "timestamp"      TIMESTAMPTZ NOT NULL,
  number_of_steps  INTEGER,
  distance         DOUBLE PRECISION,
  current_pace     DOUBLE PRECISION,
  current_cadence  DOUBLE PRECISION,
  floors_ascended  INTEGER,
  floors_descended INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, "timestamp")
);
