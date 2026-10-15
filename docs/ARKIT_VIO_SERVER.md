# ARKit VIO 서버 통합

구현 버전: `arkit-rigid-relative-v1`. iOS 송신 코드는 이 작업에서 수정하지 않았다. 아래 계약을 Collector에 적용해야 실기기 ARKit 수집이 시작된다. 기존 Collector는 변경 없이 동작한다.

## 기존 구조 분석과 설계 결정

- Express/Socket.IO/일반 WebSocket은 같은 HTTP 서버에서 실행된다. `/collector`와 `/ws/collector`는 `collector-events.ts`의 이벤트 라우터, JWT 인증, 서비스, COMMIT 후 ACK를 공유한다. 새 서버나 포트는 추가하지 않았다.
- JWT는 Collector DB ID, device DB ID, client device ID를 담는다. `collection_sessions.id`는 서버 UUID, `client_session_id`는 오프라인 시작용 UUID다. ARKit은 서버 sessionId를 받고, Collector 및 **해당 세션의 device** 소유권을 모두 검사한다.
- 기존 `telemetry:batch`는 GPS·motion·altimeter·pedometer를 각각 원본 테이블에 배치 저장한다. 측정 시각은 ISO UTC, 수신 시각은 별도 `created_at`이다. 중복 batch/sequence, 지연 업로드, 세션 종료 후 업로드가 지원된다.
- 기존 fusion-v1/v2/v2.1/v3/v3.1/v4 엔진과 replay/finalize 흐름을 유지한다. 현재 활성 버전은 `REALTIME_FUSION_VERSION`으로 선택된다. ARKit 모듈은 해당 버전의 저장 결과를 읽기만 한다.
- 기존 `fused_positions`는 PointZ/4326이며 프리뷰가 점들을 시간·segment 순서로 이어 그린다. 캠퍼스 공통 프레임은 `campus-frame.ts`: EPSG:5186, origin E=201100/N=557250, 정표고=타원체고−23.377m이다.
- AR 로컬 좌표를 기존 PostGIS 좌표나 센서 퓨전 상태에 넣지 않았다. 로컬 원본은 수치 컬럼, 전역 정합 결과만 별도 EPSG:5186 MultiLineString으로 저장한다. 신뢰도·시간 간격별 분절이 필요하므로 하나의 LineString 대신 여러 LineString을 담는 구조를 쓴다.
- 프리뷰는 기존 `/preview` namespace, Cesium entity 및 REST 복원 구조를 재사용한다. ARKit 미사용 시 기존 수집 ACK에 ARKit 필드를 요구하지 않는다.

## WebSocket 계약 v1

일반 WebSocket은 기존 `/ws/collector`에 `Authorization: Bearer <token>`, `X-Device-ID: <clientDeviceId>`로 연결한다. **기존 requestId/type/payload envelope를 유지한다.** 첨부 요구서의 단독 pose 객체는 아래의 payload 안에 들어간다.

```json
{
  "requestId": "pose-request-125",
  "type": "arkit.pose",
  "payload": {
    "type": "arkit.pose",
    "schemaVersion": 1,
    "sessionId": "11111111-1111-4111-8111-111111111111",
    "arSessionId": "22222222-2222-4222-8222-222222222222",
    "deviceId": "iphone-01",
    "sequence": 125,
    "timestamp": 1791891972531,
    "frameTimestamp": 184532.213,
    "position": { "x": 1.24, "y": 0.15, "z": -5.82 },
    "rotation": { "x": 0, "y": 0.2, "z": 0, "w": 0.98 },
    "trackingState": "normal"
  }
}
```

Socket.IO는 `/collector`에서 `arkit.pose` 또는 `arkit:pose` 이벤트에 **같은 payload 객체**를 전송한다. payload.type은 항상 `arkit.pose`이다.

- sessionId: `session:start` ACK의 서버 UUID. 오프라인 시작 시 먼저 session:start를 동기화한 다음 pose를 업로드한다.
- arSessionId: 좌표 초기화·ARKit 재시작 때 새 UUID. sequence는 AR 세션 내 음이 아닌 안전한 정수. 재전송은 같은 sequence를 사용한다.
- deviceId: JWT의 clientDeviceId와 동일해야 한다. 세션 device DB ID도 JWT와 일치해야 한다.
- timestamp: **iOS가 frame의 측정 시각에 대응시킨 Unix epoch milliseconds**. 서버 수신 시각으로 대체하지 않는다. 기존 SensorTimestamp 정책(2020년 이후, 기본 미래 24시간 이내)을 재사용한다.
- frameTimestamp: 원본 ARKit frame 초 단위 clock. UTC로 해석하지 않는다. 두 시각을 모두 보존하므로 클라이언트 대응 관계는 `timestamp/1000 - frameTimestamp`로 분석할 수 있다.
- position: 카메라 로컬 미터, Y up. 모든 값은 유한하고 절댓값 ≤1,000,000m이어야 한다(수치 overflow 방지용 상한).
- rotation: 유한한 quaternion, norm=1±0.02. 원본 값을 보존하며 서버가 임의로 정규화하지 않는다.
- trackingState: `normal`, `limited`, `notAvailable`만 허용한다. unknown 필드·스키마 버전은 거부한다.
- JSON으로 직렬화한 pose payload는 최대 4096 bytes. 전송 계층의 기존 전체 메시지 상한 10MiB는 유지한다. 전체 전송 상한 초과 시에는 기존 ws/Engine.IO 정책상 연결이 종료될 수 있다. 일반적인 잘못된 pose·JSON은 오류 ACK 후 연결을 유지한다.

일반 WS 성공 ACK:

```json
{"type":"ack","requestId":"pose-request-125","replyTo":"pose-request-125","ok":true,"data":{"sessionId":"...","arSessionId":"...","sequence":125,"duplicate":false,"receivedAt":"2026-10-13T12:00:00.000Z"}}
```

Socket.IO ACK에는 위 data와 `ok:true`가 함께 들어간다. 실패는 기존 `{ok:false,error:{code,message,status,retryable,details?}}` 규칙이다. 저장 오류는 retryable, 검증 실패는 non-retryable이다. ACK는 COMMIT 이후에만 전송한다. 중복은 `duplicate:true`와 최초 수신 시각을 반환하고 최초 원본을 유지한다. 같은 sequence를 다른 값으로 다시 보내도 최초 값이 우선한다.

## DB와 재처리

`027_arkit.sql`은 다음 세 테이블만 추가한다. 기존 원본 및 fusion 테이블은 변경하지 않는다.

| 테이블 | 내용 |
| --- | --- |
| arkit_sessions | Collector session ↔ AR coordinate lifetime, device FK |
| arkit_pose_samples | measurement timestamp, frame timestamp, raw XYZ/quaternion/trackingState, created_at(receive) |
| arkit_trajectory_results | AR 세션·알고리즘별 최신 재생성 가능 결과, generated_at, 품질/변환/관측 개수 JSON, EPSG:5186 aligned/corrected MultiLineString |

원본 unique key는 `(session_id, ar_session_id, sequence)`이다. Collector별 시각, AR 세션별 시각, AR UUID별 시각, 최근 수신 조회 인덱스를 추가한다. Collector 원본 삭제 시 기존 정책과 동일하게 해당 AR 원본·결과도 cascade 삭제된다. 자동 보존 기간이나 원본 삭제 작업은 추가하지 않았다.

실행: `npm run db:migrate`. **개발·운영 DB에는 이 작업 중 적용하지 않았다.** 신규 마이그레이션은 격리된 PostGIS 테스트 DB에서 검증했다.

- `GET /api/v1/sessions/:sessionId/arkit`: 각 AR 세션 count/latest measured pose/latest receive/generated_at/derived snapshot.
- `GET /api/v1/sessions/:sessionId/arkit/:arSessionId/poses?afterId=0&limit=1000&from=<epoch-ms>&to=<epoch-ms>`: 최대 10,000개, 수신 row ID cursor. `nextAfterId=null`이면 현재 페이지 끝. 원본 quaternion도 반환한다. cursor는 지연 업로드에 안전하도록 row ID순이며, 궤적은 **timestamp,sequence순으로 정렬**해서 사용한다.
- `POST /api/v1/sessions/:sessionId/arkit/reprocess`: 원본 GPS·현재 활성 fusion 결과로 모든 AR 세션을 재생성한다. 동일 세션 재처리 중이면 updated=false 후 재예약한다.

위 REST 경로는 기존 내부 프리뷰 session/fusion API와 동일한 접근 정책을 사용한다. 원본 삽입은 인증된 Collector WebSocket에서만 가능하다.

## 정합과 독립 보정

A는 기존 퓨전 결과 그대로다. B는 AR 카메라 궤적과 GPS 정합 결과다. C는 별도의 실험적 상대 이동 보정 결과다. 어떤 단계도 A 또는 raw GPS/IMU/barometer를 수정하지 않는다.

1. AR pose를 measurement timestamp순으로 정렬하고 각 GPS에 가장 가까운 pose를 최대 250ms 범위에서 대응시킨다. 정확도 0<hAcc≤10m, normal tracking, 캠퍼스 origin 5km 이내 관측만 사용한다. GPS 간 최소 1초, 전체 구간에 균등 분포한 최대 512 anchors로 계산량을 제한한다.
2. `(u,v)=(AR X,−AR Z)`를 계산용 수평 좌표로 사용한다. 이 −Z를 북쪽으로 가정하는 것이 아니라, GPS 기준점으로 **추가 회전각과 평행이동을 추정**한다. 미터 스케일은 1로 고정한다.
3. 최소 4개 기준점 및 로컬·GPS 양쪽 5m 이상 baseline이 있어야 한다. 최대 32개 spread seed로 deterministic RANSAC pair 가설을 만들고, GPS accuracy 기반 residual gate(3~8m)를 적용한다. 충분한 inlier(≥4 및 ≥65%)로 1/max(1,accuracy²) 가중 rigid fit을 다시 계산한다. 가중 RMS≤5m일 때만 aligned다.
4. Y up은 별도로 유지한다. 수직 정확도 0<vAcc≤10m인 GPS 고도에서 MSL(우선) 또는 ellipsoidal−campus geoid를 사용해 AR Y offset을 계산한다. 최소 3개, median 기반 이상치 제외, 수직 RMS≤3m일 때만 전역 높이가 생긴다. 그 외에는 전역 h=null이다.
5. C는 더 엄격한 RMS≤3m, inliers≥5 및 ≥80% 조건에서만 생성한다. 현재 활성 fusion의 측정 시각에 AR pose를 대응시킨다. 정합과 일관적인 hAcc≤5m GPS가 있으면 해당 전역 위치로 재기준화하고, GPS가 약하면 직전 전역 위치에 정합된 AR 상대 이동량을 더한다. AR 추적이 limited/notAvailable이거나 연속성이 없으면 기존 fusion 위치를 사용한다. height는 기존 fusion 높이를 유지한다. IMU를 다시 독립 관측으로 더하거나 두 퓨전 결과를 평균하지 않는다.
6. C의 범위는 해당 AR 세션의 측정 시간 범위다. AR 범위 밖에서는 A가 계속 표시된다. AR 세션 간 연결, 다른 fusion spatial segment간 연결, 1초 초과 capture gap, 보정 방식 전환 또는 10m 초과 jump를 선으로 연결하지 않는다.
7. frame clock 역전 또는 측정 시각 대응이 프레임 간 0.5초 넘게 변하면 해당 AR 세션 정합을 거부한다. 좌표/시간 기준이 안정된 새 arSessionId로 다시 시작해야 한다. limited 경로는 낮은 신뢰도로 구분하며, notAvailable은 원본에만 남기고 B 지도 경로에서는 제외한다.

정합 품질 숫자는 경험적 게이트이며 실제 위치 정확도 보증이나 확률이 아니다. GPS bias·동일 multipath가 여러 기준점에 공통으로 존재하면 낮은 잔차로도 잘못된 정합이 가능하다.

## 프리뷰와 실행 특성

- 기존 GPS·퓨전 표시 옵션을 유지한다. ARKit(청록), limited(황색), C(자홍) 계층은 ARKit 패널에서 각각 켜고 끌 수 있다.
- aligned 상태에서만 지도 entity를 만든다. 높이 기준이 없는 경로는 지도 지형에 clamp하며 정표고를 지어내지 않는다. 로컬 뷰어는 AR 세션별 X/−Z와 X/Y 두 투영을 보여 주며 Y 정보도 보존한다.
- 수신 활성 상태는 preview 연결 + 최근 5초 pose 수신 여부다. ARKit 자체의 별도 네트워크 연결을 의미하지 않는다. trackingState, AR 세션 ID, 저장 개수, 측정/수신 시각, 정합 RMS, 결과 생성 시각과 처리 pose 개수, C 보류 여부를 표시한다.
- 로컬 canvas는 ID cursor로 증분 복원하는 최근 15분 원본 창, 렌더링은 최대 약 1Hz다. 긴 지도 선은 segment당 최대 2,000점을 균등 샘플링한다. DB 원본/파생 결과는 전량 보존된다.
- `/preview`의 `arkit:pose`는 COMMIT 후 전송, `arkit:updated`는 파생 결과 저장 후 REST 재조회 신호다. 재접속 시 REST에서 복원한다.
- 10Hz에서는 pose별 INSERT를 사용한다. 별도 큐 시스템이나 포트는 없다. 원본 ACK는 파생 계산을 기다리지 않는다. 파생 작업은 5초 단위 coalescing, 프로세스 전체 한 번에 한 세션, advisory lock + REPEATABLE READ snapshot으로 처리한다. 동시 수집으로 추가된 pose는 다음 실행에서 반영된다.
- 대기 세션은 메모리에서 최대 1,000개다. 재시작 시 원본/GPS/fusion이 파생 결과보다 새로운 세션을 복구 예약한다(최대 1,000개). 대규모 환경에서는 이 한도와 주기적 reconciliation을 재설계해야 한다. 파생 실패는 기록되며 다음 수신 또는 수동 reprocess로 재시도한다.

## Phase별 수정 파일

| Phase | 파일 | 변경 |
| --- | --- | --- |
| 1 | modules/arkit/arkit.dto.ts, realtime/collector-events.ts | 계약, 검증, 공유 이벤트 라우팅, telemetry COMMIT 후 비동기 예약 |
| 2 | db/migrations/027_arkit.sql, modules/arkit/arkit.repository.ts | 분리된 AR 세션·원본·파생 저장 및 인덱스 |
| 3 | modules/arkit/arkit.engine.ts, arkit.service.ts, main.ts | 시간 대응, rigid fit/품질 평가/분절, 비동기 재생성·복구·종료 |
| 4 | modules/arkit/arkit.routes.ts, sessions/session.routes.ts, realtime/preview.gateway.ts, frontend/src/arkit.ts, main.ts, socket.ts, frontend/index.html | 조회·재처리 API, live events, 로컬/지도 레이어, 독립 C 보정 |
| 5 | backend/test/arkit.test.ts, arkit.integration.test.ts, frontend/test/arkit.test.mjs, root/frontend package.json | 단위·실 DB 통합·프리뷰 controller·합성 부하 검증과 npm test |
| 5 회귀 | backend/test/scene.test.ts | 기존 장면 파일에 있던 혜인관 유리 계단실이 누락된 기대 목록/면적 수정. 장면 파일은 변경하지 않음 |
| 문서 | README.md, docs/API_CONTRACT.md, 이 문서 | Collector 계약 링크, 운영 전 마이그레이션, 구현·한계 |

표의 backend 경로는 `backend/src/` 기준이며 frontend main.ts/socket.ts는 `frontend/src/` 기준이다. 작업 전에 수정되어 있던 telemetry.service.ts, fusion-v4.engine.test.ts, iOS UI 상태 및 Android 파일은 보존했다.

## 검증 결과와 한계

- `npm run typecheck`: backend/frontend 통과.
- `npm test`: backend 221개 중 218 통과, 환경 변수가 필요한 DB 테스트 3개 skip; frontend 137개 통과(ARKit controller 테스트 포함). 별도 ARKit 실 DB 테스트는 아래 명령으로 실행하여 통과했다.
- `npm run build`: backend/frontend 통과. 기존 lockfile에 선언된 누락 로컬 의존성을 `npm ci --ignore-scripts`로 설치했으며 dependency 버전 선언/lockfile은 바꾸지 않았다.
- 격리 PostGIS 16/3.4: 전체 migrations, raw WS 잘못된 JSON 후 정상 수신, Socket.IO, sequence 동시 중복/재연결, device 소유권, AR 세션·trackingState, 네 기존 센서 스트림, REST cursor/검증, pending→aligned, EPSG:5186 geometry, preview broadcasts, 기존 fusion row 불변 확인.
- 합성 부하: 36,000 pose(1시간×10Hz)와 3,600 GPS를 사용하는 rebuild는 로컬 단위 테스트에서 약 46~71ms였다. DB·전송·화면 렌더는 포함하지 않으며, 실제 운영 10Hz 장시간 soak 테스트나 다기기 성능 보증은 아니다.
- 프리뷰 테스트는 실제 controller에 DOM/Cesium adapter를 붙여 미정합 지도 차단·AR 세션 분리·독립 토글·좌표 역변환을 검증한다. 실제 브라우저/WebGL 시각 검사와 iPhone 현장 주행 검증은 수행하지 않았다.
- 카메라→발 위치 extrinsic, scale drift, gyro/IMU 재융합, EKF/factor graph, 건물/도로 map matching은 구현하지 않았다. Y offset은 수직 datum 정합이며 카메라 높이를 지면 높이로 바꾸지 않는다.
- 기존 `session:syncComplete`/`lastSequences`는 ARKit 업로드 완료 개수를 포함하지 않는다. iOS는 ARKit pose별 durable ACK를 별도로 관리해야 하며, 공통 sync manifest에 AR session별 마지막 sequence를 추가하는 확장은 남아 있다.
- 현재 시간 정렬은 ±250ms nearest match이며 서버 clock drift 추정이나 interpolation은 하지 않는다. 별도 iOS clock calibration 메타데이터를 확장할 수 있다.
- 파생 결과는 AR 세션/알고리즘별 최신 snapshot을 덮어쓴다. raw는 보존되므로 재생성 가능하지만 모든 실행 이력을 보존하는 run archive는 아직 없다. 전체 세션 원본 로딩 및 결과 JSON 전량 전송은 데이터가 커지면 병목이 될 수 있다.

통합 테스트 실행(운영 DB 대신 **반드시 폐기 가능한 이름이 `_test`로 끝나는 DB**):

```sh
ARKIT_TEST_DATABASE_URL=postgres://user:password@localhost:5432/campus_arkit_test \
  node --import tsx --test backend/test/arkit.integration.test.ts
```
