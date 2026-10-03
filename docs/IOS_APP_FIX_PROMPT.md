# iOS 앱 수정 프롬프트 (Claude/Codex에 그대로 붙여넣기)

---

이 iOS 센서 수집 앱은 REST 로그인은 성공하지만 Socket.IO 서버와 실시간 통신이 전혀 되지 않는다. 원인을 고치고, 서버 주소 하드코딩을 없애라. 먼저 프로젝트에서 네트워크/소켓/세션 관련 코드를 읽고 현재 구조를 파악한 뒤, 아래 요구사항을 기존 코드 스타일에 맞춰 최소 변경으로 반영해라. 수정 후 변경 파일 목록과 각 변경 이유를 요약해라.

## 1. 확인된 증상 (서버 로그 기준)

서버(Node.js + Socket.IO v4)는 iPhone 요청을 모두 기록하고 있다. 마지막 시도에서 iPhone(Tailscale `100.103.44.113`)이 보낸 것은 이것뿐이다.

```
GET  /health                      200
POST /api/v1/collectors/login     200   (collectorId C01, deviceId 36E81E44-...)
(이후 아무 요청도 없음)
```

- 서버는 `/collector` namespace 핸드셰이크, 기본 namespace `/` 접속, 엔진 레벨 연결 오류(잘못된 path·프로토콜)를 **모두 로그로 남기는데 아무것도 기록되지 않았다.**
- 즉 앱은 로그인 후 **이 서버로 Socket.IO 연결을 아예 시도하지 않았다.** 소켓 주소가 REST와 다른 값(하드코딩된 `localhost`, 이전 포트 `3001`, `https/wss` 등)으로 만들어지고 있을 가능성이 높다.
- 그런데도 앱 UI는 "연결됨/세션 진행 중"으로 표시된다 → 연결 상태 표시가 실제 소켓 이벤트가 아니라 앱 내부 상태에 의존하고 있다.
- 서버 DB에 세션이 0개다 → `session:start`가 서버에 도달한 적이 없다.

## 2. 서버 정보

- 개발 서버: `http://100.102.255.108:3000` (Tailscale) 또는 같은 Wi-Fi의 Mac LAN IP. **HTTP only** (TLS 없음).
- Socket.IO 서버 v4 (socket.io-client-swift 16.x 호환), namespace **`/collector`**.
- 로그인 응답에 서버가 소켓 주소를 내려준다 (iPhone이 로그인에 사용한 주소를 그대로 반환):

```json
POST /api/v1/collectors/login
{ "collectorId": "C01", "deviceId": "<identifierForVendor>", "platform": "ios",
  "deviceModel": "iPhone14,2", "systemVersion": "18.0", "appVersion": "1.0" }

200 → { "collectorId": "C01", "accessToken": "<JWT>",
        "socketUrl": "http://100.102.255.108:3000", "socketNamespace": "/collector" }
404 → { "error": { "code": "COLLECTOR_NOT_FOUND", "message": "..." } }
```

## 3. 수정 요구사항

### 3-1. 서버 주소 하드코딩 제거

- 코드 전체에서 `localhost`, `127.0.0.1`, 고정 IP, 고정 포트(`3000`, ``등),`https://`, `wss://` 하드코딩을 찾아 제거한다.
- 서버 주소는 **사용자가 설정 화면에서 입력한 host + port 한 곳**(예: `ServerConfig`)에서만 만든다. scheme은 `http`. 이 값을 `UserDefaults`에 저장하고 REST base URL은 여기서만 생성한다.
- **Socket.IO 주소는 직접 조립하지 말고 로그인 응답의 `socketUrl`과 `socketNamespace`를 사용한다.** (응답에 없을 때만 REST base URL로 fallback)

### 3-2. Socket.IO 연결

```swift
let manager = SocketManager(socketURL: URL(string: login.socketUrl)!,
                            config: [.log(true), .compress, .reconnects(true), .reconnectWait(2)])
let socket = manager.socket(forNamespace: login.socketNamespace)   // "/collector"
socket.connect(withPayload: ["token": login.accessToken, "deviceId": deviceId])
```

- `manager.defaultSocket`을 쓰지 말 것. 기본 namespace `/`는 서버가 이벤트를 처리하지 않는다.
- `SocketManager`는 강한 참조로 보관할 것 (지역 변수면 즉시 해제되어 연결이 끊긴다).
- `.forceWebsockets`, `.path`, `.secure` 등을 임의로 바꾸지 말 것 (서버 path는 기본값 `/socket.io/`).
- 토큰 인증은 handshake auth(`connect(withPayload:)`)를 사용한다. `deviceId`는 로그인에 쓴 것과 같은 `identifierForVendor`.

### 3-3. 연결 상태 표시는 실제 이벤트 기준

- `.connect` 이벤트를 받았을 때만 "연결됨"으로 표시. `.disconnect`, `.error`, `.reconnectAttempt`, `.statusChange`를 모두 처리해 UI와 로그에 반영한다.
- 인증 실패는 `connect_error`(Swift: `.error`)로 오며 data에 `{ code, message }`가 있다.
  - `TOKEN_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `DEVICE_NOT_FOUND` / `DEVICE_MISMATCH` → REST 재로그인 후 새 토큰으로 재연결.
  - `DEVICE_NOT_FOUND`는 서버에서 Collector ID가 삭제된 경우일 수 있다 → 재로그인이 404면 사용자에게 "등록되지 않은 Collector ID" 표시.
- 소켓 disconnect는 수집 세션 종료가 아니다. 로컬 수집은 계속하고, 재연결되면 대기 중인 데이터를 다시 보낸다.

### 3-4. 모든 이벤트는 ACK 기반 (`emitWithAck`)

- 연결(`.connect`) 이후에만 보낸다. ACK 타임아웃 10초 정도.
- 성공 ACK: `{ "ok": true, ... }`. 실패 ACK:
  ```json
  {
    "ok": false,
    "error": {
      "code": "...",
      "message": "...",
      "status": 400,
      "retryable": false
    }
  }
  ```

  - `retryable: true` → 큐에 유지하고 재전송. `false` → 같은 payload는 계속 실패하므로 로그 남기고 큐에서 격리.
  - 타임아웃(`NO ACK`) → 저장 여부를 모르므로 **같은 batchId/markerId로 재전송** (서버가 중복을 제거한다).

### 3-5. 세션 흐름

1. `session:start` (ACK 성공해야만 "세션 시작됨"으로 처리하고, 응답의 서버 `sessionId`를 저장)
   ```json
   { "clientSessionId": "<로컬 UUID>", "deviceId": "...", "platform": "ios", "deviceModel": "...",
     "systemVersion": "...", "appVersion": "...",
     "sensorCapabilities": { "location": true, "motion": true, "altimeter": true, "pedometer": true },
     "startedAt": "<ISO8601, 선택>" }
   → { "ok": true, "sessionId": "<서버 UUID>", "clientSessionId": "...", "startedAt": "...", "status": "ACTIVE" }
   ```

   - 오프라인에서 시작했다면 연결 후 `session:start`를 먼저 보내고(같은 clientSessionId 재전송은 기존 세션 반환), 받은 sessionId로 이후 batch를 보낸다.
2. `telemetry:batch` (1–5초 주기)
   ```json
   { "batchId": "<UUID>", "sessionId": "<서버 UUID>", "clientSessionId": "...", "createdAt": "...",
     "locations": [{ "sequence": 1, "timestamp": "...", "latitude": 37.1, "longitude": 126.9,
                     "altitude": 35.8, "ellipsoidalAltitude": 59.3, "horizontalAccuracy": 5.0,
                     "verticalAccuracy": 8.0, "speed": 1.2, "speedAccuracy": 0.5,
                     "course": 90, "courseAccuracy": 10, "floor": null }],
     "motion": [{ "sequence": 1, "timestamp": "...",
                  "userAcceleration": { "x": 0, "y": 0, "z": 0 }, "rotationRate": { "x": 0, "y": 0, "z": 0 },
                  "gravity": { "x": 0, "y": -1, "z": 0 }, "attitude": { "roll": 0, "pitch": 0, "yaw": 0 } }],
     "altimeter": [{ "sequence": 1, "timestamp": "...", "relativeAltitude": 0.0, "pressure": 101.2 }],
     "pedometer": [{ "timestamp": "...", "numberOfSteps": 10, "distance": 7.1, "currentPace": 0.6,
                     "currentCadence": 1.8, "floorsAscended": 0, "floorsDescended": 0 }] }
   → { "ok": true, "batchId": "...", "receivedAt": "...", "duplicate": false }
   ```

   - batch는 ACK `ok: true`를 받은 뒤에만 로컬 큐에서 삭제.
   - `sequence`는 세션 내 센서별 0 이상 단조 증가 정수.
   - `ellipsoidalAltitude`(CLLocation.ellipsoidalAltitude)를 반드시 포함 (지도 높이에 사용).
3. `marker:create` → `{ markerId, sessionId, clientSessionId, timestamp, type, note, latitude, longitude, altitude, ellipsoidalAltitude, horizontalAccuracy, verticalAccuracy }`
4. `collector:status` (5–10초 주기) → `{ sessionId, collecting, locationSampleCount, motionSampleCount, pendingBatchCount }`
5. `session:finish` → `{ sessionId, clientSessionId, endedAt }`

### 3-6. 날짜 인코딩

- 모든 timestamp는 **소수초 포함 ISO-8601 문자열**. `JSONEncoder` 기본값(2001 기준 Double)은 서버가 거부한다.
  ```swift
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  encoder.dateEncodingStrategy = .custom { date, enc in
      var c = enc.singleValueContainer(); try c.encode(f.string(from: date))
  }
  ```
- Socket.IO로 보낼 때는 Codable → JSON → `[String: Any]`로 변환해서 emit (JSON 문자열을 그대로 보내도 서버가 받지만 dictionary 권장).

### 3-7. ATS

- 서버가 HTTP이고 Tailscale `100.x` IP를 쓰므로 `NSAllowsLocalNetworking`만으로는 부족하다. 개발 빌드 `Info.plist`에 `NSAppTransportSecurity` → `NSAllowsArbitraryLoads = YES` (Debug 전용 구성 권장).
- 같은 Wi-Fi LAN IP를 쓸 경우 `NSLocalNetworkUsageDescription`도 추가.

### 3-8. 디버그 로그

- 콘솔에 다음을 남긴다: REST base URL, 로그인 응답의 socketUrl/namespace, 소켓 상태 변화, `connect_error`의 code, 각 emit의 이벤트명·batchId·ACK 결과(ok/duplicate/error code). 토큰 전체는 출력하지 말 것.

## 4. 완료 확인

서버 로그(`backend/logs/server.log`)에 순서대로 아래가 찍혀야 한다.

```
http POST /api/v1/collectors/login 200 (ip 100.103.44.113)
collector.handshake {"tokenFrom":"auth","deviceId":"36E81E44-..."}
collector.connected {"collectorId":"C01"}
session.started
batch.received {...}            ← 반복
```

- PC 프리뷰(`http://localhost:5173`)에서 C01이 `●`(연결) + `REC`로 표시되고, 세션 목록에 ACTIVE 세션과 point 수 증가가 보인다.
- Wi-Fi/Tailscale을 껐다 켜면 소켓이 자동 재연결되고, 쌓인 batch가 재전송되어 `batch.received` 또는 `batch.duplicate`가 찍힌다.
- 로그에 `socket.default_namespace` 경고가 보이면 `/collector` namespace를 쓰지 않은 것이다.
