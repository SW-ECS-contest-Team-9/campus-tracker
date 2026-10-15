# Xcode 전달용: Android 기준 iOS 수집·동기화 정합성 개선

아래 프롬프트 전체를 Xcode의 코딩 에이전트에 전달한다. 목표는 Android를 기준으로 iOS의 **입력 품질과 처리 계약을 맞추는 것**이다. Android 궤적 자체를 정답으로 취급하거나 GPS에 임의 오프셋을 더하는 작업이 아니다.

---

Campus Tracker iOS 앱을 수정하라. 먼저 현재 구현과 아래 Android 구현을 대조해 실행 계획을 제시한 뒤, 확인된 문제를 구현하고 검증하라. 계획 작성만 하고 끝내지 말라. 작업 중인 ARKit 및 다른 사람의 변경을 보존하고, Android와 서버 코드는 이 작업에서 변경하지 말라. 저장소가 iOS 폴더만 열려 있다면 상위 CampusTracker-Server 저장소의 Android 소스를 읽어라. 접근할 수 없으면 아래 기준을 사용하되 실제 코드를 대조했다고 주장하지 말라.

## 1. 실제 관측과 진단 범위

2026-10-13 22시대 KST에 읽은 서버 스냅샷이다. 현재 상태와 다를 수 있으므로 날짜와 세션 ID를 고정해 재확인하라.

- 프리뷰: http://100.93.21.92:5173/
- 읽기 API: http://100.93.21.92:3000/api/v1/sessions/{sessionId}
- iOS C04: `7fc9fe96-61d7-4373-bf08-fb3f95f1f6dc`, 21:54:31 시작. 마지막 센서 22:06:02, ACTIVE/OFFLINE, finishRequestedAt 없음, syncManifest 없음.
- Android C02: `ec40aab5-749f-43b5-8b17-3ce68ad62672`, 21:54:52 시작, 22:16:08 종료, FINISHED/FINALIZED, 서버와 클라이언트 샘플 개수 일치.
- 둘 다 motionUpdateHz=50, xTrueNorthZVertical, fullAccuracy 보고. C04는 motion 33,669개, 서버 보행 744걸음. 이번 사례를 기본 20 Hz 설정 문제나 보행 미검출로 단정하지 말라.
- C04: 배치 681개 중 역순 263개, 센서 구간 2개, motion 공백 1회/21.610초. Android: 역순 0개, 구간 1개, 최대 motion 간격 23ms.
- 같은 시간 구간의 GPS 보고 정확도 중앙값: C04 14.25m / C02 6.28m. 업로드 지연 중앙값: 4.90초 / 1.78초, p90: 205.78초 / 2.20초. C04 GPS 435개 중 151개가 15초 이상 늦었다. 동일 경로 여부는 확인되지 않았다.
- C04의 22:13 재처리는 ACTIVE이므로 전방 계산만 수행했다. Android는 종료 후 전체 평활화까지 수행했다. 두 결과를 같은 단계의 정확도 비교로 취급하지 말라.
- C04에서 사용자가 Stop을 눌렀는지, 공백이 OS 정지·프로세스 종료·앱 코드 중 무엇 때문인지는 아직 미확인이다. 원인을 로그로 확인해야 한다.

## 2. 먼저 읽을 파일

저장소 루트 기준 경로:

- iOS: `ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift` — 수집, PersistentUploadQueue, TelemetrySyncCoordinator가 함께 있음.
- iOS: `Services/SensorServices.swift`, `Models/SensorModels.swift`, `Persistence/ActiveCollectionStore.swift`, `Persistence/SensorDataRepository.swift`, `ContentView.swift`, `Info.plist` — 모두 위 CampusTracker 폴더 아래.
- iOS: `ARKit/ARKitModels.swift`, `ARKit/ARKitTrackingService.swift` 및 WebSocket 구현도 찾아 읽기.
- Android: `android/app/src/main/java/hoshi/campustracker/sync/TelemetrySyncCoordinator.kt`, `sync/UploadQueue.kt`.
- Android: 같은 패키지의 `collection/CollectionCoordinator.kt`, `collection/CollectionService.kt`, `CampusTrackerApplication.kt`, `core/Time.kt`, `sensors/AndroidSensors.kt`, `sensors/MotionAssembler.kt`, `sensors/MotionMath.kt`, `model/Models.kt`.
- 계약: `docs/API_CONTRACT.md`, `docs/ARKIT_VIO_SERVER.md`, 서버의 telemetry/session DTO와 실제 ACK 형식.
- 과거 `docs/IOS_SENSOR_FIX_PROMPT.md`는 10월 2일 사례다. 이미 해결된 항목은 재작업하지 말고 현재 코드와 10월 13일 데이터를 우선하라.

수집 → 측정 시각 변환 → sequence 발급 → 로컬 저장 → 배치화 → 전송 → 서버 ACK → 큐 제거 → 종료 확인의 호출 흐름을 그려라. Android와 iOS의 차이를 ‘확정 결함 / 의도된 플랫폼 차이 / 검증 필요’로 구분하라.

## 3. P0: 순서가 보장되는 영속 업로드 상태 머신

Android의 단일 inFlight, 오래된 항목 우선, ACK 오류 분류를 기준으로 구현하라.

1. iOS의 `firstIndex(where: !awaiting...)`는 이전 요청이 ACK 대기 중이어도 다음 요청을 선택할 수 있다. 타이머·재연결·콜백이 겹쳐도 기본 telemetry 업로드는 같은 세션에서 한 요청만 진행하도록 직렬 상태 머신을 만든다. 상태 전이는 하나의 actor 또는 직렬 executor가 소유한다.
2. 시작 핸드셰이크 성공 전에는 해당 세션의 데이터를 보내지 않는다. ACK 대기 중인 항목을 건너뛰어 최신 배치를 전송하지 않는다. 센서 시각은 생성 당시 그대로 유지한다. 과거 배치 수신 시각을 현재 측정 시각으로 바꾸지 않는다.
3. 재전송 시 batchId/markerId와 샘플 sequence를 유지한다. requestId는 시도별로 새로 만들 수 있다. 성공/중복 성공 ACK 후에만 해당 항목을 영속 큐에서 제거한다. 타임아웃·disconnect·늦은 ACK·중복 ACK가 상태를 두 번 완료시키지 않도록 요청 및 연결 세대 식별자를 검증한다.
4. ACK를 Bool로 축약하지 말고 code/retryable/details를 보존한다. 재시도 가능한 실패는 상한 있는 backoff를 적용한다. 재시도 불가능한 항목은 원본과 오류를 격리 보관하고 자동 재전송 루프에서 제외한다. 미전송 데이터가 있으므로 ‘전체 동기화 완료’라고 표시하면 안 된다.
5. `SESSION_NOT_STARTED` 등 실제 계약의 재핸드셰이크 오류는 동일 clientSessionId로 시작을 복구하고 제한된 횟수로 재시도한다. 인증 실패·소유자 불일치·유효성 실패를 같은 방식으로 무한 재시도하지 않는다.
6. 서버 주소와 collector/device 소유권을 큐에 연결한다. 계정·서버 변경 후 예전 데이터를 다른 대상으로 보내지 않는다. 기존 큐 파일을 읽을 수 있는 버전 마이그레이션이 필요하다.
7. ARKit 큐도 조사한다. telemetry → marker → ARKit → finish라는 전역 우선순위만으로 다른 세션이나 finish가 영구 대기하지 않게 한다. ARKit의 10/20 Hz 이벤트를 단일 ACK 직렬화하면 처리량이 부족할 수 있다. 생성률·ACK 왕복 지연·queue age로 검증하고, 기본 telemetry 순서와 세션 종료 장벽을 지키는 공정한 스케줄링/제한된 별도 전송창이 필요한지 결정한다. 서버 계약에 없는 배치 API를 임의로 만들거나 원시 데이터를 조용히 버리지 말라.
8. 디스크 저장 실패·인코딩 실패를 성공으로 취급하지 않는다. crash 시 재전송 가능한 내구성을 확보한다. 영속화 단위와 허용 가능한 아직 저장되지 않은 데이터 구간을 문서화한다.

## 4. P0: Stop과 종료·동기화 완료를 분리

- Stop 시 센서 종료 경계와 마지막 콜백을 직렬화하고, 마지막 버퍼·sampleCounts·lastSequences·clientEndedAt·종료 요청을 내구성 있게 저장한다. 저장 실패 상태에서 복구 정보를 지우지 않는다.
- ‘측정 종료’, ‘전송 대기’, ‘서버 종료 확인’, ‘동기화 완료/보류’를 구분해 UI에 표시한다. 네트워크가 없어도 측정은 종료할 수 있고, 전송은 다음 실행에서 이어져야 한다.
- 해당 세션의 필요한 항목이 pending 또는 inFlight라면 finish가 먼저 완료되지 않도록 종료 장벽을 둔다. 격리된 데이터가 있으면 그 사실을 보존하고 완료를 과장하지 않는다.
- finish ACK만 받고 sessionStarts/serverSessionIds를 즉시 제거하면 남은 diagnostic이나 복구 업로드가 고립되는지 확인한다. 해당 세션에 필요한 모든 후속 ACK와 계약상의 syncComplete/manifest 확인이 끝난 뒤 정리한다. 기존 서버의 finish와 syncComplete 의미를 먼저 읽고 중복 상태 머신을 만들지 않는다.
- Stop 직후 강제 종료, ACK 유실, 서버 재시작 후에도 같은 clientSessionId로 복구한다. 이미 종료를 요청한 세션을 앱 재실행 때 자동으로 recording으로 바꾸지 않는다.
- 사용자가 Stop하지 않은 세션을 단순 offline만으로 종료 처리하지 않는다.

## 5. P1: 시간·sequence·센서 연속성

- Android처럼 원시 수집·순번 발급·배치화가 UI 작업에 밀리지 않도록 한다. iOS는 센서 콜백 queue가 별도여도 매 샘플을 main으로 넘겨 record하는지 확인한다. 순서가 필요한 작업은 전용 직렬 executor에 모으고 UI 갱신만 감속해서 MainActor로 전달한다. 무제한 Task 생성과 비동기 append 순서 역전을 피한다.
- iOS motion/altimeter의 native timestamp는 기존 boot-to-epoch 기준으로 변환하고, CLLocation.timestamp와 CMPedometer.endDate를 사용한다. 서버 수신 시각이나 callback 실행 시각으로 덮어쓰지 않는다. 시계 변경/재부팅 시 구간 변경과 진단을 남긴다. 실제 드리프트가 입증되지 않으면 고정 시간 오프셋을 추가하지 않는다.
- wire, 큐 파일, 원시 export에서 소수 초를 보존한다. 기존 ISO8601 데이터와 호환되게 읽고, 로컬 export의 초 단위 직렬화가 분석을 왜곡하지 않게 한다.
- 복구 시 snapshot sequence를 그대로 재사용하지 말라. Android의 +1000은 참고 사례일 뿐 무충돌 증명이 아니다. 이미 ACK 후 제거된 항목까지 고려하는 영속 high-water mark/사전 sequence 구간 예약 등으로 프로세스 종료 이후에도 새 샘플의 ID 재사용을 막는다. 단순히 현재 큐의 최대 sequence만 읽는 방식은 불충분하다. 기존 sampleCounts와 lastSequences 계약도 유지한다.
- 실제 센서 재시작에만 sensorSegmentId를 바꾸고 단순 WebSocket 재연결에는 바꾸지 않는다. 데이터 공백을 가짜 IMU 샘플로 채우지 않는다. CMPedometer 복구는 누적 기준과 HISTORICAL_RECOVERY를 보존하며 과거 걸음을 현재 시각의 이동으로 바꾸지 않는다.
- 앱 상태 전환, 권한 변화, 센서 시작/정지/error, 측정 시각 간격, callback 지연, 큐 최고 age, ACK 지연, retry, finish 요청/확인 등의 제한된 진단을 남긴다. 매 IMU 샘플마다 문자열 로그를 만들지 않는다.
- 위치 background 설정과 권한은 실제 상태를 보고하고 필요한 경우 기존 권한 흐름을 바로잡는다. iOS의 OS 제약 안에서 구현하고 Android foreground service/wake lock을 그대로 흉내 내거나 무중단 수집을 보장한다고 주장하지 않는다. 화면 잠금·백그라운드 실기기 측정으로 확인한다.

## 6. P1: 값 보정은 단위·기준계 검증부터

- Core Motion의 userAcceleration/gravity는 g, rotationRate는 rad/s, attitude는 rad이다. Android `MotionMath`의 부호 반전은 Android 센서를 이 계약에 맞추기 위한 것이다. iOS에 그대로 적용해 이중 변환하지 말라.
- 정지/화면 위·아래/세로·가로/알려진 좌·우 회전 fixture로 중력 방향, 수직 가속도 투영, yaw 변화 부호, wrap-around를 검증한다. 좌표 기준계·휴대폰 자세와 실제 보행 방위는 다르다. trueNorth 보고만으로 yaw를 보행 방향으로 단정하지 않는다.
- trueNorth → magnetic → arbitrary fallback을 실제 선택값과 함께 보고한다. Android 자기편각 보정을 iOS trueNorth에 다시 적용하지 않는다. 임의 heading offset·GPS 이동·높이 이동으로 C04 궤적을 억지로 맞추지 않는다.
- 고정밀 위치 설정을 Android와 대조하되 iOS의 업데이트 간격을 Android처럼 강제할 수 있다고 가정하지 않는다. 정확도·속도·방향의 무효 sentinel과 nil 처리에는 서버 계약을 따른다. 원시 좌표를 정확도가 나쁘다는 이유로 제거하거나 accuracy 값을 낮춰 보내지 않는다.
- 기본/복구 fallback motion rate는 서버의 현재 50 Hz 가정과 맞춘다. 기존 저장 설정 10/20 Hz의 처리 방침을 정하고 실제 선택값을 보고한다. 이번 C04는 이미 50 Hz였으므로 이 변경을 이번 문제의 해결 근거로 제시하지 않는다.
- iOS의 보수계 거리·cadence·Health 보폭은 유용한 입력이다. Android의 기본 보폭 0.72m를 강제 복제하거나 iOS 누적 거리를 임의 배율로 보정하지 않는다. 현재 C04의 학습 보폭 0.65m 자체는 오류로 입증되지 않았다.
- 기존 ARKit 좌표, 세션 구분, trackingState, pose 원본 보존을 유지한다. ARKit를 켜면 기존 fused 위치가 자동으로 개선된다고 설명하지 않는다.

## 7. 검증과 완료 기준

의미 있는 회귀 테스트를 작성하라. mock clock/transport/storage를 이용해 다음을 재현하고 수정 전 실패·수정 후 성공을 확인한다.

1. ACK를 지연한 상태에서 flush 타이머를 여러 번 실행해도 기본 telemetry가 앞 배치를 추월하지 않는다.
2. 서버 commit 후 ACK 유실 → 같은 batchId 재전송 → 서버 중복 성공. 원시 샘플은 1번만 저장된다.
3. retryable backoff, non-retryable 격리, 늦은 ACK, disconnect/reconnect가 무한 루프나 유실을 만들지 않는다.
4. 오프라인 수집 → Stop → 앱 종료 → 재실행 → 업로드/finish 완료. ID와 카운터가 유지되고 완료 전 정보가 삭제되지 않는다.
5. snapshot/큐/ACK 삭제 경계에서 강제 종료해도 새 샘플 sequence가 재사용되지 않는다.
6. ARKit on/off, 느린 ACK, 여러 세션의 backlog에서 처리량과 종료 장벽이 유지된다.
7. UI 부하에도 샘플 측정 시각·순서가 유지되며, 정지/회전 fixture의 단위와 부호가 맞는다.

실기기에는 동일 장소·동일 시간·유사한 휴대 자세로 Android/iOS 동시 수집 시나리오를 작성한다: 정지, 직선, 좌/우 회전, 계단, 엘리베이터, 화면 잠금, 백그라운드, 일시적 네트워크 단절 후 Stop/재실행. OS상 실행할 수 없는 시나리오는 미검증으로 남긴다.

비교 지표: 실제 dt 분포/공백, 배치 역순률, 측정→수신 p50/p95/max, queue age, 기대/서버 저장 개수, finish 완료 여부, 보행 수·보폭·방향 미확정 시간. 건강한 네트워크의 제한된 시험에서는 앱이 유발하는 역순과 sequence 재사용 0건, 성공 ACK 이전 큐 삭제 0건을 필수 기준으로 삼는다. GPS 정확도를 특정 m 이하로 개선하겠다는 보장은 하지 않는다.

마지막에 변경 파일·원인·Android 기준과의 차이·테스트 결과·미검증 실기기 항목·서버에 필요한 추가 계약을 보고하라. 실제 경로 기준점이 없다면 ‘정확도 개선 확정’ 대신 수집/동기화 지표 개선과 남은 불확실성을 보고하라.
