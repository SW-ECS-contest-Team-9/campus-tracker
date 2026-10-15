# iOS 구현 프롬프트: 휴대폰 자세와 분리된 보행 좌표계 추정

CampusTracker iOS 앱에 실시간 보행 좌표계 추정기를 구현하라. 계획만 제시하지 말고 코드, 의미 있는 테스트, 빌드 검증과 서버 연동 계약까지 완료하라. 이 요청의 구현 대상은 iOS 앱이며, 서버 fusion 적용이 필요한 부분은 별도 계약으로 명확하게 보고하라.

## 목적과 관측된 문제

사용자가 실내에서 비슷한 길을 왕복했는데 돌아올 때 휴대폰 방향·손·기울기를 바꿨고, 추정 경로의 방향이 틀어졌다. 현재 서버는 `보행 방향 = -yaw + θ`를 사용하며 θ를 방향 구간 안에서 일정하다고 가정한다. 자세 변경은 중력 벡터의 변화를 보고 판단하므로 수평 회전이나 몸의 회전과 동시 발생한 자세 변경을 충분히 구분하지 못할 수 있다.

참고 세션은 C01 `322ea4dd-0976-495b-b149-c84bf51d1de0`, 2026-10-14 13:12–13:19 KST다. 센서는 `xTrueNorthZVertical`, 50 Hz로 수집됐고 ARKit은 꺼져 있었다. 수집된 motion 21,466개의 최대 간격은 약 22 ms였다. 13:16:56과 13:17:08에 POSE_CHANGE가 기록됐으며 GPS 보고 수평 오차 중앙값은 22.5 m였다. 이 증거는 센서 고장을 확정하지 않는다.

목표는 휴대폰을 돌리거나 기울여도, 보행 패턴에서 얻은 방향축 후보와 신뢰도를 유지·재추정해 서버가 보행 방향 오프셋을 갱신할 수 있게 하는 것이다. 정확한 위치나 방향을 항상 얻는다고 주장하지 말라.

## 먼저 확인할 코드

현재 작업 트리의 코드를 기준으로 구현하라. 기존 문서의 설명보다 실제 코드가 우선이다.

- `ios/Untitled Project/CampusTracker/Services/SensorServices.swift`: MotionService, Core Motion 큐·reference frame·수집 주기
- `ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift`: record(motion:), 타임스탬프 보정, MotionPayload, 업로드 큐, 진단 이벤트
- `ios/Untitled Project/CampusTracker/Models/SensorModels.swift`: MotionSample, SensorCapabilities
- `ios/Untitled Project/CampusTracker/Persistence/`: 원본 저장과 복구
- `ios/Untitled Project/CampusTracker/ContentView.swift`: 수집 상태 표시
- `ios/Untitled Project/CampusTrackerTests/`: Swift Testing과 업로드·복구 테스트

현재 앱은 `userAcceleration`, `gravity`, `rotationRate`, `attitude.roll/pitch/yaw`를 수집한다. quaternion과 자기장 보정 정확도는 현재 MotionPayload에 없다. reference frame 선택은 지원될 때 진북 → 자북 → arbitrary corrected 순서다. 이 정책을 근거 없이 변경하거나 세션 도중 자동으로 전환하지 말라.

## 반드시 지킬 물리적·구현적 조건

1. 가속도는 속도·진행 방향 자체가 아니다. 순간 가속도 화살표를 보행 방향으로 사용하지 말라. 가속도 이중 적분으로 절대 위치를 만드는 방식도 이번 범위에서 사용하지 않는다.
2. 중력은 수직과 수평면을 제공하지만 북쪽이나 수평 yaw를 결정하지 못한다. 보행 좌표계는 상대 좌표계로 시작하며, 지도와의 절대 정렬에는 별도 근거가 필요하다.
3. PCA에서 얻는 것은 우선 부호 없는 방향축이다. v와 -v는 동일한 축이다. 앞뒤 180도 모호성을 숨기지 말고, 특히 실제 왕복 전환을 이전 방향으로 억지로 유지하지 말라.
4. 손 흔들림·주머니 움직임에 따라 최대 분산축이 보행 방향과 다를 수 있다. 신호가 불충분하거나 가정이 맞지 않으면 UNKNOWN/AMBIGUOUS 상태를 출력하라.
5. Core Motion attitude는 이미 센서 fusion의 결과다. 그 yaw로 가속도를 변환한 뒤, 같은 가속도를 독립적인 절대 yaw 정답으로 다시 적용하는 순환 보정을 만들지 말라.
6. 원본 acceleration, gravity, rotationRate, attitude 값을 보정값으로 덮어쓰지 말라. 보행 좌표계 결과와 자기장 품질은 별도의 파생 데이터다.

## 구현할 추정기

`WalkingFrameEstimator` 등 독립적인 Swift 타입으로 구현하라. UI·네트워크·저장소 없이도 재생 테스트가 가능해야 한다. 파라미터는 별도의 설정 타입으로 모으고 알고리즘 버전을 남겨라.

### A. 입력과 좌표 정의

- 입력: 단조 증가하는 Core Motion timestamp, userAcceleration, gravity, rotationRate, attitude quaternion, 수집 segment ID.
- Core Motion acceleration/gravity 단위는 g, angular velocity는 rad/s, 각도는 rad다. 내부 계산에서 SI로 바꿀 경우 변환 위치를 명확히 하고 원본 전송 단위는 유지하라.
- `userAcceleration`에는 중력이 이미 분리되어 있다. 여기서 gravity를 다시 빼지 말라.
- 위쪽 벡터는 `up = -normalize(gravity)`다. 수평 투영은 `aHorizontal = a - dot(a, up) * up`다. 이는 userAcceleration의 수직 운동 성분을 제거하는 것이다.
- 샘플마다 달라지는 기기 좌표의 가속도를 그대로 한 PCA 창에 섞지 말라.

### B. 휴대폰 회전을 따라가는 상대 reference

- 한 estimator frame 안의 샘플을 동일한 상대 reference로 운반하라. 짧은 구간의 rotationRate 적분으로 상대 quaternion을 추정하고, 중력 관측으로 기울기 오차만 완만하게 제한하는 구조를 우선 검토하라.
- 초기 yaw는 임의 기준이어도 된다. 자기장 기반 yaw 수정값을 보행 추정기의 절대 정답으로 강제하지 않는다.
- quaternion이 `device → reference`인지 역변환인지 명시하라. 곱셈 순서·역변환·좌우수 좌표계는 축별 90도 회전 테스트로 검증하라.
- 중력에 직교하는 두 기저 e1/e2를 구성하라. 선택한 기기 축이 중력과 거의 평행하면 다른 축을 사용하라. 오른손 좌표계를 유지하고, 기저의 부호가 샘플마다 뒤집히지 않게 하라.
- reference 초기화·재초기화마다 별도의 `walkingFrameId`를 만든다. window reference가 바뀌었는데 이전 각도와 직접 비교하는 오류를 피하라.

### C. 보행 패턴과 PCA

- 기본 시작 설정: 약 2–3초의 시간 창, 약 200 ms 간격의 추정 갱신. 타이머가 아니라 실제 sensor timestamp로 창을 관리하라. 필요한 걸음 수·샘플 수·신호 에너지 임계값은 설정으로 둔다.
- 같은 reference의 수평 가속도에서 평균을 제거한 뒤 2×2 공분산을 계산하고 주축을 구하라. 주축은 보행 방향 후보이며, 확정 방향이 아니다.
- 고유값 비율, 수평 에너지, 보행 주기성, 창 사이 축 일관성, 자세 변화 정도로 신뢰도를 계산하라. 신뢰도 0–1은 내부 지표이며 측정된 정확도나 확률로 표시하지 않는다.
- 정지, 데이터 부족, 낮은 에너지, 거의 등방성인 공분산, 큰 자세 전환에서는 유효한 축을 만들지 않는다. 직전 추정치를 계속 노출한다면 생성 시각과 만료 여부를 명시하라.
- 최소한 `UNKNOWN`, `AXIS_ESTIMATED`, `AMBIGUOUS`, `POSE_TRANSITION` 상태를 구분하라. AXIS_ESTIMATED도 방향 부호가 미확정일 수 있다.

### D. 방향 부호와 실제 U턴

- `axis`와 `-axis`의 두 후보를 유지하라. 아무 근거 없이 기존 yaw나 직전 진행 방향에 더 가까운 후보 하나로 확정하지 않는다.
- 자이로는 휴대폰 회전을 관측한다. 자이로만으로 몸의 U턴과 손에서 휴대폰만 돌린 것을 완전히 구분할 수 있다고 가정하지 말라.
- 부호 확정에는 유효한 외부 방향 앵커 또는 운반 방식에 대해 검증된 보행 위상 근거가 필요하다. 근거가 없다면 `directionResolved=false`로 유지한다.
- 외부 방향 앵커 입력 인터페이스를 분리할 수 있다. GPS course를 사용할 때는 속도·courseAccuracy·horizontalAccuracy·지속 거리의 품질 조건을 확인한다. 서 있는 상태나 실내의 나쁜 GPS로 초기 진행 방향을 확정하지 않는다.
- 휴대폰 자세 변화 직후에는 방향 연속성을 강제하기보다 신뢰도를 낮추고 재추정한다. 추정 변화율 제한이 실제 180도 방향 전환을 없애지 않도록 하라.

### E. 자기장 품질

- `CMDeviceMotion.magneticField`와 `accuracy`를 선택적으로 기록하라. 필드 단위는 μT이며, Core Motion의 calibrated 값인지 명시한다. 이를 원시 magnetometer 측정으로 표시하지 않는다.
- 보정 정확도(uncalibrated/low/medium/high), 자기장 크기·변화량, gyro 예상 회전과 attitude 변화의 불일치를 진단 재료로 제공하라.
- 자기장 이상 임계값은 환경·기기 검증이 필요하므로 설정값과 이유를 남긴다. 작은 변화 하나로 고장이나 자기장 교란을 확정하지 않는다.
- 지자기 수치를 가속도로 덮어쓰지 말라. 품질이 낮을 때 해당 방향 관측을 얼마나 신뢰할지는 fusion이 결정한다.

## 앱 연결과 저장·전송

- 기존 50 Hz 원본 수집, sequence, sensorSegmentId, 업로드 큐, 종료 manifest, 재전송·중복 처리 정책을 보존하라.
- 추정기는 하나의 순차 처리 경로에서 실행한다. 50 Hz마다 main actor에서 큰 창을 다시 계산하지 말라. 값 타입 snapshot을 사용해 Swift concurrency 경계를 안전하게 넘긴다.
- 센서 서비스 재시작·앱 복구·timestamp 역행·큰 수집 공백에서는 이전 창을 폐기하고 추정기 frame을 재초기화한다. 시간 간격을 고정 1/50초로 가정하지 않는다.
- 계산은 단조 sensor timestamp를 사용한다. 기존 `BootTimeDriftCorrector`와 일관된 방식으로 window 시작/끝을 서버 시각으로 연결하고, 이중 보정이나 서로 다른 clock 혼합을 피하라.
- quaternion·자기장·파생 결과는 optional 필드로 추가하고 이전 저장 JSON의 디코딩 및 기존 pending batch 복구를 테스트하라. NaN/Infinity는 전송하지 않는다.
- 파생 결과는 갱신 시점에만 추가하거나 생성 시각을 포함한 snapshot으로 전송한다. 동일한 추정값을 매 motion sample의 새로운 독립 관측으로 취급하지 않는다.
- 진단 이벤트는 상태 변경·frame 재초기화·자기장 품질 변화 중심으로 제한하고, 매 센서 샘플마다 남기지 않는다.

UI에는 실험 기능 on/off, 보행축 상태·신뢰도·앞뒤 모호성·자세 전환·자기장 보정 상태를 간결하게 표시하라. UI 갱신은 약 2–5 Hz면 충분하다. "방향 보정 성공"이나 "정확한 방향"으로 표시하지 않는다.

`sensorCapabilities`에는 추정기 enabled 여부, 알고리즘/스키마 버전, window 설정, 실제 motion reference frame을 추가하라. 세션 중 설정 변경은 진단 이벤트에 남긴다.

## 서버 연동 계약: 완료 범위를 정확히 구분할 것

현재 서버 `backend/src/modules/telemetry/telemetry.dto.ts`의 MotionSample은 기존 acceleration/gravity/rotationRate/roll-pitch-yaw만 정의한다. 새로운 필드를 보내기만 해서는 저장·fusion에 반영되지 않는다. diagnostic-events도 fusion 입력이 아니다.

따라서 iOS-only 구현의 완료는 로컬 추정·저장·표시·계약 준비까지다. 기존 서버의 XY 경로가 개선됐다고 보고하지 말라. 서버 수신·저장·재생·실시간 적용은 후속 작업으로 정확히 제시한다. 서버 지원이 없는 동안에는 기존 wire payload를 유지하는 호환 모드를 기본으로 둔다.

후속 서버 변경을 위한 최소 제안 계약을 정리하라. 예:

```json
{
  "attitude": {
    "roll": 0.0,
    "pitch": 0.0,
    "yaw": 0.0,
    "quaternion": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 }
  },
  "magneticField": {
    "x": 0.0, "y": 0.0, "z": 0.0,
    "unit": "uT", "source": "CORE_MOTION_CALIBRATED", "accuracy": "HIGH"
  },
  "walkingFrame": {
    "schemaVersion": 1,
    "algorithmVersion": "gravity_gyro_pca_v1",
    "frameId": "UUID",
    "reference": "GYRO_GRAVITY_RELATIVE",
    "estimatedAt": "ISO_TIMESTAMP",
    "windowStart": "ISO_TIMESTAMP",
    "windowEnd": "ISO_TIMESTAMP",
    "status": "AXIS_ESTIMATED",
    "axisDevice": { "x": 1.0, "y": 0.0, "z": 0.0 },
    "directionResolved": false,
    "ambiguity": "AXIS_180",
    "confidence": 0.6,
    "eigenvalueRatio": 3.0,
    "sampleCount": 125
  }
}
```

이 JSON의 수치는 구조 예시이며 실측값으로 사용하지 않는다.

`axisDevice`는 estimatedAt의 기기 좌표계로 표현한 정규화된 수평 축이며, 역방향도 동등한 후보다. 내부 reference의 주축을 현재 기기 좌표계로 역변환한 후 출력한다. 좌표계·단위·시간·유효기간을 계약에 명시하라.

계약의 최종 필드 이름은 기존 naming에 맞춰 조정해도 되지만, 모호성 및 데이터 출처 정보를 삭제하지 않는다.

서버 작업 목록에는 MotionSample DTO, DB 저장/마이그레이션, raw loader와 timeline, 실시간·Replay 공통 fusion, θ(t) 갱신과 두 방향 가설 처리, 새·구 앱 동시 지원, 실험 결과 비교를 포함하라. 원본 yaw를 새 보행 방향으로 대체하지 않는다.

## 의미 있는 테스트와 검증

- 정지·약한 신호에서 임의 방향을 만들지 않는다.
- 같은 합성 직선 보행을 기기 좌표에서 yaw 180도, pitch/roll 변경으로 관측해도 같은 reference의 축은 부호를 제외하고 일치한다.
- 합성 실제 U턴에서 축의 180도 모호성을 숨기지 않고, 외부 근거 없이 전진 방향을 강제 확정하지 않는다.
- 손·기울기 변경 중 POSE_TRANSITION을 거쳐 새 신뢰도를 얻는다. 단순한 phone yaw 변경만으로 사람 U턴을 확정하지 않는다.
- quaternion 회전·역변환·중력 투영·각도 wraparound·행렬 곱 순서를 검증한다.
- irregular dt, 중복/역행 timestamp, sensor gap, 재시작·복구에서 오래된 축을 새 frame에 섞지 않는다.
- 기존 MotionSample JSON 디코딩, 새 필드 round-trip, 원본 sample count·sequence 보존, offline queue 재전송을 검증한다.
- 기존 Xcode scheme으로 build와 대상 테스트를 실행한다. 실행할 수 없는 기기 테스트는 실제 통과한 것으로 보고하지 않는다.

실기 검증은 같은 폰으로 같은 직선 왕복을 다음 조건으로 비교하라: 동일한 손·자세 유지, 휴대폰만 180도 회전, 손·기울기 변경, 몸의 실제 U턴. 복도와 자기장 교란이 적은 실외에서 각각 비교하면 원인 구분에 도움이 된다.

모든 실험의 sensor reference frame, 운반 방식, 추정 상태, 모호성, 자기장 품질, 원본 수집 수를 남긴다. 지도상 경로가 좋아 보이는 것만으로 센서 정확도가 좋아졌다고 결론내리지 않는다. 원형 복도에만 해당하는 보정을 일반 왕복 경로 검증에 사용하지 않는다.

## 최종 보고

변경 파일, 좌표계와 단위 정의, 추정기 버전·파라미터, 통과한 테스트/빌드, 실기 검증 결과를 보고하라. iOS에서 완료한 부분과 서버 적용이 남은 부분을 구분하라. 서버 연동 계약과 후속 구현 체크리스트를 별도 문서로 남겨 다음 작업자가 바로 구현할 수 있게 하라.

참고:

- [Apple: CMMotionManager와 처리된 device-motion 좌표](https://developer.apple.com/documentation/coremotion/cmmotionmanager)
- [Apple: userAcceleration](https://developer.apple.com/documentation/coremotion/cmdevicemotion/useracceleration)
- [Apple: calibrated magneticField](https://developer.apple.com/documentation/coremotion/cmdevicemotion/magneticfield)
- [보행축 PCA와 앞뒤 180도 모호성을 다루는 연구](https://www.mdpi.com/1424-8220/15/9/21518) — 특정 주머니 운반 조건의 연구이며 모든 운반 방식에 동일하게 적용된다고 가정하지 않는다.
