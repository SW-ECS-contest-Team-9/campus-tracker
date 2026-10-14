# Walking frame server integration contract

Status: iOS schema preparation only. The iOS app keeps the legacy motion wire payload by default,
so this work does not change the server's XY path or replace its yaw input.

## Coordinates, units, and semantics

- Core Motion `userAcceleration` and `gravity` remain in g. `rotationRate` remains rad/s.
- `attitude.quaternion` is Core Motion's fused attitude quaternion `{x,y,z,w}` for the session's
  fixed `CMAttitudeReferenceFrame`; it is not an independent heading truth.
- `magneticField` is `CMDeviceMotion.magneticField`: calibrated Core Motion output in µT, source
  `CORE_MOTION_CALIBRATED`, with `UNCALIBRATED|LOW|MEDIUM|HIGH` calibration accuracy. It is not raw
  magnetometer data and an out-of-range magnitude is diagnostic evidence, not proof of interference.
- The estimator reference is `GYRO_GRAVITY_RELATIVE`. Its yaw origin is arbitrary. Its quaternion
  maps device-coordinate vectors into that reference using a right-handed active rotation.
- `axisDevice` is a normalized horizontal PCA axis in device coordinates at `estimatedAt`.
  `axisDevice` and its negation are equivalent while `directionResolved=false`; `AXIS_180` must not
  be discarded. It expires at `expiresAt` and must not be carried across `frameId` changes.
- Sensor timestamps are monotonic seconds since boot. iOS also supplies ISO wall-clock
  `estimatedAt/windowStart/windowEnd/expiresAt`, mapped with the same boot-time conversion as the
  owning motion sample.
- Confidence is a bounded internal quality score, not a probability or angular accuracy.

Proposed optional motion extension (illustrative numbers only):

```json
{
  "attitude": {
    "roll": 0.0, "pitch": 0.0, "yaw": 0.0,
    "quaternion": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 }
  },
  "magneticField": {
    "x": 0.0, "y": 0.0, "z": 0.0,
    "unit": "uT", "source": "CORE_MOTION_CALIBRATED", "accuracy": "HIGH"
  },
  "walkingFrame": {
    "schemaVersion": 1,
    "algorithmVersion": "gravity_gyro_pca_v1",
    "frameId": "UUID",
    "reference": "GYRO_GRAVITY_RELATIVE",
    "estimatedAt": "ISO_TIMESTAMP",
    "windowStart": "ISO_TIMESTAMP",
    "windowEnd": "ISO_TIMESTAMP",
    "expiresAt": "ISO_TIMESTAMP",
    "status": "AXIS_ESTIMATED",
    "axisDevice": { "x": 1.0, "y": 0.0, "z": 0.0 },
    "directionResolved": false,
    "ambiguity": "AXIS_180",
    "confidence": 0.6,
    "eigenvalueRatio": 3.0,
    "horizontalEnergyG2": 0.01,
    "periodicity": 0.4,
    "sampleCount": 125
  }
}
```

Only estimator update samples contain `walkingFrame`; it is not repeated at 50 Hz. All fields are
optional for old queued batches and old app versions. Non-finite numeric values must be rejected.

## Required server work

- Extend `backend/src/modules/telemetry/telemetry.dto.ts` MotionSample with optional quaternion,
  calibrated magnetic-field provenance/accuracy, and walking-frame v1 fields.
- Add DB columns or a versioned JSON record and migration while retaining original motion values.
- Preserve the extension in batch ingestion, raw loader, session timeline, export, and diagnostics.
- Feed identical structures to real-time and Replay fusion; add mixed old/new client fixtures.
- Update θ(t) using time-valid walking-frame snapshots without replacing raw yaw. Track both axis
  signs until an independently quality-gated direction anchor resolves them. Permit actual U-turns.
- Gate GPS-course anchors on speed, courseAccuracy, horizontalAccuracy, and sustained distance.
- Compare baseline and experiment sessions by carry mode, reference frame, ambiguity state,
  magnetic quality, raw sample count, and ground truth. A visually improved map alone is not proof.
- Keep legacy `-yaw + θ` behavior when the optional extension is absent or invalid.
