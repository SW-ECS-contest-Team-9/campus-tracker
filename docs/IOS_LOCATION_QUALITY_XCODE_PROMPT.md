# Xcode 전달용: iOS 위치 수신 품질 — 최고 정확도 강제, 권한 시점, 요청 설정 기록, ARKit 영향 확인

아래 프롬프트 전체를 Xcode의 코딩 에이전트에 전달한다. 업로드 큐·Stop·종료 처리는 `docs/IOS_ANDROID_BASELINE_XCODE_PROMPT.md`가 다루므로 여기서는 반복하지 않는다. 이 문서의 범위는 **Core Location에서 받는 위치의 품질**이다. 근거 분석은 `docs/IOS_ANDROID_COMPARISON_20261013.md`(특히 "추가(2026-10-14)" 절)에 있다.

---

Campus Tracker iOS 앱의 위치 수집을 점검하고 고쳐라. 목표는 수집 세션의 첫 샘플부터 항상 최고 정확도 요청(`kCLLocationAccuracyBestForNavigation`)으로 위치를 받고, 그때 어떤 설정과 권한 상태였는지를 서버에서 세션별로 확인할 수 있게 하는 것이다. 먼저 현재 코드를 읽어 아래 관측이 지금 코드에도 해당하는지 확인하고, 해당하는 것만 고쳐라. 진행 중인 ARKit·업로드 큐 작업은 보존한다. 서버 코드는 수정하지 않는다. 위치 좌표나 정확도 값을 앱에서 보정·필터링하지 않는다(받은 그대로 보낸다).

## 1. 관측된 사실

2026-10-13 세션 한 쌍(iPhone C04 `7fc9fe96-61d7-4373-bf08-fb3f95f1f6dc`, Galaxy S21 C02 `ec40aab5-749f-43b5-8b17-3ce68ad62672`)에서 나온 것이다. 두 폰은 같은 동선을 함께 이동했고 Android 융합 결과가 실제 동선에 가까웠다는 것이 수집자의 확인이다. 세션이 한 쌍뿐이므로 일반화하지 말라.

- 두 폰 모두 단일 주파수 GPS다. 수신기 등급 차이가 아니다.
- C04 위치 fix는 21:54:52~22:01:52 KST 동안 Android 궤적에서 분별 중앙값 23~35 m 떨어져 있었다(같은 시간 C02 원시 GPS는 2~15 m). 무작위 잡음이 아니라 분 단위로 방향이 바뀌는 치우침이었다. 폰이 보고한 `horizontalAccuracy`는 12~33 m였다.
- 22:01:33에 모든 센서가 21.6초 끊긴 뒤 새 `sensorSegmentId`로 다시 시작됐다. 그 뒤 3분은 3~8 m로 Android와 같은 수준이다.
- 재시작 전후로 fix의 성격이 다르다.

  | | 재시작 전 | 재시작 후 |
  |---|---|---|
  | fix 빈도 | 0.46개/초 | 1.00개/초 |
  | `speed`가 유효(≥ 0)한 fix | 94 / 193 | 222 / 242 |
  | `verticalAccuracy`가 없는(≤ 0) fix | 32 | 0 |
  | `horizontalAccuracy` | 10~40 m로 퍼짐 | 14.2 m에 고정 |

- 위치 권한이 세션 도중에 바뀌었다. 진단 이벤트: 21:54:31 수집 시작(`locationAuthorization: notDetermined`으로 보고) → 21:54:34 `authorizedWhenInUse` → 21:55:29 `authorizedAlways`. 정확한 위치는 켜져 있었다(`fullAccuracy`).
- ARKit 세션이 수집 시작과 함께 돌고 있었다(21:54:32 `SENSOR_STARTED sensor=arkit`).
- 진단 이벤트는 21:55:29가 마지막이다. 22:01:33 공백과 재시작에 대한 이벤트(`SENSOR_STARTED` 등)가 서버에 없다.

**확인되지 않은 것**: 재시작 전 7분 동안 위치가 나빴던 원인. 권한 창은 첫 1분에 끝났는데 편향은 7분 동안 이어졌으므로 권한 시점만으로는 설명되지 않는다. 후보는 ARKit 동시 실행, 그 시점의 Core Location 내부 상태(위성 기반이 아닌 측위가 섞임), 폰을 든 자세다. 서버 데이터로는 가릴 수 없다. 22:01:33 재시작이 앱 재실행인지 센서만 재시작인지도 모른다.

## 2. 먼저 읽을 파일

- `ios/Untitled Project/CampusTracker/Services/SensorServices.swift` — `LocationService`
- `ios/Untitled Project/CampusTracker/Services/CollectionCoordinator.swift` — 수집 시작, 권한 요청, `sensorCapabilities` 조립, 진단 이벤트
- `ios/Untitled Project/CampusTracker/Models/SensorModels.swift` — `LocationCollectionProfile`, `SensorCapabilities`
- `ios/Untitled Project/CampusTracker/ContentView.swift` — Start 버튼, 위치 프로필·거리 필터 설정 UI
- `ios/Untitled Project/CampusTracker/ARKit/` — ARKit 세션 시작·중단
- `ios/Untitled Project/CampusTracker/Info.plist`

2026-10-14 시점 작업 트리에서 본 것(그날 빌드와 다를 수 있으니 다시 확인하라): 기본 프로필 `highAccuracy`는 `kCLLocationAccuracyBest`(6절에서 `BestForNavigation`으로 올린다), `balanced`는 10 m, `batterySaving`은 100 m. `activityType = .fitness`, 거리 필터는 사용자 설정(기본 0 m, 최대 100 m), 자동 일시정지 꺼짐, 백그라운드 위치 켜짐. `LocationService.start`는 권한이 `notDetermined`이면 그 자리에서 `requestWhenInUseAuthorization()`을 호출하고, 허용 콜백이 올 때 `startUpdatingLocation()`을 한다. 즉 기본 설정은 한 단계 낮은 `Best`이고 사용자가 더 낮출 수 있으며, 권한을 묻는 시점이 수집 시작과 겹친다. 그날 C04가 어떤 프로필과 거리 필터로 수집했는지는 서버에 기록이 없다.

## 3. P0: 수집 시작 전에 권한을 끝낸다

- 위치 권한이 `notDetermined`인 채로 수집이 시작되지 않게 한다. 권한 요청은 앱 첫 진입이나 설정 화면에서 먼저 하고, Start는 `authorizedWhenInUse` 또는 `authorizedAlways`가 된 뒤에만 가능하게 한다. 거부·제한 상태면 이유와 설정 앱으로 가는 길을 보여 준다.
- "항상 허용" 요청도 수집 도중이 아니라 그 전에 한다. 포그라운드 수집에는 "사용 중 허용"으로 충분하고 정확도도 같다. "항상 허용"을 요구할지는 백그라운드 수집 요구에 맞춰 정하되, 세션 중에 권한 창이 뜨는 흐름은 없앤다.
- `accuracyAuthorization`이 `.reducedAccuracy`이면 수집을 시작하기 전에 알린다. `requestTemporaryFullAccuracyAuthorization(withPurposeKey:)`로 그 세션에 한해 정확한 위치를 요청하고(`Info.plist`에 `NSLocationTemporaryUsageDescriptionDictionary` 필요), 거부되면 그 사실을 화면과 세션 정보에 남긴 채 사용자가 계속할지 정하게 한다. 말없이 뭉개진 위치로 수집하지 않는다.
- 세션 도중 권한이나 정확도 권한이 바뀌면 지금처럼 진단 이벤트를 남긴다. 바뀐 값이 무엇인지 포함한다.

## 4. P0: 요청 설정과 수신 상태를 세션마다 기록한다

서버는 `session:start`의 `sensorCapabilities`를 그대로 저장한다(자유 형식 객체, 서버 수정 불필요). 지금은 위치 요청 설정이 들어 있지 않아 서버에서 세션 간 비교가 안 된다.

- `sensorCapabilities`에 실제로 적용한 값을 넣는다: 위치 프로필 이름, `desiredAccuracy`(요청한 상수 이름), `distanceFilter`(m), `activityType`, `pausesLocationUpdatesAutomatically`, `allowsBackgroundLocationUpdates`, ARKit 사용 여부. 기존 키(`locationAuthorization`, `locationAccuracyAuthorization`, `motionUpdateHz` 등)는 이름과 의미를 바꾸지 않는다.
- `locationAuthorization`은 수집을 실제로 시작한 시점의 값이어야 한다. 3절을 하면 `notDetermined`로 보고되는 일이 없어진다.
- 세션 중 설정을 바꿀 수 있다면(프로필, 거리 필터) 바뀐 시각과 값을 진단 이벤트로 남긴다.
- 위치 스트림이 다시 시작될 때(새 `sensorSegmentId`) 이유를 담은 진단 이벤트를 남긴다. 센서 재시작·앱 재실행·세션 복구를 구분할 수 있어야 한다. 이 요구는 `IOS_ANDROID_BASELINE_XCODE_PROMPT.md` 5절과 겹치므로 거기서 이미 했다면 위치 스트림이 포함되는지만 확인한다.
- `CLLocation`에서 지금 버리고 있는 품질 단서가 있으면 함께 보낼 수 있는지 검토한다. 후보: `sourceInformation`(`isSimulatedBySoftware`, `isProducedByAccessory`), `speedAccuracy`, `courseAccuracy`, `floor`. 서버의 위치 샘플 스키마는 `speedAccuracy`, `courseAccuracy`, `floor`를 이미 받는다. 그 밖의 필드는 서버 스키마(`backend/src/modules/telemetry/telemetry.dto.ts`의 `LocationSample`)에 없어서 보내도 저장되지 않고 버려진다. 필요하다고 판단되면 보내지 말고 서버 계약 변경 요청으로 보고한다.

## 5. P1: ARKit이 위치 수신에 영향을 주는지 확인한다

원인 후보이지 확인된 원인이 아니다. 코드를 고치기 전에 측정한다.

- ARKit 세션 설정에서 위치·나침반과 관련된 것을 확인한다(`worldAlignment`가 `.gravityAndHeading`인지, `ARGeoTrackingConfiguration`을 쓰는지 등). Core Location 사용과 겹치는 설정이 있으면 무엇을 왜 쓰는지 적는다.
- ARKit을 켜고 끄는 스위치가 수집 화면에 있는지 확인하고, 없으면 실험용으로 추가한다. 선택 값은 4절대로 `sensorCapabilities`에 기록한다.
- 같은 폰으로 같은 실외 구간을 ARKit 켠 세션과 끈 세션으로 각각 수집한다. 권한은 미리 확정해 두고, 둘 다 6절의 `BestForNavigation`으로 한다. 비교할 값: fix 빈도, 5초 넘는 fix 공백, `horizontalAccuracy` 분포, `speed`가 유효한 fix 비율, `verticalAccuracy`가 유효한 fix 비율.
- 차이가 없으면 ARKit을 원인에서 제외한다고 보고한다. 차이가 있으면 그 수치와 함께 보고하고, ARKit 쪽 동작을 바꾸는 것은 ARKit 담당 작업과 조율한다.

## 6. P0: 수집 중에는 항상 `kCLLocationAccuracyBestForNavigation`

수집 세션의 위치 요청은 예외 없이 `kCLLocationAccuracyBestForNavigation`으로 한다. 선택 사항이 아니다.

- `LocationService.start`가 적용하는 `desiredAccuracy`는 프로필과 무관하게 `kCLLocationAccuracyBestForNavigation`이다. 포그라운드와 백그라운드 모두 같다.
- `LocationCollectionProfile`의 `balanced`(10 m)와 `batterySaving`(100 m)은 수집에 쓸 수 없게 한다. 선택 UI에서 없애거나, 프로필을 남겨야 할 이유가 있으면 `desiredAccuracy`에는 영향을 주지 않게 한다. 저장된 사용자 설정(`@AppStorage("locationProfile")`)이나 복구되는 세션(`ActiveCollectionStore`)에 낮은 프로필이 남아 있어도 적용값은 `BestForNavigation`이어야 한다.
- 다른 코드 경로가 `desiredAccuracy`를 낮추지 않는지 확인한다: 세션 복구·재시작, 백그라운드 전환, 저전력 모드 대응, ARKit 시작·중단. 낮추는 곳이 있으면 제거한다.
- `distanceFilter`는 `kCLDistanceFilterNone`(0)으로 고정한다. 설정 UI의 거리 필터 조절은 수집에 적용되지 않게 한다.
- 적용값은 4절대로 `sensorCapabilities`에 기록한다. 서버에서 모든 iOS 세션이 `BestForNavigation`으로 보고되는지로 이 요구를 검증한다.
- 배터리 소모가 늘어난다. Apple은 이 값을 전원 연결 상황을 전제로 설명한다. 수집을 막을 이유는 아니지만, 20분 세션에서 배터리가 얼마나 줄었는지 한 번 재서 보고한다. 발열로 OS가 위치 갱신을 줄이는 징후(fix 간격이 늘어남)가 보이면 그 수치도 보고한다. 그 경우에도 앱이 스스로 정확도를 낮추지는 않는다.
- 요청값은 상한이 아니라 요청일 뿐이다. 실내에서는 여전히 위성 기반이 아닌 fix가 올 수 있고, 이 설정이 2026-10-13 세션의 편향을 없앤다는 보장은 없다. 효과는 9절의 비교로 확인한다.

## 7. 선택: 라이브 액티비티

위치 정확도를 위한 것이 아니다. 백그라운드 위치는 이미 `UIBackgroundModes: location`, `allowsBackgroundLocationUpdates`, 파란 표시로 유지된다. 목적은 수집 중인 세션이 방치되지 않게 하는 것이다(C04는 종료 요청 없이 ACTIVE로 남았다).

- 잠금 화면과 Dynamic Island에 수집 상태를 보여 준다: 경과 시간, 업로드 대기 수, 연결 상태. 종료로 가는 길을 둔다.
- ARKit은 앱이 백그라운드로 가면 멈춘다. 라이브 액티비티로 바뀌지 않으므로 그 상태를 표시에 반영한다.
- P0·P1이 끝난 뒤에 한다. 범위가 커지면 별도 작업으로 넘긴다.

## 8. 하지 말 것

- Android 궤적이나 지도에 맞추려고 좌표·고도·정확도 값을 앱에서 고치지 않는다.
- 보고 정확도가 나쁜 fix를 앱에서 버리지 않는다. 서버가 원시 값을 보고 판단한다.
- 수집 중 `desiredAccuracy`를 `BestForNavigation`보다 낮추거나 거리 필터를 0보다 크게 두지 않는다(6절).
- 지도 위 길에 위치를 붙이는 기능을 켜지 않는다. 캠퍼스 실내·건물 사이에서 엉뚱한 길로 붙을 수 있다.
- Apple Watch 연동을 추가하지 않는다. 대상 워치(SE 2)는 단일 주파수이고 폰이 옆에 있으면 폰 위치를 받아 쓴다.

## 9. 검증과 보고

실기기 검증(시뮬레이터로는 위치 품질을 판단할 수 없다):

1. 권한이 미결정인 새 설치 상태에서 Start를 눌러도 수집이 시작되지 않고 권한 흐름으로 안내된다. 권한 확정 후 시작한 세션의 진단 이벤트에 세션 도중의 `LOCATION_AUTHORIZATION_CHANGED`가 없다.
2. 정확한 위치를 끈 상태에서 Start: 경고가 뜨고, 임시 정확한 위치를 허용하면 `fullAccuracy`로, 거부하고 계속하면 `reducedAccuracy`로 서버에 기록된다.
3. 서버 `GET /api/v1/sessions/{id}`의 `sensorCapabilities`에 4절의 값이 실제 적용값과 같게 들어 있다.
4. 수집 중 홈 화면으로 나갔다가 돌아와도 위치 fix 간격이 유지된다(공백 없이 약 1초).
5. 프로필 설정에 낮은 값이 저장된 상태, 세션 복구 후, 백그라운드 전환 후 각각에서 서버에 기록된 `desiredAccuracy`가 `BestForNavigation`이고 거리 필터가 0이다.
6. 5절의 ARKit 쌍 비교 결과표, 그리고 6절 적용 전 빌드(`Best`)와 적용 후 빌드(`BestForNavigation`)로 같은 구간을 걸은 비교표와 배터리 소모.

비교 결과는 서버에서 `npm run fusion:compare -- --session=<id> --session=<id> --cutoff=<iso> --from=<iso>`로 뽑을 수 있다(읽기 전용). 가능하면 Android와 함께 같은 구간을 걷고, 둘 다 Stop으로 종료한다.

최종 보고: 확인된 원인과 여전히 모르는 것, 변경한 파일, 위 검증 결과, 서버에 필요한 계약 변경(있다면). 실기기에서 하지 못한 검증은 하지 못했다고 적는다.
