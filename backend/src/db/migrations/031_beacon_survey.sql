-- Beacon registration support (docs/BEACON_POSITIONING.md §5.3): proximity UUIDs the apps scan for even before any
-- beacon of that UUID is registered, so unregistered major/minor values are collected and listed for registration.
CREATE TABLE positioning.survey_uuids (
  uuid        UUID PRIMARY KEY,
  label       TEXT CHECK (length(label) <= 200),
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX beacon_observations_unregistered_idx ON positioning.beacon_observations (uuid, major, minor, observed_at)
  WHERE resolution = 'UNREGISTERED';
