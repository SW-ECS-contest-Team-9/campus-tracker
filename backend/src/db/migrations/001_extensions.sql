-- PostGIS is required for geometry(PointZ, 4326) columns and GIST indexes.
-- gen_random_uuid() is built into PostgreSQL 13+, no pgcrypto needed.
CREATE EXTENSION IF NOT EXISTS postgis;
