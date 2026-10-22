# Xcode 전달용: iOS 트래킹 보정 구현 명세

작성일: 2026-10-14 KST. 대상은 이 폴더의 CampusTracker iOS 앱이다. 아래 지시와 처리 로직을 Xcode 코딩 에이전트에 전달해 실제 앱에 통합한다.

이 문서는 [보정 설계](/Users/hoshi/Documents/CampusTracker-Server/docs/IOS_TRACKING_CORRECTION_PLAN_20261014.md)를 함수·상태·저장 transaction 수준으로 구체화했다. [Swift 참조 구현](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/ImplementationReference/TrackingCorrectionReference.swift>)에는 시간 매핑, 날짜 codec, callback 접수/Stop barrier, sequence 예약, 주기별 창 적격성, 업로드 ticket 검사 로직이 있다. 이 참조 파일은 앱 target 밖에 있다. 필요한 타입을 실제 Services/Persistence로 옮겨 통합한다. 전체 파일을 앱 target에 추가할 경우 기존 타입과 이름·책임 중복을 정리한다.

## 0. Xcode 에이전트에 전달할 작업 지시

> 현재 CampusTracker iOS 프로젝트에 아래 구현 로직을 적용하라. 먼저 현재 파일과 작업 트리 변경을 읽고 이미 구현된 부분을 보존한다. 파일 이름이 다르면 같은 책임의 구현을 찾아 적용한다. 이 문서의 1~10절을 구현하고 테스트하라. 서버 연동을 설명하는 11절은 iOS 준비와 계약 문서까지만 수행한다. Android·backend·frontend는 별도 작업 중이므로 수정하지 않는다. 운영 서버로 시험 데이터를 보내지 않는다. 계획 작성으로 끝내지 말고 앱의 실제 호출 경로에 연결하고 build/test 결과를 보고하라. 미커밋 변경을 reset하거나 덮어쓰지 않는다. 기존 서버에 없는 API를 호출하지 않는다.

보존할 현재 동작:

- 수집 중 `BestForNavigation`, 거리 필터 없음, 자동 위치 중단 꺼짐, background location 사용.
- Core Motion 원본 g/rad/rad·s⁻¹, 실제 reference frame과 센서 segment 보고.
- CMPedometer는 세션 시작부터 누적값. 복구는 `HISTORICAL_RECOVERY` 유지.
- Health 보폭 후보는 새 세션 시작 때 고정. Android 기본 0.72 m로 대체하지 않음.
- 서버 소유권, 같은 batchId/markerId 재시도, 영구 오류 격리, 마지막 sequence의 `-1` sentinel.
- ARKit의 frame reset/arSessionId 구분과 background pause.
- 기존 `SyncQueueTests`, `WalkingFrameEstimatorTests`, Health 테스트의 의미 있는 검증.

## 1. 파일과 실행 책임

아래 신규 이름은 제안 이름이다. 작은 파일로 나누되 중복 coordinator를 만들지 않는다.

| 파일 | 실행 위치 | 책임 |
|---|---|---|
| `Services/CollectionCoordinator.swift` | MainActor | Start/Stop/Resume 명령, 센서 시작/중단, UI snapshot |
| `Services/SensorServices.swift` | 위치는 MainActor, motion/altimeter 전용 callback queue | 권한·센서 실행, immutable DTO 생성 |
| `Services/CapturedSensorSample.swift` | nonisolated value types | native timestamp, callback 시각, 세션/구간/generation, 원시 값 |
| `Services/SensorClockMapper.swift` | collection executor | 고정 시간 매핑·검증 상태·보행축 파생 시각 |
| `Services/CollectionCore.swift` | 전용 직렬 DispatchQueue | 원시 처리, sequence, 보행축, 저장 버퍼, Stop barrier |
| `Persistence/CollectionStore.swift` | 전용 직렬 storage queue | SQLite transaction, raw·세션·upload ledger·lease |
| `Networking/TelemetryWireModels.swift` | nonisolated Codable | 기존 private wire 모델 이동, 공용 JSON codec |
| `Services/TelemetryUploadEngine.swift` | actor 또는 전용 직렬 executor | ACK 상태 머신, retry, owner/generation, 스케줄링 |
| `Networking/CollectorTransportAdapter.swift` | 현재 socket의 isolation 유지 | 기존 RawWebSocket을 upload engine에 연결 |

현재 앱 target은 `SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor`, `SWIFT_VERSION=5.0`이다. DTO/순수 계산/직렬 큐 전용 타입은 `nonisolated`와 `Sendable`을 명시한다. Core Motion/Location 객체를 unchecked Sendable로 포장해 넘기지 않는다. callback에서 숫자·Date·UUID·기존 Sendable 벡터로 복사한다. `@unchecked Sendable`은 참조 ingress처럼 lock 보호를 설명할 수 있는 제한된 클래스에만 사용한다.

`CollectionCoordinator`의 역할을 UI와 lifecycle 명령으로 줄인다. 원시 샘플마다 MainActor record를 호출하는 경로는 없앤다. UI는 0.2초 간격 snapshot으로 갱신한다. 업로드 engine에는 샘플 대신 **저장 commit 알림**을 보내고, engine이 저장된 행을 조회하도록 한다.

collection core를 직렬 큐 전용 클래스로 구현한다면 `@unchecked Sendable`의 근거는 모든 mutable state 접근을 collectionQueue 내부로 제한하는 것이다. 외부 API는 명령/DTO 제출만 허용하고 내부 처리에 `dispatchPrecondition(condition: .onQueue(collectionQueue))`를 둔다. UI는 immutable snapshot만 받는다. storage 호출은 collectionQueue에서 storageQueue로 수행하며 storageQueue가 collectionQueue/MainActor를 동기 호출하는 역방향 경로를 만들지 않는다. MainActor에서 파일 I/O를 기다리는 `queue.sync`는 금지한다.

## 2. 입력 DTO와 접수 순서

새 원시 모델의 개념 구조:

```swift
nonisolated struct CaptureMetadata: Codable, Sendable {
    let schemaVersion: Int                // 새 로컬 schema: 2
    let sessionID: UUID
    let segmentID: UUID
    let generation: UUID
    let nativeTimestamp: Double?          // CM/AR native 초. GPS/보행계는 nil 가능
    let measuredEpochFromSystem: Date?    // CLLocation.timestamp / CMPedometer.endDate
    let callbackUptime: Double
    let callbackEpoch: Date
    let appStateAtCapture: CollectorAppState
}

// enum의 associated values도 모두 immutable Sendable value type으로 정의한다.
// motion: acceleration/gravity/gyro/Euler/quaternion/magnetic
// location: lat/lon/altitudes/accuracies/speed/course/floor
// altimeter: relativeAltitude/pressure
// pedometer: endDate/cumulative steps+distance/cadence/captureSource
// arkit: arSessionId/sequence/frameTimestamp/position/quaternion/trackingState
```

`appStateAtCapture`는 lock 또는 같은 sensor executor에서 읽는 작은 snapshot으로 제공한다. callback에서 `UIApplication`이나 MainActor의 coordinator를 직접 읽지 않는다. app state 갱신 명령에도 순서를 부여한다.

각 스트림마다 `TrackingCaptureIngress` 한 개를 두고, 모두 **같은 collectionQueue**로 제출한다. 스트림별 context는 센서를 실제 시작하는 순간 만들고 callback closure에 상수로 캡처한다. 스트림마다 segmentID와 generation이 다르며, 같은 세션 ID를 공유한다.

```text
sensor callback
  1. 값과 native timestamp를 읽는다.
  2. callbackUptime/callbackEpoch를 즉시 캡처한다.
  3. 시작 때 캡처한 immutable context와 DTO로 ingress.submit한다.
  4. submit이 false면 닫힌/이전 generation callback이다.
     새 세션에 귀속하지 않고 제한된 drop 진단에 누적한다.
  5. submit의 process closure가 collectionQueue에서 core.process를 호출한다.
```

접수 ordinal 발급과 `queue.async` 제출은 **같은 lock 안에서** 처리한다. ordinal만 lock에서 받고 제출을 밖에서 하면 두 callback의 제출 순서가 바뀔 수 있다. 참조 ingress가 이 순서를 구현한다. 서로 다른 스트림의 센서 시각이 callback 순서와 같다고 가정하지 않는다. 순서는 접수·저장 순서이고, 서버 융합의 시간순 처리와는 별개다.

샘플 처리 로직:

```text
CollectionCore.process(captured, admission)
  guard admission.context == 실행 중 context
  guard state == recording 또는 이미 접수된 stopping drain
  validate finite 원시 값과 좌표 범위
  measuredAt = 스트림에 맞는 측정 시각
  pedometer는 서버와 같은 millisecond timestamp key로 중복을 먼저 검사
  같은 key가 이미 저장/대기 중이면 새 sequence를 발급하지 않고 중복 진단에 보존
  sequence = sequenceAllocator.issue(저장 성공이 보장되는 lease 예약)
  rawRecord = 원시 값 + measuredAt + capture metadata + sequence
  append rawRecord to pendingCommitBuffer
  update acceptedCounts/lastIssued/진단
  motion이면 보행축 estimator.process를 이 직렬 실행기에서 수행
  32 samples 또는 최초 미저장 표본 후 250 ms이면 commitPending()
  UI 요약은 200 ms마다 갱신 가능하도록 snapshot만 publish
```

motion estimator를 기존 `MotionService`에서 core로 옮긴다. 이동 기간 동안 양쪽에서 동시에 estimator를 돌리지 않는다. 센서 native timestamp는 지연되어도 그대로 보존한다. 중복·역행 IMU timestamp는 estimator frame을 reset하고 사유를 남긴다. raw를 검증 없이 시간 재작성하지 않는다.

보행계의 서버 dedupe key는 `(session, timestamp)`다. LIVE/복구 표본의 endDate가 wire의 millisecond 정밀도에서 같으면 sequence 발급 전에 중복을 검사한다. 기존 표본과 값이 다르면 중복 원본을 별도 audit에 보존하고 `PEDOMETER_DUPLICATE_CONFLICT`를 기록한다. 같은 timestamp에 새 sequence를 발급해 manifest 최대값만 높이면 서버는 새 표본을 버려 syncComplete가 어긋날 수 있다. 다른 스트림은 같은 timestamp만으로 임의 중복 제거하지 않는다.

## 3. ClockMapper 구현

`BootTimeDriftCorrector`의 첫 record 시점 자동 offset 채택을 제거하고 `TrackingClockAnchor` 기반 mapper로 교체한다.

시간 공식:

```text
CM 측정 UTC = epochAtAnchor + (nativeTimestamp - uptimeAtAnchor) + verifiedOffset
GPS UTC     = CLLocation.timestamp
보행계 UTC  = CMPedometerData.endDate
보행축 UTC  = owningMotion.measuredAt + (snapshotNativeTime - owningMotion.nativeTime)
```

anchor는 센서를 시작하기 전에 wall clock과 uptime을 짝지어 만든다. wall clock 읽기 전후 uptime의 중앙값을 사용한다. anchor는 sensor run 동안 고정한다. `Date()`의 이후 변화나 main 처리 지연으로 갱신하지 않는다.

clock domain 상태를 `.nominal`, `.verified`, `.uncertain`으로 구분한다. `.nominal`은 native timestamp가 uptime과 같은 boot-relative 기준이라는 초기 가정이며 실측 검증 완료를 뜻하지 않는다.

- 첫 sample의 callback UTC와 nominal 측정 UTC가 2초 이상 차이 나면 `CLOCK_MAPPING_UNCERTAIN`으로 기록한다. offset은 변경하지 않는다.
- callback residual, callback→core 지연, native dt를 따로 기록한다. residual만으로 지연과 clock 기준 차이를 분리할 수는 없다.
- nonzero `verifiedOffset`은 테스트에서 주입하거나 별도 clock-domain 검증 결과로만 설정한다. C04 한 세션에 맞춘 offset을 기본값으로 넣지 않는다.
- 실제 기기에서 nominal mapping이 잘못되었다고 입증되면 domain별 mapping을 구현하고 버전을 올린다. 그 결과가 나오기 전에는 불확실한 clock을 정상으로 표시하지 않는다.
- CMAltimeter와 ARKit mapping은 각 domain을 검사한다. CM 경험적 offset을 ARKit에 자동 복제하지 않는다.
- raw model에 `clockMappingVersion`, `clockDomain`, `clockQuality`, `verifiedOffsetSeconds`를 optional로 저장한다. 현재 서버에 없는 키는 로컬 기록/진단에만 사용한다.

보행축의 `estimatedAt/windowStart/windowEnd/expiresAt` 네 필드 모두 참조 코드의 `mapDerived`를 호출한다. `frameId`나 창 길이는 변경하지 않는다.

기존 clock correction을 사용한 구세션은 metadata와 원래 timestamp를 보존한다. 새 mapper로 구파일의 timestamp를 재계산해 덮어쓰지 않는다.

## 4. LocationService 상태와 Start

LocationService에 다음 상태를 추가한다.

```swift
// MainActor 소유
private var requestedActive = false
private var requestedContext: TrackingCaptureContext?
private var appliedConfiguration: LocationRunConfiguration?
```

권한 callback:

```text
locationManagerDidChangeAuthorization
  권한/accuracy snapshot 및 onAuthorizationChanged를 갱신한다.
  권한 거부/제한이면 실제 업데이트 중단, isActive=false, 진단.
  guard requestedActive && requestedContext != nil else return
  guard authorization == WhenInUse 또는 Always else return
  실제 수집 설정을 적용한 뒤 아직 inactive이면 startUpdatingLocation()
```

`stop()`은 `requestedActive=false`, context 무효화 후 manager 업데이트를 중단한다. 권한 요청 메서드는 수집 시작 메서드와 분리한다. `isActive`는 권한이 있다는 사실이 아니라 실제 업데이트를 시작한 상태를 나타낸다. `didFailWithError`를 구현해 code/domain을 기록하고 일시 오류와 권한 해제를 구분한다.

Start 순서:

```text
1. MainActor: lifecycleState가 idle/stoppedPendingSync인지 확인.
   이전 session의 stopping/storageFailure이면 새 Start 차단.
2. coordinator에서도 권한 상태 검사. notDetermined면 권한 흐름 후 사용자 Start 재실행.
   reducedAccuracy면 상태를 명시하고 선택한 계속 수집 정책을 기록.
3. core.beginSession: UUID, owner, 시작 UTC, 실제 설정, 각 stream context/anchor 준비.
4. storage transaction: session snapshot + session:start queue item 저장/COMMIT.
5. 성공 후 ingress.open. 센서 callback에 각 context를 상수 캡처.
6. MainActor: 실제 센서 시작. 성공한 스트림만 SENSOR_STARTED.
7. 실패 스트림은 SENSOR_START_FAILED, 해당 stream counts=0/lastRecorded=-1.
8. core 상태 recording, UI 수집 중. upload engine pump 알림.
```

센서 시작에 실패했다고 session:start 자체를 새 UUID로 반복 생성하지 않는다. 시작 실패를 같은 세션에 진단한다. 실행 중 네트워크 재연결에는 sensor context를 재생성하지 않는다.

## 5. 저장소: 원시 입력과 업로드 ledger의 한 transaction

이번 구현에서는 SQLite를 canonical store로 사용한다. 기존 JSON 저장에 barrier만 더하는 중간 상태와 동시에 운영하지 않는다. `SQLite3` 시스템 라이브러리로 구현하고 app target 링크를 확인한다. 구현에 쓰는 wrapper는 한 storage queue에서만 호출한다.

DB 위치: Application Support/CampusCollector/collection-v2.sqlite. `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `user_version` 기반 migration을 사용한다. 오류는 throws로 호출자에게 전달한다.

최소 schema:

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  collector_id TEXT NOT NULL,
  server_key TEXT NOT NULL,
  capture_state TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  snapshot_json BLOB NOT NULL,
  stop_intent_json BLOB,
  finalized_manifest_json BLOB
);
CREATE TABLE sequence_leases (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  stream TEXT NOT NULL,
  reserved_exclusive INTEGER NOT NULL,
  last_recorded INTEGER NOT NULL DEFAULT -1,
  recorded_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, stream)
);
CREATE TABLE upload_items (
  enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL,             -- PENDING / ACKED / QUARANTINED / HELD
  payload_json BLOB NOT NULL,
  error_json BLOB,
  UNIQUE(kind, item_id)
);
CREATE INDEX upload_pending ON upload_items(state, session_id, kind, enqueue_order);
CREATE TABLE raw_samples (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  stream TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  measured_at_ms INTEGER NOT NULL,
  payload_json BLOB NOT NULL,
  batch_id TEXT,
  PRIMARY KEY (session_id, stream, sequence)
);
CREATE TABLE migrations (
  source_name TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  imported_at_ms INTEGER NOT NULL
);
```

raw sample에는 로컬 metadata/보행축까지 보존한다. wire payload는 별도 변환으로 기존 서버 계약을 만족시킨다. 모든 SQL은 prepared statement에 값을 bind한다. `kind`를 포함해 start/finish처럼 같은 session ID를 쓰는 item도 구별한다.

`commitPending()`:

```text
BEGIN IMMEDIATE
  raw_samples에 원시 행 삽입; 충돌은 payload 동일 여부 확인
  스트림별 last_recorded/count 갱신
  세션 durable snapshot 갱신
COMMIT
성공 후에만 pendingCommitBuffer 제거/durableCounts 갱신
실패하면 buffer와 sequence를 유지; storageFailure 상태로 전환해 ingress 닫기
```

이미 발급된 sequence의 raw record 저장 재시도에서는 **같은 sequence**를 사용한다. 실패한 record에 새 sequence를 발급하지 않는다.

batch 생성은 기존 64 samples 또는 1초를 유지하고, transaction에서 아직 batch에 연결되지 않은 durable raw를 읽는다.

```text
BEGIN IMMEDIATE
  배치에 넣을 미연결 raw를 선택
  batchId 한 번 생성, wire JSON encode, upload_items(PENDING)에 삽입
  해당 raw_samples.batch_id를 batchId로 갱신
COMMIT
upload engine에 commit 알림
```

동일 raw를 두 batch에 연결하지 않는다. COMMIT 전 batch를 전송하지 않는다. encoded batchId와 sample sequence는 재시도·앱 재실행에도 유지한다.

`acceptedCounts`와 `durableCounts`를 구별한다. 평상시 미저장 tail은 최초 pending sample 후 250 ms 또는 32개를 기준으로 commit한다. 타이머는 collectionQueue의 DispatchSourceTimer를 사용하고 매 샘플마다 deadline을 뒤로 미루지 않는다. 프로세스/OS 중단 전 아직 commit하지 않은 tail은 유실될 수 있으므로 이것을 무유실 수집이라고 표시하지 않는다. background 전환·Stop에는 즉시 flush를 요청한다.

로컬 export는 SQLite raw를 읽어 NDJSON으로 만든다. 공용 `TrackingJSONCodec`으로 fractional ISO-8601을 보존한다. export 실패는 canonical raw를 삭제하지 않는다. 예전 NDJSON과 metadata.json도 세션 목록에서 읽되 기존 소수 초 손실을 임의 복원하지 않는다.

## 6. Sequence 발급·Stop·복구

### sequence

`reservedExclusive`는 처음으로 아직 예약하지 않은 번호다. 기존 lease 파일 값은 보수적으로 이 경계로 취급한다. 새 스트림 첫 발급은 1, 표본 없는 manifest 값은 -1이다.

```text
복구 lastIssued = max(snapshotLastIssued, durableLastRecorded, reservedExclusive - 1, 0)
candidate = lastIssued + 1
candidate >= reservedExclusive이면:
  newLimit = candidate + 200
  newLimit을 DB transaction으로 예약하고 COMMIT
  성공 후 메모리 limit 변경
lastIssued = candidate
return candidate
```

참조 `TrackingSequenceAllocator`를 사용한다. 저장 실패 때 상태가 advance되지 않는 로직을 유지한다. manifest는 예약 경계나 lastIssued가 아니라 **실제로 보존한 마지막 sample**에서 만든다. durable뿐 아니라 Stop 시 pending raw도 먼저 commit해야 한다.

### Stop

UI의 capture 상태와 sync 상태는 별도다.

```text
capture: idle / starting / recording / stopping / stopped / interrupted / storageFailure
sync: pending / uploading / finishAcknowledged / complete / incomplete / quarantined / held
```

Stop 순서:

```text
1. MainActor: captureState=stopping. Start/Resume 버튼 차단.
2. 각 stream ingress.close(context)를 호출해 새 callback 접수를 차단.
   각 close는 같은 collectionQueue에 자기 스트림 drain barrier를 넣는다.
3. 센서를 즉시 중단한다. 센서 stop callback 완료로 raw가 저장됐다고 가정하지 않는다.
4. 모든 ingress가 닫힌 뒤 collectionQueue에 최종 finalize barrier를 넣는다.
   이전에 접수된 모든 스트림 callback이 먼저 처리된다.
5. core: 마지막 raw flush → 미연결 raw batch 생성.
6. 단일 transaction:
     stopIntent(sessionID, cutoff, user_stop) 기록
     captureState=stopped
     실제 lastRecorded로 final manifest 저장
     동일 manifest/endedAt의 session:finish item 삽입
     마지막 session snapshot 저장
   COMMIT
7. 성공 후 UI에 측정 종료/전송 대기 표시. active capture context 정리.
   오류 시 storageFailure와 Stop 의도를 유지; 재시도할 마지막 raw/manifest 보존.
8. 업로드 engine은 기존 세션 start→raw→종료→syncComplete를 진행한다.
```

Stop 시점은 callback 접수 경계다. 측정은 이전이지만 close 이후 도착한 callback은 새 세션에 넣지 않고 late callback 진단에 누적한다. 모든 OS 미전달 표본까지 회수했다고 주장하지 않는다. session endedAt은 마지막 stream cutoff를 공통 collection clock으로 UTC 변환해 고정한다.

ACK와 종료 ledger가 남아 있는 동안 session/owner/lease를 삭제하지 않는다. 별도 active_collection.json 정리는 새 DB의 stopped+finish 저장 COMMIT 이후 가능하다. 디스크 쓰기 실패로 Stop intent를 저장하지 못한 채 프로세스가 죽으면, 다음 실행에 자동 recording 대신 복구 선택을 보여준다.

### 재실행 복구

- DB state stopped/stopIntent 있음: 센서 자동 시작 금지, 남은 업로드/finish 이어서 처리.
- DB state recording: interrupted로 표시, 사용자의 Resume 또는 종료 선택을 받음. offline만으로 종료하지 않음.
- Resume: 동일 session ID와 owner, 실제 새 sensor segment/generation, lease 안전 경계 사용. clock anchor는 새 run에서 준비. CMPedometer는 기존 session.startedAt부터 누적 query.
- 구간 복구 표본이 LIVE 표본과 같은 `endDate`라면 서버의 보행계 dedupe 의미를 유지한다. 기존 누적값을 작은 incremental 값으로 바꾸지 않는다.
- DB decode/무결성 실패: 파일 보존 및 복구 오류 표시. 빈 큐로 초기화하고 계속하지 않음.

## 7. 구버전 저장소 migration

새 DB 사용 전에 다음을 한 번 수행한다.

1. 기존 pending_uploads.json, active_collection.json, sequence_leases를 원본 보존 상태로 읽는다. fractional/초 단위 Date 모두 decode한다. source hash를 저장한다.
2. 하나의 transaction에서 session/owner/start payload, pending·격리 상태, IDs, sequence leases, finish ACK·syncComplete 상태를 이관한다. 기존 batch에 포함된 raw는 같은 batchId로 연결한다.
3. active snapshot에만 있는 정보와 기존 로컬 NDJSON의 sample identity를 대조한다. 이미 ACK 후 큐에서 사라진 표본도 raw/lease 근거를 고려한다. snapshot을 전체 원시가 남아 있다는 증거로 쓰지 않는다.
4. owner 없는 legacy 항목은 HELD_ORPHANED 상태로 보존한다. 현 계정으로 소유권을 추정해 보내지 않는다.
5. COMMIT 후 행 수·ID·최종 sequence·quarantine 상태를 검증하고 migration row를 기록한다. 원본은 `.migrated.backup`으로 보존한다. 중간 crash 후 다시 실행해도 unique key와 source hash로 중복 import하지 않는다.
6. 읽기/인코딩 실패가 있으면 원본과 오류를 보존하고 migration을 실패 처리한다. 성공한 것으로 기록하지 않는다.

기존 JSON의 쓰기 경로는 migration 성공 후 비활성화한다. 새 데이터는 SQLite 한 경로로 쓴다. 계정 변경·서버 변경에도 예전 데이터 owner를 변경하지 않는다.

## 8. 업로드 상태 머신과 ACK

참조 `TrackingRequestTicket`와 `TrackingDispatchGate`를 적용한다. ticket은 requestId/itemId/sessionId/collectorId/serverKey/connectionGeneration을 가진다.

`connectionGeneration`은 새 연결 시 증가한다. 연결 해제 시 이전 generation을 즉시 무효화한다. 송신 성공 callback, ACK, timeout, encoding completion 모두 ticket을 전달한다. 단순 현재 inFlight 여부만 검사하지 않는다.

```text
idle → encoding(ticket) → awaitingAck(ticket) → committingAck(ticket) → idle
                  실패 → retryWait 또는 quarantined
disconnect: encoding/awaitingAck를 무효화; item은 PENDING 유지
```

`pump()` 시작 조건:

```swift
guard connected, owner != nil,
      inFlight == nil, !storageMutationPending,
      retryNotBeforeUptime.map({ nowUptime >= $0 }) ?? true
else { return }
```

1. SQLite에서 현재 owner와 일치하는 가장 오래된 eligible item을 고른다.
2. 해당 세션 start ACK가 없으면 같은 clientSessionId의 session:start부터 복구한다.
3. 새 requestId ticket을 만들고 **인코딩 시작 전에** inFlight에 저장한다.
4. 인코딩 완료 시 현재 ticket·connectionGeneration·owner를 검사한다. 불일치면 전송하지 않는다.
5. 실제 송신 직전 ACK deadline을 설정한다. 인코딩에 시간이 걸렸다고 네트워크 ACK timeout을 먼저 시작하지 않는다.
6. ACK는 requestId와 ticket을 확인한 뒤 처리한다. 성공/duplicate success는 SQLite에서 item을 ACKED로 변경한다.
7. ACK ledger COMMIT이 끝날 때까지 storageMutationPending으로 새 pump를 막는다. 성공하면 다음 item, 저장 실패면 기존 PENDING item 유지 및 저장 오류 처리.

유효 ACK를 이미 받은 뒤 로컬 ACK 저장을 기다리던 중 연결이 끊기더라도, 확인된 **동일 item의 로컬 commit**은 완료할 수 있다. 네트워크 ticket 검사는 ACK 수신 시점에 했으며 로컬 transaction은 연결 상태와 독립적이다. 반대로 미확인 stale ACK가 새 ticket을 완료시키면 안 된다.

retry:

- `retryable == true`, transport 오류, ACK timeout은 같은 item ID로 재시도한다.
- 이번 패치에서는 기존 2초 delay를 monotonic `retryNotBeforeUptime`으로 보장한다. flush·commit 알림·진단 추가가 대기 시간을 우회하지 못하게 한다.
- SESSION_NOT_STARTED/SESSION_NOT_FOUND는 기존처럼 같은 clientSessionId 재-handshake 1회. 두 번째 실패는 격리한다.
- 영구 오류는 원본 item+AckError(code/message/status/retryable/details)를 저장해 QUARANTINED 처리한다. `details`는 안전한 JSON value 타입으로 보존한다.
- 같은 encoding 오류는 네트워크 transient 오류처럼 무한 반복하지 않는다. SERIALIZATION_FAILED로 원본/문제 필드 보존 및 격리한다.
- owner 변경은 encoding/awaitingAck ticket을 무효화하고 이전 item을 보존한다. ACKED COMMIT이 끝난 항목을 owner 변경 때문에 되살리지 않는다.

`session:finish`와 `session:syncComplete`:

```text
그 세션의 required raw/marker/ARKIT/종료 이전 진단이 ACKED인지 확인
→ finish 송신, finish ACK를 저장
→ 아직 남은 항목이 없고 quarantine=0이면 syncComplete 송신
→ 반드시 data.synchronized == true를 typed decode
→ false이면 incomplete+streams 차이 보존
→ missing/malformed data이면 protocol error; complete 표시 금지
→ true 및 자체 ledger 무결성 확인 후 complete
```

현재 서버 manifest는 각 스트림의 **최대 sequence**만 비교한다. 중간 표본의 유실을 검사하는 계약이 아니다. 따라서 최대 sequence가 같다는 이유만으로 로컬 pending/quarantined/lost raw를 무시하지 않는다. complete는 자체 ledger에서도 pending=0/quarantine=0/미저장 raw=0일 때만 표시한다.

finish/syncComplete ACK를 설명하는 후속 진단은 먼저 저장해 전송하고, cleanup 조건에서 pending 진단까지 확인한다. ACK 진단 생성→동일 ACK 생성의 재귀 루프는 만들지 않는다. 데이터와 동기화 이력은 세션 owner가 정리된 뒤에도 조회 가능하게 보존한다.

## 9. ARKit 공정성과 큐 상한

현재의 6000개 초과 oldest 삭제를 제거한다. pose도 SQLite의 영속 item으로 저장한다. 실험 초기에는 single inFlight를 유지하고 처리량의 부족을 사용자와 진단에 명시한다. 서버에 없는 ARKit batch API를 만들지 않는다.

구현할 scheduler:

- telemetry는 세션별 FIFO. 순서가 필요한 start/finish/syncComplete 장벽을 유지.
- 연속 telemetry 최대 4개 처리 후 eligible diagnostic/marker 1개를 처리하고, 다음 telemetry 전에 eligible ARKit 1개를 처리한다. ACK 시간 기준으로도 마지막 ARKit 송신 후 1초가 넘으면 eligible pose에 turn을 준다.
- pending session을 enqueue_order 순서로 순환한다. stopped 세션은 활성 세션 backlog에 영원히 밀리지 않게 별도 drain turn을 부여한다.
- finish는 자기 세션의 required item이 drain된 뒤에만 eligible이다. 다른 세션 backlog는 자기 finish의 장벽에 포함하지 않는다.

이 스케줄러는 공정성만 개선한다. 10~20 pose/s를 느린 single ACK 창으로 모두 처리할 수 있는 것은 아니다. 미전송 pose 6000개 또는 가장 오래된 pose age 120초를 초기 **중단 문턱**으로 사용한다. 둘 중 하나를 넘으면 MainActor에 ARKit capture pause 요청, 새 pose ingress 닫기, 저장된 pose 유지, `ARKIT_BACKPRESSURE_PAUSED` 표시·진단을 수행한다. telemetry 수집은 계속한다.

resume은 자동으로 반복하지 않는다. backlog가 3000개 미만/age 30초 미만이 된 뒤 사용자가 ARKit 재개할 수 있게 하고, 새 arSessionId로 reset한다. threshold는 성능 실험 후 조정한다. 데이터 discard 대신 중단 구간을 명시한다. 충분한 처리량은 별도 서버 batch/window 계약이 구현된 후에 평가한다.

## 10. WalkingFrameEstimator의 실제 처리 로직

기본값 `minimumSamples=75`를 고정 적격성으로 사용하지 않는다. 참조 `TrackingRatePolicy`를 실제 창에 연결한다.

이번 실험 시작값:

| 값 | 초기 설정 |
|---|---|
| 원시 창 | 2.5초 |
| 최소 원시 시간 span | 1.5초 |
| 원래 요청 주기의 slot coverage | 80% |
| 최소 원시 수 | max(12, ceil(requestedHz × 1.5 × 0.8)) |
| 허용 최대 원시 gap | 0.25초 |
| 분석 grid | 50 Hz, 원시와 분리 |
| snapshot 주기/만료 | 기존 0.2초/1초 |

이 값은 신호 품질을 보장하는 검증 완료 수치가 아니다. 기본값 그대로 실측·fixture를 추가한다.

```text
process(input)
  원시 finite/gravity norm/quaternion/gyro 검사
  timestamp 역행·중복·gap>0.25·segment 변경이면 reset(frameId 새 UUID)
  gyro로 referenceFromDevice 갱신, gravity로 pitch/roll만 약하게 보정
  gravity를 제거한 수평 acceleration을 같은 relative reference로 투영
  원시 time-value 창을 2.5초로 trim
  snapshot 시간 도달 전이면 return nil
  원시 span/count/slot coverage/gap 검사
  부적격이면 UNKNOWN + 품질 사유, axis=nil
  적격이면 원시 창에서 50 Hz 분석 grid 생성
  PCA covariance/eigenvalue/energy를 분석 grid에서 계산
  periodicity는 timestamp 균일 grid의 시간 lag로 계산
  ratio/energy/periodicity 미달이면 UNKNOWN 또는 AMBIGUOUS
  통과하면 axisDevice, AXIS_180, directionResolved=false 출력
```

grid 보간은 인접 원시값 사이에서만 선형 보간한다. 마지막 표본보다 미래로 extrapolate하지 않는다. gap>0.25초를 가짜 표본으로 메우지 않는다. 보간 표본은 원시 sampleCount·coverage·wire sample 수에 포함하지 않는다. slot coverage의 계산은 burst 표본 수만으로 빈 구간을 숨기지 않게 한다.

pose 판정은 먼저 기존 25°/0.8초를 보존하며 진단을 늘린다. `gravityTiltDelta`, `gyroTurnAngle`, `attitudeDelta`, `axisConsistency`를 구별해 코너에서 reset 빈도를 확인한다. 폰 자세 변화와 실제 보행 회전을 구별하는 검증 없이 문턱을 바꾸지 않는다. frameId 변경 이후 과거 snapshot을 이어 쓰지 않는다.

기존 quaternion/math 테스트에 **기본 설정의 10/20/50 Hz, jitter, duplicate, gap, 정지, 폰만 회전, 실제 U턴**을 추가한다. periodicity 문턱을 0으로 낮춘 fixture만으로 새 기본 설정 통과를 선언하지 않는다.

## 11. iOS에서 준비할 서버 연동과 후속 융합

이 단계는 iOS 단독 수정으로 실제 서버 방향 보정이 완성되지 않는다. [현재 계약 초안](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/WALKING_FRAME_SERVER_CONTRACT.md>)에 다음을 반영한다.

### optional motion payload

`MotionWireOptions.includeWalkingFrameV1`은 기본 false다. server DTO/DB/loader round-trip이 확인된 시험 서버에만 명시적으로 켠다. `sensorCapabilities.walkingFrameEnabled=true`만으로 서버 지원을 추정하지 않는다. 기존 서버가 unknown key를 버리는 상태에서도 ACK 성공이 나올 수 있다.

```json
{
  "attitude": {
    "roll": 0.0, "pitch": 0.0, "yaw": 0.0,
    "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
  },
  "magneticField": {
    "x": 0.0, "y": 0.0, "z": 0.0,
    "unit": "uT", "source": "CORE_MOTION_CALIBRATED", "accuracy": "HIGH"
  },
  "walkingFrame": {
    "schemaVersion": 1, "algorithmVersion": "gravity_gyro_pca_v1",
    "frameId": "00000000-0000-0000-0000-000000000001",
    "reference": "GYRO_GRAVITY_RELATIVE",
    "estimatedAt": "2026-10-14T00:00:02.500Z",
    "windowStart": "2026-10-14T00:00:00.000Z",
    "windowEnd": "2026-10-14T00:00:02.500Z",
    "expiresAt": "2026-10-14T00:00:03.500Z",
    "status": "AXIS_ESTIMATED", "axisDevice": {"x": 1.0, "y": 0.0, "z": 0.0},
    "directionResolved": false, "ambiguity": "AXIS_180", "confidence": 0.6,
    "sampleCount": 126
  }
}
```

위 값과 시각은 schema 예시다. 실제 보정된 시각과 신호 품질 값을 사용한다. 구버전 payload·queue·nil extension의 decode를 유지한다. snapshot 갱신 sample에만 walkingFrame을 붙이고 같은 snapshot을 50 Hz 전체 sample에 반복 전송하지 않는다. optional 숫자 필드도 finite를 확인한다.

### 서버 후속 로직 전달

서버 계약의 Required server work에 다음 처리 순서를 기록한다. Xcode의 이번 iOS 작업 이후 서버 작업에 전달할 내용이다.

```text
1. snapshot의 시각 유효성·frameId·status·axis norm 검사
2. estimatedAt과 같은 시각의 quaternion으로 axisDevice를 기준계에 변환
3. ±axis 두 후보 유지, raw yaw에 대한 phone→walk offset 관측
4. 독립적인 방향 anchor가 확정되기 전에는 후보 하나를 실제 진행 방향으로 단정하지 않음
5. 품질 불량/만료/frame 변경 때 기존 yaw 경로로 복귀하며 불확실도 증가
6. GPS 편향 대책은 시간 상관이 있는 fix의 총 가중치를 별도 variant로 제한
7. 실시간과 replay에 같은 optional 입력과 gate 판정 사용
```

anchor 후보 초기 조건은 설계서의 속도 0.8 m/s 이상·수평 정확도 10 m 이하·유효 courseAccuracy 20° 이하·3초 연속·이동 5 m 이상이다. 필요한 accuracy가 없으면 후보를 채택하지 않는다. confidence를 각도 σ로 바로 변환하지 않는다. 실제 U턴을 허용하고 GPS 좌표·보고 정확도·고도에 고정 offset이나 배율을 적용하지 않는다.

## 12. Xcode에서 추가할 검증과 완료 보고

| 테스트 파일 예 | 필수 검증 |
|---|---|
| SensorClockMapperTests | callback/main 지연에 map 불변, ±40초 검증 offset, derived 시각 일치, clock jump |
| CaptureIngressTests | 병렬 submit 순서, close barrier, 이전 generation, 새 세션 혼입 방지 |
| CollectionLifecycleTests | 권한 callback의 무요청 시작 방지, Start/Resume 내부 검사, Stop drain·중복 Stop |
| CollectionStoreTests | commit 전후 실패, buffer 유지, batch 원자적 생성, raw 중복, 손상 DB |
| SequenceAllocatorTests | 예약 실패 시 발급 없음, 오래된 snapshot/ACK 삭제/crash 이후 sequence 재사용 없음 |
| MigrationTests | 구버전 날짜·격리·owner·finish ACK 유지, 중복 migration, 중간 crash |
| UploadEngineTests | delayed/duplicate/lost ACK, backoff 중 flush, encoding 중 disconnect, owner 변경 |
| FinalizationTests | manifest 최대값으로 중간 유실 숨기지 않음, synchronized false/missing, ACK 후 진단 |
| WalkingFrameEstimatorTests | default config의 모든 지원 주기·jitter·gap·회전·U턴 |
| ArkitBackpressureTests | 공정한 turn, 6000 문턱, pause 때 기존 pose 유지, 재개 때 새 frame |

참조 구현의 호스트 검증:

[검증 기록](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/ImplementationReference/CHECK_RESULTS.json>)은 Swift 5 언어 모드, 기본 MainActor isolation, strict concurrency, warnings-as-errors로 참조 코드를 컴파일하고 7개 검증 묶음을 실행한 결과다. 1000개 병렬 callback 접수 순서도 확인했다. 이 결과는 참조 helper의 검증이며 iOS 앱 통합·SQLite migration·실기기 측위 검증을 대신하지 않는다.

```bash
python3 "/Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/ImplementationReference/run_reference_checks.py"
```

Xcode Build/Test는 실제 app target과 test target을 사용한다. 공유 MyApp scheme의 오래된 참조를 CLI에 그대로 고정하지 말고 현재 scheme/target을 확인한다. 새 파일이 프로젝트의 자동 동기화 group에 포함되는지 확인한다. 기존 module 이름과 Pods 구성을 유지한다.

완료 보고는 한국어로 작성한다. 변경 파일, 실제 callback→commit→upload→finish 경로, 통과한 테스트 수와 build 결과, 미실시 실기기 항목, clock domain 검증 상태, 미저장 tail 정책, 구버전 migration 결과, 서버 연동의 준비/활성화 상태를 포함한다. 위치 정확도 개선은 실기기 기준점 측정으로 판정한다.
