# iOS 절대 고도를 이용한 실내 Z 폴백 수정 계획

작성: 2026-10-14 KST. 설계 기준: `62660d8`, `fusion-v4` revision 14.

구현 현황: **서버 수신·저장·동기화·재생·폴백 및 웹 높이 표시를 revision 15로 구현했다.** iOS는 별도 작업이며, 운영 DB 적용과 새 실기기 측정은 남아 있다. 서버 연결·배포 절차와 검증 결과는 [서버 적용 문서](/Users/hoshi/Documents/CampusTracker-Server/docs/ABSOLUTE_ALTITUDE_SERVER.md)에 기록한다.

목표는 실내에서 같은 층을 왕복한 기록에 사용할 초기 높이를 보완하는 것이다. `CMAbsoluteAltitudeData`의 검증된 절대 고도로 기준 오프셋을 정하고, 이후 높이 변화는 기존 상대 기압 고도로 추적한다. 절대 고도를 얻지 못했거나 오차가 크면 층을 미확정으로 남긴다. API 도입만으로 실내의 실제 층을 항상 알아낼 수 있다고 가정하지 않는다.

## 1. 출발점과 성공 기준

문제 세션은 `1a184755-936e-4065-93ed-49b8749383e5`, 최신 확인 실행은 `b5086aa1-938a-436c-b2b1-b0d52a9329ae`이다. 수집 시간은 2026-10-14 19:57:54~19:59:54 KST다.

| 확인 항목 | 관측 결과 |
|---|---|
| 최종 궤적 | 128점, 약 173m |
| 상대 Z 범위 | 0~0.216667m |
| GPS 수직 정확도 | 23개 모두 30m |
| 최종 높이 기준 | 전부 `TERRAIN_FALLBACK`, 기준 불확실도 5m |
| 실제 계산 | `131.624391m(시작 DEM) + 1m + 상대 Z` |
| 센서 전달 | manifest 전체 일치, 기압계 재기준화 0회 |

핵심 결함은 절대 높이 부재를 지면층 출발로 치환하는 정책이다. 새로운 폴백을 추가해도 그 값이 없을 때 기존 지면층 가정으로 돌아가면 문제는 남는다.

완료 조건:

1. 품질을 통과한 절대 고도가 있으면 같은 층 왕복에도 `CM_ABSOLUTE` 기준으로 Z를 출력한다. 4m 이상 층 이동을 요구하지 않는다.
2. 절대 고도 관측의 흔들림이 매 순간 보행 궤적의 상하 흔들림으로 전달되지 않는다.
3. 기존 실외 기준을 얻는 경로와 이후 과거 실내 구간의 보정은 유지한다.
4. 유효한 기준이 없으면 상대 Z와 XY를 보존하고 절대 높이를 `null`로 둔다. 미확정 경로를 실제 1층 경로처럼 표시하지 않는다.
5. 센서 추가가 XY·걸음·방향·기존 상대 Z 계산을 바꾸지 않는다. 기존 알고리즘과 기존 클라이언트도 계속 동작한다.

## 2. Apple API의 사용 범위

- 런타임에서 `CMAltimeter.isAbsoluteAltitudeAvailable()` 및 권한을 확인한 후 `startAbsoluteAltitudeUpdates(to:withHandler:)`를 사용한다. 종료에는 `stopAbsoluteAltitudeUpdates()`를 대응시킨다. 기기명 문자열만으로 지원 여부를 판단하지 않는다. [CMAltimeter](https://developer.apple.com/documentation/coremotion/cmaltimeter)
- Apple은 iPhone 12 이후 지원을 안내하며, 값으로 `altitude`, `accuracy`, `precision`을 제공한다. `accuracy`는 미터 단위의 추정 1표준편차, `precision`은 권장 표시 해상도다. 두 값을 같은 의미로 사용하지 않는다. [CMAbsoluteAltitudeData](https://developer.apple.com/documentation/coremotion/cmabsolutealtitudedata)
- `altitude`는 해수면 기준이며 음수도 유효할 수 있다. GPS의 `ellipsoidalAltitude` 필드에 그대로 넣지 않는다. [altitude](https://developer.apple.com/documentation/coremotion/cmabsolutealtitudedata/altitude)
- API 값이 GPS·상대 기압과 통계적으로 독립이라는 보장은 가정하지 않는다. 세 값을 독립 관측처럼 평균하여 오차를 과도하게 줄이지 않는다.
- 잠금·백그라운드·서비스 재시작 시 제공 주기, 공백 및 API 자체 보정에 따른 변화는 실기기로 확인한다.

## 3. 데이터 계약: 독립적인 선택 스트림 추가

`absoluteAltitude` 배열을 기존 telemetry batch의 선택 필드로 추가하고, 각 관측을 별도 원시 행으로 보존한다. 상대 기압 샘플마다 마지막 절대 고도를 복사하는 방식은 사용하지 않는다. 두 API의 측정 시각과 주기가 다르며, 복사하면 오래된 관측이 새 관측처럼 중복 사용될 수 있기 때문이다.

제안 계약:

```json
{
  "absoluteAltitude": [{
    "sequence": 1,
    "timestamp": "2026-10-14T10:57:55.123Z",
    "altitude": 150.2,
    "accuracy": 4.8,
    "precision": 0.5,
    "verticalReference": "APPLE_MSL",
    "sensorSegmentId": "stream-run-uuid",
    "captureSource": "LIVE",
    "appState": "FOREGROUND"
  }]
}
```

위 숫자는 계약 설명용 예시이며 실측값이 아니다.

원시 값과 무효 사유를 보존한다. JSON으로 표현할 수 없는 비유한 값은 null로 정규화하고 진단에 남긴다. 음의 고도 자체는 거절하지 않는다. 저장과 높이 기준 채택은 분리한다.

- capabilities에 `absoluteAltitudeAvailable`, `absoluteAltitudeEnabled`를 추가하여 기기 지원과 실제 수집을 구분한다.
- `(session_id, sequence)`로 중복을 제거한다. 서비스 재시작마다 새 `sensorSegmentId`를 쓰되, sequence는 세션 안에서 계속 증가한다.
- `lastSequences.absoluteAltitude`, 스트림별 수신 수·최대 sequence·동기화·지연 통계·내보내기를 추가한다. 구버전의 필드 누락은 미제공으로 처리한다.
- 서버 시작 응답에 `supportedTelemetryFeatures: ["absoluteAltitudeV1"]`를 추가한다. 새 앱은 서버 지원 확인 후 해당 데이터를 전송한다. 현재 DTO가 알 수 없는 필드를 제거하고 ACK만 성공시키는 상황을 방지한다.
- 오프라인 시작이나 구버전 서버에서도 새 원본을 로컬에 보존한다. 기존 스트림 전송은 계속하되 새 원본을 보내지 않은 상태를 전체 동기화 완료로 표시하지 않는다. 서버 지원 확인 후 대기 자료를 전송한다. 저장된 시작 응답이 오래된 경우를 위해 같은 세션의 지원 기능 재확인 경로도 둔다.

## 4. iOS 변경 지점

현재 `CollectionCore`, SQLite 저장, `TrackingClockAnchor` 구조에 추가한다. 과거 MainActor record 처리나 BootTimeDriftCorrector를 기준으로 구현하지 않는다.

| 파일 | 변경 내용 |
|---|---|
| `Services/SensorServices.swift` | `AbsoluteAltitudeService` 추가. 상대 고도와 시작·정지·오류 상태를 독립 관리 |
| `Services/CapturedSensorSample.swift` | 새 capture, stream, payload case 및 원시 행 복호화·배치 생성 |
| `Models/SensorModels.swift` | capabilities, 원시 sample, 수집 수 추가. 새 필드가 없는 구버전 JSON도 읽기 |
| `Services/TrackingInfrastructure.swift` | 새 스트림의 시각 변환 및 callback 소유권 관리 |
| `Services/CollectionCore.swift` | 측정 시각 변환, sequence 발급, 기존 transaction을 통한 SQLite 기록 |
| `Services/CollectionCoordinator.swift` | 시작·종료·중단·복구·설정·센서 상태 연결 |
| `Persistence/CollectionSnapshotModels.swift`, `CollectionStore.swift` | 이전 snapshot 호환, sequence 예약, 종료 시 저장 완료, manifest, 내보내기 |
| `Networking/TelemetryWireModels.swift`, `Services/TelemetryUploadEngine.swift` | 선택 배열, 서버 지원 확인, 복구 전송, ACK·syncComplete·미전송 수 |

callback 안에서 센서 값과 native timestamp, callback 시각을 복사한다. 처리 시각으로 측정 시각을 덮어쓰지 않는다. 이전 세션이나 종료된 generation의 늦은 callback이 새 세션에 섞이지 않게 한다. 절대 고도 수신이 상대 고도 기준점을 리셋해서는 안 된다.

## 5. 서버 저장과 재생

새 migration으로 `absolute_altitude_samples`를 만든다. 최소 열은 session, sequence, timestamp, altitude, accuracy, precision, vertical_reference, sensor_segment_id, capture_source, app_state, created_at이다. `received_batches`와 run 집계의 새 스트림 수량도 반영한다. migration 번호는 구현 시 최신 번호 다음으로 배정한다.

| 변경 지점 | 내용 |
|---|---|
| telemetry DTO·repository·service | 선택 입력, 원시 저장, 중복 제거, 시각 범위, 실시간 입력, 배치 transaction |
| session DTO·repository·service | 지원 기능 응답, manifest, 원시 수·최종 시각·동기화 확인 |
| realtime 상태와 WebSocket/Socket.IO 경로 | 새 수신 수와 응답 및 실시간 처리 연결 |
| `fusion.timeline.ts`, `fusion.repository.ts` | 새 원시 스트림 및 관측 kind |
| `fusion-runs.repository.ts` | 도착 순서 재생에도 같은 데이터를 포함 |
| `fusion.replay-input.ts`, pipeline, metrics | cutoff, 입력 hash, 수량, 지연 통계, 동일 DB snapshot |
| config·algorithms·state·engine 및 새 고도 판정 모듈 | 후보·채택·충돌·재획득, 버전 및 설정 기록 |
| `docs/API_CONTRACT.md`와 테스트 | 신구 계약, 높이 기준, 동기화·표시 의미 |

같은 시각의 처리 순서는 `motion → pedometer → altimeter → absoluteAltitude → gps`로 한다. 상대 Z를 먼저 갱신한 뒤 절대 높이 후보를 평가한다.

기존 엔진 일부는 모르는 kind를 `else → applyGps`로 처리할 수 있다. 공통 pipeline에서 알고리즘별 지원 관측을 걸러, 새 센서를 대응 엔진에만 전달한다. 새 데이터가 없거나 기존 알고리즘이 이를 무시할 때 기존 관측 순서와 출력은 유지되어야 한다.

## 6. 높이 기준의 변환

Apple의 해수면 기준이 지도의 KVD 정표고와 완전히 같다는 보장은 확인되지 않았다. 원시 자료를 `APPLE_MSL`로 저장하고, 변환 가정·교정값·불확실도를 run 설정에 고정한다.

- 첫 실험에서는 지도와의 편차 0m를 가정하되 체계적 오차의 하한을 둔다. 확인된 기준점에서 편차를 측정한 경우에만 별도 교정값을 사용한다.
- API 고도는 휴대폰 높이이므로 `phoneHeightM=1`을 다시 더하지 않는다.
- Apple 값에서 지오이드고를 빼지 않는다. 정표고 상당값을 기존 타원체고 출력으로 바꿀 때만 run에 고정된 지오이드고 `N`을 한 번 더한다.
- 초기 적용 범위는 현재 캠퍼스처럼 지형 context에서 `N`을 얻을 수 있는 run이다. 변환 정보가 없으면 `NO_VERTICAL_TRANSFORM`으로 새 기준의 좌표 출력 사용을 보류하고 원본과 상대 Z를 보존한다. 기존 GPS 타원체고 경로는 유지한다.

## 7. 기준 높이의 계산과 품질 조건

```text
b_i = Apple 절대 고도_i + 지도 기준 교정값 - 상대 Z(t_i)
b   = 채택 가능한 후보의 b_i 중앙값
현재 높이(t) = b + 상대 Z(t)
```

채택 후에는 고정한 `b`와 상대 Z로 추적한다. 절대 고도를 매번 현재 Z에 대입하지 않는다. 값이 안정적이라는 이유만으로 절대적으로 정확하다고 판단하지 않는다.

판정은 공통의 순수 함수로 만들고 실시간과 시간순 재생에서 공유한다. 아래 수치는 **실측 후 조정할 초기 실험값**이며, Apple 보장값이나 입증된 성능이 아니다.

| 조건 | 초기 실험값 |
|---|---|
| API 추정 오차 | 유한하고 `0 < accuracy <= 8m` |
| 후보 수·기간 | 30초 창에서 서로 다른 측정 시각 3개 이상, 첫 값과 마지막 값 간격 5초 이상 |
| 상대 Z 시각 대응 | 같은 연속 구간의 직전 샘플, 최대 1.5초 차이 |
| 시각 대응 오차 | 추정 수직 속도 × 시각 차이가 1m를 넘으면 보류 |
| 기준 편차 안정성 | `b_i`의 MAD 2m 이하, 최대−최소 6m 이하 |
| 출력 불확실도 | 최소 5m. API 오차, 편차 분산, 시각 대응, 기준계 오차, 경과 시간 반영 |
| 필요한 층 이동 | 없음. 기존 `GPS_BARO`의 최소 4m 조건을 적용하지 않음 |

미래의 상대 Z를 사용하지 않고 양쪽 경로에 같은 시각 대응 규칙을 적용한다. 관측 수가 많다는 이유로 `accuracy / sqrt(n)`을 적용하지 않는다. `precision`이 작다고 정확도 조건을 완화하지 않는다.

지도와의 비교는 후보 거절 근거로 사용한다. 건물 위층에 있는 값을 실외 지면 기준으로 거절하지 않는다. XY 오차 때문에 실내외가 불명확하면 좁은 지면 근처 조건을 적용하지 않는다. 건물 외곽선만으로 층을 고르거나 지도 높이로 반올림하지 않는다.

## 8. 우선순위와 상태 변화

실시간과 FINAL의 선택을 공통 `selectVerticalDatum()`에 모은다.

1. 기존에 성립한 도로 기준·엄격한 지면 접촉·신뢰 GPS의 우선순위를 유지한다. 새 저신뢰 관측으로 덮어쓰지 않는다.
2. 지도 시작 기준, 완화된 지면 접촉, GPS와 기압의 일관성 기준이 성립한 경우도 기존 순서를 유지한다. 새 API는 일치 여부를 진단하되 독립 측정처럼 평균하지 않는다.
3. 위 기준이 없고 절대 고도 후보가 조건을 통과하면 `CM_ABSOLUTE`로 채택한다.
4. 새 정책에서는 지면층 출발 가정이나 품질이 낮은 단일 GPS를 절대 기준으로 만들지 않는다. 유효 후보가 없으면 `NONE`을 유지한다.

새 경로는 `WAITING → CANDIDATE → PROVISIONAL_ANCHORED`로 진행한다. 더 신뢰할 기존 기준을 얻으면 해당 기준으로 전환한다. 지도나 도로 출처가 잠정적인 경우에는 기존의 잠정 표시를 유지한다.

API가 잠시 끊겨도 상대 Z가 연속적이면 기존 기준을 유지하고 불확실도를 늘린다. 값이 갑자기 뛰거나 기존 기준과 충돌하면 `CONFLICT`를 남기고 후보 창을 다시 모은다. 재평가에서 거절된 값으로 즉시 궤적 높이를 변경하지 않는다.

상대 기압계가 재시작되면 공백 중 높이 이동을 알 수 없다. 기존의 상대 Z 연결은 유지할 수 있지만, 새 정책의 절대 높이는 재획득 전까지 미확정으로 둔다. 새로운 연속 구간에서 기준을 다시 정한다. FINAL도 불명확한 공백을 가로질러 같은 편차를 적용하지 않는다.

FINAL에서는 뒤늦게 얻은 유효 기준을 연속성이 확인되는 과거 구간에 적용한다. cutoff 이후의 관측은 사용하지 않는다. 실시간 채택 시각과 최종 결과에서 과거 구간을 보정한 시각·범위를 구분해 기록한다.

## 9. 저장·표시·진단

- `zDatumSource`에 `CM_ABSOLUTE`를 추가한다. 기존 길이 제한 안에 들어가지만 타입·DTO·저장·run snapshot·API·프론트까지 연결을 확인한다.
- 기준 오차, 채택 시각, 원본 sequence, 해당 상대 Z 구간, 후보 수, 채택·거절 사유, 교정 설정을 기록한다.
- 사유 코드: `UNSUPPORTED`, `NO_SAMPLES`, `INVALID_ACCURACY`, `ACCURACY_TOO_LARGE`, `NO_RELATIVE_MATCH`, `TIME_ALIGNMENT_UNCERTAIN`, `OFFSET_UNSTABLE`, `DATUM_CONFLICT`, `NO_VERTICAL_TRANSFORM`, `RELATIVE_SEGMENT_BREAK`.
- `track-display.ts`, `trajectory.ts`, `main.ts`, `lab.ts`에서 “아이폰 절대 고도 기반 임시 추정”과 오차를 표시한다. 이 기준만으로 `floorAllowed=true`를 설정하지 않는다.
- 실내에서 높이 미확정인 점은 3D의 층 표시에서 제외하고 2D 투영과 상대 높이 정보를 남긴다. 지면에 그리기 위한 임시 값을 실제 추정 고도로 반환하지 않는다.
- 높이 숫자가 존재하는 점과 신뢰 기준이 있는 점을 구분한다. 기존 `absoluteHeightOutputs`의 정의를 바꾸지 않고 잠정·신뢰·미확정 내역을 추가한다.

## 10. 구현 순서와 적용

| 단계 | 작업 | 다음 단계 조건 |
|---|---|---|
| 1 | 서버 저장·계약·동기화·지원 기능 응답 | 신구 계약, 중복 제거, manifest 검증 통과 |
| 2 | iOS 수집·저장·복구·전송·내보내기 | 실기기에서 두 고도와 시각·오차·해상도 확보 |
| 3 | 후보 판정과 진단을 `shadow`로 도입 | 기존 결과를 유지하면서 후보 확보율·편차 측정 |
| 4 | `fallback` 실험 실행과 표시 수정 | 같은 원본으로 기존 결과 비교, XY 불변 및 오확정 방지 확인 |
| 5 | 실기기 비교 후 새 세션 기본 설정에 적용 | 기준점 높이 오차·이용률 확인, 기존 실외 보정의 성능 저하 없음 |

설정은 `absoluteAltitudeMode: off | shadow | fallback`으로 한다. 실험 이름은 `cm-absolute-fallback`을 제안한다. 구현 시 revision을 올리고 모드·품질 조건·교정값을 설정 hash에 포함한다. off/shadow는 기존 출력을 유지하며, fallback은 미확정 정책까지 함께 적용한다.

off에서는 새 관측을 추정 엔진에 넣지 않는다. shadow에서는 별도 후보 진단 경로로 처리하여 기존 출력 시각, `lastObservationT`, 정지 판정 누적 시간, 관측 창을 변경하지 않는다. fallback에서도 새 절대 고도 관측 자체가 추가 위치 출력을 생성하지 않도록 하고, 기존 출력 시점에 선택된 높이 기준만 반영한다.

서버를 먼저 배포한 뒤 새 앱을 배포한다. 원본 수집과 추정 적용을 별도 설정으로 두어 문제가 생기면 적용만 중단할 수 있게 한다. 기존에 공개된 결과의 일괄 덮어쓰기는 포함하지 않는다.

## 11. 검증 계획

| 상황 | 확인할 결과 |
|---|---|
| 위층에서 같은 층 왕복, GPS 불량, 절대 고도 유효 | 지면으로 내려가지 않고 `CM_ABSOLUTE`, 상대 Z·XY 유지, 층 이름은 미확정 |
| API 오차 30m·무효 값·미지원·관측 없음 | `NONE`, 원본·상대 Z 보존, 거짓 1층 출력 없음 |
| 상대 Z가 거의 0 | 최소 4m 조건 없이 후보 채택 |
| API 고도가 고정된 상태에서 실제 층 이동 | 기준 편차의 불일치 탐지, 신뢰 과대평가 방지 |
| 절대 고도의 갑작스러운 변화 | 궤적에 즉시 단차를 넣지 않고 충돌 기록 |
| 실내→계단→실외 | 실외 기준 우선, 상대 변화 유지, FINAL에서 과거 보정 |
| 상대 기압계 재시작·긴 공백 | 미관측 이동을 만들어내지 않고 구간별 기준 재획득 |
| ACK 유실·오프라인·종료 직후 강제 종료·재시작 | 누락·중복 없음, manifest 일치, 구서버의 조용한 필드 삭제 방지 |
| 실시간·SENSOR_TIME·AS_RECEIVED | 같은 품질 규칙, 도착 지연으로 제외된 차이는 진단 기록 |
| cutoff·입력 hash | 미래 데이터 미사용, 고도·오차·시각·구간 변경이 hash에 반영 |
| 기존 알고리즘·Android·이전 snapshot | 미지원 관측을 GPS로 오처리하지 않고 기존 데이터 호환 |
| 높이 기준 변환 | 휴대폰 높이와 지오이드고의 중복 보정 없음, 음수 고도 보존 |

높이를 확인할 수 있는 위치에서 다음을 각각 3회 이상 새로 수집한다. 같은 기기·OS·설정으로 비교하며 화면 잠금, 백그라운드, 복귀도 포함한다.

1. 실외 기준을 먼저 얻지 않고 알려진 위층에서 시작→같은 층 왕복→실내 종료.
2. 실외 기준점→실내→계단→같은 층 왕복→실외 복귀.
3. 같은 층에서 10분 정지 및 엘리베이터 이동. 시간 경과와 환경·이동에 따른 영향을 확인.

평가 지표는 채택률, 첫 채택까지 시간, 기준점 절대 오차, 같은 층에서의 높이 변동, 기준 전환 시 보정량, 재시작 후 재획득 시간, 틀린 층 확정 수다. 절대 정확도의 수치 목표는 실측 후 정하되, 근거 없이 층을 확정하지 않는 것은 최초 적용부터 필수다.

## 12. 기존 기록과 확인 범위

문제 세션에는 절대 고도 API 값이 없으므로 새 구현으로 과거의 값을 복원할 수 없다. 이 세션은 기존 지면층 폴백의 재현과 새 정책의 미확정 처리를 확인하는 데 사용한다. 절대 고도에 의한 개선은 새 기록으로 검증한다. 과거 실제 층을 복원하려면 알려진 시작 층이나 높이 근거가 별도로 필요하다.

이번 계획은 현재 코드·기존 세션 진단·Apple 공식 문서를 대조해 작성했다. 절대 고도의 실기기 정확도·주기·백그라운드 지속성, 새 로직 테스트는 아직 수행하지 않았다.

참조 코드:

- [iOS 센서 수집](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/SensorServices.swift>)
- [iOS 기록 처리](</Users/hoshi/Documents/CampusTracker-Server/ios/Untitled Project/CampusTracker/Services/CollectionCore.swift>)
- [전송 계약](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/telemetry/telemetry.dto.ts)
- [입력 타임라인](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion.timeline.ts)
- [고도 기준과 최종 보정](/Users/hoshi/Documents/CampusTracker-Server/backend/src/modules/fusion/fusion-v4.engine.ts)
- [고도 표시 정책](/Users/hoshi/Documents/CampusTracker-Server/frontend/src/track-display.ts)
