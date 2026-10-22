# Xcode 전달용: 트래킹 1차 통합 후 복구·sequence·Stop 저장 결함 수정

아래 전체를 Xcode 코딩 에이전트에 전달한다.

---

CampusTracker iOS 앱의 트래킹 1차 통합 후 발견된 세 결함을 수정하고, 실제 호출 경로를 검증하는 회귀 테스트를 추가하라. 계획만 작성하고 끝내지 말고 구현·Build·전체 테스트까지 진행하라. 기존 미커밋 변경을 보존하며 reset하거나 이전 버전으로 되돌리지 말라.

직전 작업 보고는 앱 Build 성공, iPhone 13 Pro/iOS 27.0 시뮬레이터 테스트 57/57 통과였다. 이는 이전 실행 결과이므로 이번 변경의 통과 근거로 재사용하지 말고 다시 검증하라.

이번 범위는 다음 세 항목이다.

1. 재실행 후 Resume 경로의 clock anchor 초기화 누락.
2. motion sample의 sequence lease 예약 누락과 예약 저장 실패 처리.
3. Stop에서 원시 저장 실패 후 버퍼·복구 정보를 삭제하고 종료 완료로 처리하는 문제.

SQLite canonical store/migration, 전체 CollectionCore 이전, 전체 callback ingress 연결, ARKit 공정 스케줄러는 이번 수정 이후의 별도 작업이다. backend/frontend/Android는 수정하지 말라. 기존 서버 계약과 walking-frame optional 전송의 기본 비활성 상태를 유지하라. 운영 서버로 시험 데이터를 보내지 말라.

## 먼저 읽을 파일

- [CollectionCoordinator.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift>)
- [TrackingInfrastructure.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/TrackingInfrastructure.swift>)
- [SensorServices.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/SensorServices.swift>)
- [ActiveCollectionStore.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Persistence/ActiveCollectionStore.swift>)
- [SensorDataRepository.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Persistence/SensorDataRepository.swift>)
- [TrackingInfrastructureTests.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTrackerTests/TrackingInfrastructureTests.swift>)
- [SyncQueueTests.swift](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTrackerTests/SyncQueueTests.swift>)
- [기존 전체 구현 명세](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/IOS_TRACKING_IMPLEMENTATION_XCODE.md>)

경로가 다르면 해당 프로젝트의 같은 파일을 찾아라. 아래 함수 이름과 현재 동작을 확인하고, 이미 수정된 부분은 재작업하지 말라. 실제 작업 파일의 상태를 기준으로 판단하라.

## 1. Start와 Resume의 clock 초기화를 공통화

현재 `motionClockAnchor`, `altimeterClockAnchor`, `arkitClockAnchor`는 `startSession`에서만 생성된다. 새 프로세스에서 `resumeInterruptedCollection`을 호출하면 nil인 채로 센서를 시작한다. 이후 각 record 함수는 anchor guard에서 반환하므로 motion·기압·ARKit 데이터가 기록되지 않는다.

수정 요구:

- `prepareSensorRunClocks()` 등 공통 초기화 함수를 추출하고 **Start와 Resume 모두 센서를 시작하기 전에** 호출한다.
- 한 run의 새 anchor들을 먼저 지역 변수로 생성·검증한 다음 한 번에 적용한다. 일부 anchor만 초기화된 상태로 센서를 시작하지 않는다.
- `try?`로 초기화 실패를 숨기고 recording으로 진행하지 않는다. 오류를 호출자/UI/진단으로 전달한다. Resume 실패 때 기존 interrupted snapshot을 유지한다.
- 동일 run 안에서는 anchor를 고정한다. 일반 WebSocket reconnect에는 다시 생성하지 않는다. 실제 sensor run 재시작이나 Resume에서만 새 mapping을 준비한다.
- 기존 motion→walkingFrame 파생 시각의 동일 mapping을 유지한다. CM/ARKit domain에 첫 callback 지연을 자동 offset으로 적용하는 로직을 복원하지 않는다.
- record의 nil anchor/매핑 실패를 조용한 return으로 끝내지 않는다. 제한된 진단을 남기고 해당 run의 상태에 반영한다.

필수 검증은 helper의 `map()` 테스트만으로 끝내지 않는다. 저장된 interrupted 상태로 **새 coordinator를 생성 → 실제 Resume 진입점 호출 → synthetic capture 입력** 순서의 통합 테스트를 작성한다. 센서 객체는 injectable factory/source 또는 DTO 입력 seam으로 대체하고 실제 측위 하드웨어가 필요한 테스트를 시뮬레이터 통과 조건에 넣지 않는다.

## 2. sequence 예약 성공 후에만 motion ID 발급

현재 `record(motion:)`은 `motionSequence += 1` 후 샘플을 만들지만 `ensureLeased(stream: \.motion, ...)`를 호출하지 않는다. 다른 스트림에는 예약 호출이 남아 있다. crash 시 snapshot보다 뒤에 이미 전송한 motion sequence가 재사용될 수 있다.

수정 요구:

- motion 예약 호출을 복원하고, 단순 한 줄 추가에 그치지 말고 `SequenceLeaseStore`의 인코딩·읽기·쓰기 실패가 발급 경로에 전달되게 한다.
- 기존 `ensureLeased`를 throws 또는 동등한 Result API로 변경한다. 새 세션의 파일 부재와 기존 파일 손상/읽기 실패를 구별한다. 손상 파일을 빈 lease로 초기화해 계속하지 않는다.
- 모든 스트림의 예약 API 호출을 갱신한다. 후보 sequence를 계산하고 예약이 필요한 경우 저장 성공한 뒤에만 live counter를 advance하고 샘플을 로컬/업로드에 append한다.
- 예약 실패 시 candidate의 sample append·카운트 증가·manifest 증가가 없어야 한다. 센서를 제어된 중단 상태로 전환하고 오류를 표시한다. 실패 과정에서 Stop/복구 정보나 lease를 삭제하지 않는다.
- 기존 lease 경계의 의미와 `max(snapshotSequence, persistedLease)` 복구 규칙을 읽고 호환성을 유지한다. 번호를 1씩 꽉 채우려고 예약된 범위를 재사용하지 않는다.
- 마지막 manifest는 실제 sample sequence를 사용한다. 복구 후 새 sample이 없으면 예약 경계를 최종 sequence로 보고하지 않는다. 빈 스트림은 -1이다.
- 시험에는 lease 저장소·clock·센서 입력을 주입할 수 있게 한다. 샘플마다 실제 디스크 쓰기를 추가하지 말고 블록 예약 정책을 유지한다.

원하는 처리 순서:

```text
candidate = currentSequence + 1
ensureLeased(session, stream, candidate)  // 필요 시 저장; 실패는 throws
currentSequence = candidate
sample 생성 → repository append → upload append → sampleCounts 갱신
```

## 3. flush 실패를 finish·Stop까지 전달

현재 repository의 `flush`는 실패한 stream buffer를 유지하지만, 이를 호출한 `finish`는 결과를 확인하지 않고 sessions/counts/buffers를 전부 제거하며 성공 completion을 실행한다. coordinator도 repository 완료 전에 active snapshot과 lease를 삭제한다.

수정 요구:

- `flush`, `writeMetadata`, `finish`의 성공/실패를 전달하는 API로 바꾼다. 예를 들어 repository `finish` completion을 `Result<Void, RepositoryError>`로 바꾼다. 관련 protocol·mock·호출자를 모두 갱신한다.
- 일부 stream만 성공했다면 성공 stream의 저장 결과를 유지하고 실패 stream buffer만 보존한다. flush 또는 종료 metadata 쓰기가 실패하면 session/counts/미저장 buffer를 정리하지 않는다.
- append 과정의 인코딩 실패도 진단/오류로 전달한다. metadata 쓰기의 `try?`를 성공 처리로 숨기지 않는다.
- NDJSON append 도중 일부 write 또는 synchronize가 실패한 뒤 재시도하면 중복 append가 생길 수 있다. 저장 전 offset을 활용한 복구나 sample identity 검증으로 재시도가 이미 기록된 부분을 중복하지 않게 한다. 복구 자체가 실패하면 상태를 불확실/저장 실패로 유지하고 원본 파일을 보존한다.
- 센서는 Stop 요청 즉시 중단하되, 저장 결과를 기다리는 동안 `stopping` 또는 `storageFailure`를 표시한다. 네트워크가 연결돼야 측정을 멈출 수 있는 구조로 만들지 않는다.
- `pendingFinalization`에 고정된 session ID, endedAt, sampleCounts, lastSequences, 종료 사유를 유지한다. 같은 Stop 재시도에서 endedAt이나 sample ID를 새로 만들지 않는다.
- 로컬 저장 실패 시 active snapshot·lease를 삭제하지 않는다. Start/Resume로 같은 세션을 다시 recording으로 바꾸는 동작도 차단한다. 사용자는 같은 종료 저장을 재시도할 수 있어야 한다.
- `finishInterruptedCollection`도 같은 오류 처리와 종료 경로를 사용한다. 여기서 repository가 세션을 메모리에 load하지 않았다는 이유로 디스크 원본을 무시하거나 새로운 빈 세션으로 덮어쓰지 않는다.

종료 순서는 다음으로 정리하라.

```text
Stop 의도·종료 경계 확정, 새로운 기록 접수 차단
→ 센서 중단
→ pendingFinalization/종료 의도 보존
→ repository 마지막 원시 flush 및 종료 metadata 저장
→ 마지막 telemetry batch와 finish 요청을 영속 upload queue에 저장
→ 영속 저장 성공 확인
→ active capture snapshot 정리, 측정 종료/업로드 대기 표시
```

기존 `PersistentUploadQueue.save()`는 지연 저장이다. 이번 수정에서 종료 항목의 저장 성공을 확인할 수 있는 최소 `saveDurably`/completion barrier를 추가하라. 마지막 batch·finish의 ID와 manifest를 유지하고, older delayed snapshot이 barrier 뒤에서 최신 파일을 덮어쓰지 못하게 revision/저장 순서를 보장한다. 저장 작업은 별도 queue에서 수행하며 MainActor를 동기 파일 I/O로 막지 않는다. SQLite 전환은 이번 범위에 넣지 않는다.

Stop 의도 보존을 위해 ActiveCollectionState에 phase/종료 필드를 추가한다면 optional/default 및 `decodeIfPresent`로 이전 파일을 읽게 하라. 이미 Stop을 요청한 snapshot은 앱 재실행 뒤 센서를 자동 재개하지 않고 종료 저장·업로드 복구 대상으로 표시한다. 복구 snapshot과 소유권은 종료 요청이 영속 저장됐다는 근거가 생긴 뒤에 정리한다. lease는 보수적으로 보존해도 되며, 정리 때문에 재사용이 가능해지는 상태를 만들지 않는다.

이 수정은 완전한 crash durability나 전체 callback drain 구현을 뜻하지 않는다. `TrackingCaptureIngress`를 실제 callback에 연결하는 작업이 남았으면 그 사실을 완료 보고에 명시하라. 늦은 callback이 stopping/storageFailure에서 새 샘플을 append하지 않도록 최소 상태 gate를 적용하고, 다른 세션으로 귀속되는 문제를 해결했다고 과장하지 말라.

## 필수 회귀 테스트

가능하면 아래 결함은 수정 전 실패를 확인하고 수정 후 통과시켜라. coordinator·repository·transport 호출 경로가 연결된 시험을 포함하라.

| 시험 | 완료 기준 |
|---|---|
| 새 프로세스의 interrupted→Resume | 새 anchor가 생성되고 motion/altimeter/synthetic ARKit sample이 저장·업로드 경로에 도달 |
| Start→Stop→다른 run 및 일반 reconnect | 새 run은 새 anchor, reconnect는 기존 anchor 유지 |
| anchor 초기화 실패 | recording 진행 없음, 기존 interrupted 정보 유지, 오류 관측 가능 |
| motion 실제 record→crash→새 coordinator Resume | snapshot보다 오래된 상태에서도 이미 발급/전송한 sequence 재사용 0건 |
| lease 예약 write/decode 실패 | sample append·live counter/sampleCounts advance·manifest advance 없음 |
| Resume 직후 새 sample 없이 종료 | 예약 경계로 manifest가 증가하지 않으며 빈 스트림 -1 유지 |
| Stop 시 한 stream의 flush 실패 | 실패 buffer/복구 snapshot/lease 유지, 완료 상태·성공 callback 없음 |
| flush 성공 후 metadata 실패 | 저장된 raw 중복 없이 metadata 재시도, 완료 상태 조기 표시 없음 |
| append 중간 write/synchronize 실패→재시도 | NDJSON sample identity 중복/부분 record 손상 검출 또는 복구 |
| 동일 Stop 재시도·중복 Stop·중단 세션 종료 | session ID/endedAt/manifest/finish ID 유지, 종료 요청 중복 생성 없음 |
| 종료 upload queue 저장 실패·barrier 전후 재실행 | 실패 때 복구 정보 유지, 영속 finish 복구, older snapshot 덮어쓰기 없음 |
| 구버전 active/lease/queue 파일 | decode 성공 또는 명시적 복구 오류, 조용한 빈 상태 초기화 없음 |

실패 주입은 임시 디렉터리와 injectable 저장 계층을 사용한다. 전체 시스템의 디스크 권한을 바꾸지 말라. 시뮬레이터 ARKit 미지원은 synthetic source로 검증하고 실제 기기 ARKit/clock domain 검증은 별도 미검증 항목으로 남긴다.

## Build·테스트·완료 보고

- 현재 실제 app/test target과 scheme을 확인해 Build와 전체 테스트를 실행한다. 기존 57개 테스트를 보존하고 새 회귀 테스트를 포함한다.
- 실기기 test target 서명이 미설정이면 가능한 시뮬레이터로 검증한다. 실기기 성공으로 보고하지 말고 서명 제한을 명시한다. 이번 작업을 위해 사용자 서명 설정을 임의 변경하지 말라.
- `git diff --check`를 실행한다. 미커밋 변경과 새 파일을 모두 포함한 실제 diff를 검토한다.
- 완료 보고는 한국어로 작성한다. 세 결함별 수정 위치·새 호출 순서·추가 시험·전체 통과 수·Build 결과를 적는다.
- 특히 Resume anchor, 실제 motion lease 예약, 실패한 Stop의 정보 보존을 **호출 경로 테스트로 확인했는지** 명시한다.
- 남은 SQLite/CollectionCore/ingress/ARKit 작업, 현재 미저장 tail 정책, 실기기 clock/위치 품질 검증의 미실시 상태도 짧게 적는다. 이번 패치로 실제 GPS 정확도 개선이나 완전한 무유실 수집을 입증했다고 보고하지 말라.
