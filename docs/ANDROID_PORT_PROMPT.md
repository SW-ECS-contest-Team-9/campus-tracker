# Android 포팅 프롬프트: CampusTracker 수집 앱 (iOS → Android)

구분선 아래 전체를 Android 코딩 에이전트에 전달한다. 목표는 iOS 앱(`ios/Untitled Project/CampusTracker/`)과 같은 동작을 하는 Android 앱을 실제로 만들고 빌드·검증하는 것이다. 서버는 바꾸지 않는다.

작성일 2026-10-07. 근거: iOS 작업 트리(Health 보폭 포함, 미커밋 상태), 서버 DTO(`backend/src/modules/*/*.dto.ts`)와 `fusion-v4.engine.ts`, 기존 iOS 프롬프트 4개(`docs/IOS_*_PROMPT.md`), 로컬 DB의 실제 iPhone 세션.

전달 전에 볼 것:

- **§12는 iOS 코드와 일부러 다르게 만드는 항목이다.** 원하지 않는 항목은 지우고 전달한다.
- **§11: 건강 앱 보폭 보정은 이번 범위에서 뺐다.** Android에 대응 지표가 없고 서버가 Apple 출처만 받는다.
- §4.2의 변환식: iPhone 쪽 규약(중력·자세·yaw·가속도 부호)은 실제 iPhone 세션으로 확인했다(수치는 §15.4). Android 쪽은 그 규약과 Android 센서 정의에서 유도한 식이고 **Android 실기기에서는 아직 확인하지 않았다.** §15.3과 §15.4가 그 확인 절차다.
- 프로젝트 위치(`android/`), applicationId, minSdk는 §2의 기본값을 바꿔도 된다.

---

CampusTracker iPhone 센서 수집 앱을 Android(Kotlin)로 포팅해줘. 같은 서버에 같은 계약으로 붙어서, 서버의 위치 추정(fusion)이 iPhone 데이터와 구분 없이 처리할 수 있는 원시 센서 스트림을 보내는 앱이다. 화면, 흐름, 주기, 큐 규칙은 iOS와 같게 만든다. 플랫폼 차이로 달라지는 부분은 이 문서가 정한 대로 한다.

## 0. 작업 규칙

- 새 Android Studio 프로젝트를 저장소 루트의 `android/`에 만든다(`ios/`와 나란히). `android/` 밖의 파일은 수정하지 않는다. 서버(`backend/`)와 iOS 코드는 읽기만 한다.
- 이 저장소는 여러 에이전트가 동시에 수정한다. `git stash`, `git reset`, `git checkout -- <path>`처럼 작업 트리 전체를 바꾸는 명령을 쓰지 않는다. 커밋은 사용자가 요청할 때만 한다. Android용 ignore 규칙은 `android/.gitignore`에 둔다.
- 순서: 아래 "먼저 읽을 것"을 읽는다 → 구현 계획을 짧게 요약한다 → 구현한다 → 빌드와 테스트를 돌린다 → §16대로 보고한다.
- 이 문서의 API 이름·권한·availability는 설치된 SDK와 공식 문서로 확인한다. 다르면 SDK를 따르고 보고에 적는다.
- 주기, 임계값, 변환식, JSON 필드 이름은 서버와의 계약이다. 임의로 바꾸지 않는다. 바꿔야 하면 이유를 보고한다.
- 서버 API는 바꿀 수 없다. 서버가 받지 않는 필드를 새로 만들지 않는다(`sensorCapabilities`와 진단 이벤트 `metadata`만 자유 형식이다).

## 1. 먼저 읽을 것

가능하면 아래 파일을 직접 읽는다. 접근할 수 없어도 이 문서만으로 구현할 수 있게 썼다.

| iOS 원본 (`ios/Untitled Project/CampusTracker/`) | 내용 | Android 대응 |
|---|---|---|
| `Models/SensorModels.swift` | 세션·샘플·마커 모델, 설정 enum | `model/` 데이터 클래스 |
| `Services/SensorServices.swift` | 위치·모션·기압·보수계 래퍼, 센서 능력 탐지, 기기 정보 | `sensors/` |
| `Services/CollectionCoordinator.swift` 1~552행 | 세션 시작·종료·복구, 샘플 생성, sequence, segment ID, 진단 | `collection/CollectionCoordinator` + `CollectionService`(포그라운드 서비스) |
| `Services/CollectionCoordinator.swift` 554~1288행 | 전송 DTO, 영속 업로드 큐, ACK 처리(`TelemetrySyncCoordinator`) | `sync/` |
| `Networking/ServerNetworking.swift` | 서버 설정 검증, HTTP 오류 매핑, WebSocket 연결·재연결 | `net/` |
| `Authentication/Authentication.swift` | 로그인, 토큰 저장, 인증 상태 | `auth/` |
| `Persistence/SensorDataRepository.swift` | 세션별 NDJSON 로컬 저장 | `persistence/` |
| `Persistence/ActiveCollectionStore.swift` | 진행 중 세션 상태(중단 복구용), 공백 통계 | `persistence/` |
| `ContentView.swift` | 화면 전체 | `ui/` (Compose) |
| `Health/HealthStrideService.swift` | 건강 앱 보폭 | 포팅하지 않음(§11) |
| `CampusTrackerTests/CampusTrackerTests.swift` | 테스트 방식 참고 | `src/test/` |

서버 쪽 참고: `docs/API_CONTRACT.md`(계약), `backend/src/common/dto.ts`·`backend/src/modules/telemetry/telemetry.dto.ts`·`backend/src/modules/sessions/session.dto.ts`·`backend/src/modules/markers/marker.dto.ts`(검증 규칙의 원본), `backend/scripts/check-raw-ws.ts`(같은 프로토콜을 쓰는 참조 클라이언트), `backend/src/modules/fusion/fusion-v4.engine.ts`의 `applyMotion`(서버가 모션 값을 쓰는 방식).

## 2. 프로젝트 구성

- Kotlin, Jetpack Compose(Material 3), 단일 Activity. minSdk 26, compile/target은 설치된 최신 안정 버전.
- applicationId `hoshi.campustracker`(iOS 번들 ID `hoshi.CampusTracker`에 맞춤), versionName `1.0`.
- 라이브러리: kotlinx-coroutines, kotlinx-serialization-json, OkHttp(REST와 WebSocket), Room(업로드 큐), DataStore(설정), play-services-location, androidx.lifecycle:lifecycle-process. 버전은 최신 안정 버전을 확인해 쓴다. 이 밖의 의존성은 꼭 필요할 때만 추가하고 보고한다.
- `CollectionCoordinator`, 업로드 동기화, WebSocket 연결은 Activity나 ViewModel이 아니라 **Application 범위 싱글턴**이다. Activity가 재생성돼도 수집과 업로드가 이어져야 한다.

Manifest:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<!-- 기압계·걸음 센서가 없는 기기에도 설치되게 한다 -->
<uses-feature android:name="android.hardware.sensor.barometer" android:required="false" />
<uses-feature android:name="android.hardware.sensor.stepcounter" android:required="false" />
<uses-feature android:name="android.hardware.sensor.gyroscope" android:required="false" />

<service android:name=".collection.CollectionService"
         android:exported="false"
         android:foregroundServiceType="location" />
```

- `ACCESS_BACKGROUND_LOCATION`, `BODY_SENSORS`, `HIGH_SAMPLING_RATE_SENSORS`, Health Connect 권한은 선언하지 않는다.
- 개발 서버가 HTTP(Tailscale `100.x` 또는 LAN IP)이고 주소를 사용자가 입력하므로 평문 통신을 허용한다: `android:networkSecurityConfig`에서 `cleartextTrafficPermitted="true"`. iOS는 ATS 예외로 같은 일을 한다.
- `android:allowBackup="false"`. 기기 ID, 토큰, 업로드 큐가 다른 기기로 복원되면 안 된다.

## 3. 서버 계약 (변경 금지)

### 3.1 공통 규칙

| 항목 | 규칙 |
|---|---|
| 시각 | ISO-8601 UTC 문자열, 밀리초 3자리 고정. 예: `2026-10-07T06:00:00.123Z`. epoch 숫자는 거부된다. 센서 시각이 2020-01-01 이전이거나 서버 시각보다 하루 넘게 미래면 그 메시지 전체가 `VALIDATION_ERROR`로 거부된다 |
| UUID | `8-4-4-4-12` hex. 대소문자 무관 |
| null | 선택 필드는 생략하거나 null. `Json { explicitNulls = false }`로 생략한다 |
| NaN·무한대 | JSON에 실을 수 없다. 전송 DTO를 만들 때 유한하지 않은 Double을 null로 바꾼다. 인코딩 실패를 `runCatching`이나 빈 `catch`로 삼키지 않고 로그로 남긴다 |
| 정수 | `sequence`, 걸음 수, 카운트는 JSON 정수(`1.0` 금지) |
| 모르는 필드 | 서버는 무시한다. 앱도 응답의 모르는 필드를 무시한다(`ignoreUnknownKeys = true`) |
| 길이 상한 | deviceId 128, platform 32, deviceModel 64, systemVersion 32, appVersion 32, collectorId 32, sensorSegmentId 64, appState 16, captureSource 24, 마커 type 32, 마커 note 2000, eventType 48. deviceModel처럼 넘을 수 있는 값은 잘라서 보낸다 |
| 크기 상한 | 메시지 10 MB, batch의 배열당 20,000개 |
| 필수 숫자 | 위치 샘플과 마커의 `latitude`(−90~90), `longitude`(−180~180)는 null일 수 없다 |

### 3.2 REST

- `GET {base}/health` → 200 `{ "status": "ok", "database": "ok" }`. 타임아웃 5초. "Test Connection" 버튼이 쓴다.
- `POST {base}/api/v1/collectors/login`, `Content-Type: application/json`, 타임아웃 8초.

```json
{ "collectorId": "C03", "deviceId": "<앱이 만든 기기 ID 문자열>", "platform": "android",
  "deviceModel": "samsung SM-S918N", "systemVersion": "14", "appVersion": "1.0" }
```

성공 200:

```json
{ "collectorId": "C03", "accessToken": "<JWT, 기본 만료 24h>",
  "socketUrl": "http://100.93.21.92:3000", "socketNamespace": "/collector",
  "webSocketURL": "ws://100.93.21.92:3000/ws/collector" }
```

- 앱은 `collectorId`(서버가 trim·대문자화한 값), `accessToken`, `webSocketURL`만 쓴다. Socket.IO(`socketUrl`)는 쓰지 않는다.
- 오류 본문은 `{ "error": { "code", "message", "details" } }`. 미등록 ID는 404 `COLLECTOR_NOT_FOUND`, 형식 오류는 400 `VALIDATION_ERROR`.
- 서버는 `platform` 값으로 분기하지 않는다. `"android"`를 보낸다.
- HTTP 상태별 사용자 메시지는 iOS와 같게 한다: 400 "The server rejected the request." / 401 "Collector authentication failed." / 404 "The collector or server endpoint was not found." / 409 "The server reported a collector conflict." / 5xx "The server could not complete the request." / 연결 불가 "Cannot connect to the server. Check the address, port, Wi-Fi, and server status." / 타임아웃 "The request timed out. Check the server connection." / 본문 해석 실패 "The server returned an unreadable response."

### 3.3 WebSocket `/ws/collector`

표준 WebSocket(RFC 6455)이다. Socket.IO 프로토콜이 아니다. OkHttp `WebSocket`을 쓴다.

- URL: 로그인 응답의 `webSocketURL`. 저장된 값이 없을 때만 설정에서 `ws(s)://host:port/ws/collector`를 만든다.
- 업그레이드 요청 헤더(필수): `Authorization: Bearer <accessToken>`, `X-Device-ID: <deviceId>`. deviceId는 로그인에 쓴 문자열과 **글자 그대로** 같아야 한다(서버가 대소문자를 구분해 비교한다).
- 거부되면 업그레이드 대신 HTTP 응답과 `{ "error": { "code", "message" } }`가 온다. OkHttp에서는 `onFailure(webSocket, t, response)`의 `response`로 받는다.

| status | code | 앱의 조치 |
|---|---|---|
| 401 | `TOKEN_REQUIRED`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | 자동 재로그인(§8.3) |
| 403 | `DEVICE_MISMATCH` | 자동 재로그인 |
| 404 | `DEVICE_NOT_FOUND` | 자동 재로그인. 로그인이 404면 "등록되지 않은 Collector ID" |
| 404 | `WS_PATH_NOT_FOUND` | 설정 오류. 재시도하지 않고 failed 상태 |

- 서버가 15초마다 ping을 보내고 응답 없는 연결을 끊는다. OkHttp가 pong을 자동으로 보낸다.
- 서버가 Collector ID를 삭제하면 close code `4004`로 닫는다. `DEVICE_NOT_FOUND`와 같게 처리한다.
- **연결이 끊겨도 수집 세션은 끝나지 않는다.** 수집과 업로드는 서로 독립이다.

요청(UTF-8 JSON text frame):

```json
{ "requestId": "<요청마다 새 UUID>", "type": "telemetry:batch", "payload": { } }
```

`type`: `session:start`, `telemetry:batch`, `marker:create`, `collector:status`, `session:finish`, `diagnostic:event`.

응답:

```json
{ "type": "ack", "requestId": "<같은 UUID>", "ok": true, "data": { } }
{ "type": "ack", "requestId": "<같은 UUID>", "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "...", "status": 400, "retryable": false, "details": {} } }
```

- ACK는 DB COMMIT 뒤에만 온다. `ok: true`를 받은 뒤에만 큐에서 지운다.
- `session:start`의 서버 세션 ID는 `data.sessionId`에 있다(최상위가 아니다).
- ACK 전에 끊기거나 10초 안에 ACK가 없으면 저장 여부를 모른다. **같은 batchId, markerId, clientSessionId, eventId로 다시 보낸다.** 서버가 중복을 제거하고 `duplicate: true`를 돌려준다.
- `requestId`가 null인 ACK(서버가 메시지를 해석하지 못함)와 ACK가 아닌 메시지는 로그만 남기고 무시한다.

### 3.4 이벤트별 payload

**`session:start`**

```json
{ "clientSessionId": "<로컬 세션 UUID>", "deviceId": "<기기 ID>", "platform": "android",
  "deviceModel": "samsung SM-S918N", "systemVersion": "14", "appVersion": "1.0",
  "sensorCapabilities": { },
  "startedAt": "2026-10-07T06:00:00.000Z" }
```

- `sensorCapabilities`는 §4.5의 객체다. `startedAt`은 사용자가 Start를 누른 시각이며 재전송해도 바뀌지 않는다.
- 같은 `clientSessionId`를 다시 보내면 서버는 새 세션을 만들지 않고 기존 세션을 돌려준다(`resumed: true`). **새 `clientSessionId`는 사용자가 Start를 누를 때만 만든다.** 새 ID로 시작하면 서버는 같은 기기의 다른 ACTIVE 세션을 `INTERRUPTED`로 바꾼다.
- ACK `data`: `{ sessionId, clientSessionId, startedAt, status, collectionState, resumed, strideCalibration: { status, reason } }`. 앱은 `sessionId`만 필요하다. `sessionId`가 없으면 실패로 처리한다.
- 오류: `DEVICE_MISMATCH`(403), `SESSION_CONFLICT`(409, 다른 collector가 쓴 clientSessionId).

**`telemetry:batch`**

```json
{
  "batchId": "<UUID>", "sessionId": "<서버 세션 UUID>", "clientSessionId": "<로컬 세션 UUID>",
  "createdAt": "2026-10-07T06:00:01.000Z",
  "locations": [{
    "sequence": 12, "timestamp": "2026-10-07T06:00:00.412Z", "latitude": 37.6105, "longitude": 127.0102,
    "altitude": 82.4, "ellipsoidalAltitude": 105.0, "horizontalAccuracy": 4.8, "verticalAccuracy": 3.1,
    "speed": 1.3, "course": 271.0, "speedAccuracy": 0.4, "courseAccuracy": 12.0,
    "appState": "FOREGROUND", "sensorSegmentId": "<UUID>" }],
  "motion": [{
    "sequence": 600, "timestamp": "2026-10-07T06:00:00.420Z",
    "userAcceleration": { "x": 0.012, "y": -0.031, "z": 0.094 },
    "rotationRate": { "x": 0.10, "y": -0.02, "z": 0.31 },
    "gravity": { "x": 0.05, "y": -0.86, "z": -0.50 },
    "attitude": { "roll": 0.10, "pitch": 1.04, "yaw": -1.92 },
    "appState": "FOREGROUND", "sensorSegmentId": "<UUID>" }],
  "altimeter": [{ "sequence": 12, "timestamp": "2026-10-07T06:00:00.500Z",
    "relativeAltitude": 0.37, "pressure": 100.29, "appState": "FOREGROUND", "sensorSegmentId": "<UUID>" }],
  "pedometer": [{ "sequence": 5, "timestamp": "2026-10-07T06:00:00.180Z", "captureSource": "LIVE",
    "numberOfSteps": 42, "appState": "FOREGROUND", "sensorSegmentId": "<UUID>" }]
}
```

- 네 배열 모두 선택이며 빈 배열도 된다.
- 서버 중복 제거 키: 위치·모션·기압은 `(세션, sequence)`, 보수계는 `(세션, timestamp)`. 같은 키의 샘플은 조용히 버려진다.
- 서버는 세션 상태와 무관하게 batch를 받는다. `session:finish` 뒤에 도착하는 batch도 저장된다.
- ACK `data`: `{ batchId, receivedAt, duplicate }`.
- 오류: `SESSION_NOT_FOUND`(404), `SESSION_FORBIDDEN`(403), `CLIENT_SESSION_MISMATCH`(400), `BATCH_SESSION_CONFLICT`(409), `VALIDATION_ERROR`(400).

**`marker:create`**

```json
{ "markerId": "<UUID>", "sessionId": "<서버 세션 UUID>", "clientSessionId": "<로컬 세션 UUID>",
  "timestamp": "2026-10-07T06:03:10.250Z", "type": "stairStart",
  "latitude": 37.6105, "longitude": 127.0102, "altitude": 82.4, "ellipsoidalAltitude": 105.0,
  "horizontalAccuracy": 4.8, "verticalAccuracy": 3.1 }
```

- `type`: `entrance`, `intersection`, `stairStart`, `stairEnd`, `rampStart`, `rampEnd`, `elevator`, `stop`, `custom`(이 철자 그대로). `note`는 UI에서 입력받지 않으므로 생략한다.
- ACK `data`: `{ markerId, duplicate }`.

**`collector:status`** (저장되지 않고 Preview 표시에만 쓰인다)

```json
{ "sessionId": "<서버 세션 UUID>", "collecting": true,
  "locationSampleCount": 421, "motionSampleCount": 8302, "pendingBatchCount": 2 }
```

**`session:finish`**

```json
{ "clientSessionId": "<로컬 세션 UUID>", "sessionId": "<서버 세션 UUID>", "endedAt": "2026-10-07T06:20:00.000Z",
  "lastSequences": { "location": 1180, "motion": 60012, "altimeter": 1124, "pedometer": 310 } }
```

- `lastSequences`는 스트림별로 마지막에 쓴 sequence다. 서버는 이 값으로 "원시 데이터가 다 도착했는지"를 판단해 최종 재계산을 시작한다. **샘플이 하나도 없는 스트림은 `-1`을 보낸다.**
- 중단된 세션을 끝낼 때는 `"interrupted": true`를 추가한다(§5.5).
- 이미 끝난 세션에 다시 보내도 성공한다.

**`diagnostic:event`**

```json
{ "clientSessionId": "<로컬 세션 UUID>",
  "events": [{ "eventId": "<UUID>", "eventType": "SENSOR_STARTED", "clientTimestamp": "2026-10-07T06:00:00.050Z",
               "metadata": { "sensor": "motion", "sensorSegmentId": "<UUID>" } }] }
```

- 메시지 하나에 이벤트 하나를 보낸다. `eventId`로 중복이 제거된다. 퓨전 입력이 아니라 공백과 재시작의 원인을 확인하는 용도다.

## 4. 센서 수집: iPhone과 같은 의미·단위·부호로 보낸다 (가장 중요)

서버 fusion은 iPhone(CoreLocation, CoreMotion) 값의 단위와 부호를 전제로 만들어졌다. 예를 들어 걸음 검출은 `-(userAcceleration · gravity) / |gravity|`를 g 단위 임계값 0.08과 비교한다. Android 센서 값을 그대로 보내면 걸음 수가 틀리고 방향이 뒤집힌다. 아래 변환을 정확히 적용한다.

### 4.0 공통

**시계.** 모든 샘플, 마커, 진단 이벤트, `startedAt`, `endedAt`이 같은 시계를 쓴다. iOS의 `bootTime + motion.timestamp`와 같은 방식이다.

```kotlin
// 프로세스 시작 때 한 번 계산해 그 프로세스 동안 고정한다.
val bootEpochMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
fun epochMs(elapsedRealtimeNanos: Long) = bootEpochMs + elapsedRealtimeNanos / 1_000_000
fun nowMs() = bootEpochMs + SystemClock.elapsedRealtime()
```

- 센서 샘플 시각은 콜백을 받은 시각이 아니라 측정 시각이다: `SensorEvent.timestamp`, `Location.getElapsedRealtimeNanos()`.
- 일부 기기는 `SensorEvent.timestamp`가 `elapsedRealtimeNanos` 기준이 아니다. 모션의 첫 이벤트에서 `SystemClock.elapsedRealtimeNanos() - event.timestamp`가 0~2초를 벗어나면 그 차이를 고정 오프셋으로 삼아 그 실행의 모든 센서 이벤트에 더하고, 진단 이벤트 `SENSOR_CLOCK_OFFSET`(metadata: offsetMs)을 남긴다.

**sequence.** 위치·모션·기압·보수계가 각각 따로 가진다. 세션 안에서 단조 증가하고, 첫 샘플이 1이다(증가시킨 뒤 사용). 센서를 재시작해도 0으로 돌아가지 않는다.

**sensorSegmentId.** 센서별로 업데이트를 시작하거나 재시작할 때마다 새 UUID 문자열을 만든다. 같은 실행 동안 유지하고, 재시작 뒤에 이전 ID를 다시 쓰지 않는다. 서버는 segment가 바뀌면 그 센서의 기준(yaw 기준, 기압 0점, 걸음 누적 기준)을 새로 잡는다.

**appState.** 샘플을 만든 시점의 앱 상태를 샘플마다 넣는다. `ProcessLifecycleOwner` 기준으로 RESUMED면 `FOREGROUND`, STARTED이지만 RESUMED가 아니면 `INACTIVE`, 그 아래면 `BACKGROUND`. 메인 스레드가 갱신하고 수집 스레드가 읽는 `@Volatile` 값으로 둔다.

**captureSource.** 보수계 샘플에만 넣는다. 평소 `LIVE`, 복구 샘플은 `HISTORICAL_RECOVERY`(§4.4).

**스레드.** 센서 콜백은 전용 `HandlerThread`에서 받는다. 샘플 생성, sequence 증가, 로컬 저장, 전송 버퍼 추가는 하나의 직렬 실행 컨텍스트에서 한다. 50 Hz 샘플을 메인 스레드로 보내지 않는다. UI에는 0.5초마다 최신 값만 반영한다.

**가공 금지.** 아래에 적힌 변환 외에는 값을 필터링, 평활화, 보정, 선별하지 않는다. 세션 시작 직후의 오래된(캐시) 위치도 그대로 보낸다. 판단은 서버가 한다. 없는 값은 null이며 0으로 바꾸지 않는다.

### 4.1 위치

`FusedLocationProviderClient`(Play services)를 쓴다. iOS의 `CLLocationManager`처럼 GNSS·Wi-Fi·기지국을 합친 추정이다. Play services가 없으면 `LocationManager.GPS_PROVIDER`로 대체하고 `sensorCapabilities.locationProvider`에 적는다.

| 설정(iOS `LocationCollectionProfile`) | iOS | Android `LocationRequest` |
|---|---|---|
| `highAccuracy` (기본값) | `kCLLocationAccuracyBest` | `PRIORITY_HIGH_ACCURACY`, interval 1000 ms |
| `balanced` | `kCLLocationAccuracyNearestTenMeters` | `PRIORITY_HIGH_ACCURACY`, interval 2000 ms |
| `batterySaving` | `kCLLocationAccuracyHundredMeters` | `PRIORITY_BALANCED_POWER_ACCURACY`, interval 5000 ms |

- 공통: `setMinUpdateIntervalMillis(interval)`, `setMinUpdateDistanceMeters(distanceFilter)`(설정값 0~100 m, 0이면 필터 없음), `setMaxUpdateDelayMillis(0)`(묶음 전달 금지), `setWaitForAccurateLocation(false)`.
- `balanced`와 `batterySaving`의 interval은 Android에 정확한 대응값이 없어 이 문서가 정한 값이다.
- `onLocationResult`의 `locations`를 순서대로 모두 기록한다.
- 서버는 약 1초 간격을 기대한다. 실외에서 `highAccuracy`의 위치 간격 중앙값이 1초 근처인지 확인한다.

| 필드 | iOS | Android |
|---|---|---|
| `timestamp` | `CLLocation.timestamp` | `epochMs(location.elapsedRealtimeNanos)` |
| `latitude`, `longitude` | 좌표 | 같음. 유한하지 않으면 그 샘플을 보내지 않는다 |
| `ellipsoidalAltitude` | WGS84 타원체고(m) | `location.altitude`(`hasAltitude()`일 때). **Android의 `getAltitude()`가 타원체고다** |
| `altitude` | 평균해수면 기준 고도(m) | API 34 이상이고 `hasMslAltitude()`일 때 `mslAltitudeMeters`, 아니면 null. **타원체고를 여기에 넣지 않는다** |
| `horizontalAccuracy` | m | `accuracy`(`hasAccuracy()`), 아니면 null |
| `verticalAccuracy` | m | `verticalAccuracyMeters`(`hasVerticalAccuracy()`) |
| `speed` | m/s (iOS 무효값은 −1) | `speed`(`hasSpeed()`), 아니면 null |
| `course` | 진북 기준 시계 방향 도 (iOS 무효값은 −1) | `bearing`(`hasBearing()`), 아니면 null |
| `speedAccuracy` | m/s | `speedAccuracyMetersPerSecond`(`hasSpeedAccuracy()`) |
| `courseAccuracy` | 도 | `bearingAccuracyDegrees`(`hasBearingAccuracy()`) |
| `floor` | `CLFloor.level` | 생략(Android에 없음) |

서버는 `ellipsoidalAltitude`에서 지오이드고를 빼 표고를 구한다. 캠퍼스에서 iPhone 값은 `ellipsoidalAltitude − altitude ≈ +22.6 m`다. Android에서 두 값이 모두 있을 때 차이가 +20~+26 m가 아니면 두 필드가 뒤바뀐 것이다.

### 4.2 모션 (CMDeviceMotion 대응)

iOS는 한 샘플에 자세, 회전 속도, 중력, 사용자 가속도가 함께 들어 있다. Android는 센서가 따로다. 네 센서를 받아 샘플 하나로 묶는다.

| 전송 필드 | iOS | Android 센서 | 변환 |
|---|---|---|---|
| `userAcceleration` {x,y,z} | 단위 g | `TYPE_LINEAR_ACCELERATION` (m/s²) | **각 축 `−값 / 9.80665`** |
| `gravity` {x,y,z} | 단위 g, 아래를 향함 | `TYPE_GRAVITY` (m/s²) | **각 축 `−값 / 9.80665`** |
| `rotationRate` {x,y,z} | rad/s | `TYPE_GYROSCOPE` (rad/s) | 그대로(축과 부호가 같다) |
| `attitude` {roll,pitch,yaw} | rad | `TYPE_ROTATION_VECTOR` 또는 `TYPE_GAME_ROTATION_VECTOR` | 아래 식 |

부호를 뒤집는 이유: Android 가속도계 계열은 정지 상태에서 위쪽으로 +9.81 m/s²(화면을 위로 눕히면 z = +9.81)를 보고하고, iOS는 중력 벡터 자체(같은 자세에서 z = −1 g)를 보고한다. iOS의 `userAcceleration`도 같은 규약이라 실제 가속도와 부호가 반대다. 이 부호를 "바로잡지" 않는다. 서버는 iPhone 값 그대로를 전제로 한다.

자세:

```kotlin
const val G0 = 9.80665

// values가 4개보다 길면 앞 4개만 넘긴다(일부 기기에서 5개짜리 배열이 예외를 낸다).
val R = FloatArray(9)
SensorManager.getRotationMatrixFromVector(R, rotationVector)   // 기기 → 세계(동, 북, 위), 행 우선

// CoreMotion 오일러 규약(R = Rz(yaw) · Rx(pitch) · Ry(roll), 기준 좌표계 X = 북, Z = 위)과 같은 값
val yawRaw = atan2(-R[4].toDouble(), -R[1].toDouble())
val pitch  = asin(R[7].toDouble().coerceIn(-1.0, 1.0))
val roll   = atan2(-R[6].toDouble(), R[8].toDouble())
val yaw    = wrapToPi(yawRaw - declinationRad)                  // 진북 기준일 때만. 아니면 declinationRad = 0
```

- yaw는 위에서 봤을 때 **반시계 방향이 +**다. 서버는 걷는 방향을 `−yaw + 상수`로 쓴다.
- 서버는 yaw의 **변화량**을 쓴다. 세션 중에 yaw의 기준이 튀면 가짜 회전이 생긴다. 기준계와 편각은 세션 시작 때 한 번 정하고 세션 동안 바꾸지 않는다. 바꿔야 하면 모션 `sensorSegmentId`를 새로 발급한다.

기준계 선택(iOS의 `preferredAttitudeReferenceFrame()` 우선순위와 같다). 세션 시작 때 한 번 정한다.

| 순위 | 조건 | 센서 | 편각 | `attitudeReferenceFrame` |
|---|---|---|---|---|
| 1 | 회전 벡터 센서가 있고 최근 위치를 안다 | `TYPE_ROTATION_VECTOR` | `GeomagneticField(lat, lon, alt, 시각).declination`을 라디안으로 | `xTrueNorthZVertical` |
| 2 | 회전 벡터 센서는 있지만 위치를 모른다 | `TYPE_ROTATION_VECTOR` | 0 | `xMagneticNorthZVertical` |
| 3 | 회전 벡터 센서가 없다 | `TYPE_GAME_ROTATION_VECTOR` | 0 | `xArbitraryZVertical` |

편각 계산에 쓰는 "최근 위치"는 `FusedLocationProviderClient.lastLocation`이다. 이 위치를 샘플로 기록하지는 않는다.

`TYPE_ROTATION_VECTOR`는 자기장 교란(철골 건물, 엘리베이터)에서 yaw가 튈 수 있다. §15.3의 실내 검증에서 자이로 적분과 어긋나는 yaw 점프가 보이면 3순위(`TYPE_GAME_ROTATION_VECTOR`)를 1순위로 바꾸는 상수를 두고, 바꿨는지 보고한다.

샘플 조립:

- 네 센서를 `registerListener(listener, sensor, samplingPeriodUs = 1_000_000 / hz, maxReportLatencyUs = 0, handler)`로 등록한다.
- `TYPE_LINEAR_ACCELERATION` 이벤트를 기준 시계로 삼는다. 그 이벤트의 시각이 직전 방출보다 `0.9 × (1/hz)`초 이상 지났을 때 샘플 하나를 만든다. 기기가 요청보다 빠르게 보내면 이 규칙으로 솎아낸다.
- 나머지 세 센서는 가장 최근 값을 쓴다. 최근 값이 기준 시각보다 `2.5 × (1/hz)`초 넘게 오래됐거나 아직 없으면 그 묶음(예: `attitude` 전체)을 생략한다.
- `timestamp`는 기준 이벤트의 시각이다.
- 네 센서 중 하나라도 없으면 `deviceMotionAvailable = false`이고 모션 스트림을 만들지 않는다. 가속도계에서 중력을 직접 분리하는 식의 자체 융합은 넣지 않는다.

**샘플링 주기 기본값은 50 Hz다.** 설정 선택지는 iOS처럼 10, 20, 50 Hz를 두되 기본값을 50으로 한다. 서버의 걸음 검출 필터가 50 Hz 입력으로 설계돼 있어 다른 주기에서는 걸음 검출이 틀어진다. 설정 화면의 안내 문구도 그렇게 적는다.

### 4.3 기압 (CMAltimeter 대응)

`TYPE_PRESSURE`(hPa)를 받아 1초에 샘플 하나를 만든다. iOS는 약 1.07초마다 하나를 보낸다.

- 센서는 `SENSOR_DELAY_UI` 정도로 등록한다. 1초 창 안의 기압을 산술평균해서 그 창의 값으로 쓴다. 이 평균이 유일하게 허용된 평활화다(iOS 값이 이미 걸러져 있기 때문이다).
- `pressure` = 평균 hPa ÷ 10 (iOS 단위는 kPa. 약 100.3이어야 한다).
- `relativeAltitude` = `h(평균 hPa) − h(p0)`, `h(p) = SensorManager.getAltitude(SensorManager.PRESSURE_STANDARD_ATMOSPHERE, p)`. `p0`는 이 기압 실행의 첫 창 평균이다. 그래서 실행의 첫 샘플은 0이다(iOS와 같다). 위로 올라가면 +다.
- `timestamp`는 창 안 이벤트 시각의 평균이다.
- 기압 센서를 재시작하면 새 `sensorSegmentId`와 새 `p0`로 0부터 다시 시작한다.
- 센서가 없으면 `altimeterAvailable = false`이고 스트림을 만들지 않는다.

### 4.4 보수계 (CMPedometer 대응)

서버 계약: `numberOfSteps`는 **보수계 실행 단위(`sensorSegmentId`)의 누적값**이다. 같은 실행 안에서 줄어들거나 0이 끼면 안 된다. 과거 iOS에서 누적값 사이에 0 샘플이 끼어 가짜 이동이 생긴 적이 있다.

`TYPE_STEP_COUNTER`(부팅 이후 누적 걸음 수)를 쓴다. API 29 이상에서는 `ACTIVITY_RECOGNITION` 런타임 권한이 필요하다.

- 등록 뒤 첫 이벤트의 값을 `baseline`으로 저장한다. 이 이벤트로는 샘플을 만들지 않는다.
- 이후 이벤트마다 `누적 = 값 − baseline`. **누적이 직전에 보낸 값보다 클 때만** 샘플을 만든다. 0 샘플, 같은 값의 반복, 증분값을 보내지 않는다.
- `timestamp`는 `SensorEvent.timestamp`(마지막 걸음 시각)다. iOS의 `CMPedometerData.endDate`에 해당한다.
- `distance`, `currentPace`, `currentCadence`, `floorsAscended`, `floorsDescended`는 생략한다. Android에는 OS가 주는 값이 없다. **걸음 수에 상수 보폭을 곱하거나 다른 추정값으로 `distance`를 채우지 않는다.** 서버가 그 값을 보폭 학습에 쓰기 때문에 지어낸 값이 모델을 오염시킨다.
- 샘플을 만드는 경로는 이 리스너 하나뿐이다. 세션 종료 때 "마지막 flush" 샘플을 만들지 않고, 상태 보고나 포그라운드 복귀 때 스냅샷을 넣지 않는다.
- 권한이 없거나 센서가 없으면 `stepCountingAvailable = false`이고 스트림을 만들지 않는다. 세션은 정상적으로 진행한다.

중단 복구(§5.5) 때를 위해 `baseline`, `Settings.Global.BOOT_COUNT`, 마지막 누적값을 진행 상태에 저장한다.

- 재개 시 부팅 횟수가 같으면: 새 `sensorSegmentId`로 다시 등록하고 저장된 `baseline`을 그대로 쓴다. 재등록 뒤 첫 이벤트의 `누적`이 마지막 누적값보다 크고 그 이벤트 시각이 마지막 보수계 샘플 시각보다 뒤면 `captureSource: "HISTORICAL_RECOVERY"`로 샘플 하나를 만든다(중단된 동안의 걸음). 그 뒤는 `LIVE`다.
- 재부팅됐으면: 새 `sensorSegmentId`, `baseline = 첫 이벤트 값 − 마지막 누적값`으로 잡아 누적이 이어지게 한다. 복구 샘플은 만들지 않는다.

### 4.5 `sensorCapabilities`

iOS와 같은 키를 쓰고 Android 전용 키를 덧붙인다. 서버는 이 객체를 그대로 저장한다.

```json
{
  "locationAvailable": true, "deviceMotionAvailable": true, "altimeterAvailable": true,
  "stepCountingAvailable": true, "distanceAvailable": false, "floorCountingAvailable": false,
  "paceAvailable": false, "cadenceAvailable": false,
  "attitudeReferenceFrame": "xTrueNorthZVertical", "motionUpdateHz": 50,
  "locationAuthorization": "authorizedWhenInUse", "locationAccuracyAuthorization": "fullAccuracy",
  "backgroundLocationUpdates": true, "pausesLocationUpdatesAutomatically": false,
  "attitudeSensor": "ROTATION_VECTOR", "magneticDeclinationDeg": -8.7,
  "locationProvider": "fused", "motionConvention": "COREMOTION_G_V1"
}
```

- `locationAvailable`: 시스템 위치 서비스가 켜져 있는지(`LocationManagerCompat.isLocationEnabled`).
- `locationAuthorization`: 권한이 있으면 `authorizedWhenInUse`(백그라운드 위치 권한까지 있으면 `authorizedAlways`), 한 번도 묻지 않았으면 `notDetermined`, 그 밖은 `denied`.
- `locationAccuracyAuthorization`: `ACCESS_FINE_LOCATION`이 있으면 `fullAccuracy`, 대략적 위치만 허용됐으면 `reducedAccuracy`. 숨기지 말고 그대로 보고한다.
- `motionConvention`: §4.2의 변환을 적용했다는 표시다. 변환식을 바꾸면 이 값도 바꾼다.
- 세션 시작 때 한 번 만들어 세션에 고정한다.

## 5. 세션 수명주기

### 5.1 포그라운드 서비스 (iOS의 백그라운드 위치 모드 대응)

과거 iOS에서 백그라운드로 가면 앱이 멈춰 31초~18.6분짜리 공백이 생긴 적이 있다. Android에서는 다음으로 막는다.

- 수집하는 동안 `CollectionService`를 포그라운드 서비스(type `location`)로 띄우고 `PARTIAL_WAKE_LOCK`을 잡는다. 종료 때 둘 다 반드시 해제한다.
- 서비스는 Activity가 화면에 보이는 상태에서 사용자가 Start 또는 Resume을 눌렀을 때만 시작한다. 그래야 백그라운드에서도 위치를 받는다. `ACCESS_BACKGROUND_LOCATION`은 요청하지 않는다. iOS의 "Allow Background Location" 버튼에 대응하는 것은 만들지 않는다.
- `START_NOT_STICKY`. 프로세스가 죽으면 자동으로 재개하지 않는다. 다음 실행 때 §5.5의 복구 화면을 보여준다.
- 최근 앱 목록에서 앱을 밀어내도 서비스는 계속 수집한다.
- 알림: 채널 하나, 진행 중 알림 "CampusTracker 수집 중", 누르면 앱이 열린다.
- 세션이 진행 중이고 화면이 앱에 있을 때 `FLAG_KEEP_SCREEN_ON`을 건다(iOS `isIdleTimerDisabled`).
- 백그라운드 진입, WebSocket 끊김, 화면 잠금 때문에 센서를 멈추지 않는다. 센서를 멈추는 것은 사용자가 Stop을 누를 때뿐이다.

### 5.2 Start

1. 인증된 collector가 없거나 이미 세션이 진행 중이면 아무것도 하지 않는다.
2. 권한을 요청한다: 위치(FINE과 COARSE를 함께), API 29 이상이면 `ACTIVITY_RECOGNITION`, API 33 이상이면 `POST_NOTIFICATIONS`. **위치 권한이 없으면 시작하지 않고 이유를 보여준다**(위치 타입 포그라운드 서비스를 띄울 수 없다). 나머지 둘은 거부돼도 시작한다.
3. `startedAt = nowMs()`, 새 `clientSessionId`(UUID), `sensorCapabilities`를 정한다.
4. 세션(`status = recording`)을 만들고 로컬 저장소에 디렉터리와 `metadata.json`을 만든다.
5. 진행 상태(§6.2)를 **즉시** 저장한다.
6. 업로드 쪽에 세션 시작을 알린다: `session:start` payload를 큐에 저장하고 1초 batch 타이머와 7초 status 타이머를 켠다.
7. 포그라운드 서비스를 띄우고 센서를 시작한다. 센서마다 새 `sensorSegmentId`를 만들고 진단 이벤트 `SENSOR_STARTED`를 남긴다.

서버 세션 ID나 연결을 기다리지 않는다. 오프라인에서도 3~7이 그대로 진행된다.

### 5.3 Stop

1. 센서 넷을 멈추고 센서마다 `SENSOR_STOPPED`(metadata: sensor, sensorSegmentId, `reason: "user_stop"`)를 남긴다.
2. 세션을 `completed`, `endedAt = nowMs()`, 최종 샘플 수로 갱신한다.
3. 업로드 쪽: 버퍼에 남은 샘플을 마지막 batch로 만들고, `session:finish`(§3.4)를 큐에 넣고, 두 타이머를 끈다.
4. 진행 상태 파일을 지우고, 로컬 저장소를 flush하고 `metadata.json`을 마지막으로 쓴다.
5. 포그라운드 서비스와 wake lock을 해제한다.

### 5.4 마커

진행 중인 세션에서만 누를 수 있다. `markerId`(UUID), `timestamp = nowMs()`, 종류, 그리고 이 프로세스가 마지막으로 받은 위치의 위도·경도·고도(MSL)·타원체고·수평·수직 정확도를 담는다. 로컬 `marker.ndjson`에 쓰고 업로드 큐에 넣는다. 위치가 한 번도 없었을 때는 §12-5를 따른다.

### 5.5 중단 복구

프로세스가 시작될 때 진행 상태 파일이 있으면 "수집 중에 프로세스가 죽었다"는 뜻이다. Activity만 재생성된 경우(싱글턴에 진행 중 세션이 살아 있음)와 구분한다. Collect 화면 위에 "Interrupted Collection Found" 카드(세션 ID, 시작 시각, 마지막 샘플 시각)와 버튼 두 개를 보여준다.

**Resume**

1. 저장된 세션, sequence 넷, 샘플 수, 모션 주기, 위치 프로필, 거리 필터를 복원한다. `wasInterrupted = true`.
2. 같은 `clientSessionId`와 같은 `startedAt`으로 업로드 쪽에 세션 시작을 다시 알린다. 서버는 기존 세션을 돌려준다.
3. 센서를 모두 **새 `sensorSegmentId`**로 시작한다. 보수계는 §4.4의 복구 규칙을 따른다.
4. 진행 상태를 즉시 저장하고 포그라운드 서비스를 띄운다.

**Finish as Interrupted**

세션을 `completed`로 닫고 진행 상태 파일을 지운다. 서버 쪽 처리는 §12-7을 따른다.

### 5.6 앱 상태와 로컬 진단

앱 상태가 바뀔 때 진행 중 세션이 있으면: 포그라운드·백그라운드 누적 시간과 백그라운드 전환 횟수를 갱신하고, 백그라운드로 갈 때 진행 상태를 즉시 저장하고, 진단 이벤트 `APP_BACKGROUND` 또는 `APP_FOREGROUND`를 남긴다. 절전 모드(`PowerManager.isPowerSaveMode`)가 한 번이라도 켜졌는지 기록한다.

센서별 공백 통계: 직전 샘플과의 간격이 `max(기대 간격 × 3, 1초)`를 넘으면 공백 횟수를 1 늘리고 최대 공백(ms)을 갱신한다. 기대 간격은 위치 1초, 모션 `1/hz`초, 기압 1초, 보수계 5초다. 이 통계는 화면 표시용이며 서버로 보내지 않는다.

포그라운드로 돌아올 때 보수계를 다시 조회하거나 추가 샘플을 만들지 않는다.

## 6. 로컬 저장 (local-first)

모든 샘플은 먼저 기기에 저장되고, 그다음에 업로드된다. 저장 위치는 앱 전용 내부 저장소(`filesDir/CampusCollector/`)다.

### 6.1 세션 원본 (iOS `LocalSensorDataRepository`)

`sessions/<clientSessionId>/` 아래에 `metadata.json`(세션 객체), `location.ndjson`, `motion.ndjson`, `altimeter.ndjson`, `pedometer.ndjson`, `marker.ndjson`. 한 줄에 샘플 하나의 JSON이다. 값은 §4의 변환을 적용한 뒤의 값이고 시각은 밀리초 ISO-8601이다.

- 스트림별로 메모리에 모았다가, 한 스트림의 버퍼가 32개가 되거나 마지막 flush에서 2초가 지나면 파일 끝에 붙여 쓴다. flush 때마다 `metadata.json`의 샘플 수를 갱신한다.
- Sessions 탭은 각 디렉터리의 `metadata.json`을 읽어 시작 시각 내림차순으로 보여준다.
- 이 파일들은 로컬 보관용이다. 업로드는 §6.3의 큐에서 나간다. 삭제 기능은 만들지 않는다(iOS에도 없다).

세션 객체: `id`(clientSessionId), `collectorId`, `deviceId`, `startedAt`, `endedAt`, `status`(`recording` 또는 `completed`), `serverSessionId`, `deviceModel`, `systemVersion`, `sensorCapabilities`, `sampleCounts { location, motion, altimeter, pedometer, marker }`, `strideCalibration`(항상 null, §11).

### 6.2 진행 상태 (iOS `ActiveCollectionStore`)

`active_collection.json` 하나. 세션 객체, 모션 주기, 위치 프로필, 거리 필터, sequence 넷, 센서별 마지막 샘플 시각 넷, 마지막 저장 시각, 로컬 진단(§5.6), 그리고 Android 전용으로 걸음 센서 `baseline`·부팅 횟수·마지막 누적 걸음 수.

- 샘플이 들어올 때마다 갱신하되 디스크에는 1초에 한 번 이하로 쓴다. 세션 시작, 백그라운드 진입, 재개 때는 즉시(동기) 쓴다.
- 임시 파일에 쓰고 rename하는 원자적 쓰기를 한다(`AtomicFile`).
- Stop과 Finish as Interrupted에서 지운다.

### 6.3 업로드 큐 (iOS `PersistentUploadQueue`)

Room에 항목 단위로 저장한다. 앱 재시작과 연결 끊김을 넘어 살아남아야 한다.

- 세션 테이블: `clientSessionId`, 소유 `collectorId`와 서버 주소(§12-6), `session:start` payload JSON, `serverSessionId`(nullable).
- 항목 테이블: 자동 증가 순번, 종류(batch, marker, finish, diagnostic), 항목 ID(batchId, markerId, clientSessionId, eventId), `clientSessionId`, payload JSON, 상태(pending 또는 quarantined), 마지막 오류 코드.
- 서버 `sessionId`는 보낼 때 세션 테이블에서 읽어 payload에 넣는다.
- 화면의 "Pending uploads" = pending 상태의 batch + marker + finish + diagnostic 개수(세션 시작 요청은 세지 않는다). `collector:status`의 `pendingBatchCount` = pending batch 개수.
- 스키마가 바뀌어도 기존 큐가 사라지지 않게 한다. Room migration을 쓰고, JSON은 새 필드가 없어도 읽히게 기본값을 둔다. 과거 iOS에서 필드를 추가한 뒤 옛 큐 파일이 통째로 디코딩에 실패한 적이 있다.

## 7. 업로드 동기화 (iOS `TelemetrySyncCoordinator`)

### 7.1 batch 만들기

- 샘플이 생기면 전송 DTO로 바꿔 메모리 버퍼(위치, 모션, 기압, 보수계)에 넣는다.
- 1초 타이머마다, 그리고 네 버퍼의 합이 64개 이상이 되는 순간, 버퍼가 비어 있지 않으면 batch 하나(`batchId` = 새 UUID, `createdAt` = 지금)로 만들어 큐에 저장하고 버퍼를 비운다.
- Stop 때 남은 버퍼를 마지막 batch로 만든 뒤 `session:finish`를 큐에 넣는다.

### 7.2 보내는 순서

**한 번에 요청 하나만 보낸다.** ACK(또는 10초 타임아웃, 연결 끊김)를 받은 뒤 다음을 고른다. 고르는 우선순위:

1. 서버 세션 ID가 없는 세션의 `session:start`
2. 가장 오래된 batch
3. 가장 오래된 마커
4. 가장 오래된 `session:finish`
5. 가장 오래된 진단 이벤트

- 가장 오래된 batch의 세션이 아직 서버 세션 ID를 못 받았으면 뒤의 것을 먼저 보내지 않고 기다린다(오래된 순서 유지).
- 그래서 `session:finish`는 대기 중인 batch가 모두 나간 뒤에 나간다.
- `collector:status`는 큐를 거치지 않는다. 7초마다, 그리고 `session:start` ACK 직후에, 연결돼 있고 진행 중 세션의 서버 세션 ID가 있을 때만 보낸다. ACK를 기다리지 않는다.
- 동기화를 깨우는 계기: 큐에 항목이 들어옴, ACK 도착, 연결 성립, 실패 뒤 2초 경과.

### 7.3 연결·재연결

- 상태: `disconnected`, `connecting`, `connected`, `reconnecting`, `failed(메시지)`. 화면 표시는 "Disconnected", "Connecting…", "Connected", "Reconnecting…", "Connection failed". **실제 소켓 이벤트(`onOpen`, `onClosed`, `onFailure`)로만 바꾼다.**
- 연결 타임아웃 10초. 끊기면 `min(2^(시도−1), 15)`초 뒤 재연결한다(1, 2, 4, 8, 15, 15, … 초). 연결되면 시도 횟수를 0으로 되돌린다. 로그아웃이나 설정 초기화로 끊은 경우에는 재연결하지 않는다.
- OkHttp `pingInterval`을 15초로 둔다(죽은 연결을 빨리 알아채기 위해서다).
- **연결이 성립할 때마다** 진행 중 세션의 저장된 서버 세션 ID를 지우고 같은 `clientSessionId`로 `session:start`를 다시 보낸다. 서버가 그 세션을 "이 연결의 진행 중 세션"으로 되살린다. 이미 큐에 있는 항목에는 영향이 없다.
- 연결이 끊기면 응답을 기다리던 요청을 실패로 처리하고 항목은 큐에 그대로 둔다.

### 7.4 ACK 처리

| 결과 | 처리 |
|---|---|
| `ok: true` | 항목을 큐에서 지운다. `session:start`면 서버 세션 ID를 저장하고 로컬 세션의 `serverSessionId`와 `metadata.json`을 갱신한다 |
| `session:finish`가 `ok: true` | 그 세션에 남은 항목이 없으면 세션 테이블의 행도 지운다 |
| 10초 안에 ACK 없음, 전송 실패, 연결 끊김 | 항목을 그대로 두고 같은 ID로 다시 보낸다 |
| `ok: false`, `retryable: true` | 항목을 그대로 두고 2초 뒤 다시 시도한다 |
| `ok: false`, `retryable: false` | §12-3의 격리 규칙 |

### 7.5 주기와 상수

| 항목 | 값 |
|---|---|
| batch 타이머 / 즉시 flush 기준 | 1초 / 버퍼 합 64개 |
| `collector:status` | 7초 |
| ACK 대기 | 10초 |
| 실패 뒤 재시도 지연 | 2초 |
| 재연결 지연 | `min(2^(n−1), 15)`초 |
| WebSocket 연결 타임아웃 | 10초 |
| 로그인 / health 타임아웃 | 8초 / 5초 |
| 로컬 저장소 flush | 스트림당 32개 또는 2초 |
| 진행 상태 저장 | 1초에 한 번 이하, 주요 시점은 즉시 |
| UI 갱신 | 0.5초 |

## 8. 설정과 인증

### 8.1 서버 설정과 기기 정보

- 서버 주소는 사용자가 입력한 scheme(`http` 또는 `https`, 기본 `http`), host, port(기본 3000) **한 곳에서만** 만든다. 코드에 `localhost`, 고정 IP, 고정 포트를 넣지 않는다.
- 검증(iOS와 같은 문구): host가 비면 "Enter a server address." / host에 `://`, `/`, 공백이 있으면 "Enter only a host or IP address." / port가 1~65535가 아니면 "Port must be between 1 and 65535." / URL을 만들 수 없으면 "Enter a valid server address."
- Collector ID: 앞뒤 공백 제거, 비어 있으면 "Enter a collector ID.", 최대 32자.
- 기기 ID: 처음 실행 때 UUID 문자열을 만들어 저장하고 계속 쓴다. 로그인 본문, `X-Device-ID` 헤더, `session:start`의 `deviceId`에 같은 문자열을 쓴다.
- `deviceModel` = `Build.MANUFACTURER + " " + Build.MODEL`(64자로 자름), `systemVersion` = `Build.VERSION.RELEASE`, `appVersion` = versionName.
- 설정값(서버 설정, Collector ID, 기기 ID, 모션 주기, 위치 프로필, 거리 필터)은 DataStore에 둔다.

### 8.2 인증 상태

상태: `unknown`, `signedOut`, `authenticating`, `authenticated(collectorId)`, `failed(메시지)`.

- 앱 시작: 저장된 Collector ID와 토큰이 있으면 `authenticated`로 두고 WebSocket을 연결한다. 없으면 `signedOut`.
- 로그인: 설정과 Collector ID를 검증·저장 → `authenticating` → 로그인 요청 → 토큰과 `webSocketURL` 저장 → `authenticated(응답의 collectorId)` → WebSocket 연결. 실패하면 `failed(메시지)`.
- 서버 설정이나 Collector ID를 **바꿔서** 저장하면 로그아웃한다.
- 로그아웃: WebSocket을 끊고 토큰을 지운다. "Reset Server and Account"는 여기에 더해 서버 설정과 Collector ID도 지운다.
- 로그아웃해도 진행 중인 수집은 멈추지 않는다. 큐는 그대로 남고 다시 로그인하면 이어서 올라간다.
- 토큰은 Android Keystore 키로 암호화해 저장한다. 평문 SharedPreferences에 두지 않는다. 토큰 전체를 로그에 찍지 않는다.

### 8.3 자동 재로그인

§3.3의 인증 거부나 close code 4004를 받으면 저장된 Collector ID와 기기 ID로 로그인을 한 번 다시 시도한다(이 시스템에는 비밀번호가 없다).

- 성공: 새 토큰과 `webSocketURL`을 저장하고 바로 다시 연결한다.
- 404 `COLLECTOR_NOT_FOUND`: 재연결을 멈추고 인증 상태를 `failed("등록되지 않은 Collector ID")`로 둔다. 수집과 큐는 유지한다.
- 네트워크 오류: 평소 재연결 지연을 따라 다시 시도한다.
- 재로그인에 성공한 직후의 연결이 또 인증 거부되면 자동 시도를 멈추고 `failed`로 둔다(무한 반복 방지).

## 9. 화면 (iOS `ContentView.swift`와 같은 구성과 문구)

루트: 인증됐으면 하단 탭 세 개(Collect, Sessions, Settings). 상태가 `unknown`이면 "Restoring account…" 진행 표시. 그 밖에는 Server Setup 화면.

**Server Setup**: Protocol 선택(HTTP, HTTPS), "Server address", "Port", 안내문("Use your development computer's LAN IP, not localhost. Example: 192.168.0.15."), "Collector ID (for example C03)"(대문자 입력), 버튼 "Test Connection"(결과: "Connecting…" → "Server reachable." 또는 오류 문구), 버튼 "Login"(진행 중에는 스피너와 비활성). 실패하면 "Login Failed" 구역에 메시지.

**Collect** (제목 "Collection", 우상단 액션 "Start" 또는 "Stop")

- 중단 복구 카드(§5.5): "Interrupted Collection Found", Session, Started, Last sample, 버튼 "Resume", "Finish as Interrupted".
- 상태: "Ready" 또는 빨간 "Recording", Collector, Session(clientSessionId), Location permission(Authorized, Denied, Not Determined. 대략적 위치만 허용이면 그 사실을 함께 표시), Background Collection(Enabled 또는 Disabled: 세션 진행 중이고 위치 업데이트가 켜져 있으면 Enabled), Server(host:port), WebSocket 상태(연결되면 초록), Pending uploads.
- 최신 값: GPS(소수 6자리), Horizontal accuracy, Altitude, Vertical accuracy, Relative altitude(소수 1자리), Step count, "Samples — Location n, Motion n, Altimeter n". 값이 없으면 "—".
- Collector Diagnostics: App State, Collection(IDLE 또는 ACTIVE), 센서 넷 각각 ACTIVE 또는 INACTIVE와 "last x.xs ago", Pending Upload, Last Persist, 센서별 Gaps 횟수, Low Power Observed, Quarantined uploads(§12-3).
- Markers: 2열 격자의 버튼 9개(Entrance, Intersection, Stair Start, Stair End, Ramp Start, Ramp End, Elevator, Stop, Custom). 세션이 없으면 비활성.

**Sessions**: 로컬 세션 목록. 항목마다 세션 ID, "collectorId · status", 스트림별 샘플 수와 마커 수, 시작 날짜. 우상단 "Refresh".

**Settings**: Account("Authenticated as …", "Server & Collector" 하위 화면, "Log Out"), Sampling("Motion sampling rate" 10·20·50 Hz, 안내문, "Location profile" High Accuracy Collection·Balanced Collection·Battery Saving, "Distance filter: n m" 0~100, 1 단위). "보폭 보정" 구역은 만들지 않는다(§11).

**Server & Collector**: Server Setup과 같은 입력란, "Save Changes"(성공 문구 "Saved. If server or collector changed, sign in again."), "Reset Server and Account".

화면의 숫자는 0.5초마다 갱신한다. 50 Hz로 recomposition이 일어나면 안 된다.

## 10. 진단 이벤트

진행 중인 세션이 있을 때만 만든다. 만들자마자 큐에 저장한다(local-first). `metadata` 값은 문자열로 통일한다.

| eventType | 시점 | metadata |
|---|---|---|
| `SENSOR_STARTED` | 센서별 시작·재시작 | `sensor`(location, motion, altimeter, pedometer), `sensorSegmentId`, 모션은 `referenceFrame`도 |
| `SENSOR_STOPPED` | 센서별 정지 | `sensor`, `sensorSegmentId`, `reason` |
| `APP_BACKGROUND`, `APP_FOREGROUND` | 앱 상태 전환 | 없음 |
| `LOCATION_AUTHORIZATION_CHANGED` | 위치 권한 상태 변화 | `status` |
| `PEDOMETER_ERROR` | 걸음 센서 등록 실패 등 | `code` |
| `SENSOR_CLOCK_OFFSET` | §4.0의 시계 보정이 일어났을 때 | `offsetMs` |
| `MAGNETIC_CALIBRATION` | 회전 벡터 센서의 정확도(`onAccuracyChanged`)가 바뀔 때만 | `accuracy` |
| `LOW_POWER_MODE` | 절전 모드 전환 | `enabled` |

## 11. 건강 앱 보폭 보정: 이번 포팅에서는 보내지 않는다

iOS는 HealthKit의 `walkingStepLength`(iPhone이 자동 측정한 평지 한 걸음 길이)를 28일 중앙값으로 집계해 `session:start`의 `strideCalibration`으로 보낸다. Android에는 같은 의미의 측정값이 없다. Health Connect에 걸음 길이 레코드 타입이 없고(설치된 SDK에서 다시 확인한다), 걸음 수와 거리로 나눈 값은 대개 키 기반 추정이라 의미가 다르다. 서버도 `source: "APPLE_HEALTH_WALKING_STEP_LENGTH"`, `sourcePolicy: "IPHONE_AUTOMATIC_V1"`만 받는다.

- `strideCalibration` 키를 보내지 않는다. 서버는 `{ status: "FALLBACK", reason: "MISSING" }`으로 답하고 기본 보폭으로 시작한다.
- Apple 출처 문자열을 Android에서 보내지 않는다. Health Connect 권한과 의존성을 추가하지 않는다. 설정의 보폭 보정 구역을 만들지 않는다.
- 호환을 위해 두 가지만 한다. 세션 모델과 시작 payload에 nullable `strideCalibration` 자리를 두고 항상 null로 둔다. ACK의 `strideCalibration { status, reason }`은 문자열로 받아 로그만 남기고, 없거나 모르는 값이어도 ACK 처리는 성공해야 한다.
- 서버가 Android용 출처를 정의하면 그때 별도 계약으로 추가한다.

## 12. iOS와 다르게 구현할 것

iOS 코드를 그대로 옮기면 안 되는 곳이다. 각 항목은 서버 계약을 지키거나 데이터 손실을 막기 위한 것이다.

1. **모션 기본 주기 50 Hz.** iOS 기본값은 20 Hz지만 서버 걸음 검출은 50 Hz를 전제로 한다(§4.2).
2. **인증 만료 시 자동 재로그인(§8.3).** iOS는 만료된 토큰으로 재연결만 반복해서, 24시간 뒤에는 업로드가 조용히 멈춘다.
3. **재시도할 수 없는 실패는 격리한다.** iOS는 `ok: false`를 받으면 같은 항목을 즉시 다시 보내 무한 반복하고 큐 전체가 막힌다. Android는 `retryable: false`면 그 항목의 상태를 quarantined로 바꾸고(삭제하지 않는다) 오류 코드를 기록한 뒤 다음 항목으로 넘어간다.
   - 예외 1: batch·마커·finish가 `SESSION_NOT_FOUND` 또는 `SESSION_NOT_STARTED`를 받으면 그 세션의 서버 세션 ID를 지우고 `session:start`를 다시 보낸 다음 한 번 더 시도한다. 또 실패하면 격리한다.
   - 예외 2: `session:start` 자체가 재시도 불가로 실패하면 그 세션의 항목은 보류하고 다른 세션의 전송은 계속한다. 다시 로그인하거나 앱을 다시 시작하면 한 번 더 시도한다.
4. **요청을 하나씩 순서대로 보낸다(§7.2).** iOS는 ACK를 기다리는 동안 다음 batch를 겹쳐 보낼 수 있어 서버에 순서가 뒤바뀌어 저장될 수 있다.
5. **위치가 없는 마커는 보류한다.** 서버는 마커의 위도·경도를 필수로 요구하는데 iOS는 위치가 없으면 null을 보내 영원히 실패한다. Android는 마커를 로컬에 바로 기록하되, 업로드는 이 프로세스가 첫 위치를 받을 때까지 미뤘다가 그 위치를 채워 보낸다. `timestamp`는 누른 시각 그대로다.
6. **큐 항목에 소유자를 붙인다.** 세션마다 시작 당시의 Collector ID와 서버 주소를 저장하고, 현재 로그인한 collector·서버와 같을 때만 올린다. 다르면 큐에 둔 채 기다리고 화면에 건수를 보여준다. iOS는 collector를 바꾸면 이전 collector의 대기 데이터를 새 토큰으로 보내 실패가 반복된다.
7. **Finish as Interrupted도 서버에 알린다.** iOS는 로컬만 닫아 서버 세션이 ACTIVE로 남는다. Android는 `session:finish`에 `"interrupted": true`, `endedAt` = 저장된 마지막 샘플 시각(없으면 마지막 저장 시각), `lastSequences` = 저장된 값을 넣어 큐에 넣는다.
8. **재개할 때 sequence를 건너뛴다.** 진행 상태는 1초에 한 번 저장되므로 죽기 직전 sequence보다 저장값이 작을 수 있다. 그대로 이어 쓰면 이미 올라간 번호와 겹쳐 새 샘플이 서버에서 버려진다. 재개 시 네 sequence를 각각 `저장값 + 1000`부터 이어간다. 서버는 중간 공백을 손실로 보지 않는다.
9. **샘플이 없는 스트림의 `lastSequences`는 −1.** iOS는 0을 보내는데, 기압계나 걸음 센서가 없는 Android 기기에서는 서버가 "아직 다 안 왔다"고 판단하게 된다.
10. **위치 권한이 없으면 Start를 막는다(§5.2).** Android의 포그라운드 서비스 제약이다.
11. **로컬 파일의 시각도 밀리초까지 쓴다.** iOS 로컬 파일은 초 단위로 저장돼 50 Hz 샘플의 시각이 뭉개진다.
12. **`webSocketURL`을 저장해 재시작 뒤에도 쓴다.** iOS는 재시작하면 설정으로 만든 주소를 쓴다.

## 13. 과거 iOS에서 실제로 났던 문제 (반복 금지)

기존 대화에서 서버 로그와 실제 세션으로 확인한 것들이다.

| 문제 | Android에서 지킬 것 |
|---|---|
| 소켓 주소가 REST와 다른 하드코딩 값이라 연결을 시도조차 안 함 | 주소는 한 곳에서만 만들고 WebSocket은 로그인 응답의 URL을 쓴다 |
| 연결되지 않았는데 UI가 "연결됨"으로 표시 | 상태는 실제 소켓 이벤트로만 바꾼다 |
| NaN이 들어간 batch의 JSON 인코딩이 조용히 실패해 pending 515개가 쌓임 | 유한하지 않은 값은 null로, 인코딩 실패는 로그로 |
| 시각을 숫자로 보내 서버가 거부 | 밀리초 ISO-8601 문자열 |
| 서버 세션 ID를 ACK 최상위에서 찾아 batch가 영원히 대기 | `data.sessionId` |
| 재연결할 때마다 새 clientSessionId를 써서 4분에 세션 4개 | 진행 중 세션의 ID를 다시 쓴다 |
| 보수계 누적값 사이에 0 샘플(포그라운드 복귀 때 넣은 복구 샘플) | 샘플 생성 경로는 리스너 하나, 누적값만 |
| 백그라운드에서 앱이 멈춰 최대 18.6분 공백 | 포그라운드 서비스와 wake lock, 센서를 멈추지 않는다 |
| `appState`, `sensorSegmentId`, `speedAccuracy`, `courseAccuracy`, 보수계 `sequence`가 전부 null | 샘플마다 채운다 |
| yaw 기준계가 임의 | 북쪽 기준을 우선하고 세션 동안 고정한다 |
| GPS 간격 중앙값 2초(기대 1초) | interval 1000 ms, 묶음 전달 금지 |
| 필드를 추가한 뒤 옛 큐 파일이 통째로 디코딩 실패 | migration과 기본값 |
| ACK마다 큐 전체를 메인 스레드에서 다시 인코딩 | 항목 단위 저장, 메인 스레드 밖에서 |

## 14. 하지 말 것

- 서버 계약에 없는 필드를 추가하거나, 있는 필드의 이름·단위·부호를 바꾸지 않는다.
- 원시 값을 필터링·평활화·선별하지 않는다(§4.3의 1초 기압 평균만 예외다).
- null을 0으로 바꾸지 않는다. `distance`를 지어내지 않는다.
- 보수계 스트림에 0, 증분값, 스냅샷을 섞지 않는다.
- 세션 중에 자세 기준계나 편각을 바꾸지 않는다. 센서 재시작 뒤 이전 `sensorSegmentId`를 다시 쓰지 않는다.
- WebSocket 연결 상태, 앱 상태, 화면 상태에 따라 센서 수집을 켜고 끄지 않는다.
- 재연결이나 재개 때 새 `clientSessionId`를 만들지 않는다.
- ACK `ok: true`를 받기 전에 큐에서 지우지 않는다.
- 대기 중인 항목을 하나의 큰 메시지로 합치지 않는다.
- 토큰, 개별 위치 기록을 일반 로그에 통째로 찍지 않는다. 로그에는 type, requestId, 항목 ID, 크기, 결과만 남긴다.
- Health Connect, 백그라운드 위치 권한, 자체 센서 융합, 세션 삭제 기능, iOS에 없는 화면을 추가하지 않는다.

## 15. 테스트와 검증

### 15.1 JVM 단위 테스트

- 변환: 선형 가속도와 중력의 부호·단위(화면 위로 눕힌 정지 상태 → gravity `(0, 0, −1)`), hPa → kPa, 상대 고도(첫 샘플 0, 기압이 내려가면 +).
- 자세: 단위 회전 행렬 → `(yaw −π/2, pitch 0, roll 0)`. 기기 X축이 북쪽(윗변이 서쪽)인 평평한 자세 → yaw 0. 세로로 세운 자세 → pitch +π/2. 오른쪽 변이 아래 → roll +π/2. 임의의 회전에 대해 `gravity ≈ (sin(roll)·cos(pitch), −sin(pitch), −cos(roll)·cos(pitch))`.
- JSON: 밀리초 3자리 UTC 시각, NaN → null, null 생략, 정수 필드, §3.4의 각 payload를 기대 JSON과 비교.
- 모션 조립: 100 Hz 입력 → 50 Hz 출력, 오래된 묶음 생략, 일부 센서 없음.
- 기압: 1초 창 평균, 재시작 뒤 0부터.
- 보수계: baseline, 단조 증가, 0·중복 미생성, 같은 부팅에서 재개(`HISTORICAL_RECOVERY`), 재부팅 뒤 이어가기.
- 큐와 ACK(가짜 WebSocket): 전송 순서(start → batch → 마커 → finish → 진단), 한 번에 하나, ACK 타임아웃 뒤 같은 batchId 재전송, 끊김 뒤 보존, 재연결 때 같은 clientSessionId로 `session:start`, `retryable` true와 false, `SESSION_NOT_FOUND` 재시도, 소유자가 다른 항목 보류, 위치 없는 마커 보류.
- 세션: 오프라인 시작 → 앱 재시작 → 재연결에서 같은 `startedAt`과 clientSessionId, 재개 시 sequence +1000, 빈 스트림의 `lastSequences` −1.
- 호환: 필드가 빠진 옛 진행 상태·세션 JSON 읽기, 모르는 필드가 있는 ACK, `strideCalibration`이 없거나 모르는 값인 ACK.
- 재연결 지연 수열, 서버 설정 검증 문구.

### 15.2 서버와 맞춰 보기

로컬 서버(`npm run dev`, 저장소 루트)에 실기기나 에뮬레이터로 붙는다. 서버 로그(`backend/logs/server.log`)에 다음이 순서대로 찍혀야 한다.

```
INFO  raw_ws.collector.connected {"collectorId":"C02","deviceId":"…","ip":"…"}
INFO  session.started {"collectorId":"C02","sessionId":"…","clientSessionId":"…","status":"ACTIVE", …}
INFO  raw_ws.message {"collectorId":"C02","type":"session:start","requestId":"…","ok":true, …}
INFO  batch.received {"collectorId":"C02","sessionId":"…","batchId":"…","locations":1,"motion":50,"altimeter":1,"pedometer":1,"captureDelayS":0}   ← 약 1초마다
INFO  raw_ws.message {"collectorId":"C02","type":"telemetry:batch","requestId":"…","ok":true, …}
INFO  marker.created { … }
INFO  session.finished {"collectorId":"C02","sessionId":"…","interrupted":false}
```

- `raw_ws.message`에 `"ok":false`가 있으면 그 줄의 `code`를 보고 원인을 고친다. 정상 세션에서는 하나도 없어야 한다.
- 비행기 모드로 2분 수집한 뒤 켜면 `batch.received`가 밀린 만큼 이어지고(`captureDelayS`가 크게 찍힌다) "Pending uploads"가 0이 된다.
- 재연결하면 `session.resumed`가 찍히고 새 세션이 생기지 않는다. 수집 중에 앱을 강제 종료하고 다시 열어 Resume해도 같다.
- 실시간 Preview(`http://localhost:5173`)에서 GPS fix 사이에도 걸음에 맞춰 위치가 움직여야 한다. 서버의 실시간 경로는 모션의 `gravity`로 걸음을 검출한다(2026-10-07에 `telemetry.service.ts`가 `gravity`·`rotationRate`·`roll`·`pitch`를 실시간 fusion에 넘기도록 고쳤다. 그 전 서버 빌드에서는 실시간 걸음 검출이 되지 않고 사후 재계산에서만 된다). 걷는데도 Preview 위치가 GPS가 올 때만 움직이면 서버가 이 수정 이후 빌드인지 먼저 확인하고, 그다음 `gravity`가 빠지거나 단위·부호가 틀리지 않았는지(§4.2, §15.4의 1번·3번 SQL) 본다.
- 참조 클라이언트: `npm run check:raw-ws -w backend -- --server http://<host>:3000 --collector C02`.

실제 센서 값을 가짜로 만들어 운영 서버에 보내지 않는다.

### 15.3 실기기 세션

자세 확인(로그나 디버그 표시로 본다):

| 자세 | 기대값 |
|---|---|
| 책상에 화면을 위로 눕힘 | gravity ≈ (0, 0, −1), pitch ≈ 0, roll ≈ 0, userAcceleration 크기 < 0.03 |
| 세로로 세움(윗변이 위, 화면이 나를 향함) | gravity ≈ (0, −1, 0), pitch ≈ +1.57 |
| 눕힌 상태에서 오른쪽 변을 아래로 세움 | gravity ≈ (+1, 0, 0), roll ≈ +1.57 |
| 눕힌 채로 위에서 봤을 때 반시계로 90° 돌림 | yaw가 약 +1.57 증가 |
| 눕힌 채 윗변을 북쪽으로(북쪽 기준계일 때) | yaw ≈ −1.57 |
| 눕힌 상태에서 위로 빠르게 들어 올림 | userAcceleration.z의 첫 변화가 **음수** |

기록 순서(세션 하나):

1. 실외에서 Start. 화면을 켠 채 1분 걷는다.
2. 화면을 잠그고 3분 걷는다. 중간에 30초 멈춘다.
3. 홈으로 나가 다른 앱을 연 채 2분 걷는다.
4. 실내로 들어가 계단을 한 층 오르내린다. 마커(Stair Start, Stair End)를 누른다.
5. 앱으로 돌아와 Stop.

별도로 화면을 잠근 채 20분 걷는 세션을 하나 더 기록해 제조사 배터리 관리가 서비스를 죽이는지 본다. 공백이 생기면 배터리 최적화 예외가 필요한지 보고한다.

### 15.4 서버에서 확인

- `npm run sessions:diagnose -- --session=<서버 세션 ID>`: 모션 1초 초과 공백 0, 센서별 segment 1 이상.
- `npm run fusion:diagnose -- --session=<서버 세션 ID>`: 보수계 "ignored below running max" 0.
- 화면 잠금 구간 샘플의 `app_state`가 `BACKGROUND`, 위치의 `speed_accuracy`·`course_accuracy`가 채워짐, `sensor_capabilities`에 `attitudeReferenceFrame`과 `motionConvention`이 있음.

iPhone과 같은 규약인지 보는 SQL(`npm run db:psql`). 오른쪽은 실제 iPhone 세션에서 나온 값이다.

```sql
\set sid '<서버 세션 ID>'

-- 1) 중력과 자세의 관계. iPhone: 세 잔차 모두 0.00000, gnorm 1.0000. Android 기대: 잔차 < 0.03, gnorm 1.00 ± 0.02
SELECT count(*) n,
  sqrt(avg(power(gravity_x - sin(attitude_roll)*cos(attitude_pitch), 2))) AS rms_gx,
  sqrt(avg(power(gravity_y + sin(attitude_pitch), 2)))                    AS rms_gy,
  sqrt(avg(power(gravity_z + cos(attitude_roll)*cos(attitude_pitch), 2))) AS rms_gz,
  avg(sqrt(gravity_x^2 + gravity_y^2 + gravity_z^2))                      AS gnorm
FROM motion_samples WHERE session_id = :'sid';

-- 2) yaw 변화율과 자이로. iPhone: slope +0.94 ~ +0.97, corr 0.92 ~ 0.97. slope가 음수면 yaw 또는 중력 부호가 뒤집힌 것
WITH m AS (
  SELECT "timestamp" t, attitude_yaw yaw, attitude_pitch pitch,
         -(rotation_rate_x*gravity_x + rotation_rate_y*gravity_y + rotation_rate_z*gravity_z)
           / sqrt(gravity_x^2 + gravity_y^2 + gravity_z^2) AS w_up,
         LAG(attitude_yaw) OVER w yaw0, LAG("timestamp") OVER w t0
  FROM motion_samples WHERE session_id = :'sid'
  WINDOW w AS (PARTITION BY sensor_segment_id ORDER BY sequence)
), d AS (
  SELECT w_up, atan2(sin(yaw - yaw0), cos(yaw - yaw0)) / EXTRACT(EPOCH FROM t - t0) AS yaw_rate
  FROM m WHERE yaw0 IS NOT NULL AND EXTRACT(EPOCH FROM t - t0) BETWEEN 0.015 AND 0.025 AND abs(pitch) < 1.2
)
SELECT count(*) n, regr_slope(yaw_rate, w_up) slope, corr(yaw_rate, w_up) corr FROM d;

-- 3) 서버가 걸음 검출에 쓰는 수직 가속도. iPhone 보행 세션: 왜도 −0.27 ~ −1.24, 0.1% 분위 −0.84 ~ −0.98, 99.9% 분위 +0.56 ~ +0.83
--    왜도가 양수면 userAcceleration 부호를 의심한다. 값이 10배쯤 크면 g로 나누지 않은 것이다
WITH m AS (
  SELECT -(user_acceleration_x*gravity_x + user_acceleration_y*gravity_y + user_acceleration_z*gravity_z)
           / sqrt(gravity_x^2 + gravity_y^2 + gravity_z^2) AS v
  FROM motion_samples WHERE session_id = :'sid'
    AND sqrt(user_acceleration_x^2 + user_acceleration_y^2 + user_acceleration_z^2) > 0.05
), s AS (SELECT avg(v) mu, stddev_pop(v) sd FROM m)
SELECT count(*) n, avg(power((v - mu)/sd, 3)) AS skew,
       percentile_cont(0.001) WITHIN GROUP (ORDER BY v) AS p0_1,
       percentile_cont(0.999) WITHIN GROUP (ORDER BY v) AS p99_9
FROM m, s;

-- 4) 간격과 단위. iPhone: 모션 0.020초, 기압 1.07초(첫 relative_altitude 0, pressure 약 100.3), 타원체고 − 고도 +22.6 m
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY dt) AS motion_dt
FROM (SELECT EXTRACT(EPOCH FROM "timestamp" - LAG("timestamp") OVER (ORDER BY sequence)) dt
      FROM motion_samples WHERE session_id = :'sid') x WHERE dt IS NOT NULL;
SELECT sequence, relative_altitude, pressure FROM altimeter_samples WHERE session_id = :'sid' ORDER BY sequence LIMIT 3;
SELECT avg(ellipsoidal_altitude - altitude) FROM location_samples WHERE session_id = :'sid';
SELECT min(number_of_steps), max(number_of_steps), count(*), count(DISTINCT sensor_segment_id) FROM pedometer_samples WHERE session_id = :'sid';
```

## 16. 완료 보고

- 변경·생성한 파일 목록과 모듈 구조.
- 빌드 결과, 실행한 테스트와 결과. 실패나 미실행 항목은 그대로 적는다.
- 사용한 SDK·라이브러리 버전. 이 문서의 API 이름과 달랐던 곳.
- 실기기 모델과 Android 버전, 선택된 자세 센서와 `attitudeReferenceFrame`, 편각, 실제 측정된 모션 주기.
- §15.3의 자세 확인 표 결과와 테스트 세션의 clientSessionId·서버 세션 ID.
- §12의 항목별 구현 여부.
- 기기에 없어서 확인하지 못한 센서, 실기기에서 확인하지 못한 항목.
- 이 문서와 다르게 구현한 부분과 그 이유.
