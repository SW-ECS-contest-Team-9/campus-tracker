-- QR anchors are independent of the routing graph. Historical markers retain node_geom on deletion.
CREATE TABLE mobility.qr_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  building_id VARCHAR(24) NOT NULL,
  floor VARCHAR(4) CHECK (floor ~ '^(B[1-9]|[1-9][0-9]?F)$'),
  geom geometry(PointZ, 5186) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
