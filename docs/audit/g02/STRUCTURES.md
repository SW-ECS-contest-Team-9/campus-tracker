# 구조물 파일 형식 (G02 에서 정함, Z02 등 다른 구역도 같은 형식으로 덧붙인다)

원칙(사용자 2026-10-11): 캠퍼스 안은 인공물이다. 지형은 **기본 평면**(평지 또는 한 경사면)만 싣고, 계단·화단·옹벽·참·데크는 그 위에 **상자**로 얹는다. 지형을 깎거나 새겨서 모양을 만들지 않는다.

## 파일
- 자리: `frontend/public/structures/<구역>.geojson` (구역마다 한 파일. 이 구역은 `g02-way.geojson`, 만드는 스크립트 `docs/audit/g02/build_inputs.py`). 손으로 고치지 않고 스크립트로 다시 만든다.
- GeoJSON FeatureCollection, 좌표 EPSG:5186(미터), `crs` 를 적는다. `provenance` 에 만든 스크립트와 기본 평면 파일.
- 기본 평면은 지형 조리법의 surface 단계 입력(`backend/data/terrain/recipes/g02-surface.geojson`)에 있다. 구조물 파일에는 넣지 않는다.

## 피처 하나 = 상자 하나
도형은 평면 외곽 `Polygon`(z 없음). 높이는 속성으로 준다. 프런트의 보정 레이어(`scene-local-corrections.ts`)가 이미 읽는 모양(kind=extrude)을 그대로 쓴다.

| 속성 | 뜻 |
|---|---|
| `id` | 파일 안에서 하나뿐인 이름. 구역 머리말로 시작(`G02-…`, `Z02-…`) |
| `kind` | 항상 `extrude` (외곽을 `fromM` 에서 `toM` 까지 세운 상자) |
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
1. `frontend/public/structures/*.geojson` 을 읽어 `kind=extrude` 상자를 그린다. 지금 있는 보정 레이어 코드(`scene-local-corrections.ts` 의 extrude 그리기)를 그대로 쓸 수 있다: 파일 목록에 이 경로를 넣고, 기본으로 켜고, `type` 별 색(돌계단·화강석 화단·흰 옹벽·나무 데크)을 정한다.
2. 합친 길 면(`road-surface-layer.ts`)이 계단 상자 위를 덮지 않게, `stair_step`·`landing` 평면 안에서는 길 면을 상자 윗면 높이로 올리거나 그리지 않는다.
3. 단면도(`section-layer.ts`)에 `addLayer()` 로 넣어 같이 잘리게 한다.
4. 지형 격자는 2 m 라 평면 사이 벽면이 2 m 폭 비탈로 그려진다. 벽면을 세로로 세우려면 조리법 surface 피처의 외곽선에서 양쪽 평면 높이를 읽어 세로 면을 그린다(`g02-surface.geojson` 의 다각형과 `heightM`/`profile` 로 계산 가능).
