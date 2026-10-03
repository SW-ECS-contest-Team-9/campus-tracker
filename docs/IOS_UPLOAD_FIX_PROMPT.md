# iOS 앱 수정 프롬프트: WebSocket 연결 후 batch/marker가 전송되지 않음

---

## 2차 확인 (앱 1차 수정 후) — 먼저 이 부분부터 처리할 것

1차 수정 후 서버 로그:

```
23:26:08 raw_ws.collector.connected        C01
23:26:20 session:start                     ok (새 clientSessionId → 이전 세션 INTERRUPTED, 재연결 규칙 아직 미수정)
23:26:21 ~ collector:status                ok, 7초마다 정상 수신
telemetry:batch / marker:create            0건
```

앱이 보내온 collector:status 내용: `collecting: true`, location 63 · motion 3127 수집, **pendingBatchCount 515**, 서버 수신 batch 0.

결론: WebSocket 연결·인증·send·ACK 수신 루프는 정상 (status는 왕복 성공). **batch와 marker만 send 전에 실패**하고 있다. status payload는 정수/bool뿐이고 batch·marker에는 Double이 들어간다는 점이 차이다.

확인 순서:

1. **NaN/Infinity 인코딩 실패**: batch·marker를 인코딩하는 곳에서 에러를 로그로 출력하라. `JSONEncoder`/`JSONSerialization`은 NaN·∞가 하나라도 있으면 throw한다 (courseAccuracy, speedAccuracy, verticalAccuracy, ellipsoidalAltitude, pace/cadence, attitude 등). 모든 Double을 인코딩 전에 `isFinite`가 아니면 `nil`로 바꿔라. `try?`나 빈 `catch`로 삼키지 말 것.
2. **sessionId 대기 조건**: raw WebSocket의 `session:start` ACK에서 서버 sessionId는 `data.sessionId`에 있다 (Socket.IO 때처럼 최상위가 아님). pending batch/marker 전송이 "서버 sessionId가 있을 때만" 같은 조건에 막혀 있지 않은지, 이전 세션(INTERRUPTED 포함)의 pending도 그 세션의 sessionId로 보내는지 확인. 서버는 종료/중단된 세션의 batch도 받는다.
3. **flush 트리거**: status 타이머는 돌지만 batch flush는 호출되지 않을 수 있다. flush 호출 여부와 pending 515개 중 첫 항목을 보낼 때 어떤 분기로 빠지는지 로그로 확인.
4. **메시지 크기**: 한 메시지는 10 MB 이하, 배열당 20,000개 이하. pending을 하나로 합치지 말고 batch 단위로 순서대로 보내라.
5. **재연결 시 기존 clientSessionId 재사용** (아래 "세션/재연결 규칙" 참고).

수정 후 Xcode 콘솔에 첫 pending batch의 send/ACK 로그와, 실패한다면 정확한 에러 메시지를 출력하게 하라.

---

iOS 센서 수집 앱이 표준 WebSocket(`URLSessionWebSocketTask`)으로 서버에 연결되고 `session:start` ACK까지 받지만, 그 뒤 `telemetry:batch`, `marker:create`, `collector:status`를 **한 번도 보내지 않는다**. 그래서 앱의 pending uploads가 줄지 않고 Preview에 위치·마커가 나타나지 않는다. 원인을 찾아 고쳐라. 먼저 업로드 큐/WebSocket 전송/세션 관련 코드를 읽고 실제 호출 경로를 설명한 뒤 최소 변경으로 수정하고, 변경 파일과 이유를 요약해라.

## 서버에서 확인된 사실

서버는 WebSocket으로 들어온 **모든 메시지**를 (검증 실패 포함) 로그에 남긴다.

```
23:17:30 raw_ws.collector.connected   C01
23:17:36 raw_ws.message session:start ok:true delivered:true
(이후 어떤 메시지도 없음)
23:19:02 raw_ws.collector.disconnected code 1006
23:19:39 raw_ws.collector.connected   C01
         → 수 분 동안 iPhone→서버 총 910 bytes (= Upgrade 헤더 + ping 응답뿐)
```

- 연결 자체와 ping/pong은 정상이다 (Wireshark에 보이는 WebSocket 트래픽은 이것).
- `session:start`는 정상 처리된다. 같은 서버로 Node 테스트 클라이언트는 batch·marker·finish까지 모두 성공한다.
- 즉 **앱이 데이터 메시지를 send하지 않거나, send 직전에 실패하고 있다.**
- 추가로: 재연결할 때마다 **새 clientSessionId로 `session:start`를 다시 보내** 4분 동안 세션이 4개 생겼고, 서버는 이전 세션을 `INTERRUPTED`로 바꿨다.

## 의심 지점 (순서대로 확인)

1. **JSON 인코딩 실패를 삼키고 있음 (가장 유력)**
   - `JSONEncoder`는 `Double.nan` / `.infinity`가 있으면 throw한다. CoreMotion/CoreLocation 값이 NaN이 될 수 있다 (예: courseAccuracy, speedAccuracy, 일부 attitude/pace 값).
   - `do { try encoder.encode(...) } catch { }`나 `try?`로 실패를 무시하면 batch는 영원히 pending으로 남고 아무것도 전송되지 않는다.
   - 수정: 인코딩 전에 NaN/Infinity를 `nil`로 바꿔라 (서버는 null 허용). 인코딩/전송 실패는 반드시 로그로 남겨라.
2. **업로드 루프가 시작되지 않음**
   - 큐 flush가 특정 조건(예: `isConnected` 플래그, 서버 sessionId 매핑, 앱 상태, 타이머)을 기다리다 영원히 조건이 충족되지 않는지 확인.
   - WebSocket open + `session:start` ACK 이후 큐 flush가 실제로 호출되는지 로그로 확인.
3. **이전(Socket.IO) 전송 코드가 남아 있음**
   - batch/marker 전송이 아직 예전 Socket.IO 클라이언트나 다른 객체를 통해 나가고 있지 않은지 확인. 모든 이벤트가 같은 `URLSessionWebSocketTask`로 나가야 한다.
4. **`send` 완료 콜백 오류를 무시함**
   - `task.send(.string(json)) { error in ... }`의 error를 로그로 남겨라.
5. **ACK 수신 루프 부재**
   - `receive()`를 한 번만 호출하고 다시 호출하지 않으면 두 번째 이후 ACK를 못 받는다. 수신 처리 후 매번 `receive()`를 재호출해야 한다.
   - pending 삭제는 `{"type":"ack","requestId":...,"ok":true}`를 받은 뒤에만 한다.

## 반드시 지킬 프로토콜

- 연결: `webSocketURL` (로그인 응답), header `Authorization: Bearer <token>`, `X-Device-ID: <deviceId>`
- 모든 메시지는 UTF-8 JSON **text** frame: `{ "requestId": "<UUID>", "type": "<type>", "payload": { ... } }`
- 응답: `{ "type": "ack", "requestId": "<같은 UUID>", "ok": true, "data": {...} }` 또는 `ok:false` + `error { code, message, status, retryable }`
  - `retryable: false` → 같은 payload는 계속 실패: 로그 남기고 격리. `true` → 큐에 유지하고 재시도.
- `telemetry:batch` payload: `{ batchId, sessionId(서버), clientSessionId, createdAt, locations[], motion[], altimeter[], pedometer[] }`
  - 모든 timestamp는 소수초 포함 ISO-8601 문자열
  - motion: `{ sequence, timestamp, userAcceleration{x,y,z}, rotationRate{x,y,z}, gravity{x,y,z}, attitude{roll,pitch,yaw} }`
- `marker:create` payload: `{ markerId, sessionId, clientSessionId, timestamp, type, note, latitude, longitude, altitude, ellipsoidalAltitude, horizontalAccuracy, verticalAccuracy }`
- 서버는 세션 상태와 무관하게(FINISHED/INTERRUPTED 포함) batch·marker를 받는다. 이전 세션의 pending batch도 그 세션의 서버 sessionId로 그대로 보내면 된다.

## 세션/재연결 규칙 수정

- 재연결 시 **진행 중인 로컬 세션의 기존 clientSessionId로** `session:start`를 다시 보내라. 서버는 같은 clientSessionId면 새 세션을 만들지 않고 기존 sessionId를 돌려준다. 새 clientSessionId는 사용자가 Start를 새로 누를 때만 만든다.
- 서버 sessionId는 clientSessionId별로 로컬 저장소에 저장하고, pending batch/marker를 보낼 때 사용한다.
- 연결이 열리면: (진행 중 세션이 있으면) `session:start` 재전송 → ACK → pending 큐를 오래된 순서로 전송.

## 디버그 로그 (Xcode 콘솔)

다음을 출력해라 (토큰 전체는 출력 금지):
- WebSocket 상태 변화와 close code/reason
- 큐 flush 시작/종료, pending 개수
- 각 send: type, requestId, batchId/markerId, payload 크기(bytes), send 완료 error
- 각 ACK: requestId, ok, duplicate, error.code
- JSON 인코딩 실패 시 어떤 필드가 문제였는지

## 완료 확인

서버 로그(`backend/logs/server.log`)에 다음이 찍혀야 한다.

```
raw_ws.collector.connected
raw_ws.message session:start ok:true
batch.received ...              ← 반복, pending이 줄어듦
raw_ws.message telemetry:batch ok:true
marker.created / raw_ws.message marker:create ok:true
```

연결이 끊길 때 로그의 `raw_ws.collector.disconnected`에 `bytesIn`과 `messages`(type별 개수)가 함께 기록된다. `messages`에 `telemetry:batch`가 있어야 정상이다. Preview에서는 C01 위치, 궤적, 마커가 실시간으로 나타나야 한다.
