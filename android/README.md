# CampusTracker Android collector

Kotlin / Jetpack Compose port of the iOS collector (`ios/Untitled Project/CampusTracker/`). Same server, same
contract (`docs/API_CONTRACT.md`): it streams raw sensor data whose units and signs match CoreMotion/CoreLocation, so the
server's fusion treats it like iPhone data.

## Build

Android Studio (or a JDK 17+ and the Android SDK with platform 37):

```
./gradlew :app:assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest      # JVM unit tests (Robolectric for the Room queue)
./gradlew :app:lintDebug
```

Opt-in end-to-end test against a **local** development backend (`npm run dev` at the repo root, collector seeded):

```
CT_SERVER_HOST=127.0.0.1 CT_COLLECTOR=C02 ./gradlew :app:testDebugUnitTest --tests '*ServerIntegrationTest*'
```

## Layout (`app/src/main/java/hoshi/campustracker/`)

| Package | Contents | iOS counterpart |
|---|---|---|
| `core/` | one collector clock, ISO-8601 ms formatting, JSON config, log facade | `bootTime`, encoders |
| `model/` | session, capabilities, sampling enums, marker types | `Models/SensorModels.swift` |
| `sensors/` | CoreMotion conversion (`MotionMath`), 4-sensor bundling (`MotionAssembler`), 1 s barometer windows, step-counter cumulative tracker, Android sensor/location sources | `Services/SensorServices.swift` |
| `collection/` | `CollectionCoordinator` (start/stop/resume, sequences, segments, diagnostics), foreground `CollectionService`, app-state tracker | `Services/CollectionCoordinator.swift` 1–552 |
| `sync/` | wire DTOs, Room upload queue, `TelemetrySyncCoordinator` (one request at a time, ACK handling, quarantine) | `CollectionCoordinator.swift` 554–1288 |
| `net/` | server configuration, REST login/health, raw `/ws/collector` WebSocket | `Networking/ServerNetworking.swift` |
| `auth/` | settings (DataStore), Keystore-encrypted token, login + automatic re-login | `Authentication/Authentication.swift` |
| `persistence/` | per-session NDJSON files, `active_collection.json` for crash recovery | `Persistence/*` |
| `ui/` | Compose screens: Server Setup, Collect, Sessions, Settings | `ContentView.swift` |

Declared route (1.2): before Start the collector can plan the route (start, via points, end; each leg walk, 계단 상행/하행
or 승강기 n층→m층) or pick a saved one (`saved_routes.json`, this phone only). Start then uses the first point as the
start anchor and sends the route as `session:start.declaredRoute`; while recording, "Reached next" records a
`routeWaypoint` marker on the next node (any marker on that node also counts) and "여기서 벗어남" a `routeDeviation`
marker. `model/DeclaredRoute.kt`, `ui/RouteScreen.kt`. iOS: not implemented, contract only (`docs/API_CONTRACT.md`).

`AppGraph` (in `CampusTrackerApplication.kt`) owns the singletons: collection runs on one `HandlerThread`, the upload
queue and the socket each on their own single thread, so Activity recreation never interrupts collection or upload.

## Deliberate differences from the iOS code

Default motion rate 50 Hz; automatic re-login on token/device rejection; non-retryable failures are quarantined
instead of retried forever; strictly one in-flight request; markers without a fix are held until the first fix;
queued sessions keep their collector/server owner; "Finish as Interrupted" also sends `session:finish` with
`interrupted: true`; resumed sequences skip ahead by 1000; empty streams report `lastSequences = -1`; Start requires the
location permission; local files keep millisecond timestamps; the login `webSocketURL` is persisted. No HealthKit
stride equivalent is sent (`strideCalibration` is always omitted).

Not ported from iOS (no Android equivalent, or not on the wire):

- `absoluteAltitude` / `absoluteAltitudeV1`: iOS `CMAbsoluteAltitudeData` (`APPLE_MSL`) has no Android sensor. Android
  sends the GPS heights only (`ellipsoidalAltitude` = `Location.getAltitude()`, `altitude` = AltitudeConverter MSL on
  API 34+), never a fake absolute stream; `sensorCapabilities.absoluteAltitudeEnabled` stays absent, so fusion keeps
  the GPS height policy (`docs/ABSOLUTE_ALTITUDE_SERVER.md`). The iOS absolute-altitude clock repair has no Android
  counterpart either.
- ARKit poses and the walking-frame (PCA) estimator: no stream on Android; the server DTO does not take walking-frame
  fields yet.
- iOS SQLite ledger, sequence lease and per-session sync-state UI: Android keeps the Room queue and the +1000 resume
  gap; the `session:syncComplete` answer is stored per queued session and logged as a diagnostic, not shown per session.

Ported from the 2026-10-14 iOS reliability work (`docs/IOS_TRACKING_CORRECTION_PLAN_20261014.md`):
`session:syncComplete` after the finish ACK once nothing of the session is left (queue schema 2); the sensor clock
offset is the smallest `now − event` over the first 25 motion events (a late first callback is reported as
`CLOCK_MAPPING_UNCERTAIN`, not adopted); callbacks of an earlier sensor run are dropped; `SENSOR_CALLBACK_STALLED`
(motion 2 s, barometer 5 s); the recovery file is removed only after the last batch and the finish are queued.

`PREFER_GAME_ROTATION_VECTOR` in `sensors/AndroidSensors.kt` switches the attitude source to the magnetometer-free
game rotation vector if indoor tests show ROTATION_VECTOR yaw jumps.
