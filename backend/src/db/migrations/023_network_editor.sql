-- Human-authored campus transport network and passwordless tracker-account collaboration.
CREATE TABLE mobility.network_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('endpoint', 'junction', 'portal')),
  level_id    TEXT,
  geom        geometry(PointZ, 5186) NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX network_nodes_geom_idx ON mobility.network_nodes USING GIST (geom);

CREATE TABLE mobility.road_segments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id             UUID REFERENCES mobility.road_segments(id) ON DELETE SET NULL,
  replaced_by           UUID[] NOT NULL DEFAULT '{}',
  from_node_id          UUID NOT NULL REFERENCES mobility.network_nodes(id),
  to_node_id            UUID NOT NULL REFERENCES mobility.network_nodes(id),
  name                  TEXT,
  road_class            TEXT NOT NULL CHECK (road_class IN ('pedestrian', 'vehicle', 'shared')),
  structure             TEXT NOT NULL DEFAULT 'ordinary'
                        CHECK (structure IN ('ordinary', 'sidewalk', 'crossing', 'stairs', 'ramp', 'indoor_corridor')),
  pedestrian_access     TEXT NOT NULL DEFAULT 'unknown' CHECK (pedestrian_access IN ('allowed', 'prohibited', 'restricted', 'unknown')),
  vehicle_access        TEXT NOT NULL DEFAULT 'unknown' CHECK (vehicle_access IN ('allowed', 'prohibited', 'restricted', 'unknown')),
  pedestrian_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (pedestrian_direction IN ('both', 'forward', 'backward', 'unknown')),
  vehicle_direction    TEXT NOT NULL DEFAULT 'unknown' CHECK (vehicle_direction IN ('both', 'forward', 'backward', 'unknown')),
  width_m               DOUBLE PRECISION CHECK (width_m > 0 AND width_m <= 100),
  wheelchair_access     TEXT NOT NULL DEFAULT 'unknown' CHECK (wheelchair_access IN ('allowed', 'prohibited', 'restricted', 'unknown')),
  building_id           TEXT,
  level_id              TEXT,
  vertical_datum         TEXT NOT NULL DEFAULT 'KVD_INCHEON_MSL' CHECK (vertical_datum = 'KVD_INCHEON_MSL'),
  status                TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'REPLACED', 'RETIRED')),
  revision              INTEGER NOT NULL DEFAULT 1,
  geom                  geometry(LineStringZ, 5186) NOT NULL,
  created_by            TEXT NOT NULL,
  updated_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ST_NPoints(geom) >= 2),
  CHECK (ST_Length(geom) >= 0.05),
  CHECK (road_class <> 'pedestrian' OR vehicle_access <> 'allowed'),
  CHECK (road_class <> 'vehicle' OR pedestrian_access <> 'allowed')
);
CREATE INDEX road_segments_geom_idx ON mobility.road_segments USING GIST (geom);
CREATE INDEX road_segments_status_idx ON mobility.road_segments (status, road_class);
CREATE INDEX road_segments_nodes_idx ON mobility.road_segments (from_node_id, to_node_id);

CREATE TABLE mobility.places (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     UUID REFERENCES mobility.places(id) ON DELETE SET NULL,
  name          TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  category      TEXT NOT NULL CHECK (category IN ('building_entrance', 'destination', 'facility', 'landmark', 'parking', 'bus_stop', 'other')),
  description   TEXT,
  building_id   TEXT,
  level_id      TEXT,
  vertical_datum TEXT NOT NULL DEFAULT 'KVD_INCHEON_MSL' CHECK (vertical_datum = 'KVD_INCHEON_MSL'),
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'RETIRED')),
  revision      INTEGER NOT NULL DEFAULT 1,
  geom          geometry(PointZ, 5186) NOT NULL,
  created_by    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX places_geom_idx ON mobility.places USING GIST (geom);
CREATE INDEX places_category_idx ON mobility.places (category, status);

-- Short-lived exclusive feature lease. A browser tab has its own editor session UUID.
CREATE TABLE mobility.editor_leases (
  object_type  TEXT NOT NULL CHECK (object_type IN ('road', 'place')),
  object_id    UUID NOT NULL,
  owner_code   TEXT NOT NULL REFERENCES collectors(collector_code) ON DELETE CASCADE,
  session_id   UUID NOT NULL,
  lease_token  UUID NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id)
);
CREATE INDEX editor_leases_expiry_idx ON mobility.editor_leases (expires_at);

-- Durable committed change log/outbox. Draft cursor/geometry previews are ephemeral Socket.IO events.
CREATE TABLE mobility.editor_changes (
  id             BIGSERIAL PRIMARY KEY,
  change_set_id  UUID NOT NULL,
  object_type    TEXT NOT NULL CHECK (object_type IN ('road', 'place', 'node')),
  object_id      UUID NOT NULL,
  operation      TEXT NOT NULL CHECK (operation IN ('created', 'updated', 'replaced', 'deleted')),
  revision       INTEGER,
  owner_code     TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ
);
CREATE INDEX editor_changes_pending_idx ON mobility.editor_changes (id) WHERE delivered_at IS NULL;
CREATE INDEX editor_changes_object_idx ON mobility.editor_changes (object_type, object_id, id DESC);

CREATE TABLE mobility.editor_mutations (
  mutation_id  UUID PRIMARY KEY,
  owner_code   TEXT NOT NULL,
  result       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
