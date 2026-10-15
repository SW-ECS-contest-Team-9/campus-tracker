-- Collection anchors (docs/API_CONTRACT.md "기준점"): a marker can say where the collector really was.
-- All columns are optional so markers of older apps keep being accepted unchanged.
ALTER TABLE event_markers
  ADD COLUMN node_id     UUID,          -- mobility.network_nodes id (no FK: nodes are merged/deleted by the editor)
  ADD COLUMN building_id TEXT,          -- campus_buildings.building_id, or 'outdoor'
  ADD COLUMN floor       VARCHAR(4) CHECK (floor ~ '^(B[1-9]|[1-9][0-9]?F)$'),
  ADD COLUMN direction   VARCHAR(4) CHECK (direction IN ('up', 'down')),
  ADD COLUMN from_floor  VARCHAR(4) CHECK (from_floor ~ '^(B[1-9]|[1-9][0-9]?F)$'),
  ADD COLUMN to_floor    VARCHAR(4) CHECK (to_floor ~ '^(B[1-9]|[1-9][0-9]?F)$'),
  -- the node as it was when the marker arrived (MSL height): fusion uses it when the node is later deleted
  ADD COLUMN node_geom   geometry(PointZ, 5186);
CREATE INDEX event_markers_node_idx ON event_markers (session_id) WHERE node_id IS NOT NULL;
