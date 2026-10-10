# Campus Collector

여러 대의 iPhone 센서 수집 앱이 보내는 위치·모션·고도·걸음·마커 데이터를 받아 PostgreSQL/PostGIS에 원본 그대로 저장하고, PC 브라우저의 VWorld 3D 지도에서 수집 현황과 궤적을 실시간으로 확인하는 **내부 개발 도구**입니다.

- Backend: Node.js + TypeScript + Express 5 + Socket.IO 4 + `pg` (ORM 없음) + Zod + JWT
- Frontend: Vite + TypeScript + Vanilla DOM + Socket.IO Client + VWorld WebGL 3D API 3.0
- DB: PostgreSQL 16 + PostGIS 3.5 (Docker Compose)
- iPhone ↔ Server 계약: **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)**

## 브랜치 전략

![브랜치 전략](docs/images/branch-strategy.svg)

그림에서 작업 브랜치는 `develop`에서 분기해 돌아옵니다. 위로 향하는 화살표는 배포 PR(`develop` → `main`), 빨간 점선은 hotfix 수정의 `develop` 반영을 뜻합니다.

- `main`: 배포용 브랜치. 일반 변경은 PR로 병합하고, 긴급 hotfix는 PR 없이 직접 병합·push합니다.
- `develop`: 개발 통합용 브랜치. 작업 브랜치는 최신 `develop`에서 분기하고 PR로 돌아옵니다.
- `feature/*`: 기능 추가, `docs/*`: 문서, `refactoring/*`: 리팩터링, `fix/*`: 일반 오류 수정, `chore/*`: 의존성·CI 등 설정 변경.
- 배포 준비가 완료되면 `develop` → `main` PR을 생성합니다.
- `hotfix/*`: 최신 `main`에서 분기하여 필요한 검증 후 PR 없이 `main`으로 직접 병합·push하고 긴급 배포합니다. 같은 수정 사항을 `develop`에도 직접 병합하거나 cherry-pick으로 반영합니다.
- 작업 브랜치는 병합 후 삭제합니다. `release/*`는 별도 배포 후보 검증이 필요해질 때 도입합니다.

PR은 목적·변경·확인·배포/후속을 각각 한 줄로 적습니다. 미검증은 이유를, 영향이나 후속 작업이 없으면 `없음`을 적습니다. [PR 템플릿](.github/pull_request_template.md)을 사용합니다. CI 필수 검사·브랜치 보호·CD는 별도 설정이 필요합니다.

## PR 작성 양식

각 항목에 한 줄씩 답합니다. hotfix는 PR 없이 진행하므로 이 양식의 대상에서 제외합니다. hotfix 커밋이나 작업 기록에는 검증 결과와 `develop` 반영 여부를 남깁니다. 새 PR 본문에 자동으로 표시하려면 템플릿을 GitHub 기본 브랜치에 병합해야 합니다.

```markdown
## 목적
왜 필요한가?

## 변경
무엇이 달라졌나?

## 확인
확인 방법과 결과. 못 했다면 "미검증: 이유"

## 배포·후속
DB/환경 변수/API 영향과 남은 작업. 없으면 "없음"
```

## 필요 환경

- Node.js **22 이상** (개발 확인: 24.x), npm 10+
- Docker Desktop (Docker Compose v2)
- (선택) VWorld API Key: 예전 VWorld 지도(`VITE_MAP_ENGINE=vworld`)를 쓸 때만 필요합니다. 기본 프리뷰 지도는 캠퍼스 3D 모델이라 키와 인터넷이 필요 없습니다.

## 설치

```bash
npm install
```

npm workspaces를 사용하므로 루트 설치 한 번으로 `backend`, `frontend`의 의존성이 모두 설치됩니다.

## 환경 변수

```bash
cp .env.example .env
```

루트 `.env` 하나를 Docker Compose, backend, frontend(Vite `envDir`)가 함께 읽습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | backend HTTP + Socket.IO |
| `HOST` | `0.0.0.0` | iPhone이 LAN으로 접속하려면 `0.0.0.0` 유지 |
| `DATABASE_URL` | `postgresql://campus:campus@localhost:5432/campus` | |
| `JWT_SECRET` | `change-me` | 개발 외 환경에서는 반드시 변경 |
| `JWT_EXPIRES_IN` | `24h` | access token 만료 (refresh token 없음) |
| `CORS_ORIGIN` | `http://localhost:5173` | backend를 브라우저에서 **직접** 호출할 때만 필요한 허용 origin (기본 Preview는 Vite proxy라 불필요) |
| `POSTGRES_DB/USER/PASSWORD/PORT` | `campus/campus/campus/5432` | Docker Compose DB |
| `VITE_API_BASE_URL` | (비어 있음) | 비워두면 Preview는 Vite dev server proxy(`/api`, `/health`, `/socket.io` → `127.0.0.1:$PORT`)로 backend에 접속. 다른 호스트의 backend를 볼 때만 지정 |
| `VITE_VWORLD_API_KEY` | (비어 있음) | 비어 있으면 지도 없이 목록/상태만 동작 |

> 5432나 3000 포트를 다른 프로세스가 쓰고 있으면 `.env`에서 `POSTGRES_PORT`+`DATABASE_URL`, 또는 `PORT`만 바꾸면 됩니다 (Preview proxy와 시뮬레이터가 `PORT`를 따라감).

## DB 시작 · migration · seed

```bash
npm run db:up        # PostGIS 컨테이너 시작 (healthy까지 대기, 데이터는 named volume에 유지)
npm run db:migrate   # backend/src/db/migrations/*.sql 중 미적용분만 순서대로 실행
npm run db:seed      # collector C01~C05 생성 (이미 있으면 건너뜀)
npm run spatial:import # backend/data/campus-map/source SHP를 버전 등록하고 캠퍼스·건물 도형 검사/적재
```

SHP 내용과 이름만 확인할 때는 `npm run spatial:import -w backend -- --dry-run`을 실행합니다. 신규 세션은 활성 지도 버전에 고정됩니다. 지도 적재 후 시작한 세션에서 `fusion-v3` 또는 `fusion-v3.1`을 재처리하면 캠퍼스 경계 필터가 적용됩니다. v3는 반복 고정밀 GPS 앵커 사이를 v2.1 PDR로 추정하고, v3.1은 별도 센서 중심 엔진에서 보행·기기 자세·기압을 주 추정 자료로 쓰며 GPS는 자격이 확인된 앵커 이벤트로만 적용합니다. 둘 다 현재 실시간 기본값은 아니며 Preview 비교 레이어에서 세션별 결과와 v3.1 센서 판정 이력을 확인할 수 있습니다.

기타: `npm run db:logs`, `npm run db:psql`, `npm run db:down` (볼륨은 유지, 완전 초기화는 `docker compose down -v`).

Apple Silicon에서도 네이티브로 돌도록 기본 이미지는 `imresamu/postgis:16-3.5`(공식 postgis Dockerfile의 multi-arch 빌드)입니다. amd64 머신에서 공식 이미지를 쓰려면 `.env`에 `POSTGIS_IMAGE=postgis/postgis:16-3.5`.

## 개발 실행

```bash
npm run dev          # backend(tsx watch) + frontend(vite) 동시 실행
```

- Backend: `http://localhost:3000` (시작 로그에 iPhone용 LAN 주소가 출력됨)
- **Preview: http://localhost:5173**
- **3D 도로·장소 편집기: http://localhost:5173/editor.html** (기존 트랙커 계정 코드로 로그인)
- **편집기 MCP(AI 에이전트용): http://127.0.0.1:3000/mcp** — 이 컴퓨터에서만 접속된다. 토큰 발급 후 환경 변수로 넘긴다.
  `export CAMPUS_EDITOR_MCP_TOKEN=$(npm run mcp:token -- --collector C01 --agent claude-code)` (읽기 전용, 30일. 쓰기는 `--scope write`).
  Claude Code는 저장소의 `.mcp.json`을 쓰고, Codex는 `~/.codex/config.toml`에 `url`과 `bearer_token_env_var`를 등록한다. 도구 30개(조회·점검, 도로/장소 편집, 묶음 적용, 되돌리기, 지도 그림)를 제공하며 AI의 커서·제안선·변경 이력이 편집기에 표시된다. 점검: `npm run check:editor-mcp`. 설계: [docs/EDITOR_MCP_PLAN.md](docs/EDITOR_MCP_PLAN.md)

처음부터 전체 순서:

```bash
npm install
cp .env.example .env
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

## iPhone 연결 방법

1. Mac과 iPhone을 **같은 Wi-Fi**에 연결합니다.
2. iPhone에서는 `localhost`가 아니라 **Mac의 LAN IP**를 사용합니다. 예: `http://192.168.0.15:3000`
   - backend 시작 로그의 `server.started … "lan": [...]` 에서 확인, 또는 `ipconfig getifaddr en0`
3. 앱 설정: 서버 `192.168.x.x`(또는 Tailscale IP `100.x.x.x`), 포트 `3000`, 프로토콜 `HTTP`, Collector `C01`
   - **표준 WebSocket(URLSessionWebSocketTask)**: 로그인 응답의 `webSocketURL`(`ws://…/ws/collector`)에 `Authorization: Bearer <token>` + `X-Device-ID` header로 연결. 메시지 형식은 [docs/API_CONTRACT.md](docs/API_CONTRACT.md#raw-websocket-wscollector-urlsessionwebsockettask용).
   - Socket.IO 주소는 하드코딩하지 말고 로그인 응답의 `socketUrl` + `socketNamespace`(`/collector`)를 사용하세요. backend 시작 로그의 `collectorSocket`에도 접속 가능한 주소가 출력됩니다.
4. HTTP(평문) 접속이므로 iOS 앱 `Info.plist`에 ATS 예외가 필요합니다 (`NSAllowsLocalNetworking` 또는 개발용 `NSAllowsArbitraryLoads`). 처음 접속 시 iOS의 "로컬 네트워크" 권한도 허용해야 합니다.
5. macOS 방화벽이 켜져 있다면 `node`의 수신 연결을 허용합니다.

흐름: `POST /api/v1/collectors/login` → `/collector` socket 연결(토큰) → `session:start` → `telemetry:batch` 반복 → `marker:create` → `session:finish`. 자세한 payload/ACK/에러 코드는 [docs/API_CONTRACT.md](docs/API_CONTRACT.md).

## iPhone 없이 테스트 (시뮬레이터)

```bash
npm run sim -- --collector C02 --seconds 120
npm run sim -- --collector C03 --lat 37.5665 --lon 126.9780 --server http://100.102.255.108:3000   # 기본값은 이 Mac의 PORT
```

실제 iOS 계약대로 login → socket → session:start → 2초마다 batch(1Hz 위치, 20Hz motion, 고도, 걸음) → 마커 → status → session:finish(2회)를 보냅니다. 5번째 batch마다 같은 batch를 재전송해 idempotency를 확인합니다.

Raw WebSocket 경로 점검 (실제 iPhone과 같은 방식으로 인증·전 이벤트·멱등성 확인, 테스트 세션 1개 생성):

```bash
npm run check:raw-ws -w backend -- --server http://100.102.255.108:3000 --collector C02
```

## Preview 사용법

- **3D 도로·장소 편집기**: 상단 `3D 도로·장소 편집기` 링크로 이동합니다. 보행로/차량 도로/보차 혼용 중심선과 장소를 저장하며, 기존 Fusion Run의 XY/유효한 XYZ 점을 참고·스냅할 수 있습니다. 저장된 도로·장소를 선택한 뒤 `선택 편집`을 눌러 Vertex와 속성을 수정합니다. 세부 범위는 [편집기 설계 문서](docs/CAMPUS_NETWORK_EDITOR_PLAN.md)를 참고하세요.

- **Collector ID 발급**: Collectors 옆 `+ ID 발급` → 비워두고 발급하면 다음 번호(`C06` …) 자동, 원하는 ID(예: `TEAM-A1`)를 직접 입력해도 됩니다. 발급된 ID를 iPhone 앱의 Collector ID에 입력하면 바로 로그인할 수 있습니다.
- **Collector ID 제거**: 목록 행의 `✕` → 삭제될 기기/세션/위치/마커 수를 확인하고 `제거하겠습니다.` 를 **직접 타이핑**해야(붙여넣기 불가) `영구 제거` 버튼이 활성화됩니다. 해당 ID의 모든 수집 데이터가 영구 삭제되고, 연결된 iPhone은 즉시 끊깁니다. 서버도 같은 확인 문구가 없으면 삭제를 거부합니다.

- **Live**: ACTIVE 세션의 궤적과 collector별 현재 위치(정확도 원, 높이 라벨)를 실시간 표시. 새 point는 `location:update`로 받아 기존 궤적에 append(전체 재다운로드 없음).
- **Historical**: 세션 목록에서 클릭하면 해당 세션만 REST로 로드해 표시하고 카메라 이동.
- 레이어 토글: Trajectory / Raw points(수평 정확도 색: 초록<5m, 노랑<15m, 빨강≥15m) / Markers / Accuracy.
- 지도 높이는 해발고(MSL) 기준입니다. 융합 높이는 타원체고 − KNGeoid18 N, raw는 폰 MSL 고도로 그립니다(아래 "지형 기준 높이" 참고).
- Preview 소켓이 끊겼다 다시 연결되면 collector/세션 목록과 로드된 궤적을 REST로 다시 가져옵니다.

## Sensor Fusion (fusion-v1 / v2 / v2.1 / v3 / v3.1 / v4)

Raw 센서 데이터는 **절대 수정하지 않고**, 파생 결과만 `fused_positions`에 **version별로** 저장합니다. 같은 raw 세션에 여러 알고리즘 결과가 동시에 존재하고 서로 비교할 수 있습니다.

```
Raw (location/motion/altimeter/pedometer_samples, event_markers — 읽기 전용)
  ├─ fusion-v1   ─→ fused_positions (algorithm_version = 'fusion-v1')
  ├─ fusion-v2   ─→ fused_positions (algorithm_version = 'fusion-v2')
  ├─ fusion-v2.1 ─→ fused_positions (algorithm_version = 'fusion-v2.1')
  ├─ fusion-v3   ─→ campus-gated GPS anchors + v2.1 pedestrian DR
  ├─ fusion-v3.1 ─→ sparse GPS anchors + sensor-led tracking + fusion_sensor_events
  └─ fusion-v4   ─→ step-level PDR + Kalman/RTS + terrain Z datum  ← 실시간 기본값 (ACTIVE_FUSION_VERSION)
```

### fusion-v2.1 (2026-10-02 v4 전환 전 실시간 기본) — v2가 첫 위치에 고정되던 문제 수정

**v2 원인 분석 (실데이터·코드 확인 결과)**: 누적값 중복 합산(Z·pedometer), yaw/course 단위 혼동, 위경도에 미터 직접 더하기, motion마다 출력 같은 구현 오류는 **없었습니다**. 실제 원인은 정책: 실내/차량 GPS(중앙값 24–40 m)가 >15 m로 거의 전부 거부되고, heading anchor 조건(≤8 m course)도 한 번도 충족되지 않아 PDR까지 막혀 **XY가 첫 fix에 고정**됐습니다. 예: 세션 `4b7f4151`은 raw GPS가 차량 속도(24.7 m/s)로 4.2 km 이동하는 동안 v2는 원점에 고정 → "4.2 km offset"; XY는 그대로이고 Z만 barometer로 −16~0 m 변해 3D에서 **수직선**처럼 보였습니다 (Z 자체는 barometer 범위와 일치).

| 단계 | v2.1 기본값 (`fusionConfigV21`) |
|---|---|
| GPS 등급 / XY 가중치 | ≤5 m 0.65 · ≤10 m 0.30 · ≤20 m 0.08 · ≤35 m 0.01 · >35 m 0 (`UNUSABLE_ACCURACY`) |
| 초기화 | ≤20 m fix 즉시, 없으면 30초 뒤 ≤50 m 중 최선의 fix로 임시 시작. 임시 상태에서 2배 이상 좋은 fix가 오면 그 위치로 교체. >50 m fix로는 시작하지 않음 |
| Heading | ① GPS course (≤10 m, ≥0.8 m/s) ② **두 GPS 점 bearing** (둘 다 ≤25 m, 거리 ≥ max(5 m, 0.5·√(accA²+accB²)), pedometer가 있으면 그 사이 ≥1 m 걸었을 때) ③ yaw **delta**만. `headingSource` = `GPS_COURSE`·`GPS_TWO_POINT`·`YAW_DELTA`(anchor 후 10° 이상 yaw로 회전)·`UNKNOWN` |
| PDR | 누적 distance의 delta만, 3.5 m/s 초과 clamp. heading 없으면 이동 안 함 → `pdr_applied=false, pdr_reject_reason=NO_HEADING` 기록. 같은 segment의 이전 최댓값보다 작은 샘플(0 샘플 포함)은 `BELOW_HIGH_WATER`로 무시하고, segment 없이 재시작된 카운터는 3샘플 연속 증가하면 `COUNTER_RESTARTED`로 새 기준 (rev 6, `fusion.pedometer.ts`) |
| Z | **anchor 기반** `z = datum + (relativeAltitude − baseRelativeAltitude)` (적분 없음). 4 m/s 초과 barometer 점프는 glitch로 무시. GPS ellipsoidal(verticalAccuracy로 가중)은 datum만 조정 |
| Gate | stationary XY lock(v2와 동일), physical jump, innovation `max(8 m, 2·√(acc²+u²))` |

### fusion-v4 — 걸음 단위 PDR + 칼만 필터 + 스무더

실측 분석(2026-10-02) 기반 버전입니다. 캠퍼스 GPS는 15~60 m(5 m 이하 1.2%)이고, yaw는 임의 기준계이며, CMPedometer는 2.6초 묶음으로 오고 계단에서도 평지 보폭을 씁니다.

| 단계 | 동작 (`fusionConfigV4`) |
|---|---|
| 걸음 | 50 Hz 수직 가속도(중력 방향 투영, 3 Hz 저역통과)의 피크. 주기적인 피크 3개가 연속돼야 보행으로 인정(폰 조작 오검출 방지). 각 걸음은 **자기 시각의 yaw**로 적용 |
| 보폭 | CMPedometer 거리 / 검출된 평지 걸음 수(high-water mark 규칙). 기압 수직속도 ≥ 0.13 m/s면 계단 → 0.30 m. 걸음 없이 고도만 변하면(엘리베이터) 수평 이동 0 |
| 방향 | 진행방향 = −yaw + θ. θ는 **방향 구간**(자세 변화·모션 공백마다 새 구간)마다 하나. 걸은 모양을 GPS에 견고(Cauchy) 그리드 탐색으로 맞춰 추정하고, 근거가 없으면 이전 구간에서 진행방향 연속을 가정(σ 35°). 둘 다 없으면 위치를 움직이지 않음 |
| GPS | [x, y, θ] EKF의 정확도 가중 관측(σ = max(hacc, 5 m)), χ² 게이트. 50 m 초과·세션 전 캐시는 제외. 일관된 거부가 5회 이상 이어지면 재앵커. GPS 속도 ≥ 3 m/s + 걸음 없음 → 차량 모드 |
| 최종(재처리) | 구간별 θ를 그 구간의 **모든** fix로 재추정 → 필터 + RTS 역방향 스무딩 → 잔차 기반 견고 가중치로 3회 반복. 저장되는 궤적은 이 결과(`finalize`) |
| 높이 | 기압 상대 Z(센서 재시작에도 연속). 절대 높이 = median(GPS 타원체고 − Z), 수직정확도 ≤ 15 m인 fix만 |

```bash
npm run fusion:reprocess -- --all --version=fusion-v4
```

**실시간 기본 버전은 fusion-v4입니다**(2026-10-02 전환, `ACTIVE_FUSION_VERSION`). 실시간에는 전방 필터를 쓰고, 세션이 끝나면 자동 재처리(finalize) 단계에서 RTS 스무딩·지형 영점·실내 계단 보정 결과로 교체됩니다. 이전 버전으로 되돌리려면 `.env`의 `ACTIVE_FUSION_VERSION`을 바꾸고 서버를 재시작합니다.

### 지형 기준 높이 (Z 영점, fusion-v4 rev 2)

서울시 1:5000 등고선·표고점(2015)으로 캠퍼스 DEM을 만들어 절대 높이 기준으로 쓴다. 자세한 내용은 `docs/TERRAIN_Z_DATUM_PLAN.md`.

```bash
npm run terrain:extract -- --contours="<등고선 폴더>" --spots="<표고 폴더>" --geoid=<KNGeoid18.dat> --buildings=<AL_D010 폴더> --campus-map=<skuniv json 폴더>
npm run terrain:import          # DEM + 품질 게이트 + 활성화 + 건물 메타데이터
npm run fusion:reprocess -- --all --version=fusion-v4 --force
```

- 높이 = 기압 상대고도 + 영점 b(t). b는 실외 보행 중 "지면 + 폰 높이 1 m"인 지면 접촉에서 구하고, 기압 표류(2 m/h 랜덤워크)를 RTS로 평활한다.
- 접촉이 없으면 지면과 일관된 GPS 높이로 대체하고, 그것도 없으면 영점 없음(NONE)으로 둔다. iPhone GPS 고도는 이 캠퍼스에서 −31~+16 m 틀려 그대로 쓰지 않는다.
- API: `GET /api/v1/terrain`(버전·QA·건물 메타데이터), `GET /api/v1/terrain/height?lat=&lon=`(정표고·타원체고·σ·건물).
- 원본 대용량 파일은 저장소 밖에 두고, 잘라낸 원천(`backend/data/terrain/source`)과 원본 해시(`SOURCES.json`)만 둔다.
- 실내 계단(rev 3): 기압상 계단 구간의 직전·직후 10초 안에 같은 건물 안에 있었다면, 그 계단은 건물 안으로 묶는다(도형 안쪽 2.5 m에 σ 1 m 약한 앵커). 바깥 계단(도로 → 출입구)은 밖에서 시작하므로 건드리지 않는다.
- 건물 층 보정: `npm run buildings:calibrate -- --session=<id>` — 현장 세션의 `entrance` 마커(출입구 층의 폰 높이)와 실내 기압 평탄 구간으로 건물별 출입구 층 정표고·층고를 `building_metadata.metadata.calibration`에 저장한다. 프리뷰는 이 값으로 "entrance floor +N"을 표시한다. 북악관: 출입구 층 바닥 135.65 m, 층고 3.39 m(2026-10-02, fbaa781d).
- 마커는 fusion-v4 궤적에 스냅한다: 마커 시각의 앞뒤 융합 점을 보간한 위치·높이(`GET /sessions/:id/markers`의 `fused`, 10초 넘는 공백이면 가까운 점). 재처리가 끝나면 프리뷰가 다시 읽는다. 융합 결과가 없을 때만 폰 위치·고도로 그린다.
- 지도 높이: VWorld는 지형·건물을 해발고(MSL) 값 그대로 장면 높이로 쓴다(샘플: VWorld 127.9/103.6/144.2 m vs DEM 해발 132.0/97.7/140.5 m). 그래서 프리뷰는 모든 점을 해발고로 그린다(융합 = 타원체고 − KNGeoid18 N, raw = 폰 MSL 고도). API의 `ellipsoidalAltitude`는 그대로 타원체고다.

### 프리뷰 지도: 캠퍼스 3D 모델 (docs/CAMPUS_3D_PREVIEW_PLAN.md)

프리뷰는 VWorld 대신 CesiumJS(npm)로 캠퍼스 단순 3D 모델을 그린다. 지형은 서버 지형 DEM(퓨전 높이 기준과 같은 면)이고, 건물은 QGIS에서 만든 박스 모델이다. 인터넷과 VWorld 키 없이 동작한다.

```bash
npm run scene:import -- --dir=/Users/hoshi/Desktop/skuniv_shp/campus_3d   # campus.gpkg → 검증 → 활성화 (원본은 backend/data/scene/source)
npm run scene:import -- --dir=<폴더> --dry-run                            # 검증과 높이 표만 출력
```

- 건물 높이(`height_m`, 대장/추정 근거)는 GeoPackage 값을 쓴다. 기초·지붕 표고는 서버 DEM 위에서 다시 계산한다(기초 = 외곽 최저 − 1 m, 지붕 = 중앙값 + 높이, 최소 최고점 + 3 m). QGIS에서 지붕을 직접 고쳤다면 `--keep-absolute`.
- 검사: EPSG:5186, 건물 도형이 퓨전의 캠퍼스 건물과 IoU ≥ 0.99, 모두 DEM 범위 안, 지붕 > 지면 > 기초. 하나라도 실패하면 활성화하지 않는다.
- 상단 Buildings: X-ray(실내 궤적 보기), 이름, 추정 높이 색(따뜻한 색 = 층수 × 3.5 m 추정), 전체/위에서 보기. 건물을 클릭하면 높이 근거·층 보정이 Detail에 나온다.
- API: `GET /api/v1/scene`(활성 장면), `GET /api/v1/terrain/grid`(DEM 격자, Float32 바이너리, ETag).
- 예전 VWorld 지도: 루트 `.env`에 `VITE_MAP_ENGINE=vworld`와 키를 두고 dev 서버를 다시 시작한다.
- **QGIS에서도 웹과 같은 높이로 보기:**
  1. `npm run qgis:sync -- --dir=/Users/hoshi/Desktop/skuniv_shp/campus_3d`: QGIS 프로젝트를 닫고 실행한다. 프로젝트의 `terrain_dem_2m.tif`를 서버 DEM으로 바꾸고, `campus.gpkg` 건물의 기초·지붕을 활성 장면 값으로 맞춘다. 원본은 `*.codex.*`로 한 번 보관한다.
  2. QGIS에서 프로젝트를 연 뒤 Python 콘솔에서 `backend/scripts/qgis/add_tracking_layers.py`를 실행한다. 스키마 `qgis`의 뷰(융합 궤적·마커·원본 GPS·대표 경로)를 고도 Absolute 3D 레이어로 추가한다. DB 접속은 루트 `.env`의 `POSTGRES_*`를 읽는다.
  3. 원래 테이블(`public.fused_positions`, `location_samples`)을 3D로 직접 쓰지 않는다. 그 geom의 Z는 타원체고라 해발보다 약 23.4 m 높고, 궤적이 건물 한 채 높이만큼 떠 보인다. `qgis.*` 뷰는 웹과 같은 규칙이다(융합 = 타원체고 − N, 없으면 지면 + 1 m / 원본 = 폰 해발고 / 마커 = v4 궤적에 스냅).
- 캠퍼스 밖(DEM 범위 밖)은 가장자리 높이로 평평하게 이어진다. 캠퍼스 밖 궤적의 지형 맥락은 없다.

### OpenCities Map 퓨전 점 연결

마이그레이션 적용(`npm run db:migrate`) 후 PostGIS의 `public.opencities_fused_positions`를 선택한다. OpenCities Map 2025에서 세션 외래키를 가진 원본 테이블이 피처 목록에서 제외되는 현상을 피하기 위한 외래키 없는 실제 테이블이다. 모든 알고리즘 버전의 기존 결과를 채우고, DB 트리거가 신규 저장·재처리·수정·삭제·세션 삭제에 따른 cascade·TRUNCATE를 원본과 같은 트랜잭션에서 반영한다. 서버 재시작은 필요 없다. 원본과 복사본 사이에 외래키를 추가하지 않는다.

OpenCities에서는 읽기 용도로 사용하고 Write Access를 끈다. 원하는 궤적만 보려면 `algorithm_version = 'fusion-v4'`와 `session_id`로 필터링한다. 이 테이블의 geometry만 EPSG:5186 PointZ(미터)로 변환한다. 원본 `fused_positions.geom`은 EPSG:4326으로 유지하고 latitude/longitude 속성도 경위도 그대로다. Z는 원본 타원체고/로컬 높이를 유지한다(QGIS용 해발고 변환 뷰와 다름). DGN의 실제 모델 좌표계도 EPSG:5186이어야 한다. 기존 4326 레이어를 이미 불러왔다면 조회 결과를 제거하고 연결을 다시 만들어 5186 geometry로 재조회한다. 향후 원본에 열을 추가하면 이 테이블에도 대응하는 마이그레이션을 추가해야 새 속성이 노출된다. `ocm_diag_*` 테이블은 진단 당시 복사본이므로 실제 사용에는 선택하지 않는다.

### 통로·광장·출입구 직접 그리기 (QGIS → DB → 프리뷰)

QGIS에서 PostGIS 스키마 `mobility`를 직접 편집한다. 저장하면 DB에 바로 들어가고, 프리뷰의 Paths 레이어가 새로 고침 없이 갱신된다.

1. QGIS에서 캠퍼스 프로젝트를 연다.
2. Python 콘솔에서 `backend/scripts/qgis/add_mobility_layers.py`를 실행한다. 편집 가능한 레이어 3개가 생긴다. 종류는 한글 드롭다운으로 고르고, 꼭짓점 1 m 스냅이 켜진다.

| 레이어 | 도형 | 용도 |
|---|---|---|
| `mobility.corridors` 통로·경로 | 선(중심선) | 보행로·인도·실내 복도·계단·경사로·횡단보도. `width_m` = 실제 폭(기본 3 m), `one_way` = 그린 방향만 |
| `mobility.open_areas` 광장·개방 공간 | 면 | 광장·중정·로비·주차장 |
| `mobility.portals` 출입구·연결점 | 점 | 건물/광장 출입구, 계단 시작·끝, 엘리베이터, 교차점 |

3. 그린 뒤 "레이어 편집 저장"을 누른다.

- `elevation_m`: 비우면 지형 위에 그린다. 실내·고가 시설은 해발 높이(m)를 넣는다.
- 저장할 때 DB가 검사한다: EPSG:5186, 캠퍼스 지형 범위 안, 올바른 도형, 통로 1 m 이상, 면적 4 m² 이상. 실패하면 QGIS가 오류를 보여주고 편집 내용은 그대로 남는다.
- 모든 추가·수정·삭제는 `mobility.edits`에 이전/이후 값과 함께 남는다(`GET /api/v1/mobility/edits`).
- 흐름: 저장 → 트리거가 `NOTIFY mobility_changed` → 백엔드 → 소켓 `mobility:changed` → 프리뷰가 `GET /api/v1/mobility`를 다시 읽는다.
- 프리뷰: 상단 Buildings 그룹의 Paths 토글. 통로는 실제 폭의 띠 + 중심선(일방통행은 화살표), 광장은 반투명 면, 출입구는 이름 붙은 점으로 그린다. 클릭하면 Detail에 속성이 나온다.
- 차도 면: 편집기 도로(`mobility.road_segments`) 중 차가 다니는 길(`road_class` vehicle·shared)은 `GET /api/v1/mobility/roads`(읽기 전용)로 받아 프리뷰에 검은 면으로 그린다. 토글 `차도`(지상, 지면에 얹음)·`지하 차도`(저장된 높이, 기본 꺼짐). 폭은 `width_m`, 없으면 표시용 기본값(`frontend/src/road-surface.ts`). 편집기 화면의 색·선 규칙은 그대로다.

### Lab · 반복 측정 이동 지도 (docs/MOBILITY_MAP_PLAN.md 묶음 1)

여러 세션의 같은 길 반복을 하나의 대표 경로 + 신뢰 폭으로 만들고, 알고리즘 변경을 수치로 비교하는 도구다. 프리뷰 상단 **Lab** 모드에서 쓴다.

```bash
npm run fusion:replay -- --session=<id|앞 8자리> --set gpsGateChi2=9 --variant=chi9   # 실험 실행(게시 안 함, 기존 결과 보존)
npm run fusion:replay -- --session=<id> --mode=as-received                         # 실시간에 보였던 결과 재현
npm run qc:run -- --all                                                             # 원본 GPS 품질 판정(qc-v1)
npm run routes:build -- --name="R1" --a=<x,y> --b=<x,y> --detect --build --validate # 경로 → 회차 → 대표 경로 → 검증
npm run bench -- --suite=default --set gpsGateChi2=9                                # 등록된 설정 vs 후보 설정
npm run sim:session -- --sessions=2 --passes=4 --route                              # 정답을 아는 합성 세션 + 경로
npm run fusion:golden -- --out=/tmp/golden.json --write | --check                   # 리팩터링 회귀 확인(메모리 replay 해시)
npm run fusion:prune -- --dry-run                                                   # 오래된 실행 스냅샷 정리
```

- 재처리마다 실행 스냅샷(전방·최종 궤적, GPS 픽스별 판정, 엔진 사건)이 남는다. `fused_positions`는 버전별 게시 결과로 그대로 쓴다.
- 좌표는 캠퍼스 공통 좌표계 `skuniv-5186-v1`(EPSG:5186 − (201,100, 557,250) m, 높이 = 정표고)이다. `--a/--b`도 이 좌표(m)이고, `--wgs84`를 주면 위경도다.
- 신뢰 폭은 회차 간 재현성이지 정확도가 아니다. 같은 장소의 공유 편향은 앵커(마커) 오차로만 드러난다.
- bench 묶음은 `backend/bench/suites/*.json`(경로 이름 목록)이다. 현장 수집 뒤 경로를 추가한다.

### fusion-v3.1 — 센서 중심 시험 버전

`fusion-v3`의 v2.1 내부 엔진 래퍼를 사용하지 않는 독립 엔진입니다. 보행 센서 누적 거리를 수평 이동의 기본값으로 사용하고, 거리 관측이 빠진 구간은 걸음 수 × 설정 보폭으로 보완합니다. 가속도·걸음 변화를 정지 판정에 함께 사용하며, 최초 방향이 잡힌 뒤에는 자세 yaw 변화로 방향을 진행합니다. roll/pitch·중력·회전 속도로 큰 휴대폰 자세 변화와 불연속 구간을 감지해 방향이 안정될 때까지 이동 적용을 보류합니다. 기압계는 상대 높이를 직접 갱신합니다. 보수계 누적값은 v2.1과 같은 high-water mark 규칙으로 처리합니다(rev 3).

GPS는 캠퍼스 내부·정확도 5 m 이하 관측 5개·최소 3초 연속 조건을 통과한 초기 앵커나 30초 이상 간격을 둔 재앵커로만 위치를 잡습니다. 개별 GPS 갱신은 보행 위치·방향·높이를 수정하지 않습니다. 위치가 없는 세션은 `UNANCHORED` 상태와 센서/앵커 진단을 기록하고 절대 좌표를 만들지 않습니다. 수동/고정 앵커 엔진 연결 지점은 준비되어 있지만 QR·기준점 화면은 후속 범위입니다.

기존 19개 세션을 v3.1로 재처리했습니다. 원본 GPS 632건 중 적격 앵커가 없어 fused 위치는 0건이며, 보행·자세·기압·GPS 판정 이벤트는 `fusion_sensor_events`와 실행 지표에 기록됩니다. v1/v2/v2.1 결과와 당시 실시간 기본값이던 v2.1은 유지했습니다(현재 실시간 기본값은 v4).

```bash
npm run fusion:reprocess -- --all --version=fusion-v3.1 --force
```
| GPS cluster re-anchor | 최근 ≤30 m fix 3–5개가 20 m 안에 모였는데 상태가 그 중심에서 max(40 m, 2×중앙 accuracy) 이상 떨어짐 → PDR drift로 보고 중심으로 50% soft reset (`GPS_CLUSTER`) |
| GPS track re-anchor | 최근 ≤35 m fix ≥4개(≥8초)가 일관된 거의 직선 이동(≥50 m)이고 pedometer 거리로 설명 안 됨(버스·차량) → 최신 fix로 이동 (`GPS_TRACK`). 실내 GPS 흩어짐은 직진성 조건으로 걸러짐 |
| Divergence guard | anchor 이후 변위 > 걸은 거리 + 채택된 보정량 + 30 m 이면 상태 손상으로 보고 GPS evidence로 reset (`DIVERGENCE`) — km 단위 발산 불가 |
| 출력 | 1 Hz tick + 중요 이벤트(초기 anchor, 정지↔이동, re-anchor, 신뢰 GPS, Z 1.5 m 이상 변화) 즉시 출력 (최소 0.5초 간격) |
| 진단 컬럼 | `gps_quality`, `pdr_applied`, `pdr_reject_reason`, `relative_altitude`, `reanchored`, `reanchor_reason`, `divergence_detected` (+ v2 진단 컬럼) |

**재처리 후 자동 검증** (`fusion.validation.ts`, 모든 version 공통, `fusion_runs.warnings`에 저장): fused 첫 위치 기준 최대 변위 > max(걸은 거리, ≤35 m GPS의 최대 변위) + 50 m 이면 `DISPLACEMENT_EXCEEDS_EVIDENCE`, 3배 초과면 `CRITICAL_DIVERGENCE`; fused Z 범위 > barometer 범위 + 10 m 이면 `Z_RANGE_EXCEEDS_BAROMETER`, 3배 초과면 `CRITICAL_Z_DIVERGENCE`; 출력이 분당 120개 초과면 `OUTPUT_RATE_HIGH`.

**현재 DB 결과 (16개 세션)**: v2.1 경고 0건, re-anchor 36회, divergence 0회. 예: `4b7f4151` — v2 변위 0 m → v2.1 1,180 m(≤35 m GPS 근거 1,475 m 이내), 마지막 usable fix(±27 m)와의 offset v2 1,423 m → v2.1 246 m (25 m/s 차량 추종 지연), Z 범위 16.3 m(barometer 12.2 m). 마지막 raw fix는 ±1,777 m라 offset 비교 대상에서 제외(Preview도 "Last usable raw → fusion" 사용). v1은 >35 m GPS까지 따라가 2개 세션에서 `DISPLACEMENT_EXCEEDS_EVIDENCE`.

### fusion-v2 (보수적, 기록용)

```
Raw timeline (timestamp 정렬) → 입력 검증 → Stationary 판정 → PDR 예측 → GPS Quality Gate
  → Physical Jump Gate → Innovation Gate → GPS 보정 → 수직 보정 → 불확실도/신뢰도 → 1 Hz 출력
```

| 단계 | 기본값 (`fusion.config.ts` `fusionConfigV2`) |
|---|---|
| GPS Quality Gate | ≤5 m α 0.65 · ≤10 m α 0.30 · ≤15 m α 0.08 · **>15 m α 0 (XY에 사용 안 함, `POOR_ACCURACY`)** |
| Stationary | 최근 2초 동안 pedometer 진행 ≤ 0.25 m(걸음 증가 없음) **그리고** userAcceleration RMS ≤ 0.12 g (CoreMotion 단위 g; 실데이터: 걷기 p10 0.29 g, 정지 ~0.02–0.06 g) → **XY 고정** (`STATIONARY_LOCK`). 예외: ≤5 m fix 3개 이상이 3 m 안에 모이면 천천히(α 0.2) 보정 |
| Physical Jump | 마지막 채택 fix 대비 `5 m + 3.5 m/s × dt + 두 accuracy`를 넘으면 `PHYSICAL_JUMP` |
| Innovation | 예측 위치와의 거리 > `max(8 m, 2 × √(gpsAccuracy² + 상태불확실도²))` 이면 `INNOVATION_TOO_LARGE` |
| 복구 | ≤10 m fix가 4초 이상 연속 5번 gate에 걸리면 상태가 틀린 것으로 보고 GPS로 재-anchor (`GPS_REANCHOR`) |
| 초기화 | ≤15 m 첫 fix로 즉시, 없으면 30초 뒤 그때까지 가장 좋은 fix로 임시(provisional) 초기화 |
| Heading | GPS course(`speed ≥ 0.8`, `accuracy ≤ 8 m`)로 절대 anchor(원형 보간 α 0.5), 없으면 정확한 두 fix 이동 방향. Motion yaw는 **변화량만** |
| PDR | pedometer 누적 distance의 delta만, 3.5 m/s 초과 clamp. **heading이 없으면 위치를 움직이지 않음** (불확실도만 증가) |
| Z | barometer relativeAltitude delta + GPS ellipsoidalAltitude(verticalAccuracy로 가중, >20 m는 미사용) |
| 신뢰도 | 상태 불확실도(m, PDR 거리·이동 시간에 따라 증가, 채택 fix로 감소) → `exp(-u/15 m)`. 확률이 아닌 휴리스틱 점수 |

- 각 fused position에 진단값 저장: `gps_used`, `gps_reject_reason`, `gps_sequence`, `innovation_distance`, `stationary`, `heading_source`, `horizontal_uncertainty`.
- **v1**: 모든 유효 fix가 accuracy별 고정 가중치(>20 m도 0.05)로 위치를 끌어당김 → 실내/차량 GPS에 크게 흔들림. 기록용으로 유지.
- 출력은 센서 시각 기준 1초 tick (motion 50 Hz마다 저장/전송하지 않음). 네트워크 batch와 무관 → **실시간 결과 = 같은 raw 재처리 결과** (테스트·실데이터로 확인).
- 실시간 fusion은 raw COMMIT 이후 비동기로 실행되며 실패해도 iPhone ACK에 영향 없음. 실패/서버 재시작 시 raw로부터 state 재구성.
- 알고리즘을 바꿀 때: 기존 version을 고치지 말고 `fusion.algorithms.ts`에 새 version을 추가. 같은 version의 **엔진 코드**를 고치면 `revision`을 올릴 것 (config 변경은 자동으로 hash됨).
- 상세 로그: `.env` `FUSION_DEBUG=true` (gate 판정·stationary 전환·anchor·1초당 출력 1줄).

### 재처리 (과거 세션 포함)

```bash
npm run fusion:reprocess:v21                                     # = --all --version=fusion-v2.1 --force (전체 세션 v2.1 강제 재계산)
npm run fusion:diagnose -- --session=<uuid>                      # 읽기 전용: raw 범위 vs 저장된 모든 version 변위/Z 범위/경고
npm run fusion:diagnose -- --all
npm run fusion:reprocess -- --all --version=fusion-v2            # 전체 (이미 같은 코드/config로 처리된 세션, ACTIVE 세션은 건너뜀)
npm run fusion:reprocess -- --session=<uuid> --version=fusion-v2 # 한 세션
npm run fusion:reprocess -- --all --version=fusion-v2 --force    # 강제
```

- 세션별 transaction, 한 세션 실패가 나머지를 막지 않음, 마지막에 요약 표 출력. 이력은 `fusion_runs`(config, raw 개수, 채택/거부 수, metrics)에 저장.
- API: `POST /api/v1/sessions/:id/fusion/reprocess` `{"algorithmVersion":"fusion-v2.1","force":true}` (`force` 없으면 같은 코드·config로 이미 처리된 세션은 건너뜀) 또는 Preview 세션 Detail의 version별 `Reprocess` 버튼. 해당 version 결과와 그 버전의 센서 이벤트 이력만 교체, 다른 version·raw는 그대로.
- 마지막에 요약 출력: Total / Success / Failed / Outputs / GPS used·rejected / Re-anchors / Divergences prevented / Validation warnings.
- CLI는 별도 프로세스라 Preview에 알리지 않음 → Preview에서 ↻.
- metrics(채택/거부 수·거부율·정지 시간·중앙 GPS accuracy·최대 거부 innovation·fused/raw 경로 길이)는 **정확도가 아님** (ground truth 없음).

### Preview에서 비교

- 헤더 `Fused` 그룹의 version 체크박스: live 버전은 실선, 비교 버전은 점선(기본 OFF). Historical 모드에서 같은 세션의 Raw와 각 fused 결과를 겹쳐 봄. v3.1은 위치 궤적이 비어도 Detail의 센서 추적 이벤트와 앵커 판정에 표시.
- 흐린 raw 점 = live 버전이 거부한 fix (DB에는 그대로). 흰 fused 점 = stationary.
- 지도 위 점을 클릭하면 Detail에 진단값 표시 (fused: source·STATIONARY/MOVING·heading/출처·GPS used/거부 사유·accuracy·innovation·불확실도·신뢰도·가장 가까운 raw와의 offset, raw: v2 판정).
- 세션 Detail에 version별 run metrics 표.
- 세션 Detail 표에 version별 re-anchor/divergence, 걸은 거리, 최대 변위(근거 대비), Z/barometer 범위, 검증 결과.
- 단위 테스트 (iPhone 없이): `npm test -w backend` (v1 16 + v2 16 + v2.1 17).

### (참고) 실데이터에서 v2가 거의 움직이지 않았던 이유

2026-10-01~02 수집 데이터는 대부분 실내·차량 구간입니다. ≤10 m fix 39개는 모두 차량 속도(평균 33–35 m/s)였고 보행 중 fix는 대부분 10 m 이상이었습니다. 그래서 v2는 GPS를 거의 거부하고, GPS course heading이 한 번도 잡히지 않아 PDR도 움직이지 않습니다(설계상 heading 없이 임의 방향으로 이동시키지 않음). 보행 PDR을 검증하려면 **세션을 야외 개활지에서 시작해 10–20 m 정도 곧게 걸어** GPS course heading을 먼저 잡은 뒤 실내로 들어가세요. 또한 iOS 앱의 `desiredAccuracy`(`kCLLocationAccuracyBest`), 정확한 위치(Precise Location) 허용 여부를 확인하세요.

### Fusion(v1·v2)의 한계 (완벽한 실내 측위가 아님)

GPS + Pedometer + 휴대폰 Motion + Barometer를 이용한 **휴리스틱 dead reckoning**입니다. 다음 이유로 오차가 생깁니다.

- 휴대폰 자세 변화: 손에 들거나 주머니에 넣거나 몸은 그대로 두고 폰만 돌리면 yaw는 바뀌지만 걷는 방향은 그대로
- pedometer 거리 오차 (보폭 모델), yaw drift (자력계 미사용), 자기장/환경 간섭
- 실내 GPS multipath, barometer drift (날씨·공조)
- 폰을 세워 들면(pitch ≈ ±90°) Euler yaw가 불안정
- 실시간 처리 중 늦게 도착한 오래된 샘플은 건너뛰고, 세션 종료 시 자동으로 전체 재처리해 정식 결과로 교체

향후 단계(아직 구현 안 함): step heading 추정, 자력계/CLHeading heading, 차량 구간 판별, **Map Matching** (`Fused → Matched`를 별도 단계로). Event marker는 아직 anchor로 쓰지 않음.

### 캠퍼스 실험 예시

야외 직선 → 건물 입구(marker) → 실내 복도 → 계단 → 다시 야외 순으로 걸으며 Preview에서 Raw 점/궤적, Accuracy 원, Fused 점/궤적, Raw↔Fused offset을 함께 비교합니다. 결과가 기대와 다르면 같은 세션을 config/알고리즘 수정 후 재처리해 비교합니다.

## 구조

```
backend/src
├── app.ts / server.ts            Express + Socket.IO 부트스트랩, /health
├── config/                       env(Zod), pg Pool, withTransaction
├── common/                       AppError·에러 핸들러, JWT, 로거, 공통 DTO
├── modules/<feature>/            route/controller → service → repository(SQL) + dto(Zod)
│   ├── collectors                login, device upsert, collector:status
│   ├── sessions                  session:start/finish, 세션 REST
│   ├── telemetry                 telemetry:batch (unnest batch insert, idempotency)
│   ├── markers                   marker:create, 마커 REST
│   └── fusion                    fusion-v1: engine(순수 로직)·state·config·algorithms·repository·service·controller
├── realtime/                     /collector(Socket.IO) · /ws/collector(raw WS) · /preview · /editor gateway
├── geo/                          WGS84 ↔ local ENU 변환, 각도 utility
└── db/                           migrate.ts, seed.ts, migrations/*.sql
backend/scripts/simulate-iphone.ts
frontend/src                      Preview UI와 Cesium 캠퍼스 지도, 별도 editor.html 도로·장소 편집기
```

## 데이터 신뢰성 요약

- ACK는 항상 **검증 → DB transaction → COMMIT 이후** 반환. Preview broadcast도 COMMIT 이후.
- `received_batches.batch_id UNIQUE`로 batch 단위 idempotency, `UNIQUE(session_id, sequence)` + `ON CONFLICT DO NOTHING`으로 sample 단위 idempotency (pedometer는 `(session_id, timestamp)`).
- 센서 샘플은 테이블당 `INSERT … SELECT FROM unnest(array…)` 1개 문장으로 batch insert (샘플 수와 무관하게 bind parameter 수 고정).
- `location_samples.geom = PointZ(longitude, latitude, COALESCE(ellipsoidal_altitude, altitude, 0))`, SRID 4326, GIST index. 원본 altitude 컬럼은 별도로 보존.
- socket disconnect는 세션 종료가 아님. 종료/중단 이후 도착한 오프라인 batch도 저장됨.

## 범위 밖 (의도적으로 구현하지 않음)

Sensor fusion, Kalman filter, PDR, GPS 보정, map matching, 궤적 클러스터링, Redis/Kafka, Preview 로그인, refresh token, RBAC 등.
