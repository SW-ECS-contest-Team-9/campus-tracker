-- Road display colour shared by every editor and MCP agent (purely visual: routing and QA ignore it).
-- NULL = no override; the editor then colours by floor or road class.
ALTER TABLE mobility.road_segments
  ADD COLUMN IF NOT EXISTS display_color TEXT
  CONSTRAINT road_segments_display_color_check CHECK (display_color IS NULL OR display_color ~ '^#[0-9a-f]{6}$');
