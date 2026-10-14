# Absolute altitude server contract

The iOS collector stores absolute-altitude observations locally regardless of server support. It sends them only when the latest `session:start` acknowledgement contains `absoluteAltitudeV1` in `supportedTelemetryFeatures`.

## Session start acknowledgement

```json
{
  "sessionId": "server-session-id",
  "supportedTelemetryFeatures": ["absoluteAltitudeV1"]
}
```

An absent array or absent feature means “do not transmit.” Existing telemetry streams continue to upload. The client keeps the absolute-altitude raw rows unbatched and forces a new session handshake after restart while held rows remain.

## Telemetry batch

`telemetry:batch.payload` may contain this optional array:

```json
{
  "absoluteAltitude": [{
    "sequence": 1,
    "timestamp": "2026-10-14T10:57:55.123Z",
    "altitude": 150.2,
    "accuracy": 4.8,
    "precision": 0.5,
    "verticalReference": "APPLE_MSL",
    "sensorSegmentId": "uuid",
    "captureSource": "LIVE",
    "appState": "FOREGROUND",
    "invalidReason": null
  }]
}
```

`altitude`, `accuracy`, and `precision` are nullable because iOS preserves the observation and records `invalidReason` when Core Motion supplies a value that JSON cannot represent. Negative finite altitude is valid. `accuracy` is the estimated one-standard-deviation uncertainty; `precision` is display resolution and must not be treated as accuracy.

The stream is independent from relative `altimeter` samples. The server must deduplicate by `(session_id, sequence)` and must not copy the latest absolute observation into relative-altitude rows.

## Completion and persistence

`lastSequences.absoluteAltitude` is the last locally preserved sequence (`-1` when empty). A server that advertises the feature must include this stream in finish/synchronization validation. The client does not allow a session with held absolute-altitude rows to advance to `session:finish`/`session:syncComplete`; after support is confirmed it creates durable batches from those rows and resumes the normal ledger.

The server needs a raw table containing at least session, sequence, timestamp, altitude, accuracy, precision, vertical reference, sensor segment ID, capture source, app state, invalid reason, and creation time. Server database, fusion, and web changes are intentionally outside this iOS change.
