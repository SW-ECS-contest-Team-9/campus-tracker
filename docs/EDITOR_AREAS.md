# 편집기 공간 영역

로비, 계단 앞 공간, 광장처럼 자유롭게 이동할 수 있는 범위를 도로 중심선과 별도의 다각형으로 저장한다.
기존 `mobility.open_areas`와 DB의 `mobility.edits` 기록/변경 알림을 재사용한다. 새 마이그레이션은 없다(019·020 필요).

## 사용
1. 편집기의 **공간 영역 → 공간 그리기**를 선택한다.
2. 이름·유형·바닥 고도·건물/층을 지정한다. 바닥 고도는 첫 커서 고도를 기본값으로 사용하며 직접 확인한다.
3. 지도 클릭 또는 기존 커서 이동 조작으로 위치를 정하고 Space/커서 점 추가로 경계점을 추가한다.
4. 최소 3개 점을 지정하고 Enter/공간 저장을 누른다. 마지막 점과 첫 점은 자동 연결된다.
5. 목록에서 공간을 선택하면 속성·고도 수정과 경계 다시 그리기가 가능하다. Backspace는 초안 마지막 점을 취소한다.

공간은 평탄한 바닥 면이다. 계단·경사로 자체는 기존 도로 도구로 그린다.
면 저장은 내부 경로 자동 생성·기존 선 제거·층간 연결을 수행하지 않는다.
공간 삭제는 확인 후 영구 삭제되며 mobility.edits에는 이전 값이 남는다. 도로 변경 목록의 되돌리기는 공간에 적용되지 않는다.

## API
모두 기존 editorAuth로 인증한다. 좌표는 EPSG:5186 XY, elevationM은 프로젝트의 절대 바닥 고도다.

| 메서드 | 경로 | 동작 |
|---|---|---|
| GET | /api/v1/editor/areas | 공간과 revision·면적·Polygon 조회 |
| POST | /api/v1/editor/areas | 공간 생성 |
| PUT | /api/v1/editor/areas/:id | expectedRevision과 일치할 때 수정 |
| DELETE | /api/v1/editor/areas/:id | expectedRevision과 일치할 때 삭제 |

입력: name, kind(plaza/courtyard/lobby/parking/other), elevationM, buildingId?, floor?, note?, coordinates(XY 배열).
revision은 DB 행의 xmin 문자열로 조회하며 수정/삭제에 그대로 전달한다. 겹친 편집은 409 AREA_CHANGED로 거부한다.
자기 교차·4㎡ 미만·활성 지형 범위 밖은 400 INVALID_AREA다.
저장 후 기존 Preview 알림과 editor:areas:changed로 다른 편집기의 저장 공간을 갱신한다. 공간 초안은 공유하지 않는다.

## 검증
- npm run typecheck / npm run build
- node --import tsx --test backend/test/editor-area.test.ts
- 격리된 빈 PostGIS DB에 AREA_TEST_DATABASE_URL과 테스트용 JWT_SECRET을 설정하고 editor-area.integration.test.ts 실행.
  테스트는 DB에 지형 fixture 및 019·020을 설치하므로 운영 DB에 실행하지 않는다.

## 중정·구멍 보존
입력에 holes?(내부 링의 XY 배열 목록)를 추가했다. 기존 공간을 편집하면 내부 링을 표시하고 저장 시 유지한다. 경계를 다시 그릴 때 내부 링 제거를 확인한다. 현재 UI에서는 새 구멍을 직접 그리는 기능을 제공하지 않는다.

2026-10-09 검증: 외곽 100㎡에서 구멍 16㎡를 뺀 84㎡가 실제 격리 PostGIS/API에서 확인됐다. 속성 수정 후 두 링 유지와 외곽 밖 구멍 거부도 통과했다. 운영 DB에는 테스트를 실행하지 않았다. 단위 검사는 editor-area.test.ts와 editor-area-holes.test.ts를 함께 실행한다.

## 면을 지나는 길 확인 (2026-10-10)
편집기 MCP `check_reachability`가 공간을 걸을 수 있는 면으로 센다(`backend/src/modules/editor-mcp/area-links.ts`). 저장되는 것은 없고 확인할 때마다 계산한다.
- 접근점: 활성 길이 쓰는 노드 가운데 면 안(또는 경계 0.5 m 안)에 있고 높이가 바닥 고도 ±0.5 m인 것. 층 ID가 있는 공간은 같은 층 ID의 노드만. 바닥 고도가 없는 공간은 건너뛴다.
- 접근점 둘은 면 안에서 가장 짧은 걸음으로 이어진다: 서로 보이면 직선, 아니면 오목한 모서리·구멍 모서리를 돈다. 결과의 roadId는 `area:<공간 id>:<노드>:<노드>`, 보행만 허용(차량·휠체어는 unknown).
- 면 위의 기존 길은 그대로 남는다. 필요 없으면 `retire_feature`로 보관 처리한다(되돌릴 수 있음).
- 하지 않는 것: 화면에 면 연결선 그리기, 면 안에 장애물 자동 인식(구멍으로 직접 그려야 함), 궤적을 면에 맞추기, QA(validate_network) 항목.
- 검증: `node --import tsx --test backend/test/area-links.test.ts` (DB 없이). 실제 DB에서 도구를 호출해 본 적은 없다.
