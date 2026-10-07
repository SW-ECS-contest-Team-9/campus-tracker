# iPhone ↔ Server 계약 (v1)

서버 구현 기준: `backend/src/modules/*/*.dto.ts` (Zod 스키마가 단일 진실 공급원).

## 공통 규칙

| 항목 | 규칙 |
|---|---|
| 시간 | **ISO-8601 문자열 + timezone** (`2026-10-01T12:00:00.123Z` 또는 `+09:00`). 숫자(epoch) 불가. iOS: `ISO8601DateFormatter` + `[.withInternetDateTime, .withFractionalSeconds]` (20Hz motion은 소수초 필수). `JSONEncoder` 기본값(`deferredToDate`, 2001 기준 Double)은 **거부됨**. |
| UUID | `8-4-4-4-12` hex, 대소문자 무관 (`UUID().uuidString` 그대로 OK). 서버 응답은 소문자. |
| null | optional 필드는 생략 또는 `null` 둘 다 허용. |
| 좌표 | `latitude`/`longitude` 이름으로 분리 전송. 서버 내부 PointZ는 `X=longitude, Y=latitude, Z=height`. |
| 알 수 없는 필드 | 무시됨 (저장 안 됨). |

## REST

### `GET /health`
```json
{ "status": "ok", "database": "ok" }        // DB 장애 시 503 { "status": "degraded", "database": "error" }
```

### `POST /api/v1/collectors/login`
Request
```json
{ "collectorId": "C03", "deviceId": "B320489C-...", "platform": "ios",
  "deviceModel": "iPhone15,2", "systemVersion": "18.0", "appVersion": "1.0" }
```
- `collectorId`는 trim + 대문자화 (`" c03 "` → `C03`). `deviceId`는 `identifierForVendor`.
- 성공 200 (기본 만료 24h, `JWT_EXPIRES_IN`)
  ```json
  { "collectorId": "C03", "accessToken": "<JWT>",
    "socketUrl": "http://100.102.255.108:3000", "socketNamespace": "/collector",
    "webSocketURL": "ws://100.102.255.108:3000/ws/collector" }
  ```
  - `socketUrl`은 iPhone이 **이 로그인 요청에 사용한 주소(scheme://host:port)를 그대로** 돌려준 값. 앱은 소켓 주소를 하드코딩하지 말고 `SocketManager(socketURL: socketUrl)` + `socket(forNamespace: socketNamespace)`로 연결한다.
- 미등록 collector → 404 `COLLECTOR_NOT_FOUND`, 형식 오류 → 400 `VALIDATION_ERROR`

에러 형식 (REST 공통)
```json
{ "error": { "code": "SESSION_NOT_FOUND", "message": "Session not found", "details": {} } }
```

## Raw WebSocket `/ws/collector` (URLSessionWebSocketTask용)

Socket.IO 클라이언트 없이 표준 WebSocket(RFC 6455)으로 붙는 경로. 이벤트·검증·멱등성·ACK-after-COMMIT은 아래 Socket.IO `/collector`와 **완전히 동일한 서비스**를 사용한다.

### 연결
- URL: 로그인 응답의 `webSocketURL` (`ws://host:port/ws/collector`, TLS proxy 뒤에서는 `PUBLIC_BASE_URL` 설정 시 `wss://…`)
- Upgrade 요청 header 필수:
  ```http
  Authorization: Bearer <accessToken>
  X-Device-ID: <deviceId>
  ```
- 거부 시 upgrade 대신 HTTP 응답 + `{ "error": { "code", "message" } }`

  | status | code | 조치 |
  |---|---|---|
  | 401 | `TOKEN_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | 재로그인 |
  | 403 | `DEVICE_MISMATCH` (X-Device-ID 없음 또는 토큰 기기와 불일치) | 로그인에 쓴 deviceId 사용 |
  | 404 | `DEVICE_NOT_FOUND` (Collector ID 삭제/DB 초기화) | 재로그인, 404면 미등록 ID |
  | 404 | `WS_PATH_NOT_FOUND` | 경로 확인 |
- 서버는 15초마다 ping을 보내고 응답 없는 연결을 끊는다 (URLSessionWebSocketTask는 자동 응답).
- 서버가 Collector ID 삭제 시 close code `4004` ("Collector deleted")로 닫는다.

### 메시지 (UTF-8 JSON text frame)
요청
```json
{ "requestId": "uuid", "type": "telemetry:batch", "payload": { ...아래 Socket.IO 이벤트 payload와 동일... } }
```
`type`: `session:start` · `telemetry:batch` · `marker:create` · `collector:status` · `session:finish`

성공 ACK (`data` = Socket.IO ACK에서 `ok`를 뺀 동일 내용)
```json
{ "type": "ack", "requestId": "uuid", "ok": true, "data": { "batchId": "...", "receivedAt": "...", "duplicate": false } }
```
실패 ACK
```json
{ "type": "ack", "requestId": "uuid", "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "...", "status": 400, "retryable": false, "details": {} } }
```
- JSON이 아니거나 `requestId`/`type`이 없으면 `requestId: null`로 `INVALID_JSON` / `VALIDATION_ERROR` ACK.
- 모르는 `type` → `UNKNOWN_TYPE` (400).
- ACK는 DB COMMIT 이후에만 전송. ACK 전에 연결이 끊기면 재연결 후 **같은 batchId/markerId/clientSessionId로 재전송** (서버가 중복 제거, `duplicate: true`).
- 메시지 최대 10 MB.

검증 스크립트: `npm run check:raw-ws -w backend -- --server http://<host>:3000 --collector C02` (테스트 세션을 하나 만든다)

## Socket.IO `/collector`

### 연결 / 인증
- URL: `http://<Mac LAN IP>:3000`, namespace `/collector`, Socket.IO v4 (socket.io-client-swift 16.x).
- 토큰 전달 (아래 중 하나, 위에서부터 우선):
  1. handshake auth: `socket.connect(withPayload: ["token": accessToken, "deviceId": deviceId])` ← **권장**
  2. query: `.connectParams(["token": ..., "deviceId": ...])`
  3. header: `.extraHeaders(["Authorization": "Bearer <token>"])`
- `deviceId`가 토큰의 device와 다르면 거부. 거부 시 `connect_error`의 `data = { code, message }`
  - `TOKEN_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `DEVICE_NOT_FOUND` / `DEVICE_MISMATCH` → **다시 로그인 후 재연결**.
- collector 식별은 토큰으로만 함. payload의 collectorId는 사용하지 않음.
- **socket disconnect ≠ session 종료.** 서버는 끊김을 세션 종료로 처리하지 않음.

### ACK 규칙 (모든 이벤트 공통)
- 모든 이벤트는 `emitWithAck`로 보낸다. 서버는 **DB COMMIT 이후에만** ACK한다.
- `ok: true` ACK를 받으면 로컬 큐에서 삭제해도 안전하다.
- 에러 ACK
  ```json
  { "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "status": 400, "retryable": false, "details": {} } }
  ```
  - `retryable: true` (5xx, DB 장애 등): 큐에 유지하고 재전송.
  - `retryable: false` (4xx): 같은 payload는 계속 실패함 → 격리(로그) 후 큐에서 제거 권장.
  - ACK timeout: 저장 여부 불명 → **같은 batchId/markerId로 재전송** (idempotent).
- payload는 dictionary 또는 JSON 문자열 둘 다 허용.

### `session:start`
```json
{ "clientSessionId": "uuid", "deviceId": "device-uuid", "platform": "ios", "deviceModel": "iPhone15,2",
  "systemVersion": "18.0", "appVersion": "1.0",
  "sensorCapabilities": { "location": true, "motion": true, "altimeter": true, "pedometer": true },
  "startedAt": "2026-10-01T12:00:00.000Z",
  "strideCalibration": { "schemaVersion": 1, "source": "APPLE_HEALTH_WALKING_STEP_LENGTH",
    "aggregationVersion": "median_mad_v1", "sourcePolicy": "IPHONE_AUTOMATIC_V1", "stepLengthM": 0.74,
    "sampleCount": 84, "observedDays": 12, "dispersionM": 0.06,
    "windowStart": "2026-09-09T05:55:00.000Z", "windowEnd": "2026-10-07T05:55:00.000Z",
    "latestSampleAt": "2026-10-07T03:40:00.000Z", "computedAt": "2026-10-07T05:55:00.000Z" } }
```
- `startedAt`은 **선택(추가 필드)**: 오프라인에서 시작해 나중에 전송되는 경우 실제 시작 시각 보존용. 없으면 서버 시각.
- 같은 `clientSessionId` 재전송 → 기존 세션 반환 (idempotent).
- `strideCalibration`은 선택 입력이다. 서버가 평지 보폭 요약을 검사해 세션 시작 시 고정하며 오류·누락·오래된 자료는 fallback 처리한다. 같은 `clientSessionId` 재전송은 최초 결정을 유지한다. 성공 ACK의 `strideCalibration.status/reason`은 `ACCEPTED` 또는 `FALLBACK` 판정이다. `ACCEPTED`는 모든 걸음에 적용됐다는 뜻이 아니다.
- 같은 device의 다른 ACTIVE 세션은 `INTERRUPTED`로 바뀜 (앱 크래시 후 새 세션 대비).
- ACK `{ "ok": true, "sessionId": "server-uuid", "clientSessionId": "...", "startedAt": "...", "status": "ACTIVE" }`
- 에러: `DEVICE_MISMATCH`(403), `SESSION_CONFLICT`(409, 다른 collector가 쓴 clientSessionId)

### `session:finish`
```json
{ "sessionId": "server-uuid", "clientSessionId": "local-uuid", "endedAt": "..." }
```
- 이미 FINISHED면 그대로 성공 (idempotent). ACK `{ "ok": true, "sessionId": "...", "endedAt": "...", "status": "FINISHED" }`
- 에러: `SESSION_NOT_FOUND`(404), `SESSION_FORBIDDEN`(403), `CLIENT_SESSION_MISMATCH`(400)

### `telemetry:batch`
```json
{
  "batchId": "uuid", "sessionId": "server-uuid", "clientSessionId": "local-uuid", "createdAt": "...",
  "locations": [{
    "sequence": 154, "timestamp": "...", "latitude": 37.1, "longitude": 126.1,
    "altitude": 82.4, "ellipsoidalAltitude": 105.7, "horizontalAccuracy": 3.2, "verticalAccuracy": 5.1,
    "speed": 1.2, "speedAccuracy": 0.5, "course": 90.0, "courseAccuracy": 10.0, "floor": null
  }],
  "motion": [{
    "sequence": 8302, "timestamp": "...",
    "userAcceleration": { "x": 0.01, "y": 0.02, "z": -0.03 },
    "rotationRate":     { "x": 0.1,  "y": 0.0,  "z": 0.0 },
    "gravity":          { "x": 0.0,  "y": -0.98, "z": -0.1 },
    "attitude":         { "roll": 0.1, "pitch": 0.2, "yaw": 1.5 }
  }],
  "altimeter": [{ "sequence": 12, "timestamp": "...", "relativeAltitude": 1.25, "pressure": 100.9 }],
  "pedometer": [{ "timestamp": "...", "numberOfSteps": 120, "distance": 84.2, "currentPace": 0.6,
                  "currentCadence": 1.9, "floorsAscended": 0, "floorsDescended": 0 }]
}
```
- 배열은 모두 선택, 생략/`null`/`[]` 허용. 배열당 최대 20 000개.
- `sequence`: 세션 내 센서별 단조 증가 정수(0 이상). `(sessionId, sequence)` 중복은 조용히 무시.
- pedometer는 sequence가 없으므로 `(sessionId, timestamp)`로 중복 제거.
- pedometer `numberOfSteps`/`distance`는 **보수계 실행 단위(`sensorSegmentId`)의 누적값**이다. 같은 실행 안에서 0이나 더 작은 값(증분·스냅샷 값)을 섞지 않는다. 보수계를 다시 시작하면 새 `sensorSegmentId`를 보낸다.
  - 서버 퓨전은 같은 실행 안에서 이전 최댓값보다 작은 샘플을 무시한다(`BELOW_HIGH_WATER`, 원본은 그대로 저장). 거리는 최댓값을 넘은 증가분만 쓴다.
  - segment ID 없이 카운터가 다시 시작된 경우는 낮아진 값이 연속으로 증가할 때(3샘플) 새 기준으로 인정한다(`COUNTER_RESTARTED`). 그 전의 걸음은 한꺼번에 적용하지 않는다.
- `speed`/`course`/accuracy의 iOS 무효값(음수)은 그대로 보내도 됨 (원본 보존).
- 처리: 검증 → 소유권 확인 → `BEGIN` → `received_batches` 확인 → samples insert → `COMMIT` → ACK
- ACK `{ "ok": true, "batchId": "...", "receivedAt": "...", "duplicate": false }`
  - 이미 저장된 batchId 재전송 → 데이터 추가 없이 `duplicate: true`, 최초 `receivedAt` 반환.
- 세션 status와 무관하게 수락함 (finish 이후 도착하는 오프라인 batch도 저장).
- 에러: `SESSION_NOT_FOUND`(404), `SESSION_FORBIDDEN`(403), `CLIENT_SESSION_MISMATCH`(400), `BATCH_SESSION_CONFLICT`(409), `VALIDATION_ERROR`(400)

### `marker:create`
```json
{ "markerId": "uuid", "sessionId": "...", "clientSessionId": "...", "timestamp": "...",
  "type": "stairStart", "note": null, "latitude": 37.123, "longitude": 126.123,
  "altitude": 82.4, "ellipsoidalAltitude": 105.7, "horizontalAccuracy": 3.1, "verticalAccuracy": 5.2 }
```
- `type`: `entrance | intersection | stairStart | stairEnd | rampStart | rampEnd | elevator | stop | custom` (그 외 문자열도 저장됨, 최대 32자)
- `markerId` 재전송 → `{ "ok": true, "markerId": "...", "duplicate": true }`
- ACK `{ "ok": true, "markerId": "...", "duplicate": false }`

### `collector:status` (5–10초 주기)
```json
{ "sessionId": "...", "collecting": true, "locationSampleCount": 421, "motionSampleCount": 8302, "pendingBatchCount": 2 }
```
- DB에 저장하지 않음 (메모리 + preview 전달만). ACK `{ "ok": true }`

## Socket.IO `/preview` (브라우저, 서버 → 클라이언트)

인증 없음, CORS(`CORS_ORIGIN`)로 제한. 모든 이벤트는 DB COMMIT 이후 송신.

| event | payload |
|---|---|
| `preview:snapshot` | 연결 직후 1회 `{ collectors: CollectorState[], serverTime }` |
| `collector:connected` / `collector:disconnected` / `collector:status` / `collector:created` | `CollectorState` |
| `collector:removed` | `{ collectorId, sessionIds }` |
| `session:started` / `session:finished` | `SessionView` (`GET /api/v1/sessions/:id`와 동일, INTERRUPTED도 `session:finished`) |
| `position:fused` | 파생 fusion 결과 1개 (약 1 Hz, `ACTIVE_FUSION_VERSION`만), v2 진단 필드 포함: `{ collectorId, sessionId, fusionSequence, longitude, latitude, ellipsoidalAltitude, heading, horizontalConfidence, verticalConfidence, overallConfidence, gpsHorizontalAccuracy, gpsVerticalAccuracy, source, algorithmVersion, timestamp }` |
| `fusion:reprocessed` | `{ sessionId, collectorId, algorithmVersion, count }` — 해당 version 결과가 통째로 재계산됨, REST로 다시 받을 것 |
| `fusion:sensor-events` | `{ sessionId, collectorId, algorithmVersion, events }` — fusion-v3.1의 앵커·추적 상태·센서 품질 판정 |
| `location:update` | `{ collectorId, sessionId, sequence, longitude, latitude, altitude, ellipsoidalAltitude, horizontalAccuracy, verticalAccuracy, timestamp }` — 새로 저장된 point마다 1개 |
| `marker:created` | `{ collectorId, markerId, sessionId, timestamp, type, note, latitude, longitude, altitude, ellipsoidalAltitude, horizontalAccuracy, verticalAccuracy }` |

Motion / altimeter / pedometer raw data는 preview로 보내지 않는다.

`CollectorState` (`latestFused`: 최신 `position:fused`와 같은 필드)
```json
{ "collectorId": "C03", "socketConnected": true, "connectionCount": 1, "activeSessionId": "...",
  "lastSeenAt": "...", "latestLocation": { "sessionId": "...", "sequence": 154, "...": "..." },
  "collecting": true, "sampleCounts": { "location": 421, "motion": 8302 }, "pendingBatchCount": 2,
  "receivedCounts": { "batches": 30, "locations": 60, "motion": 1200, "altimeter": 60, "pedometer": 30, "markers": 2 } }
```

## Preview REST

| | |
|---|---|
| `GET /api/v1/collectors` | 등록된 collector 전체 + 메모리 상태 (`CollectorState[]`) |
| `POST /api/v1/collectors` | ID 발급. body `{ "collectorId": "TEAM-A1" }` (선택, A–Z 0–9 `_` `-` 1–32자, 대문자화). 생략/빈 문자열이면 다음 `C<nn>` 자동. 201 `CollectorState`, 중복 409 `COLLECTOR_EXISTS` |
| `GET /api/v1/collectors/:collectorId` | 삭제 전 확인용 요약 `{ collectorId, createdAt, deviceCount, sessionCount, activeSessionCount, locationCount, markerCount }` |
| `DELETE /api/v1/collectors/:collectorId` | body `{ "confirmText": "제거하겠습니다." }` 필수 (정확히 일치, 아니면 400 `CONFIRMATION_REQUIRED`). ID와 기기·세션·모든 원본 데이터를 영구 삭제하고 연결된 iPhone socket을 끊음 (재연결 시 `DEVICE_NOT_FOUND`) |
| `GET /api/v1/sessions?collectorId=C03&status=ACTIVE&limit=50` | 최신순 `SessionView[]` (limit 1–500, 기본 50) |
| `GET /api/v1/sessions/:sessionId` | `SessionView` |
| `GET /api/v1/sessions/:sessionId/locations` | sequence 순 전체 point |
| `GET /api/v1/sessions/:sessionId/markers` | timestamp 순 marker |
| `GET /api/v1/sessions/:sessionId/fused-positions?algorithmVersion=fusion-v1` | fusion 결과, timestamp/fusionSequence 순 (기본 version = realtime version). v3.1은 최초 앵커 전까지 위치 출력을 만들지 않으며 상태·판정 이력은 `fusion-events`에서 조회 |
| `GET /api/v1/sessions/:sessionId/fusion` | 저장된 version별 개수/기간, version별 최신 `fusion_runs`(metrics 포함), realtime state 요약 |
| `GET /api/v1/sessions/:sessionId/fusion-events?algorithmVersion=fusion-v3.1` | 센서 추적 상태 변화, GPS 앵커 판정, 재획득 사유 등 위치 출력이 없어도 남는 진단 이력 |
| `GET /api/v1/fusion/versions` | `{ active: "fusion-v2.1", versions: [{ version, description, configHash }] }` |
| `POST /api/v1/sessions/:sessionId/fusion/reprocess` | body `{ "algorithmVersion": "fusion-v2.1", "force": true }` — raw 테이블에서 같은 엔진으로 재계산, 해당 version 결과만 교체 (raw·다른 version 불변). `force` 생략 시 같은 코드·config로 이미 처리됐으면 `{ skipped: true }`. 응답에 run metrics + validation 포함 |

fused position 공통 필드 외 **fusion-v2 진단 필드** (v1은 null): `gpsUsed`(true/false, 해당 1초 구간에 fix 없으면 null), `gpsRejectReason`(`POOR_ACCURACY`·`STATIONARY_LOCK`·`PHYSICAL_JUMP`·`INNOVATION_TOO_LARGE`·`INVALID_ACCURACY`), `gpsSequence`, `innovationDistance`(m), `stationary`, `headingSource`(`NONE`·`GPS_COURSE`·`GPS_DISPLACEMENT`), `horizontalUncertainty`(m, 휴리스틱). `source`에 v2 값 `GPS_REANCHOR`·`STATIONARY_HOLD`·`HELD` 추가.

**fusion-v2.1 추가 진단 필드**: `localX/localY/localZ`(m), `gpsQuality`(`EXCELLENT`·`GOOD`·`MARGINAL`·`POOR`·`UNUSABLE`), `pdrApplied`, `pdrRejectReason`(`NO_HEADING`·`NOT_INITIALIZED`·`NEGATIVE_DELTA`·`NOT_FINITE`·`OVERSPEED_CLAMPED`), `relativeAltitude`, `reanchored`, `reanchorReason`(`GPS_CLUSTER`·`GPS_TRACK`·`DIVERGENCE`), `divergenceDetected`. v2.1의 `headingSource`: `UNKNOWN`·`GPS_COURSE`·`GPS_TWO_POINT`·`YAW_DELTA`, `gpsRejectReason`에 `UNUSABLE_ACCURACY` 추가.

`SessionView`: `sessionId, clientSessionId, collectorId, device{deviceId, clientDeviceId, platform, deviceModel, systemVersion, appVersion}, startedAt, endedAt, status, sensorCapabilities, locationCount, markerCount, lastLocationAt`

# 공간 지도와 fusion-v3 / fusion-v3.1

- `GET /api/v1/spatial/map`은 활성 지도 버전, 캠퍼스 다각형, 건물 다각형을 WGS84 경도·위도 좌표로 돌려줍니다. 선택 지도는 세션에 고정되므로 `?mapVersionId=<id>`로 과거 버전을 조회할 수 있습니다.
- `GET /api/v1/sessions/:sessionId/spatial-decisions?algorithmVersion=fusion-v3`은 GPS마다 캠퍼스 판정, 앵커 채택 여부, 거부 사유, 건물 참고값을 돌려줍니다.
- `GET /api/v1/sessions/:sessionId/fusion-events?algorithmVersion=fusion-v3.1`은 위치 출력과 독립적으로 GPS 앵커 판정, 추적/방향 상태, 센서 공백·보행 대체·기압 변화를 반환합니다.
- `fusion-v3` 결과에는 `spatialMapVersionId`, `spatialStatus`, `spatialSegmentId`, `buildingId`, `buildingName`, `buildingMatchStatus` 진단 필드가 포함됩니다. 건물 필드는 위치 보정에 영향을 주지 않습니다.
- `fusion-v3.1`도 지도 버전을 고정하고 캠퍼스 출력 필터를 적용합니다. 고정밀 GPS 관측 묶음이 없으면 절대 위경도 출력은 만들지 않고 추적 상태와 센서 이력을 저장합니다. 기압 높이는 상대값이며 `ellipsoidalAltitude`와 층수를 대신하지 않습니다.
- v3를 켜려면 먼저 DB migration과 `npm run spatial:import`를 실행한 뒤 세션별로 v3를 재처리합니다. 실시간 기본 알고리즘 전환은 대표 경로 비교가 끝난 뒤 `ACTIVE_FUSION_VERSION=fusion-v3`로 설정합니다.
