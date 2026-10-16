# BLE / iBeacon 정밀 실내 위치추정 (fusion-v4 rev 18)

작성일: 2026-10-15
상태: 서버·Android·iOS 구현. 서버와 Android는 자동 테스트로 검증, iOS는 Xcode 빌드 미검증(아래 §11).

## 1. 기존 구조와의 차이 (먼저 확인한 사항)

작업 지시는 "iOS·Android의 기존 Sensor Fusion Engine에 BeaconMeasurement를 추가"하라고 하지만, 실제 저장소에는
**모바일 앱에 퓨전 엔진이 없다.** 두 앱은 원시 센서를 수집·업로드하는 Collector이고, 위치추정(PDR + EKF + RTS
smoother, `fusion-v4`)은 서버(`backend/src/modules/fusion`)에서만 실행된다.

이 차이를 대규모 구조 변경(모바일 퓨전 엔진 신규 개발)으로 메우지 않고 다음처럼 처리했다.

| 지시 항목 | 실제 적용 |
| --- | --- |
| 기존 Fusion Engine에 Beacon 측정 추가 | 서버 `fusion-v4`에 측정원으로 추가 (rev 18). 실시간(forward EKF)과 최종 재처리(RTS smoother) 모두 |
| iOS / Android Fusion Integration | 같은 측정 모델(보정 선택, log-distance, RSSI 창 필터)을 각 앱의 공통 `Positioning` 코드로 구현하고 서버와 **같은 fixture**로 검증. 온디바이스 엔진·Navigator가 붙을 측정 전처리 계층 |
| Floor Estimation | 서버 `fusion-v4`의 층 추정기 (비콘 층 투표 + 기압 상대고도 + 계단 걸음 + 층 높이) |

온디바이스 퓨전이 필요해지면(Navigator) 서버의 `fusion-beacon.ts`·`fusion-v4.smoother.ts`의 수식(§6)을 그대로
옮기면 되도록 측정 계층을 분리해 두었다. 이것은 향후 과제다(§12).

## 2. 아키텍처

```
          (공통 Positioning: 앱 간 재사용)                   (Collector 전용)
 iOS  CoreLocationBeaconScanner ─┐                     BeaconCollectionRecorder ── collection-v2.sqlite
      BeaconObservationAdapter   ├─ BeaconObservation ─▶  (세션·스위치·레지스트리)      beacon_observations
 And. AndroidBleBeaconScanner  ──┘   RssiModel            BeaconCollectionController ─ upload queue (kind=beacon)
      IBeaconParser                  BeaconMeasurementFilter
                                     BeaconRegistry / Cache ◀── GET /api/v1/positioning/beacon-config
                                                                           │
                       WebSocket  beacon.observations.v1  ─────────────────▼
 Server  positioning.beacon_observations (원시) ──▶ fusion-v4 rev 18 (측정원) ──▶ fused_positions (+ 층·비콘 진단)
```

- 비콘은 독립 위치추정 엔진이 아니라 `fusion-v4`의 측정원이다. 비콘 좌표로 위치를 덮어쓰지 않는다.
- 스캔은 플랫폼별로 분리(iOS Core Location, Android BluetoothLeScanner)하고, 관측 계약(`beacon.observations.v1`)은 하나다.
- Spatial Anchor의 원본 좌표·식별자는 서버가 관리하고, 앱은 설정을 캐시한다(서버가 끊겨도 캐시로 동작).
- 비콘 수집 실패(권한, Bluetooth 꺼짐, 서버 없음)는 GPS·IMU·기압 수집에 영향을 주지 않는다. 두 앱 모두 비콘
  코드는 기존 수집 코어(`CollectionCore` / `CollectionCoordinator`) 밖에 있다.

## 3. 좌표계

| 항목 | 값 |
| --- | --- |
| 수평 | EPSG:5186 (KGD2002 / Central Belt 2010), 미터. `campus_buildings`, `mobility.network_nodes`와 같음 |
| 수직 | 해발고도(MSL, KVD 인천 기준). `spatial_anchors.geom`의 Z = **비콘 설치 높이**, `floor_height_m` = 그 층 바닥 높이 |
| 퓨전 내부 | 세션 원점 기준 local ENU(m). 앵커는 EPSG:5186 → WGS84 → local로 변환(노드 기준점과 같은 경로) |
| 층 이름 | 수집 기준점과 같은 `1F`…`99F`, `B1`…`B9`. 1F와 B1은 한 층 차이(0층 없음) |

기압계 Z는 **상대고도**다. 층 판정은 기압 변화량만 쓰고, 절대 높이로 해석하지 않는다(§7). 절대 높이 영점은
`beaconFloorCorrectionEnabled`일 때만 "확정 층 바닥 높이 + 휴대폰 높이 − 그 시각 기압 Z" 관측으로 들어간다.

## 4. 서버 데이터 모델 (migration `030_beacon_positioning.sql`, schema `positioning`)

| 테이블 | 내용 |
| --- | --- |
| `spatial_anchors` | `id, anchor_type('BEACON'), building_id, floor, floor_height_m, geom PointZ 5186, horizontal/vertical_accuracy_m, status(ACTIVE/INACTIVE)` |
| `beacon_devices` | `id, anchor_id, protocol('IBEACON'), uuid, major, minor, measured_power_dbm, enabled, last_observed_at, disabled_at` — **UNIQUE(protocol, uuid, major, minor)**. MAC 주소는 저장하지 않음 |
| `beacon_calibrations` | `beacon_id(NULL=전체), platform('*','ios','android'), device_group('*' 또는 기기 모델), measured_power_1m, path_loss_exponent, rssi_variance_db2, sample_count` — UNIQUE NULLS NOT DISTINCT(beacon_id, platform, device_group) |
| `registry_state` | 한 행. 레지스트리를 바꾸는 모든 트랜잭션이 `revision`을 올림 = `configVersion` |
| `beacon_observation_batches` | 업로드 배치(멱등 키 `batch_id`), 세션·기기·플랫폼·개수 |
| `beacon_observations` | 원시 관측. UNIQUE(session_id, observation_id). 수신 시 식별 결과 `resolution`(REGISTERED / DISABLED / UNREGISTERED)과 `beacon_id` |
| `fused_positions` (컬럼 추가) | `floor_label, floor_building_id, floor_source, floor_confidence, beacon_updates` (모두 NULL 허용, 기존 행·다른 버전 영향 없음) |

세션 삭제(collector 삭제)는 기존처럼 `ON DELETE CASCADE`로 비콘 원시 데이터까지 지운다.

## 5. API

### 5.1 `GET /api/v1/positioning/beacon-config` (collector 토큰)

```json
{ "schemaVersion": 1, "configVersion": 12, "updatedAt": "...", "generatedAt": "...",
  "coordinateSystem": { "horizontal": "EPSG:5186", "vertical": "MSL_KVD_INCHEON", "units": "m" },
  "cachePolicy": { "maxAgeSeconds": 3600, "staleMaxSeconds": 1209600 },
  "features": { "scanning": true, "upload": true, "fusion": true, "floorCorrection": false },
  "proximityUuids": ["e2c56db5-..."],
  "rssiDefaults": { "measuredPower1m": -59, "pathLossExponent": 2.2, "rssiVariance": 36 },
  "defaultCalibrations": [ ... ],
  "beacons": [ { "beaconId", "protocol": "IBEACON", "uuid", "major", "minor", "measuredPowerDbm",
                 "anchor": { "anchorId", "buildingId", "floor", "floorHeightM", "position": {x,y,z},
                             "latitude", "longitude", "horizontalAccuracyM", "verticalAccuracyM" } | null,
                 "calibrations": [ { "platform", "deviceGroup", "measuredPower1m", "pathLossExponent", "rssiVariance", "sampleCount" } ] } ] }
```

- 활성 비콘만 포함(비활성 비콘·비활성 앵커 제외). 앵커가 없는 비콘도 UUID 수집을 위해 포함된다(`anchor: null`).
- `ETag: W/"beacon-config-<revision>-<features hash>"`, `If-None-Match` 일치 시 `304`. `Cache-Control: private, max-age`.
- 앱 캐시 정책: `maxAgeSeconds` 이내는 요청 없이 사용, `staleMaxSeconds` 이내는 오프라인에서도 사용(재검증 시도),
  그 이후는 만료. 만료된 설정으로는 원격 스위치를 신뢰하지 않지만 알고 있는 UUID의 원시 수집은 계속한다.
- 다른 서버의 캐시는 쓰지 않는다(서버 키별 캐시).

### 5.2 관리 API `/api/v1/positioning/admin/*`

collector 토큰 + `POSITIONING_ADMIN_COLLECTORS`(쉼표 구분 collector ID)에 있는 계정만. 목록이 비면 레지스트리는 읽기 전용.

| | |
| --- | --- |
| `GET /beacons?includeDisabled=&buildingId=` | 비콘 목록(앵커 포함) |
| `POST /beacons` | 등록 `{uuid, major, minor, measuredPowerDbm?, anchorId? \| anchor?, label?}`. 중복 식별자 409 `BEACON_EXISTS`(기존 id 포함) |
| `GET/PATCH /beacons/:id` | 조회 / 수정(측정 전력, 앵커 연결, 활성, 라벨, `anchor`: 설치 위치 전체 교체). **식별자(uuid/major/minor)는 수정 불가**. `anchor`는 그 비콘만 쓰는 앵커면 제자리 수정, 다른 비콘과 공유하면 새 앵커를 만들어 연결(공유 앵커는 그대로). `anchorId`와 동시 지정 불가 |
| `DELETE /beacons/:id`, `POST /beacons/:id/disable` | 비활성화(soft delete, 기본값) |
| `DELETE /beacons/:id?permanent=true` | 영구 삭제. 관측 행은 식별자를 그대로 두고 `beacon_id = NULL`, `UNREGISTERED`가 되어 `/discovered`에 다시 나오며, 같은 식별자를 다시 등록하면 퓨전에 쓰인다(퓨전은 식별자로 조인). 비콘별 보정값은 삭제, 다른 비콘이 쓰지 않는 앵커도 삭제 |
| `PUT /beacons/:id/anchor` | `{anchorId \| null}` 앵커 연결/해제 |
| `GET/POST /anchors`, `PATCH /anchors/:id` | Spatial Anchor 조회/생성/수정(위치 보정, 비활성화) |
| `GET/PUT /calibrations` | 보정값 upsert |

모든 변경은 `configVersion`을 올리고 로그(`beacon.registry.*`, actor 포함)를 남긴다.

### 5.3 비콘 등록 화면 `/beacons.html`

편집기와 같은 비밀번호 없는 트랙커 계정으로 로그인한다(같은 브라우저 저장소를 써서 편집기에 로그인돼 있으면 그대로 사용).
등록은 `POSITIONING_ADMIN_COLLECTORS`에 있는 계정만 가능하고, 아니면 화면 상단에 그 이유를 표시한다.

| 방법 | 동작 |
| --- | --- |
| 직접 입력 | UUID(대시·중괄호 없이 붙여 넣어도 정규화), Major·Minor(0~65535), 1 m 송신 세기, 이름, 설치 위치(건물·층·층 바닥 높이·위도/경도 또는 EPSG:5186 X/Y·설치 높이(해발)·정확도). 위치를 비우면 앵커 없이 등록 |
| 현재 위치 사용 | 브라우저 위치 권한으로 위도·경도·정확도를 채움(실내 GPS는 부정확하다고 표시) |
| 이 기기 블루투스 | `navigator.bluetooth.requestLEScan`으로 **브라우저의 블루투스 권한을 요청**하고 iBeacon 광고(Apple 0x004C, 0x02 0x15)만 검색. 신호 센 순으로 목록, 누르면 UUID·Major·Minor·송신 세기 채움. 이미 등록된 비콘은 "등록됨" 표시 |
| 앱이 들은 미등록 비콘 | `GET /admin/discovered`: 수집 앱이 올린 미등록 관측(UUID·Major·Minor별 횟수·최대 RSSI·플랫폼·최근 시각)과 **제안 위치**(신호가 가장 셀 때 그 세션의 fused 위치·층·건물). 누르면 식별자와 제안 위치를 채움 |
| 검색 UUID | `GET/POST/DELETE /admin/survey-uuids`. 앱 설정의 `proximityUuids`에 들어가, 아직 등록되지 않은 Major·Minor도 앱이 수집한다(iOS는 UUID를 모르면 검색 자체가 불가능) |

브라우저 블루투스 검색의 제약: Chromium 계열에서만, `chrome://flags/#enable-experimental-web-platform-features`를 켜야 하고,
https 또는 localhost에서만 열린다(LAN의 http 주소에서는 불가). Safari·iOS에는 Web Bluetooth가 없다. 일부 브라우저는 Apple 제조사
광고를 전달하지 않을 수 있어, 15초 동안 결과가 없으면 앱 수집 목록·직접 입력을 안내한다. 화면은 지원 여부와 이유를 먼저 표시한다.

관리 API 추가: 앵커 위치는 `{x, y, z}`(EPSG:5186) 또는 `{latitude, longitude, z}`(WGS84, 서버가 EPSG:5186으로 변환) 중 하나.
`GET /admin/me`(권한 확인), `GET /admin/discovered?sinceHours=&limit=`, `GET/POST/DELETE /admin/survey-uuids`.
퓨전 입력은 관측을 수신 시점의 해석(`beacon_id`)이 아니라 **식별자로 다시 찾으므로**, 검색 UUID로 걸으며 모은 관측은 나중에
그 비콘을 등록한 뒤 재처리하면 측정으로 쓰인다(migration `031_beacon_survey.sql`).

### 5.4 앱에서 비콘 등록·수정·삭제 (Android·iOS 설정 → "비콘 등록·수정·삭제")

웹 화면과 같은 관리 API(`/admin/me`, `/admin/beacons`, `/admin/survey-uuids`)를 앱의 collector 토큰으로 부른다. 권한도 같다
(`POSITIONING_ADMIN_COLLECTORS`). 폼 규칙(UUID 정규화, 범위, 층 형식, `z = 층 바닥 높이 + 바닥에서 높이`)은 웹·Android·iOS가
공용 fixture `fixtures/beacon/registration-cases.json`으로 같은 결과를 내는지 검사한다. 등록에 성공하면 수집 중인 비콘 설정을
바로 다시 받는다(maxAge를 기다리지 않음). 등록 화면은 수집 세션과 독립된 별도 스캐너·위치 요청을 쓰며 수집 데이터에 섞이지 않는다.

등록된 비콘 목록(사용 중지 포함)에서 하나를 누르거나, 검색 목록에서 "등록됨" 비콘을 누르면 수정 모드가 된다.
- 수정: 같은 폼(식별자 칸은 잠김) → `PATCH /admin/beacons/:id`. 비운 1 m 송신 세기·이름은 지워지고(null), 설치 위치를 모두 비우면
  앵커 연결이 해제된다(`anchorId: null`). 저장된 위치는 EPSG:5186이라 폼은 X/Y 모드로 열린다(위도·경도로 바꾸려면 "현재 위치").
  폼 → 요청 변환과 비콘 → 폼 변환은 같은 fixture의 `editCases`, `beaconToForm`으로 Android·iOS가 검사한다.
- 사용 중지 / 다시 사용: `PATCH {enabled}`. 설정·퓨전에서 빠지고 기록은 남는다.
- 삭제: 확인 후 `DELETE ?permanent=true`(위 5.2). 되돌릴 수 없다.
- 변경마다 목록과 수집 앱의 비콘 설정을 다시 받는다. 다른 곳에서 이미 삭제된 비콘은 "이미 삭제된 비콘" 안내 후 새 등록 모드로 돌아간다.

| | Android | iOS |
| --- | --- | --- |
| 주변 검색 | Nearby devices(+위치) 권한을 받아 **UUID와 관계없이** 모든 iBeacon 검색(ScanFilter: Apple 0x004C, 접두 0x02 0x15만) | Core Location은 UUID를 아는 비콘만 ranging 가능 → 등록된 비콘의 UUID + 검색 UUID + 화면에서 입력한 UUID로 검색 |
| 목록 | 미등록 먼저, 최대 RSSI 순. 누르면 UUID·Major·Minor·1 m 송신 세기 채움 | 같음. 단 iOS는 광고의 1 m 송신 세기를 알려주지 않아 그 칸은 비워 둔다(서버 기본값) |
| 현재 위치 | 수집 중 30초 이내 fix 재사용, 없으면 `LocationManagerCompat.getCurrentLocation`(GPS→네트워크, 15초) | 수집 중 30초 이내 fix 재사용, 없으면 `CLLocationManager.requestLocation`(15초) |
| 코드 | `collection/BeaconRegistrationController.kt`, `ui/BeaconRegistrationScreen.kt`, `positioning/BeaconRegistration.kt` | `Services/BeaconRegistrationModel.swift`, `BeaconRegistrationView.swift`, `Positioning/BeaconRegistration.swift` |

iOS에서 UUID를 모르는 비콘은 직접 입력하거나, Android·웹 화면으로 찾거나, 웹에서 검색 UUID를 추가해야 한다.

### 5.5 편집기 3D 지도에서 비콘 배치 (`/editor.html` → 왼쪽 "비콘 배치")

편집기의 3D 지도에 비콘 레이어를 그리고, 편집기 커서(EPSG:5186 X/Y + 정표고 Z)로 설치 위치를 정한다.
- 표시
  - 등록 비콘: 앵커 위치에 파란 점(사용 중지는 회색)과 지면에서 올라오는 기둥, "이름 · 층" 표지
  - 미등록 비콘(`/admin/discovered`, 최근 30일): 신호가 가장 셀 때 폰의 fused 위치에 주황 점선 기둥과 "? major / minor" 표시. 높이는 모르므로 지면 + 1.5 m
  - 편집 중인 비콘: 노란 점. 원래 위치에서 노란 점선으로 이어짐
  - 층 따로 보기·1인칭 보기에서는 다른 편집 표시와 함께 숨김
- 선택: 지도에서 비콘(점·표지·기둥)을 클릭하거나 패널 목록에서 고른다. "새 비콘"은 식별자를 입력해 새로 만든다.
- 배치
  - 클릭·WASD·R/F로 커서를 옮긴 뒤 **Space**(커서 위치에 놓기), **Enter**(저장), **Esc**(닫기)
  - "커서보다 위(m)": 커서를 바닥에 두고 설치 높이만 더한다(z = 커서 Z + 값)
  - "커서 따라가기": 커서를 움직이면 비콘도 따라간다
- 자동 채움: 놓는 순간 3D 지도의 건물 데이터로 건물 ID·층·층 바닥 높이를 채운다(`beacon-map.ts`)
  - 건물 ID는 커서 위치의 건물 외곽선에서 정한다
  - 층과 층 바닥 높이는 건물 노트의 층 표(`appearance.windows.floorsM` / `floorNames`)에서 커서 높이(+0.3 m 여유)가 속한 층으로 정한다
  - 건물 밖이면 `outdoor`(직접 입력한 건물 ID는 유지), 층 표가 없는 건물이면 층은 비운다
- 저장
  - 등록 비콘: `PATCH`(§5.2, 그 비콘만 쓰는 앵커는 제자리 수정)
  - 미등록·새 비콘: `POST`
  - "위치 해제" 후 저장하면 앵커 연결을 끊는다
  - 사용 중지 / 다시 사용 / 영구 삭제도 이 패널에서 한다
  - 입력 규칙과 변환은 웹 등록 페이지·앱과 같다(`buildCreateRequest` / `buildEditRequest`, 공용 fixture)
- 권한
  - `POSITIONING_ADMIN_COLLECTORS` 계정만 편집할 수 있다
  - 그 밖의 계정은 `beacon-config`(사용 중 비콘)를 읽기 전용으로 본다
- 동시 편집: 다른 편집자의 비콘 변경은 실시간으로 오지 않으므로 "새로고침"이 필요하다(도로·장소와 달리 편집권 lease도 없음)

## 6. WebSocket `beacon.observations.v1`

Raw WS `{ requestId, type: "beacon.observations.v1", payload }` 또는 Socket.IO 이벤트 `beacon.observations.v1` /
`beacon:observations.v1`. 기존 메시지는 바뀌지 않았다.

```json
{ "schemaVersion": 1, "sessionId": "server-uuid", "clientSessionId": "local-uuid", "batchId": "uuid",
  "platform": "ios" | "android", "deviceModel": "iPhone15,2", "createdAt": "...",
  "observations": [ { "observationId": "uuid", "protocol": "IBEACON", "uuid": "...", "major": 1, "minor": 2,
                      "rssiDbm": -71, "observedAt": "2026-10-15T01:00:00.120Z",
                      "proximity": "near", "platformEstimatedDistanceMeters": 3.2, "measuredPowerDbm": -59,
                      "observationTimeUncertaintyMs": 10, "rssiAggregation": "SINGLE_ADVERTISEMENT", "sampleCount": 1 } ] }
```

처리: 스키마 검증 → 세션 소유 확인(`sessionId` 또는 `clientSessionId`) → 행 검사 → 식별자 해석 → `BEGIN` →
배치 게이트 → 행 저장 → `last_observed_at` → `COMMIT` → ACK → (ACK 후) 퓨전.

| 정책 | 내용 |
| --- | --- |
| 기능 광고 | `session:start` ACK의 `supportedTelemetryFeatures`에 `beaconObservationsV1`(서버 `BEACON_POSITIONING=on`일 때). 앱은 이 세션에 대해 광고를 받은 뒤에만 전송 |
| 중복 batchId | 행 추가 없이 `duplicate: true`와 최초 `receivedAt`. 다른 세션이 쓴 batchId는 409 `BATCH_SESSION_CONFLICT` |
| 중복 observationId | (session, observationId) 기준으로 한 번만 저장. 새 배치에 다시 오면 `duplicateObservations`로 집계, 성공 ACK |
| 배치 내 중복 | `DUPLICATE_IN_BATCH`로 거절(저장 안 함), 나머지는 저장 |
| 행 검사 | RSSI가 −120…−1 dBm 밖(iOS의 0 = 미상, Android 127 = 없음) → `RSSI_OUT_OF_RANGE`; 시각이 2020년 이전·하루 이상 미래 → `TIMESTAMP_IMPLAUSIBLE`. 거절 행은 ACK의 `rejected`(최대 100개)·`rejectedCount` |
| 미등록 / 비활성 비콘 | 원시로 저장(`UNREGISTERED` / `DISABLED`), 퓨전에는 들어가지 않음 |
| 세션 상태 | 종료 후 도착도 저장, 최종 재처리를 다시 예약 |
| 서버 비활성화 | `BEACON_POSITIONING=off`: 광고 안 함, 업로드는 503 `BEACON_DISABLED`(재시도 불가). 앱은 격리하지 않고 보관 |

ACK `data`: `batchId, receivedAt, duplicate, received, inserted, duplicateObservations, registered, unregistered, disabled, rejected[], rejectedCount`.

**구버전 호환**: 구버전 앱은 이 메시지를 모르므로 보내지 않고, 다른 메시지·ACK·manifest(`lastSequences`)는 그대로다.
새 앱이 구버전 서버에 붙으면 기능 광고가 없으므로 비콘 배치를 보내지 않고 휴대폰에 보관한다. 비콘 배치는
finish 장벽·`syncComplete` 조건(iOS)에서 제외되어, 구버전 서버에서도 세션 종료·동기화가 막히지 않는다.

## 7. 퓨전 (`fusion-v4` rev 18, `fusion-beacon.ts`)

파이프라인: 식별(적재 시 활성·앵커 연결된 비콘만) → 앵커 조회 → RSSI 범위 검사 → 비콘별 창(3 s) 중앙값 →
MAD 이상치 제거 → 보정 모델 선택 → 우도 → EKF 갱신(forward) / RTS smoother(replay) → 기존 지도 제약(실내 계단 앵커,
원형 복도)과 함께 평활.

**측정 모델** (log-distance path loss): `RSSI = P1m − 10 n log10(d) + e, e ~ N(0, σ²)`. 로그 거리 공간에서는 오차가
거리와 무관한 가우시안이다.

```
z = ln d_model,   d_model = 10^((P1m − median RSSI) / (10 n))
h(x) = ½ ln((x − ax)² + (y − ay)² + dz²),   H = [(x − ax)/r², (y − ay)/r², 0]
R = (σ ln10 / (10 n))² / k_eff + (앵커 수평 정확도 / max(d,1))²
```

`dz` = 같은 층에서 앵커 설치 높이 − 휴대폰 높이(1 m). 상태는 GPS와 같은 `[x, y, θ]`이고 스칼라 EKF 갱신이므로
기존 필터와 수학적으로 같은 구조(가우시안 측정 갱신 + RTS)다. 보정 연산을 따로 더하지 않았다.

| 규칙 | 구현 |
| --- | --- |
| 비콘 없음 | 상태에 비콘 추적기가 생기지 않음. rev 17과 출력이 같다(테스트로 확인) |
| 비콘 1개 | 상한 거리(2σ)의 수평 성분이 3 m 이하면 **근접 영역 제약**(앵커 중심 가우시안, σ = 상한 거리, 최소 2 m). 아니면 거리 고리 제약 |
| 여러 개 | 독립 측정으로 순차 갱신(결합 갱신과 동치) |
| 신뢰도 낮음 | 정규화 혁신 d² > 3.84이면 R을 d²/3.84배 키움(Huber형). 샘플 수가 적거나 RSSI 분산이 크면 R이 커짐 |
| 오래된 관측 | 상태보다 늦은 관측은 버리고 `STALE`로 집계. 창 밖(3 s) 샘플 제거 |
| 강제 이동 금지 / 점프 방지 | 한 번의 갱신 이동량이 3 m를 넘으면 R을 키워 3 m로 제한. 위치 불확실성 30 m 초과 시 선형화하지 않음(근접만) |
| RSSI 이상치 | 창 중앙값과 max(8 dB, 3×1.4826×MAD) 이상 차이 → 제거 |
| 층간 간섭 | 층이 확정된 뒤 같은 건물 다른 층 비콘은 XY 갱신에 쓰지 않음(`FLOOR_MISMATCH`). 8 m 이내 비콘만 층 투표 |
| 스푸핑 기본 방어 | χ² 게이트(1 자유도 10.83, 근접 2 자유도 13.82)로 현재 추정과 모순되는 관측 거절, 관리자 비활성화는 이후 재처리에서 즉시 제외 |
| 불확실성 갱신 | EKF 공분산 갱신. 출력 `horizontalUncertainty`가 비콘으로 줄고, 신호가 끊기면 다시 커짐 |
| 초기화 | GPS가 아직 없고 근접 관측이면 앵커에서 지역 좌표계를 시작(σ ≥ 4 m, 출력 source `BEACON_ANCHORED`) |

출력: `source`에 `BEACON_CORRECTED`(GPS 없이 비콘 갱신만), `BEACON_ANCHORED` 추가. 진단 컬럼 `beacon_updates`,
run 요약 `beacons{observations, measurements, applied, proximity, rejected, floorChanges, ...}`.

**재처리 입력**: replay는 그 시점의 레지스트리(활성 여부, 앵커 위치, 보정값)로 관측을 해석한다. 앵커 좌표나 보정을
바꾸면 replay 입력 해시(`metrics.replay.input.hash`)가 바뀐다. 이미 처리된 세션에 새 레지스트리를 적용하려면
`POST /sessions/:id/fusion/reprocess {"force": true}`.

**배치 권장**: 한 줄로 늘어선 비콘만으로는 좌우를 구분할 수 없다(거울 대칭). 시뮬레이션에서 일렬 배치는 반대편에 3 m
치우친 해에 수렴할 수 있었고, 복도 양쪽 교차 배치에서는 사라졌다. 복도는 양쪽 벽에 번갈아 설치한다.

### 비교 (자동 테스트 `test/beacon-positioning.test.ts`, 합성 보행)

GPS는 처음 45 s만, 이후 95 s 실내. 실제 보폭 0.85 m, 보수계 보폭 0.75 m(13% 과소), 비콘 10 m 간격 교차 배치,
RSSI σ 3 dB. 실내 구간(60 s 이후) 평균 수평 오차:

| | 비콘 끔 | 비콘 켬 |
| --- | --- | --- |
| 최종(RTS 평활) | 11.5 m (최대 16.7) | 3.1 m (최대 3.9) |
| 실시간(forward) | 9.3 m (최대 15.0) | 3.2 m (최대 5.2) |

합성 데이터 결과이며 실제 캠퍼스 성능이 아니다. 실제 비교는 같은 세션을 두 설정으로 재처리해 확인한다:
`npm run fusion:compare -- --session=<id> --set beaconFusionEnabled=false` (읽기 전용), 또는 Lab replay의 `overrides`.

## 8. 층 판별

입력: 근접(8 m 이내) 비콘의 층 투표(가까울수록 가중), 기압 상대고도 변화, 최근 30 s의 계단·경사·수직 미확정 걸음,
앵커의 층 바닥 높이(두 층 모두 있으면 그 차이, 없으면 3.6 m).

- 첫 층: 같은 층이 6 s 창에서 60% 이상으로 3 s 유지 → `BEACON`.
- 층 변경: 새 층이 5 s 이상 우세 **그리고** 기압이 예상 방향으로 층 높이의 50% 이상(계단 걸음이 있으면 37.5%) 움직임
  → `BEACON_BAROMETER`. **비콘 다수결만으로는 바꾸지 않는다**(계단실·층간 누설).
- 기압계 없음: 15 s 이상, 80% 이상 우세일 때만.
- 비콘 없음(엘리베이터 등): 기압 변화가 층 높이의 정수배(±0.3층)이고 0.8층 이상이면 `BAROMETER`(신뢰도 0.5).
- 같은 층에서 수평으로 걷는 동안만 기압 기준을 다시 잡는다(날씨 드리프트). 오르내리는 중에는 다시 잡지 않는다.
- 다른 건물: 비콘 지속성만으로 변경(건물은 평지에서 들어감).
- 지도 위상: 건물 일치 외의 연결성(계단·엘리베이터 노드)은 아직 쓰지 않는다(§12).

출력: `floor_label`, `floor_building_id`, `floor_source`, `floor_confidence`. `beaconFloorCorrectionEnabled=true`이면 확정 층의
바닥 높이로 높이 영점을 관측한다(노드 기준점과 같은 방식, σ 1.5 m, `zDatumSource = BEACON_FLOOR`). 기본은 꺼짐.

## 9. Feature Flag

| 위치 | 이름 | 기본 | 의미 |
| --- | --- | --- | --- |
| 서버 env | `BEACON_POSITIONING` | `on` | `off`: 광고·수신 중단, 설정의 모든 기능 off |
| 서버 env | `BEACON_CLIENT_SCANNING` / `_UPLOAD` / `_FUSION` / `_FLOOR_CORRECTION` | true/true/true/false | 설정 API `features`로 앱에 전달되는 원격 스위치 |
| 서버 env | `POSITIONING_ADMIN_COLLECTORS` | 빈 값 | 관리 API 허용 collector ID |
| 서버 env | `BEACON_CONFIG_MAX_AGE_S`, `BEACON_CONFIG_STALE_MAX_S` | 3600, 14일 | 캐시 정책 |
| fusion config | `beaconFusionEnabled` | true | false = rev 17과 동일 출력 |
| fusion config | `beaconFloorEstimationEnabled` | true | 층 추정(진단 컬럼) |
| fusion config | `beaconFloorCorrectionEnabled` | false | 확정 층으로 높이 영점 보정 |
| 앱 설정 | `beaconScanningEnabled` | **false** | 비콘 수집. 켜기 전까지 기존 수집은 그대로 |
| 앱 설정 | `beaconUploadEnabled` | true | 끄면 휴대폰에만 보관 |

fusion config 값은 재처리·Lab에서 `overrides`/`--set`으로 바꿀 수 있다.

## 10. 플랫폼

**iOS** (`CampusTracker/Positioning`, `Services/BeaconCollectionRecorder.swift`)
- Core Location ranging(`CLBeaconIdentityConstraint`, iOS 13+; 앱 최소 15.0). 전용 `CLLocationManager`로 GPS 설정과 분리.
- Ranging = 관측, Monitoring(`CLBeaconRegion`, 최대 20개) = 영역 존재만. 백그라운드 연속 ranging은 보장되지 않는다.
- RSSI는 Core Location이 약 1 s 동안 모은 값(`CORE_LOCATION_RANGING`), `rssi 0`은 버림, `accuracy`는 참고값(음수면 없음).
- 정확한 위치(precise) 권한이 없으면 iOS가 비콘을 주지 않으므로 상태 `reducedAccuracy`로 표시.
- `collection-v2.sqlite` schema 2: `beacon_observations`, `beacon_config_cache` 추가(v1 파일은 한 트랜잭션에서 테이블만 추가).
  관측 행과 업로드 항목(kind `beacon`)을 한 트랜잭션에 기록. 새 버전이 만든 v2 파일을 이전 빌드가 열면 기존 보호 규칙대로
  "newer than this build"로 열지 않는다(데이터는 그대로).

**Android** (`hoshi.campustracker.positioning`, `collection/BeaconCollectionController.kt`)
- BluetoothLeScanner, UUID별 하드웨어 ScanFilter(iBeacon 접두 + UUID, major/minor 무관), LOW_LATENCY, 시작 간격 6.5 s(30 s 5회 제한).
- `BLUETOOTH_SCAN`에 `neverForLocation`을 쓰지 않는다(위치 추정 용도). API 31+: `BLUETOOTH_SCAN` + `ACCESS_FINE_LOCATION`, 30 이하: 위치 권한 + manifest `BLUETOOTH`/`BLUETOOTH_ADMIN`(maxSdk 30). 위치 서비스 꺼짐·Bluetooth 꺼짐·실패 코드별 상태.
- iBeacon 파서: 0x004C / 0x02 / 0x15, major·minor big endian, measured power signed. 잘못된 패킷은 null.
- 시각: `ScanResult.timestampNanos`(elapsedRealtimeNanos) → 다른 센서와 같은 collector clock으로 epoch 변환, 원래 나노초도 보존.
- 업로드 큐 항목 kind `beacon`(Room 스키마 변경 없음: kind는 문자열 컬럼). 수집은 foreground service 동안만.

## 11. 테스트와 검증 결과 (2026-10-15, 이 저장소에서 실행)

| 대상 | 명령 | 결과 |
| --- | --- | --- |
| 서버 전체 | `npm test -w backend` (DB 통합: `FUSION_/ARKIT_/BEACON_TEST_DATABASE_URL`) | 308개 중 306 통과, 2 skip, 실패 0. skip된 편집기 통합 테스트 2개는 각각 빈 DB로 따로 실행해 통과 |
| 프론트엔드 | `npm test -w frontend`, `npm run typecheck` | 156개 통과, 타입 검사 통과 (변경 없음, 회귀 확인) |
| 서버 타입 | `npm run typecheck -w backend` | 통과 |
| 서버 신규 | `test/beacon-positioning.test.ts`(15), `test/beacon.integration.test.ts`(1, PostGIS) | 통과 |
| 편집기 비콘 배치 | `frontend/test/beacon-map.test.ts`(2: 건물·층 판정, 커서 → 폼 → 요청), `beacon-scan.test.ts`(수정 fixture). Playwright/Chromium(swiftshader)으로 실제 편집기에서 20개 확인: 관리자 패널 로드·지도 위 비콘 클릭으로 열기·식별자 잠금·Space로 커서+2.4 m 배치·Enter 저장 후 DB 좌표 일치·커서 따라가기·실외 배치·새 비콘 검증/등록·영구 삭제·읽기 전용 계정·페이지 오류 없음 | 통과. 테스트 DB에 캠퍼스 3D 건물이 없어 건물·층 자동 채움은 단위 테스트로만 확인 |
| 등록 화면 | `frontend/test/beacon-scan.test.ts`(5, 공용 iBeacon 패킷 fixture), `backend/test/beacon-registration.integration.test.ts`(1, 수정·앵커 공유·사용 중지·영구 삭제·재등록 포함), Playwright/Chromium으로 로그인·블루투스 검색(가짜 광고)·검증 오류·등록·중복·검색 UUID·앱 수집 목록·권한 없는 계정·폰 폭 14개 확인 | 통과. 실제 블루투스 하드웨어 검색은 미확인 |
| Android | `./gradlew :app:testDebugUnitTest :app:lintDebug` | 92개 중 91 통과·1 skip(기존). 앱 등록·수정·삭제 11개(공용 등록·수정 fixture, 목록, 컨트롤러+가짜 스캐너·서버) 포함. lint: 신규 코드 경고 없음 |
| iOS 공통 코어 | Linux Swift 6.2로 `BeaconPositioning.swift` 컴파일(Swift 5/6, MainActor 기본 격리, strict concurrency) + fixture 검사 | 통과 |
| iOS 등록 | Linux Swift 6.2: `BeaconRegistration.swift` + 등록 fixture, `BeaconRegistrationModel.swift`를 CoreLocation 스텁으로 타입 검사 + `BeaconRegistrationTests.swift` 9개(등록·수정 fixture, 수정·사용 중지·삭제 흐름)를 스텁 위에서 실행 | 통과. SwiftUI 화면(`BeaconRegistrationView.swift`)은 Linux에서 컴파일 불가로 **미검증** |
| iOS 앱·테스트 | Xcode 빌드, `CampusTrackerTests/BeaconPositioningTests.swift`, `BeaconRegistrationTests.swift` | **미실행**(Xcode 없음). 기존 103개 `@Test` 회귀도 미실행 |

같은 fixture(`fixtures/beacon/*.json`: iBeacon 패킷, 측정 모델·보정 선택, 설정, 관측 배치)를 세 플랫폼 테스트가 함께 읽는다.

참고: 편집기 통합 테스트 2개(`editor-area`, `editor-height-join`)는 이미 마이그레이션된 공용 DB에서 `terrain_versions already exists`로
실패한다(변경 전에도 같음). 각자 빈 DB(마이그레이션 030 포함)에서는 통과한다.

### 실기기 수동 테스트 목록 (자동화하지 못한 항목)

1. iOS: Xcode 빌드와 기존·신규 테스트 전체 실행.
2. iOS: When In Use + 정확한 위치에서 ranging, 근사 위치일 때 `reducedAccuracy` 표시, 권한 변경 후 재시작.
3. iOS: 화면 꺼짐·백그라운드에서 수집 세션 중 ranging 간격(보장되지 않음 — 실제 공백 측정).
4. iOS: schema 1 DB를 가진 기존 설치 위에 새 빌드 설치 → 기존 세션·업로드 대기열 보존, v2 테이블 생성.
5. Android: Android 11 이하 / 12 이상에서 권한 흐름, Bluetooth 끄기·켜기 중 상태와 재시작, 위치 서비스 끄기.
6. Android: 화면 꺼짐 + foreground service에서 ScanFilter 결과 수신, 30 s 5회 시작 제한에 걸리지 않는지.
7. 양 플랫폼: 같은 비콘을 iOS·Android로 동시에 수집해 플랫폼별 RSSI 차이 측정 → `beacon_calibrations` 입력.
8. 서버: 실제 캠퍼스 세션에서 `fusion:compare --set beaconFusionEnabled=false`로 비콘 효과와 층 판정 확인.
9. 비콘 설치 위치·설치 높이·층 바닥 높이 측량값 입력과 관리 API 등록.
10. 앱 등록 화면: Android 실제 BLE 검색(UUID 무관)·현재 위치·등록·중복 메시지, iOS 등록/검색 UUID로 ranging·위치 권한 요청·등록 후 수집 설정 갱신, 권한 없는 계정 안내. 수정(위치 바꾸기)·사용 중지·다시 사용·삭제 확인 대화상자, 삭제 후 같은 비콘이 검색 목록에서 미등록으로 보이는지.
11. 편집기 비콘 배치: 실제 캠퍼스 건물 위에서 건물·층 자동 채움, 층 따로 보기 중 표시, 다른 편집자 변경 후 새로고침.

## 12. 향후 과제

- 온디바이스 퓨전(Navigator): 서버 `fusion-beacon.ts` / smoother 수식을 Swift Package · Android library로 이식(측정 계층은 준비됨).
- 지도 위상 기반 층 전환(계단·엘리베이터 노드 근처에서만 전환 허용)과 복도 map matching으로 일렬 배치의 거울 해 제거.
- 비콘별 RSSI 보정 자동 추정(수집 세션의 평활 궤적과 RSSI로 P1m·n 회귀) 및 관리 화면.
- Generic BLE / 제조사 프로토콜: `protocol` 컬럼과 `BeaconScanner` 인터페이스에 어댑터 추가(현재 IBEACON만 허용).
- AS_RECEIVED replay(도착 순서 재현)에 비콘 배치 포함.
- 비콘 배터리·고장 감지(`last_observed_at` 기반 알림).
