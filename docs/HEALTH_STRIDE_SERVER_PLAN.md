# Health 기반 개인 보폭: 서버 구현 계획 및 iOS 계약 초안

작성일: 2026-10-07. 상태: **서버 코드 구현 완료, 적용 검증 대기**. 마이그레이션 025와 API/fusion 연결을 작업 트리에 구현했다. DB 마이그레이션·배포 및 실제 세션 적용은 아직 하지 않았다.

계단·경사로 분류 및 보정은 [기존 계획](STAIR_SLOPE_STRIDE_PLAN.md), 앱 구현 지시는 [Xcode 프롬프트](IOS_HEALTH_STRIDE_PROMPT.md)를 함께 따른다. 이번 구현은 서버 코드까지만 수정했다. Xcode 프롬프트에 따른 앱 변경은 별도 작업이다.

## 1. 목적과 현재 연결 지점

HealthKit의 `walkingStepLength`를 사용자의 초기 평지 보폭으로 사용하고 현재 세션의 유효한 보행 자료가 쌓이면 세션 추정으로 점진적으로 대체한다. Health 값은 계단 판정 근거나 거리 정답이 아니다. 계단 분기의 0.30m 고정을 해제하지 않은 채 기본값만 바꾸면 경사로 문제는 남는다.

Apple의 이 항목은 평지에서 안정적으로 걷는 동안의 평균 **한 걸음** 길이다. 좌우 두 걸음을 합친 stride cycle이 아니다. iPhone 8 이상에서 허리 가까이에 휴대할 때 자동 기록하며, 일반적으로 하루 10~30개 표본이다. 키 정보도 추정 정확도에 영향을 준다. [Apple walkingStepLength](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/walkingsteplength?changes=latest_minor)

현재 코드를 확인한 연결 지점:

- 서버 `session.dto.ts`의 `SessionStartRequest`에는 개인 보폭 필드가 없다. 모르는 최상위 필드는 현재 제거되므로 구서버는 신규 값을 사용하지 않는다.
- `session.service.ts`의 시작 요청은 `clientSessionId` 기준 멱등적이다. `session.repository.ts`는 기존 세션 시작 정보를 재전송으로 덮어쓰지 않는다.
- iOS `CollectionCoordinator.swift`의 `SessionStartPayload`, `TelemetrySyncService.start`에서 시작 요청을 구성하고 로컬 큐에 보존한다. `CollectionSession`은 `SensorModels.swift`에 있다.
- `fusion-v4.engine.ts`의 `stride()`는 학습량 부족 시 `defaultStrideM=0.72`를 반환한다. `slopeStride()`도 표본이 부족하면 이 함수를 사용한다.
- `fusion.service.ts`의 신규 세션, 서버 재시작 후 복구, 두 replay 모드가 모두 같은 세션 보폭 스냅샷을 사용하도록 연결해야 한다.

## 2. 공통 API 계약 v1 — 구현 시 서버·앱이 동일하게 사용

`session:start` 최상위에 선택 필드 `strideCalibration`을 추가한다. `sensorCapabilities`나 매 센서 샘플에 넣지 않는다. 사용할 수 없으면 필드 생략 또는 null이며, 0이나 가짜 표본을 보내지 않는다.

```json
{
  "clientSessionId": "d2f9eeaa-4cbe-41e8-8c4a-08fbfd563831",
  "deviceId": "16a24997-c32f-4cfb-a0c6-5143a84423cd",
  "platform": "ios",
  "startedAt": "2026-10-07T06:00:00.000Z",
  "sensorCapabilities": {},
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

전송 단위는 m, 시각은 timezone과 소수초를 포함한 ISO-8601이다. 표본 수는 걸음 수가 아니라 집계에 포함된 Health quantity sample 수다. `observedDays`는 포함 표본의 종료 시각을 UTC 날짜로 환산한 서로 다른 날짜 수다. `latestSampleAt`도 포함 표본의 가장 늦은 종료 시각이다.

### 집계 규칙 — iOS에서 실행

다음 수치는 Apple 보장값이 아니라 v1 실험 기본값이다. 변경하면 집계 버전을 바꾸고 호환 검사를 갱신한다.

1. `windowEnd=computedAt`, `windowStart=windowEnd−28×24h`. 조회 구간에 시작·종료가 모두 포함되고, `startDate<=endDate<=windowEnd`인 표본만 사용한다.
2. `HKUnit.meter()`로 변환한다. 수동 입력, 출처를 검증할 수 없는 표본, 중복 UUID, 비유한값, 0.20m 미만 또는 1.50m 초과 값을 제외한다.
3. `IPHONE_AUTOMATIC_V1`은 iPhone의 자동 측정 출처만 사용한다. `sourceRevision`과 `device`의 실제 반환값을 실기기에서 확인해 구현하고 출처 이름만으로 판정하거나 추측한 bundle ID를 사용하지 않는다. Apple Watch·타사·수동 입력과 합치지 않는다. 확실하게 판별할 수 없으면 기능을 기본값으로 처리한다.
4. 남은 값의 중앙값 m0와 `MAD0=median(abs(x−m0))`를 구한다. `abs(x−m0)>max(3×1.4826×MAD0, 0.10m)`인 값을 제외한다. 짝수 개 중앙값은 가운데 두 값의 산술평균이다.
5. 남은 값으로 중앙값과 MAD를 다시 계산한다. `stepLengthM=median`, `dispersionM=1.4826×MAD`. 이는 표본 산포이지 보폭 평균의 표준오차가 아니다. 불확실성을 `sqrt(sampleCount)`로 나누지 않는다.
6. 최종 표본 20개 이상, 3일 이상, 최신 표본이 세션 시작 기준 14일 이내, 산포 0.20m 이하일 때 전송 후보로 사용한다. 균일한 표본의 산포 0은 허용하되 모델의 불확실성 하한을 제거하지 않는다.
7. 시작 순간에는 준비된 후보만 세션에 복사한다. 조회가 끝나지 않았으면 해당 세션에는 생략하며, 나중에 결과가 와도 이미 시작한 세션을 변경하지 않는다.

### ACK 추가 필드

기존 성공 ACK에 선택 객체를 추가한다. 구클라이언트의 기존 필드는 유지한다.

```json
{
  "ok": true,
  "sessionId": "a677597c-55ef-4aa7-a464-c5cd9b758bfb",
  "clientSessionId": "d2f9eeaa-4cbe-41e8-8c4a-08fbfd563831",
  "strideCalibration": {
    "status": "ACCEPTED",
    "reason": null
  }
}
```

`status`: `ACCEPTED | FALLBACK`. `reason`: null 또는 `MISSING | INVALID_FORMAT | UNSUPPORTED_VERSION | INSUFFICIENT_DATA | STALE | OUT_OF_RANGE | EXCESSIVE_DISPERSION | INVALID_TIME`.

ACK의 ACCEPTED는 보정 입력이 저장되었다는 의미다. 모든 걸음에 그 값이 적용됐다는 의미는 아니다. 실제 사용 출처는 fusion 진단에서 확인한다. 구서버에서 ACK 필드가 없으면 앱은 “서버 적용 여부 확인 안 됨”으로 처리하며 오류나 재전송 조건으로 삼지 않는다.

## 3. 서버 검증·저장·멱등성

`SessionStartRequest`의 기본 필수 항목 검증은 유지한다. 개인 보폭은 별도 `safeParse`로 평가하여 잘못된 선택 객체 하나 때문에 세션 시작이나 원시 센서 업로드가 실패하지 않게 한다. 무효 객체 전체를 로그나 DB에 복사하지 말고 고정된 사유 코드만 기록한다.

- v1 discriminator와 필수 필드, 유한한 수, 정수 카운트, 시각 순서를 검사한다. `20<=sampleCount<=5000`, `3<=observedDays<=29`, `observedDays<=sampleCount`, 산포 범위 및 28일 창을 검증한다.
- `windowStart<=latestSampleAt<=windowEnd=computedAt<=startedAt`를 검사한다. 최신 표본의 14일 만료는 **서버 수신 시각이 아니라 원래 세션 시작 시각** 기준이다. `computedAt`은 시작 전 24시간 이내여야 한다. 개인 보폭이 있는데 명시적 startedAt/clientStartedAt이 없으면 선택 입력만 INVALID_TIME으로 처리한다.
- 자료 검증은 0.20~1.50m를 허용하되 v4의 실제 보행 보폭 범위 0.35~1.10m 밖의 개인 값은 OUT_OF_RANGE로 대체 처리한다. 조용히 경계값으로 clamp해서 정상 개인값처럼 사용하지 않는다. 범위 확대와 달리기 지원은 별도 평가한다.
- 세션 테이블에 `stride_calibration jsonb NULL`, `stride_calibration_status`, `stride_calibration_reason`을 추가한다. 신규 마이그레이션 번호는 구현 시 마지막 번호 다음으로 정하고 진행 중인 024를 덮어쓰지 않는다.
- 첫 시작에서 정규화된 객체 또는 fallback 결정을 고정한다. 같은 clientSessionId로 재전송하면 처음 저장된 값과 ACK를 반환한다. 첫 요청이 누락/무효였더라도 재전송에서 새 보폭으로 업그레이드하지 않는다.
- 기존 행은 MISSING fallback으로 취급한다. 과거 세션에 오늘의 Health 값을 소급 주입하지 않는다. 기기·collector 공용 전역 보폭을 저장하지 않아 사용자 변경 때 섞이지 않게 한다.
- 본문 원자료, 키, Health UUID 및 기기 식별 정보를 추가 수집하지 않는다. 요약 객체는 개인 건강 정보에서 파생된 입력으로 다루고 기존 세션 접근 통제 안에서만 제공한다. 인증 없는 preview/broadcast에 새 값을 자동 추가하지 않는다.

## 4. 퓨전 모델 반영

Health가 채택되면 세션 보폭의 약한 초기 기준으로 사용한다. 현재 세션의 실제 보행 표본 수나 누적 거리에 Health의 sampleCount를 더하지 않는다. 현재 보수계와 독립적인 정답 관측으로 Kalman 업데이트하지 않는다.

- `FusionSessionContext`와 같은 명시적 입력에 정규화된 보폭을 넣고, 공통 상태 생성 경로를 추가한다. 기존 알고리즘은 이 입력을 무시할 수 있게 한다.
- Health 이전값 Lh와 세션 평지 추정 Ls를 분리한다. 유효 평지 학습량 n이 늘면 `L=(1−w)Lh+wLs`, `w=min(1,n/40)`처럼 점진적으로 이행하는 정책을 초기 실험안으로 삼는다. n은 실제 승인된 세션 걸음 수이며 Health sampleCount가 아니다. 40걸음은 조정 가능한 실험값이다.
- 유효 세션 보폭이 없으면 w=0, Health도 없으면 기존 기본값·학습 정책을 유지한다. 세션 보폭의 품질이 나빠지면 억지로 w를 증가시키지 않는다. 기존 forgetting 기반 A/B와 전환용 누적 n의 역할을 분리한다.
- Health에 의존하는 보폭 분산에는 `max(dispersionM, 0.10m)`의 초기 하한을 두고 기존 모델의 분산보다 과신하지 않게 한다. 미확정 수직 이동에서는 추가 불확실성을 적용한다. 각 수치는 검증 대상이다.
- 경사 보폭을 충분히 학습하면 그 구간 보폭이 우선이다. 경사/미확정 표본을 평지 학습에 섞지 않는다. 확인된 계단에서는 Health 평지 보폭으로 0.30m를 치환하지 않는다.
- 높이 변화만으로 계단 확정 및 보폭 축소를 하지 않는 정책과 함께 적용한다. 모델의 거리 계산, 스무더, 분산 전파는 같은 보폭 출처를 사용한다.

## 5. 실시간·재처리 재현성

`fusion.service.ts`의 `sessionStarted`, 오류/재시작 복구, `replayInMemory`, `replayAsReceived`, `hasCompletedRun` 판단, bench 경로를 전부 점검한다. 세션 생성 직후 DB에 저장된 입력을 읽어서 첫 관측 전 상태에 주입한다. process 중 공유 `fusionConfigV4`를 변경해서는 안 된다.

run에는 정규화된 세션 입력, 적용 정책 버전, 채택 사유를 기록한다. 현재 `configHash`에 모델 revision·설정·지도 외에 세션 보폭 입력 fingerprint를 포함하거나 별도 input hash를 도입하고, 완료 run 재사용 검사도 같은 키를 사용한다. 전역 알고리즘 목록의 설정 hash와 세션 실행 hash의 의미를 구분한다. 제외된 무효 원객체를 hash에 넣지 않는다.

실험에서 Health 입력을 끄는 설정 `healthStrideEnabled=false`를 추가해 동일 세션의 효과를 분리 평가한다. 세션 스냅샷은 보존하고 사용 여부만 해당 run에 고정한다. 모든 실험에 명시적 variant를 붙인다.

## 6. 구현 순서

1. 서버에서 선택 필드 파싱, 마이그레이션, 세션 고정 및 ACK부터 구현한다. `docs/API_CONTRACT.md`는 이 단계에서 실제 구현과 함께 갱신한다.
2. 공통 fusion 상태 생성과 세션 입력 hash를 연결하고, 개인 보폭 초기화·점진 보정·진단을 추가한다.
3. 기존 계획의 계단/경사/미확정 분류 수정 및 재분류 보정을 연결한다.
4. Xcode 프롬프트로 앱의 Health 조회·로컬 집계·세션 snapshot·전송을 구현한다. 구서버에서도 수집되지만 보폭 적용은 새 서버 배포 후에만 가능하다.
5. 서버 수신은 먼저 열고 새 모델 적용은 실험 설정으로 비교한다. 검증 후 신규 세션 적용, 기존 세션은 보폭 데이터 유무를 구분해 선정 재처리한다.

## 7. 검증과 완료 조건

### 현재 구현 상태 (2026-10-07)

- `session:start`의 선택 필드, 서버 범위·날짜·출처 정책 검증, fallback 사유 및 멱등 ACK 응답을 구현했다.
- migration 025에 세션 보폭 스냅샷 및 판단 상태와 fusion run `input_hash` 저장을 추가했다. DB에는 아직 적용하지 않았다.
- fusion-v4 revision 6에서 Health prior를 적용하고 유효 평지 보행 자료가 누적되면 최대 40걸음에 걸쳐 세션 추정으로 넘기는 정책을 구현했다. `healthStrideEnabled=false` variant로 Health prior 효과를 분리한다.
- 계단·경사·미확정 수직 이동을 분리했다. 5m 직선 상승은 경사로 증거로, 최소 1m 상승과 접힘 패턴은 계단 증거로 쓰며 나머지는 보통/개인 보폭과 높은 불확실성을 유지한다.
- 계단/미확정 보수계 구간은 평지 보폭 학습에서 제외하고, slope 구간에만 해당 구간 보수계 표본을 쓴다. GPS 채택 이후 이미 보정된 걸음에 소급 위치 차이를 재적용하지 않도록 경계를 갱신한다.
- replay 두 모드, 실시간 신규 세션 상태, run 설정·hash에 세션 입력을 연결했다. session view와 실시간 preview에는 보폭 수치를 추가하지 않았다.
- Backend 타입 검사는 통과했다. 이 작업에서는 테스트를 추가·실행하지 않았고, DB 마이그레이션·실제 iOS 연결·현장 비교는 미검증이다.

현재 서버 코드는 구현 단계의 완료 상태다. 운영 적용 판단은 아래 DB·실세션·정확도 검증을 마친 뒤 내린다.

- DTO: 누락/null/구버전/미지원 버전/불완전 객체/날짜 오류/비유한 숫자/단위 오류/낡은 값은 세션 수집을 막지 않고 fallback한다. malformed JSON 자체는 기존 오류 처리 대상이다.
- 멱등성: 같은 ID에 서로 다른 보폭 재전송, 앱·서버 재시작, 오프라인 시작 후 14일을 넘겨 업로드해도 시작 당시 판단을 유지한다.
- 고정성: 첫 요청 누락 후 재연결해도 나중의 Health 값이 주입되지 않는다. 두 사용자의 동시 세션 간 보폭 누출이 없다.
- 호환성: 구앱→신서버, 신앱→구서버, Health 없음, 오래된 로컬 큐 decode를 확인한다.
- 모델: Health만 변경한 조건에서 다른 사용자 보폭이 실제 초기 거리에 반영되는지, 충분한 세션 표본 뒤 개인값 영향이 사라지는지 검증한다. Health sampleCount 20/2000 차이로 위치 확신도가 비정상 증가하면 실패다.
- 재현성: 실시간·두 replay 모드·서버 복구가 동일 스냅샷을 쓰며 반복 결과가 결정적이다. 입력이 다르면 run 재사용이 일어나지 않는다.
- 성능: 개인화 꺼짐/켜짐, 분류 수정 전/후의 2×2 비교로 개선 원인을 분리한다. 같은 원자료와 지도·기준점으로 초기 20/40걸음, 평지, 짧은/곡선 경사로, 실제 계단을 평가한다.
- 정확도 기준은 기존 계획의 거리·끝점·P95·점프 기준을 따른다. 추가로 Health가 오래되거나 실제 보폭과 다를 때도 세션 학습으로 회복하는지 확인한다. 독립 기준점 없이 Health에 가까워졌다는 것만으로 개선이라고 판단하지 않는다.
- 실행 검증: backend 타입 검사, 관련 세션/DTO/fusion 테스트, 전체 backend 테스트, 실제 iPhone 한 세션의 서버 저장값·진단·재생 비교까지 확인한다.

## 8. Apple API 전제

앱은 HealthKit 사용 가능 여부를 확인하고 `walkingStepLength` 읽기만 요청한다. 읽기 허용과 거부를 `authorizationStatus(for:)`로 판별하지 않는다. 빈 조회는 자료 부재/권한 미허용을 구분하지 않고 처리한다. [Apple 권한 문서](https://developer.apple.com/documentation/HealthKit/authorizing-access-to-health-data?changes=_2)

앱에서는 조회·집계 결과가 준비되지 않아도 즉시 원시 센서 수집을 시작한다. Health 원자료는 서버로 올리지 않고 세션에 고정한 요약만 전송한다. 지원 OS, target 설정과 정확한 API는 구현할 Xcode SDK에서 확인한다.
