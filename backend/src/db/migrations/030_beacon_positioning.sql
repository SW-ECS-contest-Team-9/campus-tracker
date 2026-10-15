-- BLE / iBeacon spatial anchors (docs/BEACON_POSITIONING.md).
-- Coordinates follow the rest of the map: EPSG:5186 metres, Z = orthometric height above MSL (KVD Incheon),
-- the same frame as mobility.network_nodes. Floors use the collection-anchor names (1F..99F, B1..B9).
CREATE SCHEMA IF NOT EXISTS positioning;

-- One row: bumped in the same transaction as every registry change; the beacon-config version / ETag.
CREATE TABLE positioning.registry_state (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision    BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO positioning.registry_state (id) VALUES (1);

-- A surveyed point that positioning can rely on. anchor_type is open for other technologies later.
CREATE TABLE positioning.spatial_anchors (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_type            TEXT NOT NULL CHECK (anchor_type IN ('BEACON')),
  building_id            TEXT NOT NULL CHECK (length(building_id) BETWEEN 1 AND 64),
  floor                  VARCHAR(4) CHECK (floor ~ '^(B[1-9]|[1-9][0-9]?F)$'),
  -- floor surface height (MSL) at the anchor; with ST_Z(geom) gives the mounting height above the floor
  floor_height_m         DOUBLE PRECISION CHECK (abs(floor_height_m) < 10000),
  geom                   geometry(PointZ, 5186) NOT NULL,
  horizontal_accuracy_m  DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (horizontal_accuracy_m > 0 AND horizontal_accuracy_m <= 100),
  vertical_accuracy_m    DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (vertical_accuracy_m > 0 AND vertical_accuracy_m <= 100),
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  label                  TEXT CHECK (length(label) <= 200),
  created_by             TEXT,
  updated_by             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX spatial_anchors_geom_idx ON positioning.spatial_anchors USING gist (geom);
CREATE INDEX spatial_anchors_building_floor_idx ON positioning.spatial_anchors (building_id, floor);

-- A physical transmitter. Identity is the protocol identifier (iBeacon UUID + major + minor), never a MAC address.
CREATE TABLE positioning.beacon_devices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id           UUID REFERENCES positioning.spatial_anchors(id),
  protocol            TEXT NOT NULL DEFAULT 'IBEACON' CHECK (protocol IN ('IBEACON')),
  uuid                UUID NOT NULL,
  major               INTEGER NOT NULL CHECK (major BETWEEN 0 AND 65535),
  minor               INTEGER NOT NULL CHECK (minor BETWEEN 0 AND 65535),
  -- advertised calibrated TX power at 1 m (iBeacon byte 25), dBm
  measured_power_dbm  SMALLINT CHECK (measured_power_dbm BETWEEN -127 AND 20),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  last_observed_at    TIMESTAMPTZ,
  label               TEXT CHECK (length(label) <= 200),
  created_by          TEXT,
  updated_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at         TIMESTAMPTZ,
  UNIQUE (protocol, uuid, major, minor)
);
CREATE INDEX beacon_devices_anchor_idx ON positioning.beacon_devices (anchor_id);

-- RSSI model per beacon (NULL = every beacon), platform and device group ('*' = any).
-- RSSI(d) = measured_power_1m - 10 * path_loss_exponent * log10(d) + N(0, rssi_variance_db2)
CREATE TABLE positioning.beacon_calibrations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beacon_id            UUID REFERENCES positioning.beacon_devices(id),
  platform             TEXT NOT NULL DEFAULT '*' CHECK (platform IN ('*', 'ios', 'android')),
  device_group         TEXT NOT NULL DEFAULT '*' CHECK (length(device_group) BETWEEN 1 AND 64),
  measured_power_1m    DOUBLE PRECISION NOT NULL CHECK (measured_power_1m BETWEEN -127 AND 20),
  path_loss_exponent   DOUBLE PRECISION NOT NULL CHECK (path_loss_exponent BETWEEN 1 AND 6),
  rssi_variance_db2    DOUBLE PRECISION NOT NULL CHECK (rssi_variance_db2 > 0 AND rssi_variance_db2 <= 400),
  sample_count         INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (beacon_id, platform, device_group)
);

-- Raw observations. batch_id is the upload idempotency key; (session, observation_id) the per-row key.
CREATE TABLE positioning.beacon_observation_batches (
  batch_id            UUID PRIMARY KEY,
  session_id          UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  device_id           UUID NOT NULL REFERENCES devices(id),
  schema_version      INTEGER NOT NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  client_created_at   TIMESTAMPTZ,
  observation_count   INTEGER NOT NULL,
  inserted_count      INTEGER NOT NULL,
  registered_count    INTEGER NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX beacon_observation_batches_session_idx ON positioning.beacon_observation_batches (session_id, received_at);

CREATE TABLE positioning.beacon_observations (
  id                         BIGSERIAL PRIMARY KEY,
  session_id                 UUID NOT NULL REFERENCES collection_sessions(id) ON DELETE CASCADE,
  batch_id                   UUID NOT NULL REFERENCES positioning.beacon_observation_batches(batch_id) ON DELETE CASCADE,
  observation_id             UUID NOT NULL,
  protocol                   TEXT NOT NULL CHECK (protocol IN ('IBEACON')),
  uuid                       UUID NOT NULL,
  major                      INTEGER NOT NULL CHECK (major BETWEEN 0 AND 65535),
  minor                      INTEGER NOT NULL CHECK (minor BETWEEN 0 AND 65535),
  -- resolved at ingest: REGISTERED (enabled beacon), DISABLED (known but disabled), UNREGISTERED (unknown identifier)
  beacon_id                  UUID REFERENCES positioning.beacon_devices(id),
  resolution                 TEXT NOT NULL CHECK (resolution IN ('REGISTERED', 'DISABLED', 'UNREGISTERED')),
  rssi_dbm                   SMALLINT NOT NULL CHECK (rssi_dbm BETWEEN -127 AND 20),
  observed_at                TIMESTAMPTZ NOT NULL,
  platform                   TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  device_model               TEXT,
  proximity                  TEXT,
  platform_distance_m        DOUBLE PRECISION,
  measured_power_dbm         SMALLINT,
  observation_time_uncertainty_ms DOUBLE PRECISION,
  rssi_aggregation           TEXT,
  sample_count               INTEGER,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, observation_id)
);
CREATE INDEX beacon_observations_session_time_idx ON positioning.beacon_observations (session_id, observed_at);
CREATE INDEX beacon_observations_beacon_idx ON positioning.beacon_observations (beacon_id, observed_at);

-- fusion-v4 rev 18 diagnostics (nullable; other versions and sessions without beacons leave them NULL)
ALTER TABLE fused_positions
  ADD COLUMN floor_label        VARCHAR(4),
  ADD COLUMN floor_building_id  TEXT,
  ADD COLUMN floor_source       VARCHAR(24),
  ADD COLUMN floor_confidence   DOUBLE PRECISION,
  ADD COLUMN beacon_updates     INTEGER;
