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

`AppGraph` (in `CampusTrackerApplication.kt`) owns the singletons: collection runs on one `HandlerThread`, the upload
queue and the socket each on their own single thread, so Activity recreation never interrupts collection or upload.

## Deliberate differences from the iOS code

Default motion rate 50 Hz; automatic re-login on token/device rejection; non-retryable failures are quarantined
instead of retried forever; strictly one in-flight request; markers without a fix are held until the first fix;
queued sessions keep their collector/server owner; "Finish as Interrupted" also sends `session:finish` with
`interrupted: true`; resumed sequences skip ahead by 1000; empty streams report `lastSequences = -1`; Start requires the
location permission; local files keep millisecond timestamps; the login `webSocketURL` is persisted. No HealthKit
stride equivalent is sent (`strideCalibration` is always omitted).

`PREFER_GAME_ROTATION_VECTOR` in `sensors/AndroidSensors.kt` switches the attitude source to the magnetometer-free
game rotation vector if indoor tests show ROTATION_VECTOR yaw jumps.
