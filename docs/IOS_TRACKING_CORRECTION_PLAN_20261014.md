# Android 구현을 기준으로 한 iOS 트래킹 보정 설계

작성일: 2026-10-14 KST. 검토 기준: HEAD `a5d6c2a`와 현재 작업 트리의 미커밋 변경. **분석·설계 문서이며 앱 수정 완료 보고가 아니다.** 기존 iOS·서버 작업은 보존했다.

후속 산출물: [Xcode 구현 명세와 Swift 참조 로직](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/IOS_TRACKING_IMPLEMENTATION_XCODE.md>). 함수·상태 전이·저장 transaction·복구 절차를 이 명세에 구체화했다.

가장 먼저 고칠 것은 **센서 시간축, 수집 생명주기, 저장 완료 보장**이다. 그다음 보행축을 서버까지 연결하고, GPS 편향에 견디는 방향 추정을 실험한다. Android의 좋은 결과를 재현하려면 Android의 수집·전송 계약을 참고해야 한다. Android 좌표, 기본 보폭, 센서 부호 변환을 iOS에 그대로 복제하면 별도의 오류가 생긴다.

## 1. 비교 범위와 현재 상태

두 앱은 센서를 수집하고 서버로 보내는 클라이언트다. 최종 XY/Z 궤적의 보행 검출·방향 맞춤·GPS 융합·평활화는 공통 서버 `fusion-v4`가 수행한다. iOS에서만 수집 코드를 바꿔도 되는 항목과 서버 알고리즘 변경이 필요한 항목을 구분했다.

```text
Android: 센서 → collection HandlerThread → 단위/시간 변환 → 로컬 기록
                                             → sync 전용 스레드 → Room 큐 → ACK → 서버 fusion
iOS:     센서별 callback → MainActor record → 로컬 기록용 queue
                              → 메모리 batch → 지연 저장 JSON 큐 → ACK → 서버 fusion
         motion queue에서 WalkingFrameEstimator 실행 → 로컬 MotionSample/UI에만 추가
```

| 항목 | Android 기준 | 현재 iOS | 판단 |
|---|---|---|---|
| 위치 요청 | highAccuracy에서 높은 정확도, 요청 주기, batch 지연 0 | `BestForNavigation`, 거리 필터 없음, 자동 중단 꺼짐 | iOS 설정 상향은 이미 반영됨. 다시 구현할 항목 아님 |
| 수집 실행 위치 | 센서와 coordinator가 전용 HandlerThread 공유 | 모든 record가 MainActor를 거침 | UI 부하와 측정 시간 보정의 결합을 제거해야 함 |
| 업로드 순서 | 단일 inFlight, backoff 중 pump 차단 | 단일 inFlight·격리·소유권·syncComplete 있음 | 예전 동시 전송 결함은 이미 수정됨. 남은 경계 조건 검토 필요 |
| 복구 sequence | snapshot에 1000을 더해 복구 | 별도 sequence lease 사용 | iOS 설계를 유지하고 저장 실패 처리를 보강 |
| 센서 단위 | Android 값을 서버의 Core Motion 계약으로 변환 | Core Motion 원본 g/rad/rad·s⁻¹ | Android 부호 변환을 다시 적용하지 않음 |
| 보행 거리 | Android step counter는 거리 미제공 | CMPedometer 거리 및 Health 보폭 사용 가능 | iOS 거리를 보존. Android 기본 0.72 m 강제 금지 |
| 보행축 | 별도 PCA 보행축 없음 | 실험용 추정기 있음, 기본 OFF | 추정 안정성·시간축 수정과 서버 계약 구현이 선행 조건 |
| ARKit | 해당 스트림 없음 | 별도 pose 수집·전송 | 기본 융합 개선 여부와 업로드 부하를 별도로 평가 |

근거: [Android 실행 구조](/Users/hoshi/Documents/CampusTracker-Server/android/app/src/main/java/hoshi/campustracker/CampusTrackerApplication.kt:53), [위치 요청](/Users/hoshi/Documents/CampusTracker-Server/android/app/src/main/java/hoshi/campustracker/sensors/AndroidSensors.kt:87), [iOS 위치 설정](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/SensorServices.swift:47>), [iOS 콜백 연결](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:575>).

기존 문서와의 관계: [Android 정합성 요청](/Users/hoshi/Documents/CampusTracker-Server/docs/IOS_ANDROID_BASELINE_XCODE_PROMPT.md), [위치 품질 요청](/Users/hoshi/Documents/CampusTracker-Server/docs/IOS_LOCATION_QUALITY_XCODE_PROMPT.md)은 이전 구현을 기준으로 한 작업 지시다. 이 문서는 **현재 코드에서 남은 문제**를 다룬다. 고정밀 설정, UI의 시작 전 권한 검사, 단일 inFlight, sequence lease를 미구현으로 다시 분류하지 않았다.

## 2. 과거 실측이 말해 주는 것

[기존 C04/C02 비교 보고서](/Users/hoshi/Documents/CampusTracker-Server/docs/IOS_ANDROID_COMPARISON_20261013.md)의 10월 14일 추가 분석을 참고했다. 이번 작업에서 운영 DB를 다시 조회하지는 않았다.

- 동일 동선이라는 수집자 확인을 반영한 보고서에서 Android FINAL은 근사 기준이다. 측량 정답은 아니다.
- C04 iOS의 GPS는 센서 공백 이전 분별 중앙값 기준으로 Android 기준 궤적에서 23~35 m 벗어났고, 공백 이후에는 3~8 m였다. 권한 변화나 ARKit이 원인이라는 증거는 아직 없다.
- motion은 두 앱 모두 실제 50 Hz였다. C04에는 21.61초 공백이 있었고, 수신 순서 재현에서 관측 14,130개가 늦어서 제외됐다. 현재 코드의 10·20 Hz 결함은 이 과거 세션을 설명하지 않는다.
- C04 FINAL이 Android 근사 기준에서 전방 결과보다 더 멀어진 구간이 있다. 다수의 편향된 GPS에 방향을 다시 맞추면 평활화도 악화될 수 있다.
- 상대 Z 범위는 iOS 50.3 m, Android 50.4 m였다. iOS의 절대 높이 부재를 기압계 배율 오류로 볼 근거는 없다.

따라서 목표는 `입력 정합성 회복 → 새 실측 → 동일 단계 replay 비교 → 방향/GPS 가중 실험`이다. 과거 한 세션에 맞춘 고정 XY/Z 오프셋은 보정안으로 채택하지 않는다.

## 3. 우선순위

P0는 원시 입력의 시각·세션 귀속·복구 가능성을 손상시키는 항목, P1은 정확도 실험과 지속 수집 품질에 필요한 항목이다.

| ID | 우선순위 | 보정 대상 | 확인 수준 | 적용 위치 |
|---|---|---|---|---|
| T1 | P0 | 첫 callback 지연을 영구 시간 보정값으로 채택 | 순수 Swift 재현 | iOS clock/record |
| T2 | P0 | motion과 walkingFrame 시각 변환 불일치 | 순수 Swift·변환식 재현 | iOS record |
| T3 | P0 | 권한 callback의 무조건 위치 시작, Stop/새 세션 경계 | 코드 확인 | iOS LocationService/coordinator |
| T4 | P0 | 종료·sequence 예약·원시 파일의 저장 실패 처리 | 코드 확인, 강제 종료 시험 필요 | iOS persistence/sync |
| T5 | P1 | 로컬 export 소수 초 손실 | Foundation 재현 | iOS repository |
| T6 | P1 | 10·20 Hz에서 보행축 추정 불가능 | 현재 기본값으로 재현 | iOS estimator/settings |
| T7 | P1 | 보행축·quaternion이 서버 융합에 미연결 | wire/DTO/계약 확인 | iOS + 서버 |
| T8 | P1 | backoff 우회·인코딩 중 재연결·ARKit 적체 | 코드 확인, 부하 시험 필요 | iOS sync |
| T9 | P1 | 편향 GPS의 방향 재맞춤, 높이·보폭 검증 | 과거 보고서 + 현재 엔진 | 서버 실험 + 양 앱 실측 |

## 4. T1·T2: 시간축을 먼저 통일한다

### 확인된 동작

[BootTimeDriftCorrector](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:18>)는 첫 호출에서 `Date() - (bootTime + rawTimestamp)`가 2초보다 크면 그 차이를 이후 모든 샘플에 더한다. 호출은 센서 callback 진입 시점이 아니라 **main으로 넘어온 record 시점**이다. 첫 callback의 대기 시간이 3초면, 정상 측정 시각도 이후 계속 3초 늦어진다. Android의 보정도 첫 이벤트 기반 휴리스틱이므로 이 부분까지 정답으로 복제하면 안 된다.

[record(motion:)](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:668>)는 motion timestamp에는 이 보정을 적용하지만, `walkingFrame.estimatedAt/windowStart/windowEnd/expiresAt`에는 `bootTime + raw`만 적용한다. 보정값이 40초인 입력을 주면 동일 순간의 motion과 walkingFrame이 40초 차이 난다. 현재 보행축은 서버로 전송되지 않으므로 당장은 로컬 분석 결함이고, 서버 연동 후에는 만료·시간 대응 오류가 된다.

Apple은 `CMLogItem.timestamp`를 부팅 후 경과 초로 정의한다. 코드 주석의 “sleep clock 차이가 원인”이라는 설명만으로 특정 기기의 원인을 확정해서는 안 된다. [Apple CMLogItem timestamp](https://developer.apple.com/documentation/coremotion/cmlogitem/timestamp)

### 구체적 변경

1. 센서 callback 입구에서 `nativeTimestamp`, callback의 monotonic 시각, callback UTC를 캡처한다. record 대기 시간과 센서 자체의 전달 지연을 별도 지표로 둔다. 시간 매핑은 UI 실행 시각을 참조하지 않게 한다.
2. `SensorClockMapper`를 추출해 기준점·고정 offset·clock domain·검증 상태를 소유하게 한다. 정상 boot-relative 변환을 기본으로 유지한다. 첫 callback 하나가 늦다는 이유만으로 offset을 확정하지 않는다. 시계 기준 차이를 여러 표본과 위치/보행계의 측정 시각으로 검증한 경우에만 별도 보정을 적용한다. 단순 전달 지연과 clock offset을 구분할 근거가 없으면 `CLOCK_MAPPING_UNCERTAIN`을 남긴다.
3. 같은 motion에서 나온 보행축에는 **같은 변환**을 사용한다. 우선 수정식은 다음과 같다. `measuredAt`의 신뢰성은 1·2번에서 별도로 해결해야 한다.

```swift
// 같은 motion의 native timestamp에 대한 상대 차이를 보존한다.
func mapDerivedTime(_ raw: TimeInterval) -> Date {
    measuredAt.addingTimeInterval(raw - motion.timestamp)
}
snapshot.estimatedAt = mapDerivedTime(snapshot.estimatedAtSensorTimestamp)
snapshot.windowStart = mapDerivedTime(snapshot.windowStartSensorTimestamp)
snapshot.windowEnd = mapDerivedTime(snapshot.windowEndSensorTimestamp)
snapshot.expiresAt = mapDerivedTime(snapshot.expiresAtSensorTimestamp)
```

4. CMAltimeter와 ARKit도 clock domain을 확인한다. 현재 [ARKit mapping](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:748>)은 단순 bootTime 합산이다. 검증 없이 motion의 경험적 offset을 다른 센서에 복사하지 않는다. 장기적으로 raw timestamp와 mapping 버전을 원시 기록에 보존한다.
5. 시간 보정 기준이 달라지면 매핑 전후를 구간으로 구분하고 진단을 남긴다. 이전 샘플 시각을 덮어쓰지 않는다. 네트워크 재연결만으로 센서 구간이나 offset을 바꾸지 않는다.

**완료 기준:** 첫 main 처리에 3초 지연을 넣어도 측정 시각은 불변. 동일 motion과 snapshot의 `estimatedAt` 차이는 직렬화 오차 1 ms 이내. 상대 창 길이와 만료 기간 보존. clock 변경·앱 복구·센서 재시작 fixture에서 역행이나 원인 없는 offset 갱신이 없다.

## 5. T3: 위치 수집 의도와 callback 생명주기를 분리한다

[LocationService 권한 callback](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/SensorServices.swift:101>)은 권한이 있으면 항상 `startUpdatingLocation()`을 호출한다. 사용자가 Start를 요청했는지는 보지 않는다. Apple 문서상 이 callback은 manager 생성 때도 호출되므로, 수집 전 자동 시작과 Stop 이후 권한 변경에 따른 재시작 경로가 존재한다. 이것이 과거 C04 GPS 편향의 원인이었다는 뜻은 아니다. [Apple 권한 callback](https://developer.apple.com/documentation/corelocation/cllocationmanagerdelegate/locationmanagerdidchangeauthorization(_:))

또한 각 센서 callback은 session ID를 캡처하지 않고 main에서 처리할 때의 `activeSession`과 현재 segment를 읽는다. Stop 전 측정된 callback이 main에 늦게 들어오면 폐기될 수 있고, 다음 세션이 이미 시작됐다면 그 세션에 들어갈 수 있는 구조다.

구현 방향:

- `requestedActive`, 적용 설정, `runGeneration`을 LocationService에 둔다. 권한 callback은 상태를 갱신하고 **requestedActive일 때만** 수집을 시작한다. `stop()`은 먼저 의도와 generation을 무효화한다. 권한 해제·오류 때도 실제 상태를 갱신한다.
- 수집 상태를 `idle → starting → recording → stopping → stoppedPendingSync`로 명시한다. Start/Resume의 권한 검사는 UI뿐 아니라 coordinator 진입점에서도 수행한다. 위치 없는 센서 수집을 지원한다면 별도 선택과 상태로 명시한다.
- Android의 전용 collection executor를 참고해 `SensorSampleProcessor` 직렬 실행기를 만든다. sequence 발급, 시간 변환, session/segment 귀속, 버퍼링은 이 실행기가 소유한다. 센서 callback에서 immutable `CapturedSample(sessionID, segmentID, generation, nativeTime, values)`을 생성한다.
- Stop은 cutoff와 generation을 먼저 정하고 센서를 중단한다. 이미 접수한 유효 callback을 처리한 뒤 마지막 batch·manifest를 확정한다. cutoff 이후 callback 및 이전 generation은 새 세션에 넣지 않는다. 접수되지 못한 꼬리 구간은 진단으로 남긴다.
- UI에는 4~5 Hz 요약만 MainActor로 전달한다. actor를 도입하더라도 샘플마다 독립 Task를 생성해 실행 순서를 기대하지 말고, 순서가 보장되는 입력 채널/직렬 큐를 쓴다.
- Location `didFailWithError`, motion/altimeter의 현재 무시되는 error를 진단에 연결한다. 수신 중단과 낮은 GPS 정확도를 구분한다. 낮은 정확도만으로 주기적 재시작을 수행하지 않는다.

**완료 기준:** 권한 callback만으로 수집 시작 0건, Stop 후 재시작 0건, 빠른 Stop→Start에서 이전 generation 혼입 0건. UI 부하에도 센서 timestamp 순서와 원시 수가 유지된다. 시작/정지 이벤트는 실제 성공 여부·사유·generation을 포함한다.

## 6. T4·T5: 저장된 데이터가 재처리 가능한 원본이어야 한다

### 종료와 sequence 예약의 내구성

[PersistentUploadQueue.save](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:1272>)는 100 ms 지연 저장이고 성공/실패를 호출자에게 반환하지 않는다. [stopSession](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:282>)은 finish를 큐에 추가한 다음 active snapshot과 lease를 지운다. 서로 다른 저장 큐이므로 finish가 디스크에 기록되기 전에 복구 정보가 사라지는 crash window가 있다. 잦은 save가 지연 작업을 계속 취소할 수 있어 100 ms는 최대 유실 구간 보장도 아니다.

[SequenceLeaseStore.ensureLeased](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Persistence/ActiveCollectionStore.swift:159>)의 `try?`는 예약 저장 실패를 무시한다. 또한 매 샘플마다 파일을 다시 읽는다. 예약 개념은 유지하되 오류 경로와 main I/O를 고친다. [원시 repository flush](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Persistence/SensorDataRepository.swift:127>)도 쓰기 실패 뒤 버퍼를 비우므로 같은 범위에서 다룬다.

변경 순서:

1. 최소 수정은 `saveDurably() async throws`와 저장 barrier다. 마지막 샘플/finish/manifest의 기록 성공을 기다린 다음 active 상태를 종료하고 lease를 정리한다. 실패하면 Stop 의도와 미저장 상태를 보존하며 재시도 가능하게 한다. 네트워크 ACK를 기다려야 센서를 끌 수 있는 구조로 만들지 않는다.
2. sequence lease를 메모리에 캐시하고 새 블록을 **저장 성공한 뒤에만** 발급한다. 읽기 실패를 신규 빈 lease와 구분한다. 저장 불가 때는 데이터 완전성을 보장할 수 없음을 표시하고 제어된 수집 중단으로 전환한다.
3. 원시 파일 append 성공 전에는 버퍼를 지우거나 저장 개수를 증가시키지 않는다. 인코딩 실패와 파일 쓰기 실패를 진단으로 올린다.
4. 장기안은 Android의 행 단위 Room 큐를 참고한 SQLite 저장소다. 마지막 batch·finish·세션의 종료 의도·manifest를 한 transaction에 기록한다. 큐 전체 JSON을 매번 인코딩하는 비용을 없애고, 기존 파일은 검증·백업 후 이관한다. Android의 버퍼 삭제 순서나 `+1000` 복구 방식까지 복제하지 않는다.

**완료 기준:** 저장 실패, 마지막 batch/finish 기록 전후 강제 종료, ACK 유실에서 sequence 재사용 0건. “측정 종료”, “업로드 대기”, “서버 종료 확인”, “동기화 완료”를 구분한다. 저장 실패를 성공 상태로 표시하지 않는다.

### 로컬 export의 소수 초

[LocalSensorDataRepository](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Persistence/SensorDataRepository.swift:30>)와 ActiveCollectionStore는 `.iso8601`을 사용한다. 호스트 Foundation에서 123 ms와 143 ms의 Date를 이 방식으로 직렬화하니 동일한 초 문자열이 됐다. 반면 [wire encoder](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:2040>)는 fractional seconds를 보존한다. **서버로 간 기존 motion이 모두 초 단위였다는 결론은 아니다.** 로컬 파일로 재현하면 50 Hz 시간 정보가 손실된다는 문제다.

공용 fractional ISO-8601 encoder/decoder를 사용하고 이전 초 단위 파일도 읽는다. 새 로컬 schema에는 native timestamp도 보존한다. 이미 손실된 소수 초를 sequence로 추측해 실측값처럼 복원하지 않는다.

**완료 기준:** 20 ms 간격 원시 샘플의 저장/재로드 오차 ≤1 ms, 순서 보존, 구버전 파일 decode 성공.

## 7. T6·T7: 휴대폰 방향과 보행 방향을 분리해 보정한다

### 지금 보행축 기능을 켜도 서버 궤적은 달라지지 않는다

[MotionSample](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Models/SensorModels.swift:204>)에는 quaternion·자기장·walkingFrame이 있지만, [MotionPayload](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:1014>)에는 없다. [서버 MotionSample DTO](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/telemetry/telemetry.dto.ts:34)에도 없다. [기존 서버 계약 초안](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/WALKING_FRAME_SERVER_CONTRACT.md>)은 이를 의도된 schema 준비 단계라고 명시한다. 누락 버그로 단정할 항목은 아니지만, 실제 트래킹 보정에는 남은 연결 작업이 필요하다.

### 샘플 주기 결함부터 수정

[추정기 기본 설정](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/WalkingFrameEstimator.swift:143>)은 `windowDuration=2.5`, `minimumSamples=75`다. 현재 앱은 [10/20/50 Hz를 지원](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Models/SensorModels.swift:316>)하고, 기존 사용자 설정은 새 50 Hz 기본값으로 강제 이관되지 않는다.

20초 합성 입력의 실제 실행 결과:

| 입력 주기 | 창 안 최대 샘플 | AXIS_ESTIMATED / 출력 snapshot |
|---|---:|---:|
| 10 Hz | 26 | 0 / 81 |
| 20 Hz | 51 | 0 / 82 |
| 50 Hz | 126 | 88 / 95 |

[기존 estimator 테스트](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTrackerTests/WalkingFrameEstimatorTests.swift:5>)는 최소 표본 40, periodicity 문턱 0 등으로 기본값을 바꾼다. 해당 테스트가 통과해도 실제 기본 설정의 10·20 Hz 동작은 보장되지 않는다.

보정안:

- 창의 **시간 길이·샘플 밀도·최대 공백**으로 적격 여부를 판단한다. 예를 들어 최소 1.5초 관측과 지원 주기에 맞는 최소 표본 수를 함께 요구하되, 이 숫자는 시작 실험값이다. 단순히 75를 25로 낮추는 방식은 불규칙 입력을 구분하지 못한다.
- periodicity 계산은 균일 시간 격자 또는 timestamp 기반 lag를 사용한다. 현재 평균 rate로 index lag를 고르는 방식은 jitter·누락에서 왜곡될 수 있다. 이는 추가 검증 과제다.
- 기본 설정 그대로 10/20/50 Hz, jitter, 250 ms 초과 공백, 정지, 회전, 계단 fixture를 검증한다. 실제 표본이 50 Hz보다 적다고 가짜 원시 샘플을 업로드하지 않는다.
- 임시 운영 정책으로 보행축 실험을 50 Hz에서만 허용할 수 있다. 이 경우 UI와 capability에 제한을 명시하고 복구 경로에도 적용한다.
- 서버도 현재 [stepTimeBased 기본값이 false](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion.config.ts:549)이고 [50 Hz 필터 경로](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.engine.ts:410)가 있다. 앱 추정기 주기 수정과 별도로 replay A/B 후 서버 옵션 전환을 판단한다. 이번 문서만으로 운영 설정을 변경하지 않는다.

### 보행축을 방향 보정에 쓰는 설계

서버는 현재 [motion yaw 변화의 음수](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.engine.ts:363)를 누적하고, GPS 궤적 모양에서 방향 offset θ를 구한다. 폰만 수평으로 돌리면 중력 방향은 거의 같아 기존 자세 전환 판정이 놓칠 수 있다. 보행축은 이때 폰과 몸의 방향 차이를 추정하는 보조 관측으로 쓸 수 있다.

1. **전송·보존부터:** 계약 초안의 optional quaternion/magneticField/walkingFrame을 iOS wire, 서버 DTO, DB, raw loader, export, 실시간/replay에 연결한다. 초기에는 저장·진단만 하고 융합에는 미사용한다. capability에는 `walkingFrameCollected`, `walkingFrameTransmitted`, 서버의 사용 여부를 구별해 표시한다.
2. **시각과 좌표 검증:** snapshot과 같은 시각의 자세로 `axisDevice`를 기준 좌표계에 투영한다. 과거 snapshot을 현재 자세 quaternion과 바로 조합하면 안 된다. Core Motion quaternion의 실제 변환 방향과 진북/자북/arbitrary 기준은 알려진 자세 fixture로 확인한다. Android Euler 변환식을 다시 적용하지 않는다.
3. **양방향 가설 유지:** PCA는 `u`와 `-u`를 구별하지 못한다. `directionResolved=false`, `AXIS_180`을 유지하고 후보 방위를 둘 다 추적한다. confidence를 각도 표준편차나 정답 확률로 쓰지 않는다. PCA의 큰 축이 모든 휴대 자세에서 실제 진행축이라는 보장도 없다.
4. **폰-보행 offset 추적:** 기존 yaw 상대 방위에 보행축에서 얻은 offset 관측을 결합하되, quality가 낮거나 만료·frameId 변경·자세 전환이면 갱신하지 않는다. 기존 yaw 경로로 복귀하고 불확실도를 늘린다. offset의 시간 상수와 변화 제한은 회전·U턴 실측으로 정한다.
5. **부호 결정용 독립 근거:** 시작 실험값으로 GPS speed ≥0.8 m/s, horizontalAccuracy ≤10 m, courseAccuracy가 유효하고 ≤20°, speedAccuracy가 유효한 경우 속도 하한도 점검, 3초 이상 연속·누적 이동 ≥5 m를 후보 조건으로 둔다. 이는 현재 구현값도 보장값도 아니다. 여러 관측에서 같은 후보가 지지될 때만 부호를 확정한다. 조건이 부족하면 미확정 상태를 유지하고 실제 U턴을 허용한다.
6. **회전과 자세 전환 구분:** 현재 [25° quaternion 차이 판정](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/WalkingFrameEstimator.swift:227>)은 보행 중 코너 회전도 창 초기화로 처리할 수 있다. 중력 기울기 변화, 자이로 회전, 보행축 연속성, 자기장 품질을 함께 기록하고 코너에서의 미확정 시간을 측정한다. 회전 자체를 오류로 억제하지 않는다.

**완료 기준:** 같은 실제 직진에서 폰만 90°/180° 회전해도 궤적이 따라 꺾이지 않는다. 실제 90° 코너와 U턴은 유지된다. absent/invalid extension은 기존 동작과 같고, 실시간·replay에 동일 관측이 들어간다. 정확도 향상 판정은 현장 기준점으로 한다.

## 8. T8: 전송 병목이 보정 입력을 늦게 만들지 않도록 한다

이미 들어간 단일 inFlight는 유지한다. 남은 것은 다음 세 항목이다.

| 문제 | 코드 근거 | 변경 및 검증 |
|---|---|---|
| retry 대기 중 새 flush가 재전송 가능 | iOS `synchronize()`는 inFlight만 검사. Android `pump()`는 backoff도 검사 | `retryBackoff == nil`을 진입 조건에 포함. retryable ACK 직후 계속 샘플을 넣어도 2초 대기 전 송신 0건 |
| 이전 요청의 비동기 인코딩 완료가 재연결 후 송신될 수 있음 | `dispatch`의 encodingQueue→main 경계에 현재 requestId 확인 없음 | 송신 직전 requestId·connection generation·owner 일치 확인. 끊긴 연결의 완료 콜백은 현재 요청 timeout도 수정하지 못하게 함 |
| ARKit 개별 ACK의 처리량·보존 한계 | 모든 pose가 단일 inFlight 공유, 큐 6000 초과 시 oldest 삭제 | 별도 제한 전송창 또는 협의된 batch 계약, 행 단위 영속 큐, 스트림별 공정성. 삭제 대신 보존 또는 명시적 수집 중단 정책 |

근거: [Android pump](/Users/hoshi/Documents/CampusTracker-Server/android/app/src/main/java/hoshi/campustracker/sync/TelemetrySyncCoordinator.kt:261), [iOS synchronize](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:1546>), [비동기 dispatch](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:1950>), [ARKit 큐 상한 처리](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift:1458>).

예시 계산: ARKit 10 pose/s + telemetry 약 1 batch/s일 때 평균 ACK 왕복 200 ms인 단일 창의 이론 상한은 총 5 요청/s다. telemetry가 1 요청/s를 쓰면 pose 적체는 약 6개/s, 빈 6000개 큐는 약 16.7분에 찬다. 직렬화·서버 처리 비용은 제외한 용량 추정이며 실측 결과가 아니다. 종료 후에도 backlog 배출에 시간이 든다.

ARKit OFF를 보정 기준 실험으로 삼고 ON을 별도 비교한다. ARKit의 현재 `.gravity` 설정이나 같은 시각 실행만으로 GPS 악화 원인을 단정하지 않는다. 진단 이벤트가 pose 뒤에서 오래 대기하지 않도록 우선순위도 점검한다. ACK RTT, 가장 오래된 측정의 queue age, 원시 측정→callback→저장→ACK→서버 수신 지연을 각각 기록한다.

## 9. T9: GPS·보폭·고도 보정은 관측 품질을 기준으로 한다

### GPS 편향과 방향 재맞춤

`BestForNavigation`은 이미 적용되어 있고, Apple이 설명하는 가장 높은 정확도 요청이다. 실제 오차를 특정 미터 이하로 보장하는 값은 아니므로 요청값을 올리는 작업만으로 개선 완료를 선언하지 않는다. [Apple 정확도 상수](https://developer.apple.com/documentation/corelocation/kcllocationaccuracybestfornavigation)

현재 [applyGps](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.engine.ts:611)는 보고 정확도와 innovation으로 채택 여부를 정하고, [fitHeading](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.smoother.ts:119)은 Cauchy 비용으로 방향을 맞춘다. 소수 outlier에 강건해도 같은 편향을 가진 다수 fix는 정답과 구별하기 어렵다.

실험 순서:

1. 앱에서 원시 GPS 좌표와 accuracy를 보존한다. 별도의 `LocationQualityMonitor`에서 측정 age, fix 간격, 권한, 유효 speed/course 비율, accuracy 분포를 진단한다. reduced accuracy는 세션에 표시하고 임시 full accuracy 요청이 필요하면 Info.plist purpose dictionary와 함께 구현한다. 현재 설정 안내만 있는 상태를 자동 승격 구현으로 오인하지 않는다.
2. 서버 후보안은 OS 이름별 고정 배율이 아니라 **시간적으로 상관된 GPS 관측의 총 영향 제한**이다. 예를 들어 heading fit에서 5초 묶음의 총 가중치를 제한하는 안과, 일관된 혁신 잔차가 지속되는 구간의 유효 분산을 증가시키는 안을 각각 별도 variant로 실험한다. 5초는 튜닝 시작값이다. raw accuracy를 덮어쓰지 않고 derived weight를 남긴다.
3. 전방/최종에서 사용하는 관측 가중치와 거부 사유를 함께 저장한다. 임의로 GPS 전체를 제외해 PDR drift가 커지는지 확인한다. 이미 있는 강건 손실에 손실 함수 하나만 더 붙이는 작업을 해결책으로 간주하지 않는다.
4. 진입·회전·계단 기준점의 오차를 우선 평가하고 Android FINAL과의 차이는 보조 지표로 둔다. 편향 구간 식별에 평가 정답을 사용해 같은 구간을 다시 평가하는 누출을 피한다.

### 보폭과 고도

- iOS CMPedometer의 session-start 기준 누적 거리, cadence, `HISTORICAL_RECOVERY` 의미를 유지한다. Android에 거리가 없어서 쓰인 0.72 m와 iOS 학습값 0.65 m의 차이만으로 보폭 오류라고 판단하지 않는다. 기준 길이가 알려진 평지 50~100 m 구간을 반복하고 걸음·거리·실제 길이를 비교해 보정 여부를 정한다. 계단/경사 데이터는 평지 보폭 학습과 분리한다.
- Core Motion 가속도와 중력은 현재 서버가 기대하는 g 단위다. [Android MotionMath](/Users/hoshi/Documents/CampusTracker-Server/android/app/src/main/java/hoshi/campustracker/sensors/MotionMath.kt:15)는 Android→Core Motion 변환이므로 iOS에 음수 부호나 9.80665 나눗셈을 다시 넣지 않는다. 자기편각도 iOS trueNorth에 중복 적용하지 않는다.
- `altitude`와 `ellipsoidalAltitude`, 상대 기압 높이를 구분한다. C04를 Android와 맞추기 위한 고정 +20~40 m는 쓰지 않는다. [현재 서버의 시작 높이 선택](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.engine.ts:759)과 작업 중인 통로 보정이 있으므로 이를 미구현으로 다시 설계하지 않는다. 선택 근거·불확실도·실제 층 판정을 검증한다.
- [기압 구간 재시작](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.engine.ts:519)은 직전 Z에 이어 붙인다. 공백 중 높이 변화는 복구되지 않는다. 재시작 사유·구간 ID를 정확히 보내고, 높이 기준이 없으면 상대 Z 및 불확실성을 표시한다. Android의 1초 기압 평균을 iOS에 중복 적용하려면 계단 지연을 먼저 측정한다.

## 10. 구현 단위와 검증 순서

| 묶음 | 작업 파일/범위 | 선행 조건 | 완료 판정 |
|---|---|---|---|
| A | SensorServices, CollectionCoordinator의 clock/lifecycle, repository 시간 포맷 | 없음 | T1·T2·T3·T5 fixture 통과 |
| B | ActiveCollectionStore, SequenceLeaseStore, PersistentUploadQueue, sync 경계 | A의 session generation 계약 | 강제 종료·저장 실패·재연결·backoff 시험 통과 |
| C | WalkingFrameEstimator, 설정·복구 경로, 기본값 테스트 | A | 10/20/50 Hz 적격성·회전·공백 검증 |
| D | optional wire/DTO/DB/loader/replay 계약 | A·C, 서버 확장 먼저 | old/new 혼합 입력 round-trip, 최초에는 진단만 |
| E | 서버 보행 offset·GPS 영향 제한 variants | B·D로 새 실측 확보 | 동일 입력 A/B와 현장 기준점 검증 |

각 묶음을 별도 변경으로 검토한다. 현재 작업 트리의 WalkingFrame·시작 높이·통로 보정은 보존한다. 여러 보정안을 한꺼번에 켜서 어느 변경이 영향을 줬는지 알 수 없게 만들지 않는다.

필수 자동 검증:

| 시나리오 | 판정 기준 |
|---|---|
| 첫 callback main 대기 0/3/10초 | 동일한 raw 측정 시각으로 복원, 지연을 영구 offset으로 반영하지 않음 |
| 검증된 offset이 0/+40/-40초인 mapping | motion과 snapshot 시각 대응 및 창 길이 일치 |
| 로컬 파일 50 Hz 저장/복구 | 20 ms 구분 보존, 이전 schema 읽기 가능 |
| 권한 변경, Stop→즉시 Start, 늦은 callback | 요청 없는 시작·세션 혼입 0건 |
| 디스크 오류·저장 경계 crash·ACK 유실 | 성공 ACK 전 삭제 및 예약 실패 후 sequence 발급 0건 |
| retry 대기 중 지속 flush, encode 중 disconnect | backoff 우회 및 stale send 0건 |
| ARKit 10/20 Hz, ACK 20/100/200/500 ms | 최대 적체량·회복 시간 계측, 한계 초과 시 원시 조용한 삭제 없음 |
| 보행축 default config의 주기/정지/폰 회전/U턴 | 지원 주기에서 추정 가능, 정지에서 가짜 방향 없음, 양방향 모호성 보존 |
| old/new motion 혼합 + replay | 원시 개수·시각·sequence 보존, extension 없으면 기존 출력 유지 |

실기기 실험은 Android/iOS를 함께 들고 같은 경로에서 각 조건을 최소 3회 반복한다. 휴대 위치를 교환하고, 빌드/기기/OS/권한/주기/ARKit/휴대 자세를 기록한다. 권한은 측정 전에 확정한다.

1. 야외 기준점에서 정지 30초 → 알려진 100 m 직진 → 좌/우 90° 회전 → U턴.
2. 직진 중 폰만 회전, 손→주머니 이동. 실제 진행 방향 변화와 폰 자세 변화를 구분해 마커로 기록.
3. 실외→실내→계단→엘리베이터→실외. 기준점·층·구간 길이를 별도 기록.
4. 화면 잠금/백그라운드/복귀. iOS에서 모든 센서의 연속 실행을 가정하지 않고 실제 공백을 측정.
5. 네트워크 단절→Stop→앱 종료→재실행→전송 완료. 두 세션 모두 manifest 확인.

분석은 동일 시간 구간·동일 입력 snapshot·동일 엔진/설정으로 `AS_RECEIVED`, `SENSOR_TIME 전방`, `FINAL`을 각각 비교한다. GPS 잔차는 위치 정확도가 아니다. 보고 지표는 측정 dt/공백, 지연 p50/p95/max, queue age, 데이터 개수/sequence, 방향 미확정 시간, 폰 회전 직후 궤적 꺾임, 기준점 수평/수직 오차, 경로 길이 오차다. 정상 네트워크의 제한된 시험에서 앱이 유발한 순서 역전 0건을 요구한다. 실제 GPS 정확도 목표치는 기준점 측정으로 baseline을 만든 뒤 정한다.

## 11. 이번 작업에서 확인한 범위

[재현 스크립트](/Users/hoshi/Documents/CampusTracker-Server/docs/audit/ios_tracking_20261014/probe.py)와 [결과·소스 SHA-256](/Users/hoshi/Documents/CampusTracker-Server/docs/audit/ios_tracking_20261014/results.json)를 저장했다. 현재 estimator와 BootTimeDriftCorrector 소스를 변경 없이 추출해 Swift 6.4로 컴파일·실행했다.

- 첫 처리 3초 지연을 주면 첫 샘플과 이후 샘플 모두 +3초로 변환됨.
- +40초 보정을 주면 motion과 현재 보행축 매핑식 사이에 40초 차이가 생김.
- `.iso8601` 직렬화에서 20 ms 차이의 두 Date가 같은 문자열이 됨.
- 기본 보행축 추정기는 10/20 Hz에서 20초 동안 AXIS_ESTIMATED가 한 번도 나오지 않고, 50 Hz에서는 나옴.

재실행 명령:

```bash
python3 /Users/hoshi/Documents/CampusTracker-Server/docs/audit/ios_tracking_20261014/probe.py
```

이는 결함 재현 probe이며 개선안의 통과 테스트가 아니다. iOS 전체 빌드/XCTest, 디바이스 측정, 저장 실패 주입, 업로드 부하 시험, 운영 DB 재분석은 실행하지 않았다. 본 문서의 신규 threshold·GPS weighting·보행 방향 결합 방식은 구현·검증할 설계안이며 정확도 개선이 입증된 결과가 아니다.
