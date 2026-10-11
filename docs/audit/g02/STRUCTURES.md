# 구조물 파일 형식 (G02 에서 정함, Z02 등 다른 구역도 같은 형식으로 덧붙인다)

원칙(사용자 2026-10-11): 캠퍼스 안은 인공물이다. 지형은 **기본 평면**(평지 또는 한 경사면)만 싣고, 계단·화단·옹벽·참·데크는 그 위에 **상자**로 얹는다. 지형을 깎거나 새겨서 모양을 만들지 않는다.

## 파일
- 자리: `frontend/public/structures/<구역>.geojson` (구역마다 한 파일. 이 구역은 `g02-way.geojson`, 만드는 스크립트 `docs/audit/g02/build_inputs.py`). 손으로 고치지 않고 스크립트로 다시 만든다.
- GeoJSON FeatureCollection, 좌표 EPSG:5186(미터), `crs` 를 적는다. `provenance` 에 만든 스크립트와 기본 평면 파일.
- 파일 하나에 기단(`platform`), 빈 곳(`void`), 얹는 상자(`extrude`)가 함께 들어 있다.

## 기단(땅 덩어리) — `kind: "platform"`
사용자 2026-10-11: "지형이 까다로운 거면 어차피 지하 구조부터 지상까지 전부 기둥·철골·콘크리트·암석인 거, 구조물을 추가해서 다뤄." 캠퍼스 안의 땅은 그 자체를 구조물로 적는다. 기단이 먼저이고, 계단·화단·현관·데크는 기단 위에 얹는다.

| 속성 | 뜻 |
|---|---|
| `id`, `type: "platform"`, `kind: "platform"` | 기단 하나. 도형은 평면 외곽 `Polygon` |
| `topM` | 윗면이 평평할 때의 높이(m) |
| `topProfile` | 윗면이 한 방향으로 기울 때: `{origin:[x,y], direction:[dx,dy], points:[[거리, 높이], …]}`. 높이 = 그 점을 `direction` 축에 내린 거리에서의 값(사이는 직선, 폭 방향으로 평평, 양 끝 밖은 끝 값). `topM` 과 둘 중 하나만 |
| `bottomM`, `bottomNote` | 옆면을 내릴 바닥 높이와 그 까닭(아래 기단의 윗면, 지하층 천장, 옛 지형보다 아래의 안전 깊이) |
| `material` | `paving` / `concrete` / `rock` / `timber` / `planting`(화단 띠·나무 덮인 비탈: 윗면만 초록, 옆면은 벽 색. Z05) |
| `surfaceName` | 지형 조리법 surface 입력에서 같은 평면의 `name` (지형 칸은 여기서 나온다) |
| `grade`, `estimated`, `assumption`, `source` | 상자와 같다 |

- **지형 칸은 기단에서 만든다.** `docs/audit/g02/build_inputs.py` 가 같은 정의로 구조물 파일의 기단과 조리법 입력 `g02-surface.geojson` 을 함께 쓴다. 조리법의 `surface` 단계는 칸 가운데가 기단 외곽 안이면 그 칸을 기단 윗면 높이로 둔다(번짐 없음, 건물 칸은 그대로, 겹치면 뒤의 기단). `preview.py` 가 둘이 같은지 확인한다. 지형을 따로 손보지 않는다.
- **빈 곳** `kind: "void"`(`type: "void"`): 기단 안에 비워 둘 공간(지하 차도 등). 평면 외곽 + `fromM`(바닥) ~ `toM`(천장) + `inside`(어느 기단 안인지). 지형 칸에는 영향이 없다(위 기단의 윗면이 그대로 지표다).

## 피처 하나 = 상자 하나
도형은 평면 외곽 `Polygon`(z 없음). 높이는 속성으로 준다. 프런트의 보정 레이어(`scene-local-corrections.ts`)가 이미 읽는 모양(kind=extrude)을 그대로 쓴다.

| 속성 | 뜻 |
|---|---|
| `id` | 파일 안에서 하나뿐인 이름. 구역 머리말로 시작(`G02-…`, `Z02-…`) |
| `kind` | `extrude` (외곽을 `fromM` 에서 `toM` 까지 세운 상자). 기단·빈 곳은 위 절 |
| `type` | 요소 종류: `stair_step`(계단 한 단 또는 디딤판), `landing`(참·바닥), `planter`(화단 상자), `wall`(옹벽·난간·기둥처럼 얇고 높은 상자), `deck`(뜬 판), `canopy`(차양·지붕 덩어리), `barrier`(차단기) |
| `fromM`, `toM` | 상자 아래·위 높이(m). `fromM` 은 그 자리 기본 평면 높이 이하로 내려도 되지만(틈 막기) 윗면 `toM` 이 형상을 정한다. `toM > fromM` |
| `basePlane` | 얹힌 기본 평면의 이름(조리법 surface 피처의 `name`, 또는 `plaza 130.6` 같은 평탄면, 다른 상자의 `id`). 뜬 판은 `없음(…)` |
| `stair` | (계단 단만) 같은 계단에 속한 단들을 묶는 이름. 단은 아래에서 위로 `…-S01, S02 …` |
| `riseM`, `runM`, `widthM` | (계단 단만, 있으면) 한 단 높이, 디딤 깊이, 폭. 단 수 = 같은 `stair` 의 피처 수. 오르는 방향 = 단 번호가 커지는 쪽(외곽 중심이 옮겨 가는 쪽) |
| `grade` | `확정`(사용자) / `S-MAP` / `추정`. 섞이면 `확정(위치), 추정(크기)` 처럼 적는다 |
| `estimated` | 치수에 추정이 하나라도 있으면 `true` (프런트 보정 레이어의 '추정' 묶음 조건) |
| `assumption` | 무엇을 어떻게 가정했는지 한 줄(추정이면 반드시) |
| `source` | 근거: 사진·영상(시각)·그림·S-MAP 파일·시험용 DB 길 id |

경사진 윗면(길을 따라 오르는 옹벽 등)은 2 m 마디로 잘라 마디마다 평평한 윗면을 준다. 계단은 단마다 상자 하나다(윗면 = 그 단의 디딤 높이, 아래는 계단 발치 높이까지).

## 프런트가 할 일 (아직 안 됨)
0. `kind=platform`: 윗면(평평하거나 `topProfile` 대로 기운 면)을 재질 색으로 그리고, 외곽을 따라 `bottomM` 까지 세로 옆면을 그린다. 기단 외곽 안의 지형은 숨긴다(지금 길 면 안의 지형을 숨기는 것과 같은 방식). 이렇게 하면 평면 사이가 2 m 폭 비탈이 아니라 벽면이 되고, 치마가 뜨거나 골이 생길 수 없다. `kind=void` 는 단면도에서만 빈 곳으로 보이면 된다. 길 찾기는 그대로 길·영역을 쓴다.
1. `frontend/public/structures/*.geojson` 을 읽어 `kind=extrude` 상자를 그린다. 지금 있는 보정 레이어 코드(`scene-local-corrections.ts` 의 extrude 그리기)를 그대로 쓸 수 있다: 파일 목록에 이 경로를 넣고, 기본으로 켜고, `type` 별 색(돌계단·화강석 화단·흰 옹벽·나무 데크)을 정한다.
2. 합친 길 면(`road-surface-layer.ts`)이 계단 상자 위를 덮지 않게, `stair_step`·`landing` 평면 안에서는 길 면을 상자 윗면 높이로 올리거나 그리지 않는다.
3. 단면도(`section-layer.ts`)에 `addLayer()` 로 넣어 같이 잘리게 한다.
4. 지형 격자는 2 m 라 평면 사이 벽면이 2 m 폭 비탈로 그려진다. 벽면을 세로로 세우려면 조리법 surface 피처의 외곽선에서 양쪽 평면 높이를 읽어 세로 면을 그린다(`g02-surface.geojson` 의 다각형과 `heightM`/`profile` 로 계산 가능).

## Z05 에서 더한 것
- 기단은 손으로 정한 곧은 변의 큰 평면으로 적는다(`docs/audit/z05/build_inputs.py`). 가파른 곳을 높이 띠로 나눈 단을 만들지 않는다: 두 평면은 벽면 하나로 만난다.
- 구조물 파일의 기단 외곽은 더 높은 이웃 밑으로 0.5 m 들어가 있다(벽면에 틈이 없게). 지형 조리법 입력(`z05-surface.geojson`)은 겹치지 않는 외곽이다.
- 상자의 `material` 이 `concrete`·`opening` 이면 종류 색 대신 그 색으로 그린다(`opening` = 벽면의 뚫린 곳을 나타내는 어두운 판. 안쪽 빈 곳은 아니다).

## Z06 에서 더한 것
- 기단 `material: asphalt` = 캠퍼스 밖 공도. 윗면은 차도 색, 옆면은 벽 색.
- 상자의 `material` 은 종류 색보다 먼저다: `brick`, `glass`, `stone`, `white_stone`, `roof_tile`, `roof_red`, `red_railing`, `timber`, `water`, `fence`, `trunk`, `foliage`, `concrete`, `opening`(색은 `frontend/src/structures.ts` 의 `boxMaterials`).
- `type: tree` = 단순한 나무(줄기 상자 + 잎 상자 둘). `frontend/public/structures/z06-trees.geojson`, 만드는 스크립트 `docs/audit/z06/trees.py`. 사진에 나무 줄이 있는 화단에만 두고, 자리는 화단 상자의 긴 축을 고르게 나눈 것이다(추정).
- 캠퍼스 밖으로 나간 기단도 지형을 숨기는 구역에 넣는다: 기단 바깥 가장자리가 지형 칸을 따라 톱니로 보이지 않고 곧은 선이 된다(`structures-layer.ts`).
- 청운관·혜인관·서문 상자는 `docs/audit/z05/boxes_z06.py` 가 Z05 상자를 걷고 다시 만든다(id 머리말 `Z06-`, 파일 이름은 그대로 `z05-*.geojson`).

## Z07 에서 더한 것
- 상자는 제 색을 가질 수 있다: `color`(옆면·윗면), `topColor`(윗면만), 둘 다 `#rrggbb` 소문자. 있으면 `material`·종류 색보다 먼저다. 기단에는 쓰지 않는다.
- `frontend/public/structures/z07-building-parts.geojson`(만드는 스크립트 `docs/audit/z07/build_parts.py`): 건물에 붙는 덩어리 가운데 높이·외곽이 추정이라 건물 보정 파일에 못 넣는 것(유담관 둥근 기단부의 창 띠·옥상 정원, 굽은 낮은 날개의 바깥벽과 창, 문예관 저층부의 나머지·열린 기둥 층·옥상 테두리).
- 본관–한림관 틈(`docs/audit/z05/boxes_z07.py`, 파일은 `z05-upper-branch.geojson`): 덮인 보행 복도 = 마디마다 밑단·바닥(`landing`) + 옆벽 둘(`wall`) + 덮개(`canopy`). 내리막길 기단 밑 구간은 `void`(inside = `G02-PLATFORM-WAY`). 틈 바닥 기단은 그대로 둔다.
- 갈무리 스크립트 `docs/audit/z05/shots.mjs`: 시점에 `section: {a, b, flip?, ortho?, zoom?: {widthM, centerM}}` 을 주면 그 선으로 단면을 켜고 찍는다. `SHOT_URL` 로 다른 포트의 화면을 찍을 수 있다.

## Z09 에서 더한 것
- 기운 판: 상자에 `topProfile` 과 `thicknessM` 을 함께 주면 밑면이 윗면과 나란한 판이 된다(덮인 복도의 덮개: 바닥과 나란한 한 경사 판). 옆벽은 `topProfile` + `bottomM`.
- 포장 무늬: `material: paving` 인 기단의 윗면은 길·영역이 칠하지 않는 곳도 블록 줄눈 무늬로 그린다(보행 우선 길과 같은 무늬).
- 중립 바닥이 두 높이 사이를 가파르게(약 55도 넘게) 잇는 조각은 바닥 색이 아니라 옹벽 색으로 그린다(벽과 기단 사이의 얇은 틈이 흰 조각으로 보이지 않게).
- 이음 표본 `backend/data/terrain/samples/z09_edge_blend_5186.json`(만드는 스크립트 `docs/audit/z09/blend.py`, `z05/write_out.py` 가 부른다): 캠퍼스 밖으로 나간 기단의 바깥 변에서 지형이 기단 윗면과 턱 없이 만나게 하는 추정 표본. 잰 값이 아니다.
- `frontend/public/structures/z09-parts.geojson`(만드는 스크립트 `docs/audit/z09/build_parts.py`): 뒤편 숲 비탈의 듬성듬성한 나무, 문예관 3층 로비 입구의 차양과 문 면.
- 건물 겉모습(동 노트 `겉모습`, 양식은 `docs/audit/registry/appearance.py`): 창 모양 `작은 아치`·`기둥 발코니`, 지붕 `겹: 2`, `밑동`.

## Z10 에서 더한 것
- `frontend/public/structures/z10-parts.geojson`(만드는 스크립트 `docs/audit/z10/build_parts.py`): 사진에 있는 덧붙은 덩어리. 둥근 아치(네모난 뚫린 곳의 윗모서리를 계단 모양 조각 `…-ARCHn-Lk/Rk` 로 채운다: 형식에 굽은 면이 없어서), 북악관 서쪽 옆길의 자연석 쌓기·생울타리·풀밭·GS25 문과 차양, 북악관 정면 화단, 서문 위·굽이 섬의 소나무, 외국인 생활관의 유리 띠·문·지붕 상자·지붕창, 공연실습소의 간판 면·탑·옥상 틀, 한림관 1층 차양.
- 기단 정의에 `terrainCut`(build_inputs.py 의 S(...)): 그 도형 안과 둘레 1 m 는 지형 입력에서 뺀다(캠퍼스 지도에 없는 추가 건물 밑의 지형 칸을 지키려고. 구조물 파일의 기단 외곽은 벽까지 그대로). 그런 기단 안의 S-MAP 표본은 빼지 않는다.
- 건물 겉모습: 모임지붕에 `테두리` 색이 있으면 처마를 그 색으로 그린다.

## Z11 에서 더한 것
- `frontend/public/structures/z11-parts.geojson`(만드는 스크립트 `docs/audit/z11/build_parts.py`): 유담관 공도 쪽 기단 벽. 건물 자료의 외곽이 톱니일 때 그 바깥에 굽은 벽 한 면(꺾은선의 모서리를 호로 둥글린 선)을 세우고, 벽과 건물 사이를 기단 윗면까지 채운 덩어리 하나 + 창 줄 띠 상자 + 난간벽. 건물 외곽은 건드리지 않는다.
- 상자의 도형은 구멍이 있어도 된다(`Polygon` 의 안쪽 고리).
- 표시 규칙(`campus-ground.ts`): 건물 벽과 기단 사이 5 cm 틈의 안쪽 점도 바로 옆(0.15 m 안) 기단·길 면의 높이를 받는다. 전에는 그 점이 건물 칸과 섞인 높이를 받아 틈이 벽을 타고 선 세모 조각(톱니)으로 그려졌다.
- 건물 겉모습의 창 크기(동 노트 `겉모습.창` 의 `폭`·`높이`·`간격`·`창턱`·`쌍`, 띠창의 `덧색`): 양식은 `docs/audit/registry/appearance.py`.


## U01 에서 더한 것
- `frontend/public/structures/u01-field-basement.geojson`(만드는 스크립트 `docs/audit/u01/build_parts.py`): 운동장 슬래브 기단 안의 지하 1층·지하 2층. 층은 빈 곳 두 개이고, 그 사이에 남는 기단 덩어리가 바닥 판·둘레 벽·운동장 슬래브다(따로 상자를 만들지 않는다).
- 빈 곳의 `inside` 를 적지 않으면 평면이 겹치는 모든 기단의 자른 면에서 비운다(운동장 슬래브, 정면 바닥, 내리막길 기단에 걸친 빈 곳).
- 빈 곳의 `name`: 단면의 이름표에 `빈 곳` 대신 쓴다(`운동장 지하 1층 145.3–148.2 m`). 이름표는 이름마다 15 m 에 하나라 위아래로 겹친 층이 각각 적힌다.
- `type: ramp` = 차 경사로 판(`topProfile` + `bottomM`). 계단·참이 아니라서 위의 길·영역 면을 가리지 않는다. 지하의 상자에는 `stair_step`·`landing` 을 쓰지 않는다(그 평면 안의 운동장 면이 지워진다).
- 운동장 슬래브 기단(`Z02-PLATFORM-FIELD`)의 `bottomM` 을 지하 2층 아래 기초 판까지 내렸다(141.0 → 140.7). 윗면과 지형 입력은 그대로다.
- 상자의 `inVoid: true`: 빈 곳 안에 선 상자(기둥, 경사로 판). 단면에서 빈 곳의 면보다 앞에 그린다(없으면 빈 곳의 면에 가려 안 보인다).
- 지하 차도 연장의 빈 곳은 1 m 마디다: 빈 곳은 바닥이 평평한 상자뿐이라 잘게 나눠야 단면에서 한 경사로 보인다(마디 사이 턱 0.1 m 는 계단이 아니다).

## U02 에서 바꾼 것
- `u01-field-basement.geojson` 은 이제 `docs/audit/u02/build_parts.py` 가 쓴다(파일 이름만 U01, 안의 id 는 `U02-…`). 높이는 사용자 단면 표시(지하 1층 141.4~144.4, 지하 2층 133.0~140.4 m), 평면은 학교 지하도 지도를 좌표에 맞춘 것(`docs/audit/u02/georef.py`, 잔차 RMS 3.3 m).
- 굽은 경사로: 형식에 굽은 기운 면이 없어 부채꼴 조각 12개(`U02-RAMP-CURVE-nn`, 조각마다 제 방향의 `topProfile`)로 나눈다. 조각 사이 높이는 1 cm 안에서 이어진다.
- 낮은 끝이 `bottomM` 과 같은 경사 판은 읽히지 않는다(윗면이 바닥보다 높아야 한다): 낮은 끝을 바닥 + 0.02 m 로 둔다.
- 빈 곳 안의 표시용 상자(`inVoid: true`, `type: wall`): 기둥 색 띠, 주차 줄 선(두께 3 cm), 섬 벽. 계단·참 종류는 쓰지 않는다(U01 절과 같은 까닭).
- 운동장 슬래브 기단의 `bottomM` 132.0(지하 2층 133.0 아래 기초 판).

## U03 에서 더한 것
- `frontend/public/structures/u03-underground-walk.geojson`(만드는 스크립트 `docs/audit/u03/build.py`): 학교 지하도 걷는 길의 구조물. 파란 둥근 지붕 연결통로 둘(낮은 흰 벽·파란 띠·아치 갈비는 계단 모양 조각, 지붕은 띠 7개), 본관 2층 유리문과 단, 본관–유담관 지하통로(1 m 마디 빈 곳), 본관 정류장 쪽 기둥 열(여덟 모 기둥 5·보·처마).
- 본관–한림관 통로의 바닥은 있던 판(`G02-DECK-MAIN-HANLIM`)을 그대로 쓰고, 남쪽 흰 벽이 Z07 의 나무 난간 상자를 감싼다(그 상자는 지우지 않았다).

## U04 에서 더한 것
- `frontend/public/structures/u04-parking.geojson`(만드는 스크립트 `docs/audit/u04/build.py`, 주차 칸 읽기 `digitise.py`): 운동장 지하 1층·2층 바닥의 주차 칸 묶음(`U04-STALLS-B1-Snn`, 두께 2 cm 판)과 칸 선(`U04-BAYLINE-B1-Snn`, 두께 4 cm. 묶음 외곽 + 칸 사이 + 두 줄 묶음의 가운데 선을 구멍 있는 도형 하나로). 주차 칸은 길이 아니다.
- 통로(차와 사람이 다니는 곳)는 구조물이 아니라 공간 영역이다: 이름에 `지하`가 있고 바닥 고도가 있으며 건물·층이 없는 영역 = 지하 면. 지하 길 색(차도 검정)으로 그 높이에 그리고 `지하 길` 체크를 따른다(`road-surface-layer.ts` 의 `undergroundAreas`). 지상 면(운동장·포장면)과 합치지 않는다. 단면에서는 바닥 높이의 굵은 검은 선이고 주차 칸 묶음 자리는 끊긴다.
- 상자의 `underground: true`: 지하 길을 켜면 땅과 기단을 비쳐 보이게 제 색으로 한 번 더 그린다(길 면 레이어가 그린다). 비쳐 보이는 것끼리는 깊이로 가려지지 않아 그리는 차례가 위아래다: 차도(층 사이 경사로 포함) → 지하 면과 표시 상자를 낮은 층부터 → 보행 길. 끄면 다른 상자와 같다(기단 안이라 안 보인다).
- `u01-field-basement.geojson`(U02 스크립트): `docs/audit/u04/stalls.json` 이 있으면 기둥은 두 층 모두 주차 칸 묶음 안인 격자점에만 세운다(82 → 48개. 통로에는 기둥이 없다). 줄 가운데 선 `U02-BAYLINE-…` 은 없앴다(칸 선이 대신한다).

## B13 에서 더한 것
- `frontend/public/structures/b13-hyein.geojson`(만드는 스크립트 `docs/audit/b13/build_parts.py`, 좌표계 `frame.py`): 혜인관 운동장 쪽 출입부(벽돌 현관, 양쪽 계단, 세로 살 가림벽, 전광판), 옥상 전원 버튼 원판, 화단 나무, 북동 옆면의 작은 아치 현관·쉼터·콘크리트 어귀·화단. `z05-hyein.geojson` 의 `Z06-HYEIN-PORCH-*` 와 `z10-parts.geojson` 의 혜인관 아치는 없어졌다.
- 세로 면의 둥근 판: 형식에 세로 원이 없어 폭 방향 조각(`…-01, 02 …`, 조각마다 위아래 높이가 원을 따른다)으로 나눈다.
- 비쳐 보이는 벽: 살(폭 0.27 m 상자)을 0.45 m 간격으로 세운다(반투명 재질은 없다).
