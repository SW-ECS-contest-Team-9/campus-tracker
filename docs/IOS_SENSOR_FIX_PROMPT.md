# iOS 앱 수정 프롬프트: 센서 데이터 품질 (보수계 0 샘플 · 백그라운드 정지 · 메타데이터 · 방향 기준계)

iOS 센서 수집 앱이 서버로 보내는 원시 데이터에 결함이 있어 서버의 위치 추정(sensor fusion)이 불안정하다. 아래 "서버에서 확인된 사실"은 실제 iPhone 세션 데이터로 확인한 내용이다. 각 항목의 원인을 앱 코드에서 찾아 고쳐라.

작업 방식:
1. 먼저 센서 수집(CLLocationManager, CMMotionManager, CMAltimeter, CMPedometer), 샘플 변환, 업로드 큐 코드를 읽어라. 각 센서 샘플이 만들어지는 **모든 호출 경로**를 설명하라.
2. 원인을 확인한 뒤 최소 변경으로 수정하라.
3. 마지막에 변경 파일, 원인, 수정 이유를 요약하라.

서버 API는 바꿀 필요가 없다. 아래에 나오는 필드는 모두 이미 서버가 받는다. 이전에 고친 업로드 큐, ACK, 재연결, clientSessionId 재사용 규칙은 깨지 않게 유지하라.

---

## 서버에서 확인된 사실 (2026-10-02, 같은 iPhone의 실제 세션들)

| # | 관찰 | 영향 |
|---|---|---|
| 1 | **보수계 0 샘플**: 4개 세션에서 17번, `numberOfSteps: 0, distance: 0` 샘플이 누적값 스트림 중간에 끼어 있다. 바로 다음 샘플은 다시 원래 누적값이다. 예: `82.4s 158걸음 → 85.6s 0 → 87.5s 158`, `179s 64 → 180s 0 → 182s 82` | 서버가 카운터 리셋으로 오인해 수 m씩 가짜 이동이 생겼다. 서버는 임시로 이런 샘플을 무시하게 바꿨지만 원인은 앱에 있다 |
| 1-a | 0 샘플은 정상 업데이트 주기(약 2.58초)와 **어긋난 시각**에 나온다. 걷다가 멈출 때, 다시 걸을 때 주로 생긴다. 0 샘플이 있는 세션은 **모두 종료 0.4~5.2초 전에 0 샘플로 끝난다** | 정상 `startUpdates` 핸들러가 아닌 다른 경로가 샘플을 만든다는 뜻이다 |
| 1-b | **0 샘플은 10월 2일 11:25에 시작한 세션부터 나타난다.** 11:03 세션까지는 하나도 없다(앱 버전 문자열은 계속 1.0) | 그 사이에 바뀐 보수계·세션 종료 코드를 git 이력에서 먼저 확인하라 |
| 2 | **백그라운드에서 앱 전체가 멈춘다**: 31초~18.6분짜리 모션 공백이 15번 있었다. 공백 동안 위치·기압·보수계 샘플도 0~3개뿐이다. 한 세션은 72분 중 56분이 비어 있다. 재개되면 그동안의 걸음(784걸음/643 m)이 1분에 몰린다 | 그 구간의 동선이 통째로 없다 |
| 3 | **메타데이터가 비어 있다**: 위치 670건 모두 `speedAccuracy`, `courseAccuracy`, `floor`, `appState`, `sensorSegmentId`가 null이다. 보수계 383건도 모두 `sequence`, `appState`가 null이다 | 백그라운드 여부, 센서 재시작, GPS 진행방향 신뢰도를 판단할 수 없다 |
| 4 | **yaw 기준계가 임의(arbitrary)다**: 모든 세션에서 `attitude.yaw`가 0° 근처에서 시작한다 | 절대 방위가 없다. 실내처럼 GPS가 나쁜 곳에서는 처음 방향을 잡을 수 없다 |
| 5 | yaw 변화량 자체는 정확하다. 계단 3개 층을 내려가는 동안 −970° 회전이 기압계 −9.2 m와 정확히 맞았다. 50 Hz도 안정적이다(간격 20 ms) | 유지할 것 |
| 6 | 실외 세션의 GPS 갱신 간격 중앙값이 2초다(기대값 약 1초) | 위치 설정을 확인할 것 |

---

## 수정 1. 보수계: 누적값 스트림 하나만 보낸다 (필수)

서버 계약: `numberOfSteps`/`distance`는 **보수계 실행 단위(`sensorSegmentId`)의 누적값**이다. 같은 실행 안에서는 값이 줄어들면 안 된다.

1. 보수계 샘플을 만드는 경로를 모두 찾아라. 의심되는 경로는 다음과 같다.
   - `startEventUpdates`(pause/resume 이벤트)를 보수계 샘플로 변환하는 곳
   - `queryPedometerData` 스냅샷이나 증분 조회
   - 상태 보고(collector:status)나 하트비트에 붙는 보수계 값
   - 세션 종료 시 마지막 "flush" 샘플. 모든 세션이 0으로 끝나므로 가장 유력하다
   - `stopUpdates` 뒤의 콜백
   - `data`가 nil이거나 `error`인 콜백을 `?? 0`으로 변환하는 곳
   - 0으로 초기화된 struct를 그대로 큐에 넣는 곳
2. 보수계 샘플은 **`startUpdates(from: 세션 시작 시각)` 핸들러에서만** 만든다. `from`이 과거면 iOS가 그 시각부터의 누적값을 준다.
   ```swift
   pedometer.startUpdates(from: sessionStartDate) { data, error in
       guard let data, error == nil else {
           // 샘플을 만들지 말고 diagnostic:event PEDOMETER_ERROR 로 남긴다 (error code 포함)
           return
       }
       enqueue(PedometerSample(
           sequence: nextPedometerSequence(),          // 세션 내 0부터 단조 증가
           timestamp: data.endDate,                    // 측정 구간의 끝 시각
           numberOfSteps: data.numberOfSteps.intValue,
           distance: data.distance?.doubleValue,       // nil은 nil 그대로. `?? 0` 금지
           currentPace: data.currentPace?.doubleValue,
           currentCadence: data.currentCadence?.doubleValue,
           floorsAscended: data.floorsAscended?.intValue,
           floorsDescended: data.floorsDescended?.intValue,
           sensorSegmentId: pedometerSegmentId))
   }
   ```
3. pause/resume 이벤트가 필요하면 보수계 샘플이 아니라 `diagnostic:event`(`PEDOMETER_PAUSE`/`PEDOMETER_RESUME`)로 보낸다.
4. 세션 종료 시에는 `stopUpdates()`만 호출하고 추가 샘플을 만들지 않는다.
5. 앱이 재실행돼 보수계를 다시 시작해야 하면 같은 `from: sessionStartDate`로 시작해 누적 기준을 유지하라. 기준 시각이 달라지는 재시작이라면 **새 `sensorSegmentId`**를 쓴다.
6. 과거 구간을 `queryPedometerData(from: sessionStartDate, to:)`로 복구해서 보낼 때도 값은 세션 시작 기준 누적값이어야 한다. 이때 `captureSource: "HISTORICAL_RECOVERY"`로 표시한다.

## 수정 2. 백그라운드·화면 잠금에서도 수집이 계속되게 (필수)

백그라운드 위치 업데이트가 앱을 깨워 두지 못하고 있다. 아래를 확인하고 맞춰라. 수정 전 값과 수정 후 값을 보고에 포함하라.

```swift
// Info.plist: UIBackgroundModes 에 location 포함, 위치 권한 문구 포함
locationManager.desiredAccuracy = kCLLocationAccuracyBest
locationManager.distanceFilter = kCLDistanceFilterNone
locationManager.activityType = .fitness
locationManager.pausesLocationUpdatesAutomatically = false   // true면 iOS가 멈춘 것으로 판단해 업데이트를 끊고 앱이 정지된다
locationManager.allowsBackgroundLocationUpdates = true
locationManager.showsBackgroundLocationIndicator = true
```

- 위치 업데이트는 수집 시작 시 **포그라운드에서** 시작해야 한다. "앱을 사용하는 동안" 권한일 때 그래야 백그라운드에서 계속된다.
- `CLLocationUpdate.liveUpdates`(iOS 17+)를 쓰고 있다면 수집하는 동안 `CLBackgroundActivitySession`을 유지하라.
- CMMotionManager, CMAltimeter, CMPedometer 업데이트를 백그라운드 진입이나 WebSocket 끊김 때 멈추는 코드가 있으면 제거하라. 수집 중지는 사용자가 Stop을 누를 때만 한다. 모션 핸들러는 main이 아닌 전용 `OperationQueue`에서 받는다.
- `locationManagerDidPauseLocationUpdates` / `didResumeLocationUpdates`, `applicationDidEnterBackground` / `willEnterForeground`는 `diagnostic:event`로 남겨라(수정 4).

## 수정 3. 샘플 메타데이터 채우기 (필수)

서버가 이미 받는 필드다. 샘플마다 넣는다. 배치 단위 값은 샘플 값이 없을 때만 기본값으로 쓰인다.

| 필드 | 값 |
|---|---|
| `appState` | 샘플 **수집 시점**의 `FOREGROUND` / `BACKGROUND`. 알림(didEnterBackground/willEnterForeground)으로 갱신하는 thread-safe 캐시 값을 쓴다 |
| `captureSource` | 평소 `LIVE`. 사후 조회로 복구한 데이터는 `HISTORICAL_RECOVERY` |
| `sensorSegmentId` | 센서별로 업데이트를 **시작하거나 재시작할 때마다** 새 UUID 문자열(64자 이하). 같은 실행 동안은 유지한다. 재시작 후 기존 ID를 재사용하지 않는다 |
| 위치 `speedAccuracy` | `CLLocation.speedAccuracy` |
| 위치 `courseAccuracy` | `CLLocation.courseAccuracy` (iOS 13.4+) |
| 위치 `floor` | `CLLocation.floor?.level` (없으면 null) |
| 보수계 `sequence` | 세션 내 0부터 단조 증가. `session:finish`·`session:syncComplete`의 `lastSequences.pedometer`에도 같은 값을 쓴다 |

iOS의 무효값(음수 accuracy·course·speed)은 그대로 보낸다. NaN·Infinity만 null로 바꾼다(이전 수정과 동일).

## 수정 4. 방향 기준계와 수집 환경 보고 (권장)

1. 디바이스 모션을 북쪽 기준계로 받는다. **세션 시작 때 한 번 정하고 세션 동안 바꾸지 않는다.**
   ```swift
   let frames = CMMotionManager.availableAttitudeReferenceFrames()
   let frame: CMAttitudeReferenceFrame =
       frames.contains(.xTrueNorthZVertical) ? .xTrueNorthZVertical :
       frames.contains(.xMagneticNorthZVertical) ? .xMagneticNorthZVertical :
       .xArbitraryCorrectedZVertical
   motionManager.deviceMotionUpdateInterval = 1.0 / 50.0     // 50 Hz 유지
   motionManager.startDeviceMotionUpdates(using: frame, to: motionQueue) { motion, error in ... }
   ```
   - 지금 쓰는 기준계가 무엇인지 보고에 적어라.
   - 서버의 현재 엔진은 yaw **변화량**만 쓰므로 기준계를 바꿔도 깨지지 않는다. 북쪽 기준계면 서버가 다음 버전에서 절대 방위로 활용할 수 있다.
   - 세션 중에 기준계를 바꿔야 하면 모션 `sensorSegmentId`를 새로 발급한다.
2. `session:start`의 `sensorCapabilities`에 다음을 추가한다(자유 형식 JSON, 서버에 그대로 저장된다).
   ```json
   {
     "attitudeReferenceFrame": "xTrueNorthZVertical",
     "motionUpdateHz": 50,
     "locationAuthorization": "authorizedWhenInUse",
     "locationAccuracyAuthorization": "fullAccuracy",
     "backgroundLocationUpdates": true,
     "pausesLocationUpdatesAutomatically": false
   }
   ```
   - 기존 키(`deviceMotionAvailable` 등)는 유지한다.
   - "정확한 위치"가 꺼져 있으면(`reducedAccuracy`) 그대로 보고하라. 서버가 원인을 구분할 수 있다.

## 수정 5. 진단 이벤트 (권장)

서버는 `diagnostic:event`를 받는다. 퓨전 입력이 아니라 공백·재시작 원인을 확인하는 용도다.
- 이벤트도 배치처럼 로컬 큐에 저장했다가 보낸다(local-first).
- `eventId`(UUID)로 중복이 제거되므로 재전송해도 된다.
- 콜론 대신 점(`diagnostic.event`) 표기도 받는다.

```json
{ "requestId": "…", "type": "diagnostic:event",
  "payload": { "clientSessionId": "…", "events": [
    { "eventId": "uuid", "eventType": "APP_BACKGROUND", "clientTimestamp": "2026-10-02T06:01:09.120Z",
      "metadata": { "lowPowerMode": false } } ] } }
```

보낼 이벤트: `APP_BACKGROUND`, `APP_FOREGROUND`, `LOCATION_PAUSED`, `LOCATION_RESUMED`, `SENSOR_STARTED`·`SENSOR_STOPPED`(metadata: sensor, sensorSegmentId, reason), `PEDOMETER_ERROR`(error code), `PEDOMETER_PAUSE`/`PEDOMETER_RESUME`, `MAGNETIC_CALIBRATION`(`motion.magneticField.accuracy`가 바뀔 때만), `LOW_POWER_MODE`, `LOCATION_AUTHORIZATION_CHANGED`.

---

## 하지 말 것

- 원시 값을 가공·필터링하지 않는다. 세션 시작 직후 들어오는 오래된(캐시) 위치도 그대로 보낸다. 판단은 서버가 한다.
- nil을 0으로 바꾸지 않는다(보수계, 고도, accuracy 전부).
- 보수계 스트림에 증분값·스냅샷·0 샘플을 섞지 않는다.
- 세션 중 기준계 변경, 센서 재시작 후 기존 `sensorSegmentId` 재사용을 하지 않는다.
- WebSocket 연결 상태에 따라 센서 수집을 켜고 끄지 않는다. 수집과 업로드는 독립적이다.

## 완료 확인

기기에서 아래 순서로 테스트 세션 하나를 기록하라.
1. 실외에서 Start를 누르고 앱 화면을 켠 채 1분 걷는다.
2. 화면을 잠그고 3분 걷는다. 중간에 30초 멈춘다.
3. 홈으로 나가 다른 앱을 연 채 2분 걷는다.
4. 계단을 한 층 오르내린다.
5. 앱으로 돌아와 Stop을 누른다.

Xcode 콘솔에 다음을 출력하게 하라.
- 센서별 시작·재시작 시 `sensorSegmentId`
- 사용한 attitude 기준계
- `allowsBackgroundLocationUpdates` / `pausesLocationUpdatesAutomatically` 값
- 세션 종료 시 센서별 마지막 sequence

보고에 포함할 것:
- 변경 파일과 이유
- 0 샘플을 만들던 코드 경로(정확한 위치)
- 백그라운드 설정의 수정 전/후 값
- 사용 중인 기준계
- 테스트 세션의 clientSessionId

서버 측에서는 이 세션으로 다음을 확인한다.
- `sessions:diagnose`: `Motion gaps > 1s: 0`, 센서별 segments ≥ 1
- `fusion:diagnose`: 보수계 `ignored below running max 0`
- 위치 샘플의 `speedAccuracy`/`courseAccuracy`가 채워짐
- 화면 잠금 구간 샘플의 `appState`가 `BACKGROUND`
- `sensorCapabilities.attitudeReferenceFrame`이 기록됨
