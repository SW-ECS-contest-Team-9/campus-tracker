CREATE TABLE devices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id     UUID NOT NULL REFERENCES collectors(id),
  client_device_id VARCHAR(128) NOT NULL,       -- iOS identifierForVendor
  platform         VARCHAR(32),
  device_model     VARCHAR(64),
  system_version   VARCHAR(32),
  app_version      VARCHAR(32),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (collector_id, client_device_id)
);
