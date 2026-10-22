-- ARKit local coordinates are camera positions in meters; deliberately no spatial SRID here.
CREATE TABLE arkit_sessions (
  session_id uuid NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  ar_session_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, ar_session_id)
);
CREATE TABLE arkit_pose_samples (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL,
  ar_session_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(id),
  sequence bigint NOT NULL CHECK (sequence >= 0 AND sequence <= 9007199254740991),
  timestamp timestamptz NOT NULL,
  frame_timestamp double precision NOT NULL CHECK (frame_timestamp >= 0 AND frame_timestamp < 'Infinity'::float8),
  position_x double precision NOT NULL CHECK (abs(position_x) < 'Infinity'::float8),
  position_y double precision NOT NULL CHECK (abs(position_y) < 'Infinity'::float8),
  position_z double precision NOT NULL CHECK (abs(position_z) < 'Infinity'::float8),
  rotation_x double precision NOT NULL, rotation_y double precision NOT NULL,
  rotation_z double precision NOT NULL, rotation_w double precision NOT NULL,
  tracking_state text NOT NULL CHECK (tracking_state IN ('normal', 'limited', 'notAvailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, ar_session_id) REFERENCES arkit_sessions ON DELETE CASCADE,
  UNIQUE (session_id, ar_session_id, sequence),
  CHECK (abs(sqrt(rotation_x^2 + rotation_y^2 + rotation_z^2 + rotation_w^2) - 1) <= 0.02)
);
CREATE INDEX arkit_pose_session_time_idx ON arkit_pose_samples(session_id, timestamp, sequence);
CREATE INDEX arkit_pose_ar_time_idx ON arkit_pose_samples(session_id, ar_session_id, timestamp, sequence);
CREATE INDEX arkit_pose_ar_global_time_idx ON arkit_pose_samples(ar_session_id, timestamp, sequence);
CREATE INDEX arkit_pose_ar_received_idx ON arkit_pose_samples(session_id, ar_session_id, created_at DESC);
-- Rebuildable derived snapshots. Each AR coordinate lifetime stays separate, including LineStrings.
CREATE TABLE arkit_trajectory_results (
  session_id uuid NOT NULL,
  ar_session_id uuid NOT NULL,
  algorithm_version text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL,
  aligned_geom geometry(MultiLineString, 5186),
  corrected_geom geometry(MultiLineString, 5186),
  PRIMARY KEY (session_id, ar_session_id, algorithm_version),
  FOREIGN KEY (session_id, ar_session_id) REFERENCES arkit_sessions ON DELETE CASCADE
);
