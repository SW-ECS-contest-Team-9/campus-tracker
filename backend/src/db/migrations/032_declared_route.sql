-- Declared route (사용자 지정 길): the path the collector said they would walk, sent on session:start before walking it.
-- Ground truth for the session, stored as sent after validation ({ nodeKeys, segments, text }); NULL = none declared.
-- An invalid route never blocks a session: it is dropped and the reason kept in declared_route_status / _reason.
ALTER TABLE collection_sessions
  ADD COLUMN declared_route JSONB,
  ADD COLUMN declared_route_status TEXT NOT NULL DEFAULT 'NONE' CHECK (declared_route_status IN ('NONE', 'ACCEPTED', 'REJECTED')),
  ADD COLUMN declared_route_reason TEXT;
