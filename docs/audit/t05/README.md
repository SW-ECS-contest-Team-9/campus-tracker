# T05 시험용 DB

운영 서버·운영 DB와 무관한 로컬 PostGIS다. 운영 스냅숏(2026-10-09 도로 128개·노드 118개)을 넣고 지형·도로·건물 명령을 실제로 돌려 보는 데 쓴다.
결과와 출력 원문은 볼트 `데이터/보완자료/3d-map-audit-20261009/t05/`, 요약은 볼트 작업로그 `2026-10-10-시험용-DB-검증`.

## 구성
| 항목 | 값 |
|---|---|
| 작업 폴더 | `C:\campus-tracker-testdb` (git worktree, 브랜치 `t05-testdb`) |
| 컨테이너 | `campus-tracker-test-db` (compose 프로젝트 `campus-tracker-test`, 이미지 `imresamu/postgis:16-3.5`) |
| 볼륨 | `campus-tracker-test_pgdata` |
| DB 접속 | `postgresql://campus:campus@127.0.0.1:5544/campus` (이 PC에서만 열림) |
| 설정 파일 | `C:\campus-tracker-testdb\.env` (git에 안 들어감). `PORT=3210`, `HOST=127.0.0.1`, 위 `DATABASE_URL`, 시험용 `JWT_SECRET` |
| 시험용 계정 | 수집자 코드 `T05` (그 밖에 seed의 C01~C05) |

다른 프로젝트의 컨테이너·볼륨(`campus-backend-*`, `campus-tracker-main_campus_pgdata` 등)은 건드리지 않는다.

## 켜기 / 끄기
```sh
cd C:\campus-tracker-testdb
docker compose -p campus-tracker-test -f docs/audit/t05/docker-compose.test.yml up -d --wait   # 켜기
docker compose -p campus-tracker-test -f docs/audit/t05/docker-compose.test.yml stop           # 끄기(자료 유지)
```

## 화면으로 보기
창 두 개에서 실행한다. 운영(3000/5173)과 다른 포트다.
```sh
cd C:\campus-tracker-testdb\backend  && npx tsx src/server.ts                                   # 백엔드 http://127.0.0.1:3210
cd C:\campus-tracker-testdb\frontend && npx vite --port 5273 --strictPort --host 127.0.0.1      # 화면
```
- 지도: http://localhost:5273/
- 편집기: http://localhost:5273/editor.html (계정 `T05` 또는 `C02`)
- 끝나면 두 창에서 Ctrl+C.

## 지금 들어 있는 상태 (2026-10-10)
- 지형: `local-samples-7e415b29668b2f62`(운동장 후보) 활성. `seoul5000-2015-ba7fcb19`(운영과 격자 바이트 동일), `local-samples-f5f1dbc499a3263c`(권장 조합)는 비활성으로 있음.
- 도로: 운영 스냅숏 + 운동장 도로 이동(길 5개·꼭짓점 18개·노드 561a12b4). 변경 묶음 이력 9건.
- 건물: `campus3d-1b0d4590`(보정 적용, 28줄). 비활성으로 `campus3d-ae7db7a7`(운영과 같은 id), `campus3d-0f0b65e0`(옛 지형 + 보정).
- 공간 영역: 운동장 1개(E10 제안, 8,012㎡, 148.9 m). 길 자르기(E10-2)는 시험 뒤 되돌렸다.
- 수집 세션·위치 자료는 없다.

## 처음부터 다시 만들기
```sh
cd C:\campus-tracker-testdb
docker compose -p campus-tracker-test -f docs/audit/t05/docker-compose.test.yml down -v        # 이 프로젝트의 컨테이너·볼륨만 지움
docker compose -p campus-tracker-test -f docs/audit/t05/docker-compose.test.yml up -d --wait
cd backend
npm run db:migrate && npm run db:seed && npm run spatial:import && npm run terrain:import
npm run scene:import -- --dir=<data/scene/source 를 복사한 임시 폴더> --no-overrides          # campus3d-ae7db7a7
npx tsx ../docs/audit/t05/load-network-snapshot.ts <볼트>/claude-live/roads-live-2.json <볼트>/claude-live/nodes-live-2.json
```
그다음 순서는 볼트 작업로그의 검증 표를 따른다.

### 주의: 줄바꿈 (Windows)
이 PC의 git은 `core.autocrlf=true`라서 글자 파일을 CRLF로 꺼낸다. `terrain:import`는 `backend/data/terrain/source` 파일 바이트로, `scene:import`는 보정 파일 바이트로 버전 id를 만들기 때문에 그대로 돌리면 운영과 다른 id가 나온다(지형 `seoul5000-2015-0d3e44c9`). 자료 폴더만 LF로 다시 꺼낸 뒤 돌린다.
```sh
cd C:\campus-tracker-testdb
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
```
merge·checkout으로 `backend/data` 파일이 바뀌면 다시 한다. 저장소에 `.gitattributes`(`backend/data/** -text`)를 두면 필요 없어진다(제안, 미적용).

## 스크립트 (모두 `backend/`에서 실행, 시험용 DB가 아니면 거부)
| 파일 | 하는 일 |
|---|---|
| `docker-compose.test.yml` | 시험용 PostGIS |
| `load-network-snapshot.ts ROADS NODES [--reset]` | 스냅숏 도로·노드 적재 후 전 항목 대조 |
| `dump-network.ts write|compare FILE` | 도로 꼭짓점·노드 좌표 저장 / 이전 저장본과 비교(되돌리기 확인용) |
| `compare-grid.ts VERSION FILE.f32` | 지형 버전 격자와 파일 비교 |
| `mcp-call.ts TOOL [JSON] [--write]` | 편집기 MCP 도구 한 번 호출(백엔드 실행 중일 때) |
| `editor-api.ts METHOD PATH [JSON]` | 편집기 REST 한 번 호출(이력, 변경 묶음 되돌리기, 공간 영역) |
