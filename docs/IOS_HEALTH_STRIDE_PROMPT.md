# Xcode 작업 프롬프트: Apple Health 기반 개인 보폭 추가

아래 내용을 Xcode의 코딩 에이전트에 전달한다. 목표는 실제 iOS 코드를 수정하고 빌드·검증하는 것이다. 서버 계약은 **계획된 신규 계약**이며 현재 서버가 이미 구현했다고 가정하지 않는다.

---

CampusTracker iPhone 앱에 Apple Health의 평지 한 걸음 길이를 이용한 선택적 개인 보폭 보정 기능을 구현해줘. 서버가 추적 초반의 보폭 초기값으로 사용할 집계만 전송한다. 현재 원시 센서 수집, local-first 저장, 재연결 업로드와 ACK 규칙을 보존하고 실제 앱 코드를 수정해줘.

## 1. 먼저 확인할 코드

이 저장소 기준 프로젝트는 `ios/Untitled Project/`이고 앱 코드는 `CampusTracker/` 아래에 있다. Xcode에서 별도 checkout을 사용한다면 실제 경로를 확인해라.

- `Models/SensorModels.swift`: `CollectionSession`, `SensorCapabilities`.
- `Services/CollectionCoordinator.swift`: 세션 생성, 복구, `SessionStartPayload`, `TelemetrySyncService.start`, 영속 upload queue, `SessionStartResponse`.
- `Persistence/ActiveCollectionStore.swift`, `Persistence/SensorDataRepository.swift`: 세션 및 활성 상태 보존.
- `ContentView.swift`: 사용자 설정과 수집 시작 UI.
- `Info.plist`, 앱 target, entitlements, Swift concurrency 설정.

가능하면 `docs/HEALTH_STRIDE_SERVER_PLAN.md`와 `docs/STAIR_SLOPE_STRIDE_PLAN.md`를 읽어라. 전자는 이 프롬프트와 같은 v1 계약이다. 접근할 수 없어도 아래 계약으로 구현할 수 있다. 서버 엔진 변경·배포·DB 마이그레이션은 이번 앱 작업의 범위가 아니다. 기존 미커밋 수정은 보존한다.

## 2. 사용자 경험과 권한

- “건강 앱 보폭으로 보정” 옵션과 “보폭 새로고침” 동작을 추가한다. 옵션은 기본 꺼짐으로 두고 사용자가 켤 때 설명과 HealthKit 읽기 요청을 진행한다.
- 설명: “건강 앱의 걷기 보폭을 이용해 이동거리 추정의 초기값을 보정합니다. 개별 건강 기록 대신 보폭 요약이 추적 서버로 전송됩니다. 연결하지 않아도 기록할 수 있습니다.”
- `HKHealthStore.isHealthDataAvailable()` 확인 후 `walkingStepLength` 읽기만 요청한다. HealthKit capability와 `NSHealthShareUsageDescription`을 설정하고 현재 SDK/target에서 빌드되게 한다. 쓰기·임상 기록·백그라운드 Health 전달 권한은 추가하지 않는다.
- `requestAuthorization`의 성공은 읽기 허용을 뜻하지 않는다. `authorizationStatus(for:)`로 읽기 거부를 판정하지 않는다. 조회가 비면 “읽을 수 있는 보폭 데이터가 없습니다. 기본 보폭을 사용합니다.”로 표시한다.
- 사용 가능한 요약 값과 최신 관측일은 사용자가 원할 때 확인할 수 있게 한다. 값이 없거나 오래돼도 수집 시작은 가능해야 한다.
- 조회는 옵션 활성화/명시적 새로고침/활성화된 앱의 foreground 진입 시 비동기로 수행하고 중복 요청을 합친다. 센서 callback이나 수집 시작의 동기 경로에서 Health 조회를 기다리지 않는다.
- 새 세션용 후보 캐시는 프로세스 메모리로 제한한다. 앱 재실행 후에는 다시 조회한다. 빈 결과·오류·옵션 해제 시 새 세션용 후보를 지워 오래된 값을 계속 쓰지 않는다. 작업 취소·계정 변경 뒤 늦게 온 결과가 후보를 되살리지 않도록 세대 토큰/취소 처리를 한다.
- 활성 세션의 snapshot은 고정이다. 새로고침/옵션 변경은 다음 세션부터 적용한다고 안내한다. 기존 서버 전송 기록의 삭제 기능을 이 옵션과 혼동하지 않는다.

## 3. Health 조회와 집계

별도 `HealthStrideService`와 순수 집계 함수, 테스트 가능한 Health 조회 인터페이스를 추가해라. 반환 모델은 `Codable`/`Sendable` 등 현재 프로젝트의 concurrency 방식에 맞춘다.

`walkingStepLength`는 한 걸음의 평균 길이다. 두 걸음 길이로 바꾸거나 2를 곱하지 않는다. 실시간 걸음 스트림도 아니다. `HKUnit.meter()`로 읽는다.

집계 v1은 다음과 같다. 아래 수치는 프로젝트의 초기 실험 정책이지 Apple의 정확도 보장이 아니다.

1. `computedAt`을 고정하고 `[computedAt−28×24h, computedAt]` 내에 시작과 종료가 모두 포함된 표본을 조회한다. 종료가 시작보다 이르거나 미래인 표본을 제외한다.
2. `HKMetadataKeyWasUserEntered=true`, 중복 UUID, 비유한 값, 0.20m 미만 또는 1.50m 초과 표본을 제외한다.
3. 출처는 iPhone 자동 측정만 허용한다. `HKSourceRevision`/`HKDevice`를 조사해 실기기에서 확인되는 정보를 사용하고 표시 이름 하나 또는 추측한 bundle ID만으로 허용하지 않는다. Apple Watch·타사 기록은 합치지 않는다. 출처를 확실히 확인할 수 없으면 보정을 비활성 fallback으로 두고 확인하지 못한 항목을 보고한다. sample UUID나 기기 식별자는 서버로 전송하지 않는다.
4. 초기 중앙값 m0, MAD0를 계산하고 `abs(x−m0)>max(3×1.4826×MAD0, 0.10)`인 표본을 제외한다. 짝수 중앙값은 중간 두 값의 평균이다.
5. 최종 표본에서 `stepLengthM=median(x)`, `dispersionM=1.4826×median(abs(x−median(x)))`를 계산한다. 산포를 표준오차로 바꾸거나 표본 수의 제곱근으로 나누지 않는다.
6. 최종 표본 20개 이상, 종료 시각의 UTC 날짜 3일 이상, 산포 0.20m 이하, 최신 표본이 세션 시작 기준 14일 이내여야 한다. 대표값은 현재 서버 보행 모델에 맞춰 0.35~1.10m에 있을 때만 사용하고 범위 밖을 조용히 clamp하지 않는다.
7. 세션 시작 시 후보의 `computedAt`이 시작 전 24시간 이내인지와 최신 표본 14일 조건을 다시 확인한다. 오래됐거나 조회 중이면 이번 세션에는 보정 필드를 넣지 않는다.

기기의 건강 데이터 전체/키/몸무게/심박 등을 추가로 읽지 않는다. 출처 확인에 필요한 메타데이터만 로컬에서 사용한다.

## 4. 서버와 맞출 선택적 JSON 계약

기존 `session:start` payload의 **최상위**에 아래 `strideCalibration` 객체를 추가한다. 기존 필드를 지우지 말고 `sensorCapabilities` 안에 넣지 마라.

```json
{
  "strideCalibration": {
    "schemaVersion": 1,
    "source": "APPLE_HEALTH_WALKING_STEP_LENGTH",
    "aggregationVersion": "median_mad_v1",
    "sourcePolicy": "IPHONE_AUTOMATIC_V1",
    "stepLengthM": 0.74,
    "sampleCount": 84,
    "observedDays": 12,
    "dispersionM": 0.06,
    "windowStart": "2026-09-09T05:55:00.000Z",
    "windowEnd": "2026-10-07T05:55:00.000Z",
    "latestSampleAt": "2026-10-07T03:40:00.000Z",
    "computedAt": "2026-10-07T05:55:00.000Z"
  }
}
```

- 네 시각은 timezone 및 소수초가 있는 ISO-8601 문자열이다. `windowEnd=computedAt`, `windowStart=windowEnd−28×24h`다. 기존 네트워크 encoder를 사용하고 Date의 숫자 인코딩이 생기지 않게 한다.
- `sampleCount`는 최종 집계에 사용된 Health 표본 수이며 실제 걸음 수가 아니다. `observedDays`는 이 표본 종료 시각의 서로 다른 UTC 날짜 수다.
- 데이터가 없으면 객체 전체를 생략하거나 null로 보낸다. 숫자 필드를 0으로 채운 객체를 보내지 않는다.
- 새 서버는 잘못된 선택 객체만 무시하고 기본값으로 시작할 예정이다. 구서버는 해당 최상위 필드를 제거하므로 저장·사용됐다고 표시하지 않는다.
- 신규 성공 ACK의 선택 필드: `strideCalibration: { status: "ACCEPTED" | "FALLBACK", reason: null | "MISSING" | "INVALID_FORMAT" | "UNSUPPORTED_VERSION" | "INSUFFICIENT_DATA" | "STALE" | "OUT_OF_RANGE" | "EXCESSIVE_DISPERSION" | "INVALID_TIME" }`.
- ACK의 이 필드가 없거나 미래의 모르는 status/reason이 오더라도 기존 sessionId ACK 처리는 성공해야 한다. 확인 상태만 unknown으로 둔다. ACCEPTED는 입력 저장 확인이지 매 걸음 적용 확인은 아니다.

## 5. 세션 고정·영속 저장·오프라인 동작

- `CollectionSession`과 `SessionStartPayload`에 같은 optional `StrideCalibration` 모델을 연결한다. 옛 JSON에 필드가 없어도 정상 decode되게 하고 기존 initializer 호출을 빠짐없이 갱신한다.
- 시작 시점의 준비된 후보를 한 번 복사하여 원래 `startedAt`과 함께 저장한다. 후보가 없었다는 사실도 고정한다. 서버 ID를 기다리지 않고 로컬 저장·센서 시작을 계속한다.
- `SensorDataRepository`, `ActiveCollectionState`, 영속 upload queue의 시작 payload가 동일 snapshot을 보존하는지 확인한다. 재연결 및 앱 재시작 때 시작 요청을 오늘의 후보로 다시 만들지 않는다.
- 조회 완료가 늦게 도착해도 활성 세션이나 이미 큐에 든 payload를 변경하지 않는다. 같은 clientSessionId를 가진 재전송은 동일 snapshot이다.
- 옵션 해제/collector 변경은 새 세션 후보에만 반영한다. 이전 collector의 큐와 세션은 기존 소유자 연결을 보존하며 다른 collector의 새 세션에 보폭을 복사하지 않는다. collector 변경 후 필요하면 새 사용자 동작으로 다시 활성화한다.
- 원시 보수계 `numberOfSteps`, `distance`, 모션, 위치, 기압 샘플은 기존 그대로 보낸다. iOS에서 개인 보폭을 곱해 CMPedometer 원시 거리를 덮어쓰지 않는다.
- 보폭 요약이나 개별 건강 표본을 일반 콘솔·진단 전송에 덤프하지 않는다. 기능 상태/오류 분류만 남긴다. 서버에는 위 집계 객체만 보낸다.

## 6. 검증 및 완료 보고

먼저 기존 변경사항과 빌드 target/scheme을 확인한 뒤 구현하고 가능한 환경에서 빌드해라. API 이름과 availability는 설치 SDK 및 Apple 문서로 확인한다.

단위/통합 테스트:

- 중앙값·MAD·이상치·중복·수동 입력·출처 필터·m 단위·UTC 날짜 수. MAD=0, 짝수 표본, 경계 시각도 포함.
- 19/20개 표본, 2/3일, 14일 최신성, 24시간 후보 만료, 산포/보폭 범위 경계.
- 데이터 없음·사용 불가·조회 오류·사용자 미연결 상태에서도 세션 시작 및 원시 수집 정상.
- 수집 시작과 조회 완료의 경쟁, 옵션 해제 뒤 늦은 callback, 여러 foreground 조회에서 마지막 유효 상태만 채택.
- 기존 session/active state/upload queue JSON의 디코딩 호환.
- offline 시작→앱 재실행→재연결 시 같은 보폭 snapshot, 처음 생략한 세션은 계속 생략.
- 새/구서버 ACK 및 알 수 없는 신규 status에서도 업로드 큐 정상 처리.

실기기에서는 보폭 데이터가 있는 상태와 없는 상태에서 각각 세션을 만들고, 오프라인·화면 잠금·재연결을 확인한다. Health 자료가 없는 시뮬레이터에는 mock으로 검증한다. 실제 센서 표본을 가짜로 만들어 서버에 보내지 않는다.

최종 보고에 변경 파일, 빌드 결과, 실행한 테스트, 실제 조회 출처 판별 방식, 서버 payload 필드 확인 결과, clientSessionId, 실기기에서 확인하지 못한 항목을 적어라. 서버 미구현 상태라면 앱의 준비 완료와 서버 적용 미확인을 명확히 구분한다. 기능 구현 완료 후 실제 동작에 필요한 수동 Xcode 설정이 남으면 정확한 target과 설정명을 알려줘.

참고: [walkingStepLength](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/walkingsteplength?changes=latest_minor), [HealthKit 권한](https://developer.apple.com/documentation/HealthKit/authorizing-access-to-health-data?changes=_2), [HealthKit 설정](https://developer.apple.com/documentation/healthkit/setting-up-healthkit).
