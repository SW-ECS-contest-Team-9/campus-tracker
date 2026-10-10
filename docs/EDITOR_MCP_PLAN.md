# 편집기 MCP 연동 계획 (초안)

작성: 2026-10-06. 상태: **P0~P4 구현됨(2026-10-06).** §13은 권장안으로 확정했다. 구현 현황과 계획에서 달라진 점은 §14.
대상: [캠퍼스 도로·장소 3D 편집기](CAMPUS_NETWORK_EDITOR_PLAN.md)를 Claude Code·Codex 같은 MCP 클라이언트가 조작할 수 있게 한다.

## 0. 요약

- AI는 브라우저 화면을 원격 조종하지 않는다. 기존 협업 모델(편집권 lease, revision, mutationId, outbox)에 **작업자 한 명으로 참여**한다. 사람의 편집기에는 AI의 커서, 제안선, 저장 결과가 기존 실시간 채널로 그대로 보인다.
- MCP 서버는 기존 backend 프로세스에 `POST /mcp`(Streamable HTTP, 무상태)로 내장한다. 도구는 `editorService`를 직접 호출하므로 검증, 위상 처리, 변경 알림이 사람의 저장과 같은 경로를 탄다.
- 도구는 작업 단위다. lease 토큰, 편집 세션 ID, mutationId는 MCP 계층이 처리하고 모델은 `expectedRevision`만 다룬다.
- 모델이 좌표를 맞추게 하지 않는다. 기존 객체에 붙일 때는 참조(`at`)로, 높이는 DEM(`zMode: terrain`)으로 서버가 계산한다.
- 기본은 읽기 전용이다. 쓰기는 토큰 scope로 열고 DRAFT만 만든다. 모든 쓰기 도구에 `dryRun`이 있고 변경은 `editor_changes`에 `actor`와 함께 남는다.
- 단계: P0 준비 → P1 읽기 → P2 쓰기 MVP → P3 정확한 dry-run·묶음 적용·되돌리기 → P4(선택) 지도 렌더·화면 안내.

## 1. 목표와 범위

목표는 MCP 클라이언트가 캠퍼스 도로·장소 네트워크를 조회, 점검, 편집하게 하는 것이다. 대표 시나리오:

1. "Fusion Run X의 120~480번 구간을 보행로 초안으로 그려줘. 높이는 지면 기준으로."
2. "끊어진 끝점이나 연결되지 않은 교차를 찾아 목록으로 보여주고, 내가 고른 것만 연결해줘."
3. "이름 없는 도로에 인접 건물 기준으로 이름 후보를 제안해줘."
4. "내 커서 위치에 '북악관 정문' 출입구 장소를 추가해줘."
5. "방금 AI가 만든 변경을 되돌려줘." (P3)

범위 밖:

- 브라우저 UI(키 입력, DOM) 원격 조종.
- 승인(APPROVED) 네트워크의 직접 변경과 승인/게시 워크플로 자체.
- 경로 탐색, Map Matching.
- LAN 밖 원격 접근과 OAuth.
- Fusion/QC/Lab 기능의 실행(재처리 등). 편집 참고용 조회만 제공한다.
- 범용 SQL 접근.

## 2. 현재 상태 (2026-10-06 확인)

| 항목 | 확인 내용 |
|---|---|
| 편집 API | `backend/src/modules/editor/`: snapshot, leases, topology/junction preview, road-changesets, places, retire. `/api/v1/editor/*`, 인증은 `editorAuth`(Collector JWT + 기기 행 확인) |
| 실시간 | `/editor` Socket.IO: presence, cursor, draft는 서버 메모리. 확정 변경은 `editor_changes` outbox → `editor:feature:changed` |
| 저장 절차의 위치 | lease 획득 → topology-preview → 영향 도로 lease → 저장 → 해제 순서가 브라우저에 있다(`editor-main.ts`의 `saveCurrent()` 880행, `defineJunction()` 409행, `deleteSelection()` 925행). 서버에는 이 순서를 묶은 함수가 없다 |
| DB | migration 023은 **적용되어 있다**(편집기 설계 문서 §9의 "미적용" 서술은 낡았다). DRAFT 도로 4, REPLACED 1, 노드 6, 장소 0, APPROVED 0 |
| 참고 데이터 | Fusion Run 574, 세션 30, canonical path 5, 장면 건물 12. QGIS corridors/portals는 0건 |
| 노출 범위 | backend는 iPhone 접속용으로 `0.0.0.0:3000`에서 수신한다. 편집기 로그인은 비밀번호 없는 Collector 코드다 |
| 타입체크 | **현재 실패한다.** backend 6건(전부 `editor.service.ts`), frontend 69건(전부 `editor-main.ts`). `tsx`와 Vite dev는 타입을 검사하지 않아 실행은 된다. 단위 테스트 97건은 통과 |
| 그중 MCP에 영향 | `AppError.conflict(code, message)`는 인자가 2개인데 서비스는 세 번째 `details`(현재 revision, lease 소유자)를 넘긴다. 런타임에 **details가 버려진다.** 모델이 충돌에서 복구하려면 이 값이 필요하다 |
| MCP 클라이언트 | Codex 설정(`~/.codex/config.toml`)에 이미 `url` + `bearer_token_env_var` 형식의 HTTP MCP 서버가 있다. HTTP 전송 하나로 Claude Code와 Codex를 모두 지원할 수 있다 |
| SDK | `@modelcontextprotocol/server` 2.3.1이 현재 안정판(2026-07-28 스펙)이고 `@modelcontextprotocol/sdk` 1.32.1은 유지보수 라인이다. v2는 zod ^4.2, Node ≥20을 요구하며 현재 zod 4.6.5, Node 24와 맞는다 |

## 3. 접근 방식

### 3.1 AI는 협업 참가자다

```
Claude Code / Codex ── POST /mcp (Bearer 에이전트 토큰) ──┐
                                                         ▼
                              backend (기존 프로세스, :3000)
  editor-mcp: 가드 → 인증 → 도구 → agent-editor(저장 절차) ──► editorService ──► PostGIS
                   │                                               │
                   └─ editorAgents(가상 참가자: 커서, 제안) ─┐       └─ editor_changes + NOTIFY
                                                          ▼                     │
                              /editor Socket.IO ◄────────────── editor.listener ◄┘
                                      │
                         사람의 브라우저 편집기 (AI 커서, 제안선, 저장 결과가 실시간 표시)
```

편집기 설계가 이미 여러 작업자를 전제로 하므로 AI를 위한 별도 쓰기 경로를 만들지 않는다.
사람과 AI가 같은 객체를 동시에 고치려 하면 기존 lease와 revision 규칙이 그대로 막는다.

브라우저 원격 조종을 택하지 않는 이유:

- 편집 상태가 한 탭의 모듈 변수와 DOM에 있다(`attrsFromUI()`가 input 값을 읽는다). 명령 계층이 없어서 외부에서 구동하려면 편집기부터 재구성해야 한다.
- 탭이 열려 있고 렌더링 중이어야 한다. 숨겨진 탭에서는 `requestAnimationFrame`이 멈춰 Cesium이 그리지 않는다.
- WASD/Space 커서 조작은 사람을 위한 입력 방식이다. AI에게는 좌표와 참조 기반 명령이 더 정확하다.
- "AI가 작업하는 모습을 본다"는 요구는 presence와 제안 방송으로 충족된다(§7.4, §7.5).

### 3.2 전송 방식

| 안 | 내용 | 판단 |
|---|---|---|
| A. backend 내장 HTTP `/mcp` | 같은 프로세스에서 서비스 직접 호출, 게이트웨이의 메모리 상태(presence, draft) 직접 사용 | **권장.** 프로세스가 하나이고 DEM 샘플링, 투영 같은 서버 계산을 왕복 없이 쓴다. 대신 LAN 노출 차단이 필수다(§4) |
| B. stdio 별도 프로세스 | 브라우저와 같은 REST + Socket 계약만 사용하는 클라이언트 | 서버 변경이 적고 네트워크 노출이 없다. 대신 저장 절차를 HTTP 위에 다시 구현하고, 조회 기능을 늘릴 때마다 REST를 추가해야 한다 |
| C. 범용 DB MCP | SQL 직접 실행 | lease, revision, 위상 규칙을 우회하므로 쓰지 않는다 |

stdio만 지원하는 클라이언트는 `npx mcp-remote http://127.0.0.1:3000/mcp` 브리지로 A에 연결한다.

**무상태로 운영한다.** 요청마다 서버 인스턴스를 만들고 MCP 세션을 두지 않는다.
`tsx watch`는 backend 파일을 저장할 때마다 재시작하는데, 세션이 없으면 대화 도중 재시작되어도 다음 호출이 그대로 동작한다.
편집 상태는 DB(lease, revision)와 토큰에서 유도한 편집 세션 ID에 있으므로 MCP 세션이 필요 없다. 서버 → 클라이언트 알림(SSE)은 쓰지 않는다.

### 3.3 SDK

v2(`@modelcontextprotocol/server`, `@modelcontextprotocol/express`, 필요하면 `@modelcontextprotocol/node`)를 쓴다.
Express 어댑터 README에 요청마다 서버를 만드는 무상태 구성 예시와 localhost Host 검증 미들웨어(`localhostHostValidation`)가 있다.
v2의 세부 API와 2026-07-28 스펙은 P0에서 공식 문서와 실제 연결로 확인한다. Claude Code나 Codex와 프로토콜 협상 문제가 있으면 v1.32로 대체한다.
이 교체가 쉽도록 도구 구현(§9의 `tools/`, `agent-editor.ts`)은 SDK 타입에 의존하지 않고, 등록 코드(`mcp.server.ts`)만 SDK를 안다.

## 4. 신원, 인증, 권한

- **토큰**: 기존 Collector JWT에 `agent`(예: `claude-code`)와 `scope` 클레임을 더한다.
  `npm run mcp:token -- --collector C01 --agent claude-code --scope write --days 30`이 `devices`에 `platform='mcp'` 행을 등록하고 서명한다.
  검증은 기존 `verifyAccessToken` + `touchDevice`를 쓰고 선택 클레임만 추가로 읽는다. `agent` 클레임이 없는 토큰(폰, 브라우저용)은 `/mcp`에서 거부한다.
  기기 행을 지우면 토큰이 폐기된다(`--list`, `--revoke` 제공).
- **귀속**: `created_by`, `updated_by`, lease `owner_code`는 토큰을 발급한 사람의 Collector 코드다.
  AI 표시는 `editor_changes.payload.actor = { via: 'mcp', agent }`와 presence의 `agent` 필드로 한다.
  AI 전용 Collector 계정을 만들지 않으므로 Preview 수집자 목록과 편집기 로그인 목록이 그대로다.
- **편집 세션 ID**: 토큰의 기기 행 UUID(`deviceDatabaseId`)를 쓴다. 무상태 요청 사이에서 안정적이고, 같은 C01이라도 브라우저 세션과 달라서 서로의 lease를 재획득하지 못한다.
- **scope**: `editor:read`(기본) / `editor:write`(DRAFT 생성·수정·보관, 교차점 지정) / `editor:approved`(APPROVED 객체에 닿는 작업, 예약. 현재 APPROVED는 0건).
  scope는 AI의 의도치 않은 쓰기를 막는 가드이고 보안 경계는 아니다. 편집 REST 자체가 비밀번호 없는 로그인으로 LAN에 열려 있기 때문이다.
- **네트워크 가드(`/mcp` 전용)**: loopback 원격 주소만 허용(`MCP_ALLOW_REMOTE=false` 기본), Host 헤더 검증(DNS rebinding 차단), 브라우저 Origin 거부. `EDITOR_MCP=off`로 전체를 끈다.

클라이언트 등록:

```json
{ "mcpServers": { "campus-editor": {
  "type": "http", "url": "http://127.0.0.1:3000/mcp",
  "headers": { "Authorization": "Bearer ${CAMPUS_EDITOR_MCP_TOKEN}" } } } }
```

```toml
[mcp_servers.campus-editor]
url = "http://127.0.0.1:3000/mcp"
bearer_token_env_var = "CAMPUS_EDITOR_MCP_TOKEN"
```

위는 프로젝트 `.mcp.json`(Claude Code), 아래는 `~/.codex/config.toml`(Codex)이다. 토큰은 환경 변수에만 두고 저장소에 넣지 않는다.

## 5. 도구 설계 원칙

1. **작업 단위**로 만든다. REST를 1:1로 옮기지 않는다. lease 토큰, 세션 ID, mutationId는 노출하지 않는다.
2. **좌표계는 REST/DB와 같다.** EPSG:5186(x=동, y=북, m) + 정표고 Z(KVD_INCHEON_MSL). 출력은 0.01 m로 반올림한다. WGS84와 캠퍼스 로컬(`skuniv-5186-v1`)은 변환 도구로 다룬다.
3. **연결은 좌표 일치가 아니라 참조로 표현한다**(§7.2).
4. **출력은 기본이 요약이다.** 형상은 요청할 때만 준다. 전체 snapshot은 네트워크가 커지면 수만 토큰이 된다.
5. **모든 쓰기 도구에 `dryRun`이 있다.** 결과에는 항상 위상 결과(분할된 도로, 생성/재사용 노드, 연결되지 않은 끝점)를 넣는다.
6. **오류는 `code`와 복구 방법**을 함께 준다(§7.6).
7. **annotation**(`readOnlyHint`, `destructiveHint`, `idempotentHint`)을 정확히 달아 클라이언트의 권한 확인이 의미를 갖게 한다. 읽기 도구만 허용 목록에 넣으면 쓰기 때만 확인을 받는다.
8. **도메인 규칙**은 서버 `instructions`와 `get_editor_context`로 전달한다: 미확인 속성을 허용으로 추정하지 않는다, Z는 노면/바닥 높이다, `levelId` 표기를 기존 값과 맞춘다.

## 6. 도구 목록

P0~P2에서 만드는 도구는 22개다(읽기 14, 쓰기 6, 표시 2). P3 이후 후보는 8개다.
"기반"은 구현이 기대는 기존 코드이고, "신규"는 새 로직이 필요하다는 뜻이다.

### 6.1 상황 파악 (읽기, P0~P1)

| 도구 | 하는 일 | 주요 입력 | 기반 |
|---|---|---|---|
| `get_editor_context` | 대화의 시작점. 좌표계, 수직 기준, 지형 범위, enum, 허용오차(같은 노드 높이 0.3 m / 가까운 높이 1.25 m / 0.15 m / 0.75 m), 사용 중인 `levelId`, 현재 권한, 객체 수 (P0) | 없음 | 상수와 간단한 집계 |
| `list_features` | 도로·장소·노드의 요약 목록: id, 이름, 유형, 상태, revision, 길이, Vertex 수, 양 끝 노드, 편집 중 여부 | `type`, `status`, `roadClass`, `levelId`, `nameContains`, `bbox`, `near`, `limit`, `geometry: none\|endpoints\|full` | snapshot 쿼리를 요약형으로 다시 작성 |
| `get_feature` | 객체 하나의 상세: 속성, 인덱스가 붙은 좌표, revision, 편집 중인 작업자, 노드별 연결 도로, 계보(parent/replacedBy), 최근 변경 | `type`, `id`, `simplifyM?` | 신규 SQL |
| `find_nearby` | 한 점 주변의 도로(최근접점, 거리, measure, 인접 Vertex, 보간 Z), 노드, 장소, 지면 Z, 건물. 연결 대상을 찾을 때 쓴다 | 점 또는 참조, `radiusM`, `levelId?` | `projectOnLine`, `terrain.buildingAt` |
| `get_collaborators` | 접속자, 커서 위치와 방향, 편집 중인 객체, 다른 작업자의 미저장 초안. P2부터 각자 선택한 객체도 포함한다 | 없음 | 게이트웨이 메모리, lease 테이블 |
| `get_changes` | changeset 단위로 묶은 변경 이력 | `sinceId?`, `changeSetId?`, `via?` | `editor_changes` |

### 6.2 참고 자료 (읽기, P1)

| 도구 | 하는 일 | 주요 입력 | 기반 |
|---|---|---|---|
| `sample_terrain` | 점이나 선의 지면 높이, sigma, 경사, 범위 내 여부, 건물 | 점 배열 또는 선 + `spacingM` | `terrain.sampleXY` |
| `list_fusion_runs` | 세션과 그 세션에서 궤적을 쓸 수 있는 Run 목록: 수집자, 시각, 길이, 점 수, 절대고도가 있는 점의 비율 | `collectorId?`, `bbox?`, `includeSynthetic?` | `fusionRunsRepository` |
| `get_run_track` | Run의 FINAL 궤적을 5186 좌표로 반환한다. h는 null일 수 있다 | `runId`, seq 범위, `bbox?`, `resampleM?`, `simplifyM?` | `positions()`, `resampleTrack`, 단순화는 신규 |
| `list_routes` | Lab 경로와 최신 정규 경로(canonical path) ID | 없음 | `pathfusionService.listRoutes` |
| `get_canonical_path` | 반복 측정으로 만든 정규 경로의 점열(1 m 간격, 점별 신뢰도) | `pathId`, idx 범위 | `pathfusionService.canonicalPath` |
| `list_buildings` | 건물 ID, 이름, 중심, 층수. `buildingId` 속성과 장소 배치의 기준 | 없음 | scene 쿼리 |
| `convert_coordinates` | WGS84 ↔ EPSG:5186 ↔ 캠퍼스 로컬 변환 | 점 배열, `from`, `to` | `tm.ts`, `campus-frame.ts` |

궤적 데이터의 현재 규모(2026-10-06)가 도구 기본값을 정한다.

- FINAL 위치가 저장된 스냅샷 Run은 29개이고, 세션 30개 중 21개만 궤적을 쓸 수 있다. 나머지는 Lab에서 replay로 스냅샷을 만들어야 한다. MCP는 replay를 실행하지 않는다.
- Run당 점 수는 16~6,104개(중앙값 251)다. `get_run_track`은 기본으로 단순화하고 반환 점 수에 상한(예: 400)을 둔다.
- FINAL 점의 56.6%는 h가 없다. 그래서 경로 높이의 기본값이 DEM이다(§7.1).
- 정규 경로는 5개(35~129점)다.

### 6.3 점검 (읽기, P1)

| 도구 | 하는 일 | 주요 입력 | 기반 |
|---|---|---|---|
| `validate_network` | 위상과 속성을 점검해 findings(코드, 심각도, 객체 ID, 위치, 권장 조치)를 반환한다 | `bbox?`, `checks?` | 신규 순수 함수 |

초기 검사 항목: 다른 도로 가까이에서 끊긴 끝점, Z 차이로 연결되지 않은 XY 교차, 0.15 m 안의 중복 노드,
공선 겹침(서버가 저장할 때 검출하지 않는다), 지면에서 1.5 m 넘게 뜬 실외 도로, 속성 모순(계단 + 차량 허용, 계단 + 휠체어 허용), 고립된 작은 연결 요소.

### 6.4 편집 (쓰기, P2, `editor:write` 필요)

| 도구 | 하는 일 | 주요 입력 | 기반 |
|---|---|---|---|
| `create_road` | 도로 초안을 만든다. 속성을 생략하면 UI와 같은 유형별 프리셋을 쓴다 | 속성, `path`(§7.1), `zMode`, `dryRun` | `saveRoad`, `path-resolver` 신규 |
| `update_road` | 속성이나 형상을 고친다. 교차가 생기면 새 ID로 분할된다 | `id`, `expectedRevision`, `attrs?`, `path?` 또는 `vertexOps?`, `reverse?`, `simplifyM?`, `drapeToTerrain?`, `dryRun` | `saveRoad` |
| `connect_roads` | 한 지점에서 반경 0.75 m 안의 같은 층·높이 도로들을 공통 노드로 연결한다 | 점 또는 참조, `dryRun` | `previewJunction`, `saveJunction` |
| `create_place` | 장소 마커를 만든다 | 이름, 분류, 설명, 건물/층, 위치(점 또는 참조), `dryRun` | `savePlace` |
| `update_place` | 장소의 속성이나 위치를 고친다 | `id`, `expectedRevision`, 바꿀 필드, `dryRun` | `savePlace` |
| `retire_feature` | 도로나 장소를 보관 처리한다. 행은 RETIRED로 남는다(`destructiveHint`) | `type`, `id`, `expectedRevision` | `retire` |

### 6.5 사람에게 보여주기 (P2)

| 도구 | 하는 일 | 주요 입력 | 기반 |
|---|---|---|---|
| `show_overlay` | 점, 선, 기존 객체 강조를 라벨과 함께 사람의 편집기에 잠시 표시한다. 저장하지 않는다. 점검 결과의 위치를 짚어 줄 때 쓴다 | 항목 배열(점/선/객체 ID, 라벨), `ttlSec?` | 게이트웨이와 프런트 소폭 변경 |
| `clear_overlay` | 자신이 띄운 표시를 지운다 | 없음 | 위와 같음 |

쓰기 도구의 `dryRun` 결과도 같은 방식으로 자동 표시된다(§7.4).

### 6.6 후속 후보 (P3~P4)

| 도구 | 하는 일 | 필요한 것 |
|---|---|---|
| `apply_changes` | 여러 작업을 한 트랜잭션으로 적용한다. 하나가 실패하면 전부 취소된다 | 서비스 함수의 트랜잭션 주입형 분리(§7.4) |
| `revert_changeset` | changeset 하나를 되돌린다 | P2의 `before` 기록, 신규 서비스 함수 |
| `move_node` | 노드와 거기 연결된 도로 끝점을 함께 옮긴다 | 신규 서비스 함수 |
| `split_road` | 교차 없이 한 지점에서 도로를 나눈다. 구간별로 속성이 다를 때 필요하다 | 신규 서비스 함수 |
| `merge_roads` | 속성이 같은 인접 구간을 합친다 | 신규 서비스 함수(편집기 설계에서도 후속) |
| `check_reachability` | 두 지점이 보행/차량/휠체어 조건으로 이어지는지 확인한다 | 신규 그래프 탐색. 범위 밖인 경로 탐색과 겹치므로 점검 용도로 한정한다(§13) |
| `render_map` | 지정 범위의 평면도를 PNG로 반환해 모델이 결과를 눈으로 확인한다 | 신규 렌더러와 새 의존성 |
| `focus_view` | 사람 편집기의 카메라를 지정 위치로 옮긴다 | 프런트 변경, 탭별 허용 설정 |

QGIS corridors/portals 가져오기는 현재 데이터가 0건이라 목록에서 뺐다. 데이터가 생기면 `path`의 참조 종류로 추가한다.

## 7. 핵심 동작

### 7.1 경로 입력과 높이

```ts
type PathPoint =
  | { xy: [number, number]; z?: number }                    // z 생략 시 zMode 적용
  | { at: { roadId: string; vertexIndex: number } }         // 기존 Vertex의 저장된 XYZ 그대로
  | { at: { roadId: string; measureM: number } }            // 도로 위 거리 지점(보간 XYZ)
  | { at: { roadId: string; nearest: [number, number] } }   // 해당 도로 위 최근접점
  | { at: { nodeId: string } | { placeId: string } | { cursorOf: string } }
  | { run: { runId: string; fromSeq: number; toSeq: number; simplifyM?: number } }  // FINAL 궤적 구간을 펼쳐 넣음
  | { canonical: { pathId: string; fromIdx?: number; toIdx?: number } }             // 정규 경로 구간을 펼쳐 넣음
```

- `zMode: 'terrain'`(기본)은 z가 없는 점을 활성 DEM에서 샘플링한다. `terrainOffsetM`을 줄 수 있다.
- `densify: 'auto'`는 직선 보간과 DEM의 차이가 0.3 m를 넘는 곳에 중간점을 넣는다. 끝점만 샘플링하면 중간 지형을 놓친다는 기존 원칙을 따른다.
- `run`과 `canonical` 구간의 Z는 기본이 DEM이다. `runZ: 'run_h'`는 h가 유효한 점만 쓰고 결과에 "폰 높이를 포함할 수 있음" 경고를 붙인다. h가 없는 점의 `zRel`은 절대 높이로 쓰지 않는다.
- Run과 정규 경로의 좌표는 캠퍼스 로컬 프레임이므로 원점(201100, 557250)을 더해 5186으로 바꾼다.
- 해석 결과의 출처(Run ID와 seq 범위 등)는 changeset payload의 `source`에 남긴다. Vertex 단위 출처 컬럼은 이 계획의 범위 밖이다.
- `update_road`의 `vertexOps`(`move`, `insert`, `delete`, `replaceRange`)는 서버에 저장된 좌표에 순서대로 적용한다. 모델이 수백 개 좌표를 반올림해 되돌려 보내지 않아도 된다.

### 7.2 연결 보장

현재 서버가 도로를 연결하는 조건은 넷이다.

- 같은 `level_id`(NULL 포함 완전 일치)에서 선분이 교차하고 보간 Z 차이가 0.3 m 이하 (2026-10-11 전에는 1.25 m, 아래 "높이 허용치" 참고)
- Vertex가 XY 2 cm, Z 5 cm 안에서 일치
- `branchFrom`(시작점만 가능)
- 끝점이 같은 층에서 XY 0.15 m, Z 0.3 m 안의 기존 노드에 흡수 (2026-10-11 전에는 1.25 m)

모델이 cm로 반올림한 좌표로 "도로 중간에 닿는" 끝점을 보내면 몇 mm 차이로 연결되지 않고, 오류도 나지 않는다. 그래서 다음을 지킨다.

1. 붙일 지점은 `at` 참조로만 받는다. 서버가 배정밀도로 좌표를 계산해 넣는다.
2. 시작점이 Vertex 참조면 기존 `branchFrom`을 쓴다.
3. 저장 후 검증한다. 참조한 도로(또는 그 분할 결과)와 새 도로가 노드를 공유하지 않으면 그 지점에 `saveJunction`으로 보정하고 다시 확인한다.
4. 그래도 연결되지 않으면 성공으로 보고하지 않고 결과의 `unconnected`에 넣는다.
5. `levelId`가 다르면 연결이 조용히 생략된다. 참조한 도로와 `levelId`가 다르면 저장 전에 거부한다.

P3에서 `saveRoad`의 `branchAnchorHit`를 "임의 Vertex ↔ 대상 도로 measure" 앵커 목록으로 일반화하면 3번의 보정 단계가 필요 없어진다.

### 7.3 쓰기 절차 (`create_road` 기준)

1. 입력 검증, 경로 해석 → XYZ 배열.
2. 사전 검사: 지형 범위, 길이, Vertex 수, 속성 모순, `levelId`, 기존 활성 도로와 사실상 같은 형상(응답 유실 후 재시도로 생기는 중복 방지).
3. `previewTopology`로 분할될 도로, 교차, 자기 교차를 구한다.
4. `dryRun`이면 계획을 반환하고 제안선을 방송한 뒤 끝낸다.
5. 새 도로 ID와 분할 대상 도로의 lease를 얻는다. 다른 작업자가 편집 중이면 얻은 것을 모두 해제하고 `EDITOR_OBJECT_LOCKED`를 반환한다.
6. `saveRoad`를 호출한다. mutationId는 요청마다 새로 만들고, `idempotencyKey`가 오면 그 값에서 유도한다.
7. `TOPOLOGY_REFRESH_REQUIRED`면 3번부터 한 번 재시도한다.
8. 연결을 검증·보정한다(§7.2). 실패 경로에서는 남은 lease를 해제한다.
9. `roadIds`, `changeSetId`, `splits`, `nodes`, `connections`, `unconnected`, `warnings`를 반환한다.

AI는 도구 호출 사이에 lease를 들고 있지 않으므로 사람의 편집을 길게 막지 않는다. 사람의 lease를 빼앗지 않는다.

`update_road`는 현재 행을 읽어 patch를 적용한 뒤 같은 절차를 탄다. 현재 서비스 동작에서 나오는 다음 사항은 결과로 알린다.

- 수정한 형상이 다른 도로나 자신과 교차하면 도로가 REPLACED되고 조각들이 새 ID를 받는다.
- APPROVED 도로를 수정하면 원본은 유지되고 DRAFT 후속본이 새 ID로 생긴다.
- 공유 노드에 있던 끝점을 옮기면 다른 도로는 옛 노드에 남는다(노드 이동 기능이 아직 없다). `ENDPOINT_DETACHED` 경고를 붙인다.
- `reverse`는 좌표 순서와 forward/backward 속성을 함께 뒤집어 실제 통행 방향을 보존한다.

### 7.4 dryRun과 AI 제안선

- **P2**: `previewTopology` / `previewJunction`과 사전 검사로 계획을 만든다. 실제 저장과 같은 코드 경로는 아니다.
- **P3**: 서비스 함수를 트랜잭션 주입형(`saveRoadTx(db, …)`)으로 나누고 "실행 후 ROLLBACK"으로 정확한 dry-run을 만든다. NOTIFY와 mutation 기록도 함께 롤백된다. 같은 구조로 여러 작업을 한 트랜잭션에 묶는 `apply_changes`가 가능해진다.
- **제안선**: dry-run 결과 형상을 `/editor` room에 `editor:draft:update`(`proposal: true`, `agent` 포함)로 방송한다. TTL은 5분이고 커밋 또는 만료 시 지운다. lease가 필요 없고 스냅이나 저장의 대상이 아니다. `show_overlay`도 같은 채널을 쓴다.

### 7.5 Presence

게이트웨이에 `editorAgents`를 추가한다. 도구가 호출되면 가상 참가자(`socketId = agent:<기기 ID>`)를 등록하고,
쓰기나 dry-run이 일어난 위치로 커서를 옮겨 방송한다. 90초 동안 호출이 없으면 퇴장시킨다. 새로 접속하는 브라우저의 presence snapshot에도 포함한다.

### 7.6 오류 매핑

| code | 의미 | 모델에게 주는 안내 |
|---|---|---|
| `REVISION_CONFLICT` | 읽은 뒤 객체가 바뀜 | `currentRevision`을 주고 `get_feature`로 다시 읽게 한다 |
| `EDITOR_OBJECT_LOCKED` | 다른 작업자가 편집 중 | 소유자와 만료 시각. 기다리거나 사용자에게 알린다 |
| `TOPOLOGY_REFRESH_REQUIRED` | 교차 대상이 그사이 바뀜 | 내부에서 1회 재시도. 재실패 시 다시 계획하게 한다 |
| `OUTSIDE_TERRAIN` | 지형 범위 밖 | 범위(bounds)를 함께 준다 |
| `JUNCTION_UNAVAILABLE` | 연결할 도로가 2개 미만이거나 이미 연결됨 | `find_nearby` 결과로 원인을 설명한다 |
| `LEVEL_MISMATCH` (신규) | 참조 도로와 `levelId`가 다름 | 사용 중인 `levelId` 값을 준다 |
| `DUPLICATE_GEOMETRY` (신규) | 같은 형상의 활성 도로가 있음 | 기존 도로 ID를 준다 |
| `SCOPE_REQUIRED` (신규) | 토큰에 쓰기 권한 없음 | 토큰 재발급 방법을 안내한다 |

P0에서 `AppError.conflict`가 `details`를 실제로 전달하게 고쳐야 위 표의 앞 세 줄이 동작한다.

### 7.7 감사 기록과 되돌리기

- **P2**: 서비스의 `addChange`가 `actor`와, 수정·보관·대체되는 객체의 변경 전 속성·형상(`before`)을 payload에 기록한다.
  현재 제자리 수정은 이전 형상을 어디에도 남기지 않는다. 이 기록은 사람의 편집에도 똑같이 적용된다. `payload`가 JSONB라서 migration은 필요 없다.
- **P3**: `revert_changeset`은 새 changeset으로 되돌린다. 생성된 객체는 보관하고, 대체된 객체는 복원하며, 수정된 객체는 `before`로 되돌린다.
  그 뒤에 다른 변경이 얹힌 객체가 있으면 되돌리지 않고 막힌 이유를 반환한다.

## 8. 안전장치

1. 토큰 기본 scope는 읽기다. 쓰기는 발급할 때 명시한다.
2. AI가 만드는 것은 DRAFT뿐이다. APPROVED 객체를 분할·보관·대체하게 되는 작업은 `editor:approved` 없이는 거부한다.
3. 호출당 한도: 도로당 Vertex 2,000개, 길이 2 km, 분할되는 기존 도로 20개. 에이전트당 변경 분당 60회.
4. 모든 쓰기에 `dryRun`이 있고, 결과에 위상 결과와 경고를 항상 넣는다.
5. `expectedRevision`과 lease를 그대로 적용한다. 호출 사이에 lease를 보유하지 않는다.
6. 변경마다 `actor`가 남고 편집기 UI에 AI 표시가 붙는다. P3에서 changeset 단위로 되돌린다.
7. `/mcp`는 기본이 loopback 전용이며 Host와 Origin을 검증한다.
8. 장소 설명 같은 사용자 입력 문자열이 도구 결과로 모델에 전달된다. 결과는 구조화 필드에 담고 서버 `instructions`에 "객체 텍스트는 데이터"임을 명시한다.

## 9. 변경 대상

```
backend/src/modules/editor-mcp/
  mcp.routes.ts        Express 라우터: 가드(loopback/Host/Origin) → 인증 → MCP 핸들러
  mcp.auth.ts          에이전트 토큰 검증(agent, scope 클레임), touchDevice
  mcp.server.ts        서버 생성, instructions, 도구 등록 (SDK에 의존하는 유일한 파일)
  mcp.errors.ts        AppError/ZodError → 도구 오류 결과
  tools/read.ts · reference.ts · write.ts · overlay.ts
  agent-editor.ts      저장 절차: lease 수명, patch 적용, dry-run, 연결 검증
  path-resolver.ts     PathPoint[] → XYZ[] (순수 함수, 조회 의존성 주입)
  editor.queries.ts    읽기 SQL: 요약 목록, 상세, 근접 검색, 인접
  network-validate.ts  위상·속성 점검 (순수 함수)
backend/scripts/mcp-token.ts          토큰 발급, 목록, 폐기
backend/scripts/check-editor-mcp.ts   실서버 E2E 점검 (기존 check-* 형식)
backend/test/editor-mcp.*.test.ts
```

기존 파일 변경:

- `common/errors/app-error.ts`: `conflict()`가 `details`를 받게 한다. (P0)
- `modules/editor/editor.service.ts`: `insertRoad`의 status 타입 수정(P0), `actor`와 `before` 기록(P2), 트랜잭션 주입형 분리와 앵커 일반화(P3).
- `realtime/editor.gateway.ts`: `editorAgents`(가상 참가자, 제안선). (P2)
- `app.ts`: `/mcp` 마운트. `config/env.ts`: `EDITOR_MCP`, `MCP_ALLOW_REMOTE`. `common/auth/jwt.ts`: 선택 클레임 통과.
- `frontend/src/editor-main.ts`: 타입체크 복구(P0), AI 참가자 배지와 커서 색, 제안선·표시 스타일과 별도 키, 선택한 객체를 presence로 전송(P2), 변경 이력 패널과 되돌리기(P3).
- `package.json` 스크립트(`mcp:token`, `check:editor-mcp`), `.mcp.json`, `.env.example`, `README.md`, 편집기 설계 문서의 낡은 서술.

기존 REST와 Socket 계약은 바꾸지 않는다. 추가만 한다.

## 10. 단계와 완료 기준

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **P0 준비** | 타입체크 복구(backend 6건, frontend 69건)와 conflict details 전달. SDK 설치. `/mcp` 골격(가드, 인증, `get_editor_context`). 토큰 CLI. `.mcp.json` | `npm run typecheck` 통과. Claude Code와 Codex 양쪽에서 `get_editor_context` 호출 성공. LAN 주소로 온 요청과 토큰 없는 요청이 거부됨 |
| **P1 읽기** | 읽기 도구 전체, `editor.queries.ts`, `network-validate.ts` | "끊어진 끝점을 찾아줘", "이 Run에 가장 가까운 도로는?"을 도구만으로 답한다. 현재 DB의 도로 4개에 대한 결과가 편집기 화면과 일치한다 |
| **P2 쓰기 MVP** | `agent-editor`, `path-resolver`, 쓰기 도구 6개와 표시 도구 2개, `actor`/`before` 기록, presence와 제안선, 프런트 배지, 한도 | Run 구간으로 보행로 초안을 만들면 열려 있는 편집기에 새로고침 없이 나타난다. 사람이 편집 중인 도로를 AI가 고치려 하면 `EDITOR_OBJECT_LOCKED`. 참조로 붙인 끝점이 노드를 공유한다. E2E 점검 통과 후 lease와 활성 행이 남지 않는다 |
| **P3 검토와 복구** | 트랜잭션 주입형 분리, 정확한 dry-run, `apply_changes`, `revert_changeset`, 앵커 일반화, `move_node`, `split_road`, 변경 이력 패널 | dry-run 계획과 실제 저장 결과가 일치한다. 묶음의 한 작업이 실패하면 전체가 롤백된다. AI changeset 하나를 되돌리면 그 전 snapshot과 같아진다 |
| **P4 선택** | `render_map`, `focus_view`, `check_reachability`, `merge_roads`, prompts | 필요가 확인되면 범위를 정한다 |

각 단계는 독립적으로 쓸 수 있다. P1만으로도 네트워크 점검에 쓸 수 있고, P2까지가 "AI가 편집기를 조작한다"의 최소 범위다.

## 11. 검증

- **단위 테스트(DB 없음)**: `path-resolver`(참조, zMode, densify, Run 프레임 변환), `vertexOps`와 `reverse`, `network-validate` 규칙, 오류 매핑, 중복 형상 검사, 연결 검증 로직.
- **프로토콜**: 메모리 내 클라이언트-서버 쌍으로 도구 목록, 스키마, annotation, scope 거부를 확인한다.
- **E2E(`npm run check:editor-mcp`)**: 실행 중인 dev 서버와 DB에서 임시 토큰 발급 → 생성 dry-run → 생성 → 조회 → revision 충돌 → 교차점 → 점검 → 보관 → 잔여 lease 확인.
  전용 `levelId` 표식을 써서 실제 도로와 연결되지 않게 하고(층이 다르면 연결되지 않는다), 끝에 그 표식의 행만 정리한다.
- **협업 시나리오(수동)**: 브라우저를 연 상태에서 AI 저장이 즉시 반영되는지, lease 충돌, 제안선 표시와 만료, AI presence 등장과 퇴장.
- **회귀**: 기존 `npm test` 97건과 `fusion:golden`은 영향이 없어야 한다(MCP 모듈은 추가만 한다).

## 12. 위험과 미확정

- **v2 SDK와 클라이언트 호환**: v2 API와 2026-07-28 스펙은 npm README와 공식 문서 요약만 확인했다. 실제 연결은 P0에서 검증한다. TypeScript 7에서 SDK 타입 검사 비용도 P0에서 확인한다.
- **서비스에 테스트가 없다**: `editor.service.ts`는 DB 의존이라 단위 테스트가 없다. P3의 트랜잭션 분리는 E2E 점검을 먼저 만든 뒤 진행한다.
- **기준점이 없다**: 편집기 코드(`backend/src/modules/editor/`, `frontend/src/editor-main.ts` 등)가 아직 git에 커밋되지 않았다. P0에서 두 파일을 고치기 전에 커밋 기준점을 만든다.
- **P2 dry-run은 근사**다. 분할 결과의 세부(조각 수, 노드 Z)는 실제 저장과 다를 수 있다. P3에서 해소한다.
- **노드 이동이 없다**: 공유 끝점을 옮기는 수정은 P3 전까지 경고만 한다.
- **공선 겹침**은 서버가 검출하지 않는다. `validate_network`가 사후에 찾는다.
- **`levelId` 관례**: 현재 도로는 전부 NULL이다. 'outdoor' 같은 값을 새로 쓰면 기존 도로와 연결되지 않는다. 관례를 정해 `instructions`에 넣는다.
- **무상태의 한계**: 진행 알림과 서버 발신 요청(elicitation)을 쓰지 못한다. 현재 도구는 모두 1초 안에 끝나므로 필요 없다.
- **AI는 지도를 보지 못한다**: P1~P3은 구조화 데이터만 준다. 시각 확인이 필요해지면 P4의 `render_map`을 앞당긴다.

## 13. 결정이 필요한 항목

| # | 결정 | 권장 | 대안 |
|---|---|---|---|
| 1 | 조작 방식 | AI를 협업 참가자로(서버 API 수준) | 브라우저 UI 원격 조종 |
| 2 | 전송 | backend 내장 HTTP `/mcp`, 무상태 | stdio 별도 프로세스 |
| 3 | AI 신원 | 사람 계정 위임 + `agent` 표시 | AI 전용 Collector 계정 |
| 4 | 쓰기 기본값 | 토큰 scope로 개방, DRAFT만, APPROVED 접촉 금지 | 처음부터 전체 허용 |
| 5 | 속성 기본값 | UI와 같은 유형별 프리셋(보행로: 보행 allowed, 차량 prohibited) | DTO 기본값(unknown) |
| 6 | P0에 타입체크 복구 포함 | 포함(conflict details가 MCP 오류 복구의 전제) | MCP와 분리해 별도 진행 |
| 7 | P4 범위 | 필요가 확인되면 결정 | `render_map`을 P2에 포함 |
| 8 | 연결성 확인(`check_reachability`) | 점검 용도로만 추가(연결 여부와 끊긴 지점만 반환, 미확인·제한 통행은 불가로 취급) | 경로 탐색 단계로 미룸 |

## 14. 구현 현황 (2026-10-06)

도구는 30개다: 읽기 16, 쓰기 11, 표시 3. `npm run check:editor-mcp`가 실서버에서 53항목을 점검하고, 단위 테스트는 112건이 통과한다.

| 단계 | 구현 내용 |
|---|---|
| P0 | 타입체크 복구, `AppError.conflict`의 `details` 전달, v2 SDK, `POST /mcp`(loopback 전용, Host/Origin 검증, 에이전트 토큰), `npm run mcp:token`, `.mcp.json` |
| P1 | 읽기 도구 14개(§6.1~6.3) |
| P2 | `create_road`, `update_road`, `connect_roads`, `create_place`, `update_place`, `retire_feature`, `show_overlay`, `clear_overlay`. AI 참가자 표시, 제안선, 선택 객체 공유, `actor`와 `before` 기록 |
| P3 | 서비스의 트랜잭션 주입, 롤백 방식 dry-run, `apply_changes`, `revert_changeset`, `move_node`, `split_road`, 앵커 일반화, 편집기의 변경 이력 패널과 되돌리기 버튼 |
| P4 | `render_map`, `focus_view`, `check_reachability`, `merge_roads`, MCP prompt 2개(`network_qa`, `trace_road_from_run`) |

계획에서 달라진 점:

- **dry-run은 처음부터 롤백 방식이다.** 서비스 함수가 호출자의 트랜잭션을 받을 수 있게 먼저 바꿨기 때문에, P2의 "근사 dry-run" 단계는 건너뛰었다. 모든 쓰기 도구는 한 트랜잭션 안에서 lease 획득과 저장을 함께 하고, `dryRun`이면 그대로 롤백한다.
- **연결은 앵커로 보장한다.** `RoadSave`에 `anchors`(이 Vertex가 저 도로의 measure 지점에 있다)를 추가했고 `saveRoad`가 교차 판정과 함께 처리한다. §7.2의 "저장 후 교차점 보정" 단계는 필요 없어져 구현하지 않았다. 저장 후 연결 여부는 확인해서 결과에 넣는다.
- **`move_node`, `split_road`, `merge_roads`, `revert_changeset`은 lease 토큰을 쓰지 않는다.** 대신 다른 세션이 편집권을 가진 객체가 있으면 거부한다(`editor.ops.ts`).
- **묶음의 changeset**: `apply_changes`의 각 작업은 자기 changeSetId를 갖고, 같은 `batchId`가 `actor`에 기록된다. 묶음을 되돌리려면 changeset을 최신 것부터 차례로 되돌린다.
- **REST 추가**: `GET /api/v1/editor/changes`, `POST /api/v1/editor/changesets/:id/revert`(편집기 패널용), `topology-preview`의 `anchors`. 기존 계약은 그대로다.
- **새 의존성**: `@resvg/resvg-js`(`render_map`의 PNG 변환).
- **MCP 응답 형식**: SDK 기본(`auto`)을 쓴다.

남은 것과 한계:

- before-image가 없는 과거 변경(2026-10-06 이전 저장분)은 `revert_changeset`으로 되돌릴 수 없다(`REVERT_UNSUPPORTED`).
- `move_node`는 이동으로 새로 생긴 교차를 연결하지 않는다. 결과에 `validate_network` 실행을 안내한다.
- `check_reachability`는 시작·끝을 가장 가까운 노드에 맞춘다. 도로 중간 지점에서 출발하는 경우는 다루지 않는다.
- Codex에서의 연결은 확인하지 않았다. Claude Code(데스크톱)에서는 도구 30개가 보이고 호출된다.
- 현재 데이터의 `validate_network` 결과: 도로 4개가 모두 지면에서 5.8~12.4 m 떠 있다(Fusion 높이로 그린 것으로 보인다).

## 층간 연결·중복 판정·색·동선 통로 (2026-10-07)

MCP 사용 중 보고된 "층별 경로 중복 판정 문제"를 반영한 변경이다.

- **중복 판정은 3D로 한다.** 평면 Hausdorff 0.05 m 안의 후보 중, 높이 범위(±0.3 m)와 높이 단면까지 같은 경우만 `DUPLICATE_GEOMETRY`다(역방향 포함, levelId 무관). 같은 계단실의 위·아래 층 계단, 같은 샤프트의 다른 층 엘리베이터 구간은 별개 도로다(`corridor.ts`의 `sameRoad3D`).
- **계단·엘리베이터·경사로(connector)가 층을 잇는다.** (경사로는 지하 차도·주차장 진입로 때문에 2026-10-11 추가. 정의는 `topology.ts`의 `CONNECTOR_STRUCTURES` 한 곳) connector의 끝은 같은 위치(평면 0.15 m, 높이 0.3 m)의 노드를 levelId와 상관없이 재사용하고, 일반 도로도 connector 끝 노드는 다른 층이어도 재사용한다. 일반 도로끼리는 층이 다르면 여전히 연결되지 않는다. 한 층 위에 있는 야외 경사로(오르막 보행로 등)는 끝에서 같은 자리·같은 높이의 노드만 재사용하므로 겹친 층(층 사이 2.7 m 이상)을 잇지 않는다.
- **높이 허용치 (2026-10-11, 규칙 "잰 고저차는 한 층으로 줄이지 않는다").** 값은 `topology.ts`의 `SAME_HEIGHT_M` 0.3 m, `NEAR_HEIGHT_M` 1.25 m 두 개뿐이다.
  - 0.3 m 안: 같은 점. 끝점이 노드를 재사용하고, 교차하는 두 길을 나눠 잇는다(connector든 아니든 같다).
  - 0.3 ~ 1.25 m: 가까운 두 면(계단 4~6단, 길 옆 1 m 낮은 데크). 자동으로 잇지 않고 노드를 따로 만든다. 끝점을 옛 노드 높이로 끌어가지 않는다. `validate_network`가 `NODES_HEIGHT_GAP`(같은 자리 두 노드), `UNCONNECTED_CROSSING` 경고(교차)로 알리고, MCP 저장 결과에 `HEIGHT_GAP_NOT_JOINED` 경고가 붙는다. 겹침·끊긴 끝 경고에는 높이 차를 적는다.
  - 1.25 m 초과: 관계없음(다른 층, 고가).
  - 직접 지시한 연결은 그대로 된다: `{at:{nodeId}}`·`{at:{roadId}}`(그 높이를 그대로 씀), `connect_roads`(1.25 m 안의 길을 평균 높이에서 이음, 0.3 m 넘으면 `HEIGHT_GAP_JOINED` 경고), `merge_nodes`(0.3 m 넘으면 `NODES_TOO_FAR`로 거절하고 차이를 알려 줌. 한 점이 맞으면 `move_node` 먼저). `move_node`는 다른 노드와 0.3 m 안으로 겹칠 때만 `NODE_COLLISION`.
  - 0.3 m인 이유: 계단 두 단보다 작고, 지형 높이로 그은 선이 지형과 벌어질 수 있는 한도(densify 0.3 m)이며, "명확한 고저차" 최소값 0.9 m(`height-difference.ts`)의 1/3(걸음 한 번의 높이 오차)이다. 이미 connector·`merge_nodes`·3D 중복 판정이 쓰던 값이다.
- connector는 `{at:{roadId}}`로 다른 층 도로를 참조할 수 있고(`LEVEL_MISMATCH` 면제), 참조 지점에서만 그 도로를 분할·연결한다. 기하 교차는 같은 층 도로와만 계산한다.
- `create_road` 결과의 `nodeRefs`: `{at:{nodeId}}` 끝점이 실제로 그 노드에 붙었는지. 아니면 `NODE_NOT_REUSED` 경고.
- `merge_nodes`: 같은 위치(평면 0.15 m, 높이 0.3 m)의 두 노드를 하나로 합친다. 층이 다르면 connector 끝에서만 허용. 이전 우회 저장분(층마다 다른 levelId로 따로 생긴 노드)을 잇는 데 쓴다. `validate_network`의 `LEVEL_NODES_NOT_JOINED`가 대상을 찾아 준다. 엘리베이터 양 끝은 `DUPLICATE_NODES`에서 제외했다.
- `move_node`가 엘리베이터 끝을 움직일 때 평면 길이 대신 수직·높이차 조건으로 검사한다(전에는 항상 거부됐다).
- **표시 색 공유**: `road_segments.display_color`(migration 026), `PUT /api/v1/editor/roads/:id/style`, MCP `set_road_style`. lease·revision 없이 바뀌고 changeset으로 기록되어 다른 편집기가 다시 읽으며 `revert_changeset`으로 되돌린다. 분할·병합·저장 때 유지된다. 진행 중인 다른 사람의 초안은 지우지 않는다.
- **동선 → 통로**: `POST /api/v1/editor/corridor-preview`(저장 없음, 편집기가 초안으로 띄움), MCP `create_corridor`(저장). 가장 긴 실행을 기준으로 1 m 간격 단면에서 각 실행의 횡방향 위치 중앙값 = 중앙선, 실행 간 퍼짐의 80% 분위 + 0.8 m = 폭, 높이 = 실행 높이 중앙값 − 폰 높이(기본 1.1 m, 가정값) 또는 지형. 기본 구조는 `indoor_corridor`.
- 편집기 표시: 자동 색은 층별 고정 팔레트(B3 어두운 남색 → 10F 원색 빨강, `floor-colors.ts`)가 기본이고 도로 유형별로 바꿀 수 있다. 층은 levelId에서 읽고, 없으면 지형 위 높이 ÷ 층고(기본 3 m)로 추정해 범례에 "추정"으로 표시한다. 유형은 색 대신 형상으로 구분한다: 횡단보도 지브라 점선, 경사로 긴 점선, 계단 오르막 방향 갈매기표, 인도 밝은 테두리, 실내 통로 사각 튜브(폭 = widthM, 높이 설정값), 엘리베이터 샤프트 상자, 두께 보행 < 혼용 < 차량.
