# 캠퍼스 도로·장소 3D 편집기 설계

작성: 2026-10-06. 상태: 1차 구현 반영. migration 023은 DB에 적용되어 있다(2026-10-06 확인).

## 1. 요구사항과 범위

사용자가 그리는 선은 이동 가능한 도로/통로의 중심선이며, 단순한 도형이 아니다.
보행자 도로, 차량 도로, 보차 혼용 구간을 구분하여 저장하고 독립적인 장소 마커를 작성한다.
기본 작도 UI/UX는 PASCO PADMS-Solid를 우선 참고한다. 사용자 경험에 따라 WASD는 커서 머리 방향 기준 평면 이동,
Q/E는 커서 머리 반시계/시계 회전으로 채택한다. 이전 Q/E 높이 이동 제안은 폐기한다.
기존 Cesium, EPSG:5186, KVD_INCHEON_MSL 정표고, 명시적 저장, Raw 원본 보존 원칙을 유지한다.
초기에는 도로 중심선과 폭을 관리하며 차로별 정밀 지도나 도로 면 편집까지 확장하지 않는다.
여러 작업자의 동시 작업을 초기 요구사항에 포함한다. 최초 초안의 1인 편집/locking 제외 전제는 폐기한다.
초기 협업은 객체별 편집권과 실시간 미리보기로 구현하며 동일 객체의 동시 Vertex 병합은 후속 범위다.

## 2. 도메인

### 도로/통로

새 논리 모델은 RoadSegment. geometry는 LineStringZ(5186), Z는 보행면/노면 정표고다.
식별자, 이름, revision, DRAFT/APPROVED, 생성/수정 시각을 공통으로 가진다.

| 속성 | 의미 |
|---|---|
| roadClass | pedestrian / vehicle / shared |
| structure | ordinary / sidewalk / crossing / stairs / ramp / indoor_corridor |
| pedestrianAccess | allowed / prohibited / unknown |
| vehicleAccess | allowed / prohibited / restricted / unknown |
| pedestrianDirection | both / forward / backward / unknown |
| vehicleDirection | both / forward / backward / unknown |
| widthM | 알려진 폭(m), 미확인은 null |
| wheelchairAccess | allowed / prohibited / unknown |
| buildingId, levelId | 선택적인 건물/층 정보 |
| verticalDatum | KVD_INCHEON_MSL 고정 |

도로 유형과 통행 가능 여부는 구분한다. 차량 도로라는 이유만으로 보행을 금지하거나 허용하지 않는다.
UI는 유형별 프리셋을 제공하고 필요한 속성만 펼쳐 보여준다. restricted의 세부 조건은 초기 메모로 기록하되 라우팅에서 허용으로 간주하지 않는다.
방향은 좌표 배열 순서 기준이다. 선 반전은 형상 순서와 forward/backward를 함께 뒤집어 실제 통행 방향을 보존한다.
유형/통행 조건이 바뀌는 위치에서는 구간을 분할한다. 동일 속성 구간의 병합은 후속 기능으로 둔다.
계단에 차량 허용 같은 모순은 저장 검증 대상으로 삼는다. 접근성 미확인은 허용으로 추정하지 않는다.

### 장소

새 논리 모델은 Place. geometry는 PointZ(5186)이며 수집 세션 없이 존재할 수 있다.
name, category, description, buildingId/levelId, verticalDatum, status, revision을 가진다.
category 예: building_entrance, destination, facility, landmark, parking, bus_stop, other.
장소마다 위치 Z가 의미하는 기준을 일관되게 정의한다(초기: 해당 장소의 바닥/접근 위치).
장소의 표시 위치와 실제 도로 진입 위치가 다를 수 있다. 장기적으로 PlaceAccess로 여러 접근점을 연결한다.
장소를 도로 근처에 배치하는 것만으로 네트워크 연결이 생성되지는 않는다.

### 연결점

Junction/Portal은 장소 POI와 별도 개념이다. 출입구는 장소와 연결점 역할을 동시에 가질 수 있지만
관계로 연결하며, 마커 하나를 배치했다고 도로들을 자동 연결하지 않는다.
기존 portals는 참고 레이어로 사용한다. 사용자 요청에 따라 교차점 자동 연결에 필요한 Node/Edge는 초기 범위에 포함한다.
RoadSegment는 fromNodeId/toNodeId를 가지며, Junction은 PointZ(5186)와 revision을 가진다.
연결된 도로 끝점 XYZ는 해당 Node와 일치해야 한다. 경로 탐색 알고리즘은 후속 단계다.
다른 층이나 높이의 XY 교차는 자동 연결하지 않는다.

## 3. 현재 데이터와의 관계

- canonical_paths/canonical_points: 알고리즘 산출물. 수동 도로로 복사할 수 있지만 원본은 보존한다.
- mobility.corridors: 기존 QGIS 관리 2D 중심선 + 단일 elevation_m. 새 도로 모델과 유사하지만 Vertex별 Z를 표현하지 못한다.
- mobility.portals: 출입구/계단/교차로 연결점. 범용 장소 저장소로 사용하지 않는다.
- event_markers: 수집 세션의 관측 사건이며 세션 삭제 시 함께 삭제된다. 영속적인 Place와 분리한다.

초기 저장소 제안은 mobility.road_segments와 mobility.places 추가이다.
기존 테이블·트리거·API는 그대로 두고 새 테이블 전용 검증, 변경 알림, 변경 이력을 구현한다.
현재 mobility.edits는 integer feature_id를 사용하므로 UUID를 쓰는 새 객체에 기존 트리거를 그대로 연결하지 않는다.
신규 작성 객체의 권위 있는 저장소는 새 테이블 하나로 한정한다. 기존 corridors의 이관은 명시적 복사와 source ID 기록으로 진행한다.
이관된 원본은 읽기 전용/숨김으로 처리하는 운영 규칙을 정하고 자동 양방향 동기화는 만들지 않는다.
지면 기반 2D 선의 이관은 필요한 중간점에서 DEM을 샘플링한다. 끝점만 샘플링하면 중간 지형을 놓칠 수 있다.

## 4. PADMS-Solid 참고 현황

확인된 공개 자료:

- [PASCO 공식 제품 소개](https://www.pasco.co.jp/biz/service/padms/): 점군/사진을 참고하여 3D 공간에서 점을 배치하는 도화 기능.
- [PASCO 발표 자료](https://www.kkr.mlit.go.jp/plan/ippan/kensetsugijutsuten/ol9a8v0000017u2s-att/13-dourokuukan.pdf): 3D/2D 보조 뷰, 종횡단 확인, Keypad 조작 소개(5~6페이지).
- [PADMS Gate](https://user.padms.pasco.jp/): 제품 관련 사용자 포털.
- [사용자가 지정한 공식 제품 페이지](https://user.padms.pasco.jp/en/product-catalog/): PADMS-Solid를 ArcGIS/CAD 연동 MMS 도화 소프트웨어로 소개한다. 이 제품을 조작 비교 대상으로 삼는다.

공개 자료만으로 확인되지 않은 사항: 개별 키 배치, 마우스 버튼/휠 조합, 좌표축 기준,
NumLock 영향, 누름 반복/가속, 점 확정, 선 종료, 취소, 삭제, 카메라 전환의 정확한 동작.
실제 사용 버전의 매뉴얼 또는 시연과 대조하기 전까지 단축키 호환을 주장하지 않는다.

### 사용자 경험으로 확인된 조작 요구사항 (2026-10-06)

공식 키맵 검증과 별개로 다음 사용자 설명을 이 편집기의 설계 기준으로 삼는다.

| 입력 | 동작 |
|---|---|
| W / S | 커서 머리 방향으로 전진 / 후진 |
| A / D | 커서 머리 기준 왼쪽 / 오른쪽으로 평행 이동(설계안) |
| Q | 커서 머리를 반시계방향으로 회전 |
| E | 커서 머리를 시계방향으로 회전 |
| Space | 선 작도 중 현재 유효 커서 위치에 Vertex 추가(사용자 지정) |

커서는 위치 XYZ와 방향 상태를 별도로 가진다. 위치·방향을 화면에 표시하고 이동 Step과 회전 Step을 구분한다.
Q/E는 Z 증감에 배정하지 않는다. 별도 Z 상하 이동을 제공한다. 단축키는 사용자 기억으로 확인되지 않았으므로
우리 앱의 제안으로 R=상승, F=하강을 두고 재지정할 수 있게 한다. Z 직접 입력과 화면의 상하 버튼도 제공한다.
커서 회전으로 기존 도로 Geometry나 통행 방향 속성이 바뀌지는 않는다.
Q/E 회전 후 W의 이동 방향도 회전한 머리 방향으로 바뀐다는 사용자 설명을 반영한다.
초기 설계는 별도 Z 조작과 구분하기 위해 WASD를 수평 XY 이동으로 해석한다. 이는 PADMS의 면 정의를 확인한 사실이 아니라 구현 제안이다.
카메라를 회전하거나 추적하더라도 커서 heading과 이동축은 자동 변경하지 않는다.
heading은 투영 좌표 +Y 기준 시계방향 각도로 정의한다. W 방향=(sin heading, cos heading),
D 방향=(cos heading, -sin heading), S/A는 각각 반대다. Q는 heading 감소, E는 증가다.
이동 Step은 m, 회전 Step은 도이며 화면에 각각 표시한다. 동시 이동키는 정규화하여 대각선 속도가 증가하지 않게 한다.
그 밖의 정확한 키맵은 미확인 상태를 유지한다.

아래는 우리 편집기의 제안 구조이며 PADMS의 검증된 세부 동작 목록이 아니다.

1. 커서 위치, 선택된 Vertex, 카메라 상태를 분리한다.
2. 작도 커서는 XYZ를 가지며 아직 저장되지 않은 다음 점을 표시한다.
3. 마지막 확정점부터 커서까지 임시 선과 거리/고도차를 표시한다.
4. 점 확정, 직전 점 취소, 선 종료, 객체 저장을 서로 다른 명령으로 둔다.
5. 같은 커서를 도로 작도와 장소 마커 배치에서 사용한다.
6. 카메라 이동 중에도 확정점과 편집 커서의 월드 좌표는 불필요하게 바뀌지 않는다.
7. 입력 바인딩과 명령을 분리하여 확인된 PADMS 키맵으로 교체할 수 있게 한다.
8. 입력 필드/IME 조합 중에는 작도 단축키를 차단한다. 브라우저가 가로채는 조합은 대체키를 명시한다.
9. 키패드 유무, macOS/Windows, 포커스 상실, keyup 유실 시 이동 정지를 검증한다.

입력 명령 예: moveCursor, moveCursorZ, rotateCursor, commitVertex, removeLastVertex, finishFeature, cancelOperation,
selectVertex, moveSelectedVertex, setStep, navigateCamera, undo, redo, save.
Space는 선 작도 모드에서만 처리한다. 스냅 후보가 활성화되었으면 후보 위치, 아니면 자유 커서 위치를 사용한다.
keydown의 repeat는 무시하여 한 번 누를 때 한 점만 추가하고, 키를 뗀 뒤 다시 눌러야 다음 점을 추가한다.
입력창/contenteditable/버튼 등 UI 컨트롤에 포커스가 있거나 IME 조합 중이면 가로채지 않는다.
작도 화면에서 처리한 Space만 기본 스크롤을 막는다. 같은 XYZ의 연속 점은 추가하지 않는다.
첫 Space는 시작점, 이후 Space는 다음 선분 확정이다. Space는 선 종료나 DB 저장을 뜻하지 않는다.
WASD/QE/Space 이외의 물리 키와 버튼 매핑은 추가 설명 또는 자료 확인 후 확정한다.

### 교차점 자동 연결 (사용자 요청, 초기 범위에 포함)

기본 ON. Space로 선분을 확정할 때 그 선분 전체와 기존 도로의 교차를 검사한다.
커서가 교차점 위에 정확히 놓이지 않아도, 두 점 사이 선분이 기존 선을 통과하면 연결 후보를 찾는다.
이동 중에는 후보를 미리 표시하고 Space 시 로컬 changeset에 Node 생성/재사용과 도로 분할을 반영한다.
DB 반영은 명시적 저장 시 이루어지며 서버가 최신 Geometry로 다시 판정한다.

- X자 교차: 공유 Node 하나를 만들고 두 도로를 그 지점에서 분할하여 네 개 구간으로 연결한다.
- T자 접속: 끝점의 Node를 재사용하거나 생성하고 상대 도로 내부만 분할한다.
- 끝점끼리 접속: 허용오차 안에서 기존 Node를 재사용하고 중복 Node/영길이 도로를 만들지 않는다.
- 여러 교차점: 원래 선의 진행 순서대로 모두 분할한다. 여러 선이 한 점에서 만나면 같은 Node를 쓴다.
- 자기 교차: 인접 선분의 공통 끝점을 제외하고 같은 규칙을 적용한다. 루프는 허용하되 영길이 edge는 금지한다.
- 일정 구간이 겹치는 선: 단일 교차점으로 처리하지 않고 중복/겹침으로 표시한다. 자동 병합하지 않는다.
- Raw/Fusion 참고 선과 타인의 미저장 초안은 자동 연결 대상이 아니다.

연결은 같은 높이/층의 실제 접속에 한정한다. XY 교차 후보를 구한 뒤 각 원본 선분에서 보간한 Z를 비교한다.
Z 허용오차와 끝점 XY 허용오차는 명시적인 프로젝트 설정으로 두며 초기 수치는 실제 자료로 검증 후 정한다.
다른 층/입체교차 표식이 있으면 높이가 가까워도 자동 연결하지 않는다. 기준 고도나 연결 의미가 불확실하면 후보로 남긴다.
허용오차 내 Z 차이는 기존 Node, 기존 대상 도로의 보간 높이, 신규 도로끼리는 결정적인 순서의 기준 도로 순으로
Node Z를 정한다. 맞춰지는 끝점의 높이 변화는 미리보기에서 표시한다. 범위를 넘는 Z를 자동 평균내어 연결하지 않는다.
PostGIS ST_Intersection의 결과 Z만으로 연결 여부를 판정하지 않는다. 해당 함수는 XY로 계산하며 Z를 복사/평균/보간할 수 있다.
원본 선분별 보간으로 Z와 Vertex/스냅 출처를 보존하고, 수직 선분처럼 XY 길이가 0인 구간은 별도의 명시적 연결로 다룬다.

도로 분할 시 이름/유형/통행 조건/폭/방향은 자식 구간에 상속하고, 원본 ID와 분할 이력을 보관한다.
자식 Geometry는 원본 진행 방향을 유지한다. 부모는 대체된 상태로 기록하고 새 ID 매핑을 클라이언트에 반환한다.
UI는 같은 도로 그룹으로 계속 보여 주어 한 번의 작도로 생성된 여러 구간을 관리할 수 있게 한다.
Node를 공유해도 차량 도로에서 보행 전용 구간으로 차량 통행을 허용하지 않는다. 이동수단별 통행 조건은 그대로 적용한다.

교차 자동 연결은 Node와 관련 도로들을 함께 바꾸는 changeset이다. 현재 구현은
POST /api/v1/editor/road-changesets에 geometry, 각 영향 도로의 revision/lease token, mutationId를 전송한다.
서버가 연결 계획을 검증/계산하고 전체를 한 트랜잭션에 저장하거나 전체 실패시킨다.
편집 초안끼리는 바로 연결한다. APPROVED 도로를 건드리는 초안 changeset은 로컬로 유지하고,
초기에는 그 전체 changeset을 함께 확정하는 경우에만 승인 네트워크에 적용한다. 초안 연결을 일부만 공개하지 않는다.

다른 작업자가 대상 도로를 편집 중이면 교차점을 연결 대기로 표시하며 그 도로를 몰래 분할하지 않는다.
저장 시 모든 영향 객체의 편집권을 확보하고 revision을 재검사한다. 확보 불가 시 초안을 유지하고 연결 저장을 보류한다.
새로 만들어지는 도로끼리의 동시 교차는 객체 잠금만으로 검출할 수 없으므로 초기 서버는 프로젝트별 topology 저장을
짧은 DB 트랜잭션 잠금으로 직렬화하고 잠금 획득 후 교차를 재검색한다. 모든 도로/Node Geometry 쓰기는 이 경로를 따른다.
Node 이동/삭제는 연결된 도로까지 같은 변경 묶음으로 처리하며 고아 참조를 남기지 않는다.
다중 객체 알림에는 changeSetId와 영향 객체/Node 및 삭제·대체 정보를 포함해 클라이언트가 한 번에 반영한다.
저장 전 Undo 한 번으로 Space에 의한 Vertex 추가와 그에 따른 로컬 교차 분할/연결을 함께 되돌린다.
저장 이후 되돌리기는 모든 영향 객체의 revision/편집권을 검증하는 새 changeset으로만 적용한다.

참고: [ST_Intersection](https://postgis.net/docs/ST_Intersection.html), [ST_Split](https://postgis.net/docs/ST_Split.html).

### Fusion 점 스냅 (사용자 요청, 초기 범위에 포함)

- 사용자가 선택하여 표시한 Fusion Run의 점을 스냅 대상으로 선택할 수 있다. 세션/Run별 켜기·끄기를 제공한다.
- 재처리로 바뀔 수 있는 공개 fused_positions보다 runId와 stage가 고정된 fusion_run_positions 스냅샷을 우선 사용한다.
  기존 공개 결과만 있는 경우 미리보기는 가능하지만 근거를 영구 기록할 때는 고정된 스냅샷을 확보한다.
- 기본은 XY 스냅: 수평 위치만 맞추고 현재 커서 Z를 유지한다. 선택 옵션 XYZ 스냅은 절대 정표고 h가 유효한 점에만 적용한다.
  h=null인 점의 zRel이나 렌더링용 지형 fallback을 절대 높이로 저장하지 않는다.
- Fusion 점의 높이는 휴대전화 위치일 수 있다. XYZ 스냅 시 그 높이를 그대로 가져온다는 것을 표시하고,
  노면/바닥 기준 경로로 확정하기 전 높이 보정을 확인한다. 임의의 폰 높이를 조용히 빼지 않는다.
- 후보는 미터 단위 검색 반경과 화면상 거리로 좁히고, 알려진 층/고도 차이가 큰 점은 제외한다.
  고도/층 미확인 후보는 그 상태를 표시한다. 겹친 후보를 순환 선택할 수 있게 한다.
- 자유 커서 좌표와 스냅 후보 좌표를 분리한다. 후보 강조, 연결 가이드, 이동 거리와 고도차를 보여주고
  점 확정 시 후보 좌표를 사용한다. 탐색 기준을 자유 커서에 두어 스냅 점에서 벗어나지 못하는 현상을 방지한다.
- 후보 전환에 히스테리시스를 적용하고 스냅 끄기/일시 해제를 제공한다. 카메라 이동만으로 점이 확정되지는 않는다.
- 저장한 Vertex의 작성 근거는 안정적인 Vertex ID와 runId/stage/seq, 스냅 방식으로 연결한다.
  근거 보존을 위한 Run 삭제/정리 정책도 함께 정한다. 실제 Geometry 좌표는 복사하여 저장하며 원본 점은 수정하지 않는다.
- 도로의 연결 관계를 만드는 Topology Snap과 Fusion 참고점 Snap은 별개 기능이다.

### 카메라 커서 추적 (사용자 요청, 초기 범위에 포함)

- OFF / 위치 따라가기 / 위치+머리 방향 따라가기 옵션을 제안한다. 기본 OFF로 시작하고 사용자 선택을 유지한다.
- 위치 따라가기: 커서를 중심으로 카메라를 이동하되 현재 관찰 방향, 기울기, 거리를 유지한다.
- 위치+방향 따라가기: Q/E 회전에 맞춰 커서에 대한 상대 관찰 각도를 유지한다. 별도 옵션으로 두어 강제 회전을 피한다.
- 카메라는 자유 작도 커서를 추적한다. 스냅 후보의 빈번한 전환에 카메라가 흔들리지 않게 한다.
- 수동 카메라 조작 중 추적을 일시 중지하고 명시적인 재개/커서로 돌아가기 버튼을 제공한다.
- 추적 상태는 Geometry Undo/Redo와 분리한다. 카메라가 커서를 바꾸고 다시 카메라를 움직이는 피드백 루프를 만들지 않는다.

## 5. 화면과 편집 상태

- 도구: 선택 / 보행로 / 차량 도로 / 보차 혼용 / 장소.
- 중앙: 현재 Cesium 캠퍼스 장면, 3D 커서, 임시 선, 확정 형상.
- 속성 패널: 유형, 통행, 방향, 폭, 건물/층, 좌표. 유형별 관련 속성만 노출.
- 상태 표시: 현재 도구, 커서 XYZ, Step, 좌표축 기준, 높이 기준, 미저장 상태.
- 레이어: 도로 유형별, 장소, Raw Track, Fusion Run, 기존 QGIS 이동 공간.
- Top View와 사선 시점으로 시작하고 높이 프로파일/보조 뷰를 후속 추가.

EditorStore에는 road/place를 구분하는 객체 상태와 Geometry/속성 변경을 함께 보관한다.
Undo/Redo는 점 추가/이동뿐 아니라 도로 유형 변경, 통행 설정, 장소 생성/이동/삭제도 포함한다.
커서 이동 자체는 미리보기이고 점 확정 시 Geometry 편집 기록을 만든다.
객체 작성 종료와 DB 저장을 구분하며, 저장 실패 시 초안을 보존한다.

## 6. API와 검증

기존 /api/v1/mobility 조회 응답을 깨지 않도록 새 /api/v1/road-segments, /api/v1/places CRUD를 제안한다.
도로는 XYZ 배열, 장소는 단일 XYZ와 각각의 도메인 속성을 전송한다.
둘 다 srid=5186, verticalDatum, expectedRevision(수정/삭제)을 사용한다.
협업 모드의 수정/삭제에는 서버가 발급한 유효한 편집권 토큰도 필요하며 REST와 Socket 양쪽에서 같은 작업자 권한을 확인한다.
서버는 고정 CRS/수직 기준, 유한 숫자, 캠퍼스 범위, 도로 최소 Vertex 수, 영길이, 속성 모순을 검증한다.
화면 색깔로만 도로 유형을 구별하지 않고 enum 속성으로 실제 저장한다.
확정 경로만 이후 네트워크/Map Matching 입력으로 사용한다.

## 7. 동시 작업

### 기존 구조와 확장

현재 server.ts는 같은 HTTP 서버에 Socket.IO /collector와 /preview를 등록한다.
/preview는 로그인 없는 읽기 전용 브로드캐스트이고, preview.gateway.ts는 DB 커밋 후 알림 패턴을 사용한다.
mobility.listener.ts는 QGIS 저장의 PostgreSQL NOTIFY를 받아 mobility:changed로 전달한다.
이 기반에 인증된 /editor namespace와 캠퍼스 room을 추가한다. 사용자 결정에 따라 기존 트랙커 계정 코드로
기존 POST /api/v1/collectors/login을 호출해 브라우저 기기를 등록하고, 발급된 Collector JWT를 편집 REST와
/editor namespace에서 사용한다. 비밀번호는 추가하지 않는다. 서버는 JWT에서 Collector/device identity를 확인하고
기기 등록 상태를 재검사하며, 클라이언트가 전송한 사용자 ID나 CORS 설정으로 편집 권한을 결정하지 않는다.

### 사용자 경험과 편집권

- 서로 다른 도로/장소는 여러 작업자가 동시에 편집한다.
- 접속자, 이름/색상, 3D 커서와 머리 방향, 선택 객체, 편집 중인 객체를 표시한다.
- 같은 도로/장소는 한 작업 세션만 편집권을 갖는다. 다른 사람은 결과와 임시 형상을 보면서 다른 객체를 편집할 수 있다.
- 같은 사용자의 두 탭도 별도 작업 세션으로 식별한다. socket.id를 영구 작업자 ID로 사용하지 않는다.
- 신규 도로/장소는 client-generated UUID와 draft ID로 구분하여 저장 전 미리보기도 공유한다.
- 실시간 초안은 점선/작성자 표시로 확정 데이터와 구분한다. 기본 스냅 대상이나 라우팅 입력으로 사용하지 않는다.
- 카메라의 커서 따라가기는 각 사용자의 로컬 설정이다. 다른 사용자의 카메라 이동을 강제로 전파하지 않는다.

### 객체별 lease와 저장

편집권은 장시간 DB 트랜잭션이 아닌 만료 가능한 lease로 관리한다.
PostgreSQL lease 테이블의 객체별 고유 키와 원자적 획득/갱신을 사용하고,
ownerId, editorSessionId, leaseToken, expiresAt을 기록한다. 시간 판단은 서버/DB 기준이다.
예시 초기값은 30초 만료, 10초 heartbeat이며 실제 네트워크 환경에 맞춰 조정한다.
재획득 시 새 토큰을 발급하고 오래된 heartbeat/해제/저장이 새 소유자의 편집권에 영향을 주지 못하게 한다.
명시적 편집 종료 시 해제한다. 연결 단절 시 갱신이 멈춰 만료되며 로컬 초안은 보존한다.

저장 트랜잭션에서 lease 행을 잠그고 소유자/토큰/만료를 검증한 후 expectedRevision을 조건으로 형상과 속성을 갱신한다.
lease 재획득도 같은 행을 통해 직렬화하여 검증 이후 소유자가 바뀌는 경쟁을 막는다.
revision을 증가시키고 변경 이력/알림 outbox를 같은 트랜잭션에 기록한다. 삭제도 같은 정책을 적용한다.
revision 불일치는 409, 타인 소유/만료된 편집권은 별도 오류로 응답한다. 자동 덮어쓰기는 하지 않는다.
신규 생성과 재시도에는 mutationId를 사용하고 서버가 처리 결과를 보관해 중복 생성을 방지한다.
분할/병합처럼 여러 객체를 바꾸는 기능은 관련 객체의 편집권을 일정한 순서로 확보하고 단일 트랜잭션으로 적용한다.

### 실시간 데이터와 영속 데이터

| 채널 | 내용 | 정책 |
|---|---|---|
| Socket presence | 접속/퇴장, 커서 XYZ/heading | 빈도 제한, 최신 값 우선, DB에 매 프레임 저장하지 않음 |
| Socket draft | 임시 Geometry/속성 | 소유자 검증, draftSeq 순서 확인, 빈도/크기 제한, 만료 시 제거 |
| Socket lease | 획득/갱신/해제 | ACK와 서버 검증, 소유 상태 알림 |
| REST mutation | 명시적 생성/저장/삭제 | 인증, lease, revision, mutationId, DB 트랜잭션 |
| Socket committed | 저장/삭제된 객체 ID와 revision | 커밋 후 outbox에서 전파, 클라이언트가 정식 데이터 조회 |

예시 이벤트: presence:update, cursor:update, draft:update, lease:acquire/renew/release,
lease:changed, feature:committed, feature:deleted. 명칭은 구현 시 확정한다.
초안 이벤트는 leaseToken/baseRevision/draftSeq를 확인하고 예전 세션에서 지연 도착한 메시지를 버린다.
outbox 전파는 중복될 수 있으므로 eventId와 객체 revision으로 중복/오래된 알림을 무시한다.
삭제 이벤트는 tombstone 정보를 유지하여 지연된 갱신 응답으로 삭제 객체가 다시 나타나지 않게 한다.
QGIS의 기존 mobility 알림은 그대로 유지한다. 새 협업 테이블은 QGIS에서 초기에는 읽기 전용으로 제공하여
편집권과 revision을 우회하는 직접 쓰기를 막는다. QGIS 쓰기 지원은 동일 규칙을 강제할 때 별도로 추가한다.

### 재접속과 Undo/Redo

Socket.IO만으로 연결 중단 시 누락 없는 저장 알림을 보장하지 않는다.
초기에는 reconnect 시 room 구독 및 이벤트 버퍼링을 시작한 뒤 전체 확정 객체/편집권/활성 초안 스냅샷을 다시 받고,
revision과 삭제 정보를 기준으로 버퍼를 적용한다. 삭제 목록/스냅샷 경계를 처리해 재조회 중 변경도 놓치지 않게 한다.
연결 상태 복구는 최적화로만 사용하며 실패 시 전체 동기화가 가능해야 한다.
outbox의 미전달 커밋 이벤트는 서버 재시작 후에도 재전파한다.
연결이 끊기면 협업 저장을 중지하고 로컬 초안을 보존한다. 재접속 후 편집권과 최신 revision을 다시 확인한다.
원본이 변경되었으면 차이 확인 또는 별도 복사로 해결하고 오프라인 명령을 무조건 재생하지 않는다.
Undo/Redo는 본인의 현재 편집 changeset에만 적용한다(교차 분할 등 영향 객체 포함). 원격 변경을 본인 Undo 스택에 넣지 않는다.
저장 후에도 같은 lease/revision 계보에서 Undo를 하면 새 로컬 수정으로 취급하고 명시적으로 다시 저장한다.
편집권을 잃거나 다른 작업자의 변경이 들어오면 기존 Undo를 최신 객체에 적용하지 않고 복구용 초안으로 보존한다.

초기에는 현재 단일 Node 서버를 유지한다. 서버 다중 인스턴스 배포 시 room/접속/초안 브로드캐스트를 위한
공유 adapter와 임시 상태 저장소를 추가해야 한다. DB lease만으로 인스턴스 간 초안 동기화가 해결되지는 않는다.

참고: [Socket.IO 전달 보장](https://socket.io/docs/v4/delivery-guarantees/),
[연결 상태 복구](https://socket.io/docs/v4/connection-state-recovery/).

## 8. 단계와 검증

1. 사용 중인 PADMS-Solid 조작 자료 확인, 명령·키·커서·카메라 행동 대응표 확정.
2. 도로/장소 도메인과 DTO, 작업자 인증/편집권/revision 계약 확정. 기존 도로 데이터와의 이관 경계 확정.
3. 머리 방향 기반 3D 커서, 별도 Z 이동, 임시 선, 점 확정/선 종료, 속성 편집, 장소 배치, 카메라 추적의 소규모 프로토타입.
4. 협업 저장/재조회, 객체별 편집권, 다른 작업자 커서/초안, 재접속 복구, 속성 포함 Undo/Redo, 여러 Raw/Run 참고 레이어, Fusion 점 XY/XYZ 스냅.
5. 초기 필수 기능: Space 점 추가, 교차 Node/Edge 자동 생성·분할, 다중 객체 changeset과 협업 충돌 처리.
6. 후속: PlaceAccess, 공개 버전/초안 분리, 이동수단별 경로 탐색 및 Map Matching.

검증 예: 차량 일방통행/보행 양방향 동시 표현, 미확인 접근성을 허용으로 취급하지 않음,
선 반전 후 실제 통행 방향 보존, 세션 삭제와 Place 수명 분리, 다른 층 교차의 비연결,
도로/장소의 Z 보존, 속성 포함 Undo, 카메라 조작과 점 확정 충돌 방지.
커서 회전 후 전진 방향 일치, 카메라 추적/수동 회전 후 이동축 보존, 스냅 후보에서 자유롭게 이탈,
절대고도 없는 점의 XYZ 스냅 차단, XY 스냅의 Z 유지, 원본 Fusion 좌표 불변도 확인한다.
두 클라이언트의 같은 객체 편집권 경쟁, 서로 다른 객체 동시 저장, lease 만료 후 옛 소유자 저장 거부,
저장 성공/응답 유실 후 중복 재시도, 커밋 후 알림 전 서버 종료, 원격 삭제/재접속,
초안 순서 역전, 타인 변경을 되돌리지 않는 Undo를 통합 검증한다.
Space 자동반복/입력 포커스/중복점 방지, 커서 사이 선분의 X자 교차, T자/끝점/다중/자기 교차,
입체교차 비연결, 겹친 구간 감지, 분할 후 방향/속성/출처 보존, Space 작업 전체 Undo,
다른 작업자 lease 충돌, 동시 생성 도로 교차 재검출, 다중 객체 저장 원자성 및 중복 재시도를 검증한다.

## 9. 1차 구현 현황

- `backend/src/db/migrations/023_network_editor.sql`은 `mobility.road_segments`, `places`, `network_nodes`, lease, mutation idempotency, committed outbox 테이블을 추가한다. 실제 DB 적용은 `npm run db:migrate`가 필요하다.
- 편집 API는 `/api/v1/editor/snapshot`, `/leases`, `/topology-preview`, `/junction-preview`, `/junctions`, `/road-changesets`, `/places`, `/roads/:id`, `/places/:id`다. 저장은 명시적 mutation이며 지형 범위, XYZ, lease, revision을 검증한다.
- 보행/차량/혼용 도로 속성과 PointZ 장소 마커를 저장한다. 승인된 객체를 편집하면 원본을 보존하고 부모 연결이 있는 초안 successor를 만든다. 승인/게시 UI와 권한별 review flow는 아직 없다.
- `/editor` Socket.IO namespace는 Tracker JWT와 브라우저별 editor session을 확인한다. 접속자/커서/머리 방향과 lease가 있는 객체의 임시 초안을 전파하며, draftSeq/크기/빈도를 검증한다. 확정 변경은 PostgreSQL outbox에서 커밋 뒤 전파한다.
- Space는 Vertex를 추가한다. WASD는 머리 방향 기준 수평 이동, Q/E는 반시계/시계 회전, R/F와 XYZ 입력은 높이 이동을 제공한다. 카메라 추적은 끔/위치/위치+방향 모드이며, 별도 옵션으로 지도 드래그의 회전 중심을 현재 커서에 고정할 수 있다. 휠/우클릭 드래그 줌은 피킹한 객체와 관계없이 카메라 높이 또는 커서 거리로 속도를 정한다. R/F는 PADMS 확인 키맵이 아니라 아직 재지정 가능한 제안이다.
- 선택한 Fusion Run의 FINAL 점을 표시한다. Fusion 점과 저장된 도로 Vertex를 각각 스냅 원천으로 켤 수 있으며, 둘 다 켜면 가장 가까운 점을 사용한다. 2.5m 이내에서 XY·Z·XYZ 스냅을 지원하고 락 상태에서는 이동 중 가까운 점으로 대상을 갱신한다. 도로 스냅은 같은 층의 저장된 도로를 대상으로 하며 목표 Vertex를 지도에 표시한다. 저장 시 새 도로와 기존 도로의 Vertex가 일치하면 공통 Node로 연결하고 기존 도로의 중간 Vertex라면 분할한다. Fusion 스냅 출처(runId/seq)를 Vertex 메타데이터로 보존하는 기능은 남아 있다.
- 저장 시 같은 층 ID 및 보간 Z 1.25m 이내의 기존 도로 교차와 새 선의 자기 교차를 Node로 연결하고 영향을 받는 선을 분할한다. 평행·공선 겹침 검출, 임시 교차 미리보기, 접속 허용오차 설정 UI는 남아 있다.
- 저장된 도로를 선택하면 Vertex가 보인다. Vertex 더블클릭은 그 좌표를 첫 점으로 하는 새 도로 초안을 열고 도로 유형과 층을 상속한다. 저장 시 시작 Vertex를 원본 도로와 검증하고, 선이 평행하게 출발해 자동 교차 검출이 되지 않아도 해당 위치를 공통 Node로 연결한다.
- 교차점 도구는 커서 0.75m 안의 같은 층·높이 도로 후보를 보여 준다. 지정 시 영향 도로의 편집권과 revision을 재검사하고 끝점을 공통 노드로 이동하거나 중간 구간을 분할해 연결한다. 후보 및 저장 결과는 명시적 교차점으로 표시한다.
- 현재 Undo/Redo는 작도 Vertex 좌표 기록에 한정된다. 속성, 장소, 저장 후 changeset Undo는 구현 전이다. 재접속 시 단일 서버 메모리에 남은 활성 초안을 다시 받지만 서버 재시작 뒤 임시 초안은 복구하지 않는다. 여러 Raw/Fusion 레이어 동시 표시도 후속이다.
- migration 023은 DB에 적용되어 있다. AI 에이전트용 MCP 연동은 [EDITOR_MCP_PLAN.md](EDITOR_MCP_PLAN.md)를 따른다.
