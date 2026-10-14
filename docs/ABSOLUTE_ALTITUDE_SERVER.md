# 절대 고도 폴백: 서버 적용

작성: 2026-10-14 KST. `fusion-v4` revision 15.

## 연결 계약

`session:start` 응답에 `supportedTelemetryFeatures: ["absoluteAltitudeV1"]`를 제공한다. 새 세션과 재접속 응답 모두 포함한다. Xcode 작업의 `ios/Untitled Project/docs/ABSOLUTE_ALTITUDE_SERVER_CONTRACT.md`와 같은 계약이다.

기존 `telemetry:batch`에 선택적인 `absoluteAltitude` 배열을 받는다. 각 항목은 sequence, timestamp, altitude, accuracy, precision, `verticalReference: "APPLE_MSL"`, invalidReason 및 기존 메타데이터를 가진다. 수치는 null을 허용하며 음수 고도도 저장한다. 원시 저장은 기준 채택과 독립적이다.

원본은 `absolute_altitude_samples`에 저장한다. `(session_id, sequence)` 중복을 제거하고 배치와 같은 transaction 안에서 저장한 뒤 ACK한다. `lastSequences.absoluteAltitude`를 finish와 syncComplete에서 비교한다. 이전 앱이 필드를 생략하면 기존 네 스트림만 비교한다. 원본은 센서 시각순·도착순 재생, cutoff, 입력 hash, 수집 통계에 포함된다.

## 높이 정책

기본 설정은 `absoluteAltitudeMode: "fallback"`이다. 다음 중 하나로 새 높이 정책을 활성화한다.

- 세션 시작 시 `sensorCapabilities.absoluteAltitudeEnabled: true`를 전달한다.
- 해당 세션에 실제 `absoluteAltitude` 관측이 들어온다.

기존 앱·과거 세션처럼 둘 다 없으면 종전 높이 정책을 유지한다. 이 범위 구분은 기존 결과가 새 센서 없이 일괄 변경되는 것을 피하기 위한 구현 결정이다. 새 센서를 켠 세션은 관측이 아직 없거나 모두 품질 미달이어도 지면층 출발을 가정하지 않는다.

기존의 유효한 도로·지면·GPS·지도 및 기압 일관 기준이 있으면 그 우선순위를 유지한다. 이들 기준이 없을 때 검증한 API 관측에서 `b = altitude + 교정값 - 상대 Z`를 구해 `CM_ABSOLUTE`로 채택한다. 최초 채택 뒤에는 상대 Z로 이동을 추적하며 단일 API 변화로 기준을 교체하지 않는다.

초기 품질 조건:

| 항목 | 설정 |
|---|---|
| API 오차 | 0보다 크고 8m 이하 |
| 후보 | 30초 안에서 서로 다른 시각 3개 이상, 시간 범위 5초 이상 |
| 상대 Z 대응 | 같은 연속 구간의 직전 측정, 시각 차이 1.5초 이하 |
| 대응 오차 | 수직 속도와 시각 차이의 곱 1m 이하 |
| 편차 안정성 | MAD 2m 이하, 최대−최소 6m 이하 |
| 출력 오차 | 최소 5m. API·기준계·시각 대응·편차·시간 경과를 반영 |
| 최소 수직 이동 | 요구하지 않음 |

위 수치는 실험 시작값이며 실기기 정확도를 보장하지 않는다. `precision`을 정확도로 취급하거나 표본 수만으로 불확실도를 줄이지 않는다. 채택 후 큰 불일치는 `DATUM_CONFLICT`로 기록하고 기존 기준을 유지한다. 새로운 절대 높이 기준은 상대 센서가 재시작된 구간에서 다시 획득한다.

높이는 잠정적인 Apple 해수면 기준이다. `absoluteAltitudeDatumOffsetM` 기본값 0과 `absoluteAltitudeDatumSigmaM` 기본값 3으로 지도 기준과의 차이를 명시한다. 휴대폰 높이 1m를 재가산하지 않으며, 지도 지오이드고를 한 번 더해 타원체고로 출력한다. 변환용 지형 context가 없으면 새 API의 좌표 출력 사용은 보류한다.

`off`는 새 API 관측을 추정에 사용하지 않는다. `shadow`는 후보 진단만 남기고 기존 결과를 유지한다. 실험 API의 overrides로 모드를 선택할 수 있다. 새 관측은 위치 출력·XY 예측·정지 시간의 시계를 진행시키지 않는다.

상대 센서 재시작이나 긴 공백은 별도 연속 구간으로 관리한다. 구간에 기준이 없으면 높이는 미확정이다. FINAL은 같은 연속 구간 안에서 뒤늦게 얻은 기준을 과거에 적용한다. 모르는 공백을 가로질러 초기 높이를 전파하지 않는다.

## 표시와 진단

`CM_ABSOLUTE`는 높이와 오차를 표시하되 층을 확정하지 않는다. 실내에서 절대 고도가 미확정인 점은 3D 선과 점에서 제외하고, Lab의 XY 비교·상대 높이 기록은 보존한다. Lab에서 일부 점의 높이가 없다는 이유로 전체 경로를 지면에 붙이지 않도록 구간별로 그린다.

run metrics의 `absoluteAltitude`에 연속 구간별 채택 시각·원본 sequence·편차·오차 및 거절 사유를 기록한다. 개별 판단은 run events의 `absolute-altitude`로 저장한다. 높이 숫자가 있는 점의 기존 집계에 더해 `provisionalHeightOutputs`, `trustedHeightOutputs`를 제공한다.

## 배포

서버의 DB migration을 먼저 실행한 뒤 새 서버를 시작하고, 이후 새 iOS 앱을 연결한다.

```sh
npm ci
npm run db:migrate
npm run build
```

기존 실행 환경의 방식으로 서버를 재시작한다. 기본 `DEPLOY_RECONCILE=dry-run`은 migration을 적용하지 않으므로 재시작만으로 DB 변경이 끝났다고 간주하지 않는다. 이번 변경에서 실행 중인 운영 DB와 기존 세션 결과는 수정하지 않았다.

기존 문제 세션에는 이 API 원본이 없어 과거 높이를 복원할 수 없다. 새 앱으로 알려진 위층에서 실내 시작→왕복→실내 종료 기록을 다시 수집해 검증한다.

## 검증

- 백엔드·프론트 타입 검사와 프로덕션 빌드 통과.
- 같은 층, 상대 상승, API 급변, 부정확·누락 데이터, 센서 재시작, 시각 대응, 입력 hash·cutoff, 도착순 재생, 구알고리즘 호환 및 표시의 회귀 검증을 추가.
- DB 통합 검증은 `FUSION_TEST_DATABASE_URL`이 가리키는 이름이 `_test`로 끝나는 폐기 가능한 PostGIS DB에서만 실행한다. 로컬 Docker가 실행되지 않아 이번 환경에서는 DB 검증을 건너뛴다. 운영 DB로 대체 실행하지 않는다.
