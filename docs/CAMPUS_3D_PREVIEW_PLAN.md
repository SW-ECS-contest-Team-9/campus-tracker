# 캠퍼스 단순 3D 모델로 프리뷰 지도 교체 계획

작성일: 2026-10-04
상태: **1~3단계 구현 완료(2026-10-04), 서버 DEM 기준.** 기본 프리뷰 지도가 캠퍼스 3D 모델로 바뀌었고, `VITE_MAP_ENGINE=vworld`로 예전 지도로 돌아갈 수 있다. 4단계(VWorld 완전 제거)는 결정 대기.

### 구현 결과

| 항목 | 결과 |
|---|---|
| 가져오기 | `npm run scene:import`(`node:sqlite`로 GeoPackage를 직접 읽음), 마이그레이션 017. 활성 장면 `campus3d-ae7db7a7`. 건물 12개 모두 퓨전 캠퍼스 건물과 IoU 1.00 |
| 높이 재계산 | 서버 DEM 위의 지붕은 GeoPackage 값 대비 −3.8~+1.4 m(북악관 −3.77, 유담관 −3.57, 문예관 +1.36). 수인관은 서버 DEM에서도 지붕을 최고점 + 3 m로 올림 |
| 지형 일치 | 화면 지면 높이 − 서버 terrainHeight: 51개 지점 중앙값 −0.001 m, 최대 0.47 m(메시 보간) |
| 실내 | fbaa781d 북악관 실내 점 177개가 모두 건물 박스 안(기초 128.4 ~ 지붕 161.7 m). 최고 높이 = 출입층 + 2층(현장 보정과 일치) |
| 실외 | 지면 위 높이는 서버 값과 같다(중앙값 3.5 m). 도로 접촉 구간은 0.5~1 m, 북악관 출입구 테라스는 2~4 m. 이는 화면 문제가 아니라 2015 DEM과 현재 지형의 차이다 |
| 외부 요청 | 없음(Cesium 자원은 `/cesium/`로 직접 서빙, Ion 미사용) |
| 화면 | 음영기복(경사 꺾임이 계단처럼 보이지 않도록 음영 계산에만 평활 사용), 캠퍼스 아이보리, 지붕·모서리 선, 이름, X-ray, 추정 높이 색, 건물 클릭 상세, Historical·Lab 정상 |
| 테스트 | 97개 통과(+ GeoPackage 해석, 블록 높이) |
| QGIS 일치 (2026-10-04) | QGIS 3D에서 궤적이 높게 보인 원인은 두 가지였다. 원래 테이블 geom Z가 타원체고(+23.4 m)였고, 프로젝트가 Codex DEM·건물 높이를 썼다. 해결: 마이그레이션 018(스키마 `qgis` 뷰, Z = 해발고, 웹과 같은 규칙), `npm run qgis:sync`(프로젝트 DEM을 서버 DEM GeoTIFF로, 건물 기초·지붕을 활성 장면 값으로. 원본은 `*.codex.*`), `backend/scripts/qgis/add_tracking_layers.py`(고도 Absolute 3D 레이어). 내보낸 GeoTIFF와 서버 격자는 모든 셀에서 0.0005 m 이내로 같다 |
대상 자료: `/Users/hoshi/Desktop/skuniv_shp/campus_3d/` (Codex가 QGIS 3.44로 만든 러프 3D)

## 0. 요약

- **권장 구성:** VWorld 대신 CesiumJS를 프로젝트에 직접 넣는다(npm `cesium`). 지형은 서버 DEM으로 만들고, Codex 모델의 건물 12개를 박스(돌출 다각형)로 그린다. 배경 지도 타일은 쓰지 않는다.
- **지금 코드를 거의 그대로 쓸 수 있다:**
  - 프리뷰와 Lab의 궤적·마커·Lab 그리기 코드는 이미 Cesium API로 짜여 있다. VWorld도 내부적으로 Cesium 1.99를 쓴다.
  - 지도 엔진을 띄우는 부분(`vworld.ts`)만 바꾸면 된다.
  - 높이 규칙(장면 높이 = 해발 정표고)도 Codex 모델과 같다.
- **DEM은 하나만 써야 한다.** 자료를 확인해 보니 Codex의 `terrain_dem_2m.tif`는 서버 DEM과 다른 방법으로 만든 별도 DEM이다(1절). 이를 그대로 쓰면 fusion-v4 궤적이 북악관 주변에서 지면보다 약 4 m 아래로 그려진다. 그래서 **지형은 서버 DEM으로 그리고, 건물의 기초·지붕 높이는 Codex의 건물 높이(height_m)를 서버 DEM 위에 다시 계산**한다.
- **편집 흐름:** QGIS 프로젝트(`campus.gpkg`)를 편집 원본으로 유지한다. QGIS에서 고친 뒤 `npm run scene:import`를 실행하면 새 버전으로 프리뷰에 반영된다.
- **장점:**
  - VWorld API 키와 인터넷 연결이 필요 없다(현장 LAN만으로 동작).
  - 나중에 실내 LiDAR 촬영본을 같은 뷰어에 3D Tiles(점군·메시)로 얹을 수 있다.

## 1. 자료 진단

| 항목 | 내용 |
|---|---|
| `campus.gpkg` | EPSG:5186. 레이어 `buildings_3d`(12개), `source_buildings`, `campus_boundary`, `contours` |
| 건물 속성 | `name`, `source_fid`, `height_m`, `height_source`(REGISTER 6개 / ESTIMATE 6개), `register_id`, `ground_floors`, `base_m`, `roof_m`(절대 정표고), `note` |
| 건물 외곽선 | 원본 `building.shp`의 SHA-256이 서버 `backend/data/campus-map/source/building.shp`와 같다. 즉 퓨전이 쓰는 캠퍼스 건물(건물 태그, 실내 계단 앵커)과 도형이 정확히 같다 |
| 높이 규칙 | 기초 = 외곽 DEM 최저 − 1 m, 지붕 = DEM 중앙값 + height_m, 지붕은 DEM 최고 + 3 m 이상. 높이는 정표고로 지오이드를 더하지 않았다(서버·프리뷰와 같은 기준) |
| `terrain_dem_2m.tif` | 등고선과 표고점을 선형 삼각망으로 보간. 범위는 캠퍼스 + 90 m(480 × 508 m, 240 × 254 격자) |
| 서버 DEM | `seoul5000-2015-ba7fcb19`. 거리 보간에 표고점 2단계 보정, 900 × 928 m. fusion-v4의 지면 접촉 영점과 북악관 층 보정(출입층 바닥 135.65 m)이 이 DEM 기준이다 |
| **두 DEM 차이(Codex − 서버)** | 겹치는 15,240점 기준 중앙값 +0.95 m, 10–90% 범위 −1.75~+4.47 m, 절대값 99% 7.7 m, 최대 18.9 m. 건물 외곽 중앙값: 북악관 +4.07, 유담관 +4.45(최대 16.7), 본관 +2.84, 수인관 +3.45(최대 13.1), 공연실습소 −0.18, 문예관 +0.17 m |
| 미리보기 | 건물은 흰 박스, 지형은 연두색, 캠퍼스 안은 아이보리. 삼각망 꺾임 때문에 경사면에 톱니 모양 음영이 보인다 |
| VWorld 내장 Cesium | 1.99. `CustomHeightmapTerrainProvider`, `Cesium3DTileset` 모두 있다 |

두 DEM은 어느 쪽이 더 정확하다고 단정할 근거가 아직 없다. 둘 다 같은 등고선과 표고점에서 나왔고 보간 방법만 다르다. 하지만 **그려지는 지면과 퓨전이 기준으로 쓰는 지면은 같아야 한다.** 다르면 궤적이 땅에 묻히거나 뜨고, 건물 층 판단도 어긋난다. DEM을 바꾸는 일은 별도 결정으로 다룬다(8절).

## 2. 방식 비교

| 방식 | 내용 | 기존 코드 재사용 | 판단 |
|---|---|---|---|
| **A. Cesium 직접 사용 (권장)** | npm `cesium` Viewer + 서버 DEM 지형 + 건물 돌출 다각형. 배경 타일 없음 | 궤적·마커·Lab 코드 거의 그대로(Cesium API 동일) | 작업량 최소, 오프라인 동작, LiDAR 3D Tiles 확장 가능 |
| B. VWorld 위에 덮기 | VWorld 건물·영상을 끄고 우리 건물만 추가 | 그대로 | VWorld 내부 구조에 의존해 깨지기 쉽다. 지형은 VWorld 것이라 DEM 불일치가 남는다. 키와 인터넷 필요 |
| C. MapLibre + deck.gl | 애플 지도와 비슷한 2.5D 스타일 | 궤적·Lab 그리기 전부 재작성 | 절대 높이 3D 선과 지형 높이 처리가 번거롭다. 다시 만드는 비용이 크다 |
| D. three.js 직접 | 캠퍼스 좌표계 m 단위로 장면 직접 구성 | 전부 재작성(선택·라벨·지면 붙이기) | 자유도는 최고지만 지금 필요한 이상이다 |
| E. glTF / 3D Tiles 변환 | 건물을 오프라인에서 모델 파일로 변환 | A 위에서 선택 사용 | 건물 12개에는 과하다. 실내 LiDAR를 붙일 때 이 경로를 쓴다 |

## 3. 높이 기준 원칙

- **장면 높이 = 정표고(인천 평균해수면).** 지금 VWorld 프리뷰와 같다. 기존 코드(`sceneHeight(ell) = ell − N`)는 바꾸지 않는다.
- **지형:** 활성 서버 지형 버전의 격자를 그대로 쓴다. 범위 밖은 가장 가까운 가장자리 높이로 평평하게 이어 붙여, 절벽이 생기지 않게 한다.
- **건물:** Codex의 `height_m`과 근거(`height_source`, `note`)는 그대로 쓴다. 기초와 지붕은 서버 DEM 위에서 Codex와 같은 규칙으로 다시 계산한다.
  - 기초 = 외곽(2 m 간격) + 내부 대표점의 DEM 최저 − 1 m
  - 지붕 = DEM 중앙값 + height_m, 단 DEM 최고 + 3 m 이상
  - Codex 원래 값은 `source_base_m`, `source_roof_m`로 함께 보관하고 차이를 가져오기 보고에 남긴다.
- **QGIS에서 지붕을 직접 고친 경우:** `roof_m`·`base_m`을 그대로 쓰는 옵션 `--keep-absolute`를 둔다. 기본은 재계산이다(DEM을 바꾸면 자동으로 따라가도록).

## 4. 데이터 파이프라인 (서버)

### 4.1 가져오기 명령

```bash
npm run scene:import -- --dir=/Users/hoshi/Desktop/skuniv_shp/campus_3d [--keep-absolute] [--dry-run]
```

1. **원본 보관:** `campus.gpkg`, `building_heights.csv`, `validation.json`, `build_campus.py`, `campus_3d.qgz`를 `backend/data/scene/source/`로 복사한다(약 300 KB). SHA-256은 `SOURCES.json`에 기록한다. 지형·캠퍼스 지도와 같은 방식이다.
2. **GeoPackage 읽기:** Node 내장 `node:sqlite`로 `buildings_3d`와 `campus_boundary`를 읽는다. 지오메트리는 GeoPackage 헤더 + WKB를 직접 해석한다(외부 의존성 없음, 약 80줄). 좌표계가 EPSG:5186인지 확인한다.
3. **검증** (실패하면 활성화하지 않는다):

   | 검사 | 기준 |
   |---|---|
   | 건물 수 | 12개, 도형 유효 |
   | 퓨전 건물과 같은지 | 활성 캠퍼스 지도의 `campus_buildings`와 건물마다 IoU ≥ 0.99. 이 대응으로 `building_id`를 연결한다 |
   | 이름 | `building_metadata.display_name`과 일치. 공연실습소/혜인관 교정이 반영됐는지 |
   | 높이 | 기초 < 외곽 DEM 최저, 지붕 > DEM 최고. Codex 값과의 차이는 표로 출력만 한다 |
   | 지형 범위 | 모든 건물이 활성 DEM 범위 안 |

4. **저장:** 마이그레이션 `017_campus_scene.sql`.
   - `scene_versions`: id = `campus3d-<sha8>`, 원본 해시, 지형 버전, 캠퍼스 지도 버전, 활성 여부, 검증 결과(JSON)
   - `scene_buildings`: 장면 버전, 건물 ID, 이름, height_m, height_source, register_id, 지상층, base_m, roof_m, source_base_m, source_roof_m, note, 도형(EPSG:5186 MultiPolygon)
   - 캠퍼스 경계는 기존 `campus_areas`를 쓴다.
5. **활성화:** 새 버전을 활성으로 하고 이전 버전은 보존한다(지형 가져오기와 같다).

### 4.2 API

| 경로 | 내용 |
|---|---|
| `GET /api/v1/scene` | 활성 장면: 버전, 지형 버전, 좌표계·지오이드 N, 경계 사각형, 건물 목록(WGS84 외곽선, 기초·지붕, 높이 근거, 층수, 비고, 층 보정값), 캠퍼스 경계. ETag = 버전 |
| `GET /api/v1/terrain/grid` | 활성 DEM 격자를 바이너리로(Float32 LE, 약 0.8 MB, gzip). 헤더에 원점·해상도·크기·버전. 버전이 바뀌지 않으면 브라우저 캐시를 쓴다 |

## 5. 프리뷰 구성 (프런트)

### 5.1 Cesium 도입

- `frontend`에 `cesium`을 의존성으로 추가한다. Vite 빌드에서 Cesium 정적 자원(Workers, Assets, Widgets, ThirdParty)을 복사하고 `CESIUM_BASE_URL`을 지정한다(`vite-plugin-static-copy`).
- Cesium Ion은 쓰지 않는다. `baseLayer: false`로 하고, 지오코더·기본 레이어 선택기는 끈다. 그러면 외부 요청이 없다.
- 새 `campus-map.ts`의 `initCampusMap('vmap')`가 지금 `initVWorld`와 같은 형태(Viewer를 돌려주는 Promise)를 갖는다.
  - 기존 코드가 전역 `window.Cesium`을 쓰므로 그대로 넣어 준다.
  - 그러면 `trajectory.ts`·`lab.ts`는 고치지 않는다.
- Cesium 1.99 → 1.13x 차이에서 우리 코드가 쓰는 API는 그대로다(PolylineDash, PointPrimitiveCollection, CallbackProperty, HeightReference, drillPick, globe.pick). 스파이크에서 확인한다.

### 5.2 장면

| 요소 | 구현 |
|---|---|
| 지형 | `CustomHeightmapTerrainProvider`. 타일마다 격자에서 쌍선형 보간하고, 범위 밖은 가장자리 높이를 쓴다. 지면 붙이기(clampToGround), Lab의 A/B 지도 클릭(`globe.pick`)이 그대로 동작한다 |
| 지면 색 | DEM으로 음영기복(hillshade)을 브라우저 캔버스에서 계산한다. 캠퍼스 안은 아이보리, 밖은 연한 연두로 칠해 `SingleTileImageryProvider` 한 장으로 덮는다(QGIS 미리보기와 같은 색). 타일 서버가 필요 없다 |
| 건물 | `PolygonGeometry`(height = 기초, extrudedHeight = 지붕) 12개를 한 `Primitive`로 묶는다(그리기 1회). 건물마다 ID와 색을 갖는다. 고정 방향광으로 벽 음영을 넣고, 지붕 외곽선을 얇은 선으로 그려 애플 지도 같은 느낌을 낸다 |
| 높이 근거 표시 | ESTIMATE 건물은 지붕색을 약간 다르게 한다(토글). 클릭 상세에 "대장" / "추정 n층 × 3.5 m"를 표시한다 |
| 투명 모드 | 건물 불투명도 100% / 35% 토글. 실내 궤적이 건물에 가려지지 않게 하는 용도이며, 가려진 선은 이미 점선(depthFail)으로 보인다 |
| 이름 라벨 | 지붕 위 라벨. 거리에 따라 크기를 줄이고 다른 물체에 가려지지 않게 한다 |
| 건물 클릭 | 상세 패널: 이름, 높이·근거, 지상층, 기초/지붕 정표고, 층 보정(출입층·층고), 비고 |
| 카메라 | 시작 시 캠퍼스 전체(Seoul 3 km가 아니라). 버튼: 전체 / 위에서 / 선택 건물 |
| 배경 | 하늘·대기·안개를 끄고 밝은 회색 배경(도식적인 지도 느낌) |

### 5.3 VWorld와의 관계

- **단계적 전환:** `VITE_MAP_ENGINE=campus | vworld`(기본 campus). vworld일 때만 Vite 플러그인이 VWorld 로더를 넣는다. 전환이 끝날 때까지 되돌릴 수 있다.
- **캠퍼스 밖 세션:** 초기 차량 세션처럼 캠퍼스를 벗어난 궤적은 DEM 범위 밖이라 평평한 바닥 위에 그려진다. 맥락이 필요하면 다음을 선택 레이어로 둘 수 있다(키 필요, 기본 꺼짐).
  - VWorld 2D 타일(WMTS 위성/기본지도)을 Cesium 영상 레이어로
  - 또는 그런 세션만 VWorld 엔진으로 보기

## 6. 단계별 작업

| 단계 | 작업 | 완료 기준 |
|---|---|---|
| 0. 결정 | DEM 기준(3절, 권장: 서버 DEM) | 사용자 확인 |
| 1. 스파이크 (반나절) | Cesium 도입, 서버 DEM 지형, gpkg에서 한 번 뽑은 건물 12개, 기존 프리뷰·Lab 연결 | ① 건물이 캠퍼스 외곽선 오버레이와 정확히 겹친다 ② fbaa781d v4 궤적이 실외에서 지면 + 약 1 m에 그려진다 ③ 북악관 실내 구간이 건물 박스 안, 타당한 층 높이에 있다 ④ Historical·Lab(재생·경로 A/B 지정)이 그대로 동작한다 ⑤ 네트워크에 외부 요청이 없다 |
| 2. 파이프라인 | `scene:import`, 마이그레이션 017, `/scene`·`/terrain/grid` API, 검증 보고, 테스트(GeoPackage 해석, 기초·지붕 계산, IoU 대응) | 가져오기 → 활성화 → 프리뷰 반영. QGIS에서 높이를 고치고 다시 가져오면 화면이 바뀐다 |
| 3. 화면 완성 | 지면 음영·색, 지붕 외곽선, 이름, 투명 모드, 건물 클릭 상세, 추정 높이 표시, 카메라 버튼, 엔진 스위치 | 애플 지도 수준의 가독성. 궤적·신뢰 폭이 건물·지형 위에서 잘 읽힌다 |
| 4. 정리 | README(VWorld 키 선택 사항으로), 범례, 문서. VWorld 기본 제거 여부 결정 | 키 없이 `npm run dev`만으로 프리뷰가 뜬다 |

규모는 1~3단계 합쳐 1묶음의 Lab 화면 정도다. 스파이크 결과를 보고 2단계로 넘어간다.

## 7. 위험과 한계

- **건물 높이의 절반은 추정이다.** 청운관·문예관·북악관·대일관·수인관·상승관은 "n층 × 3.5 m"이다. 화면에서 추정임을 드러내고, 현장 보정(`buildings:calibrate`)이나 대장 자료로 교체한다.
- **겹치는 건물:** 공연실습소와 혜인관 도형이 96% 겹친다. 높은 쪽이 가린다. 본관/북악관 대장 높이도 하나로 합쳐져 있다.
- **수인관 지붕:** 지형에 묻히지 않게 인위적으로 올렸다. 서버 DEM으로 다시 계산하면 값이 바뀌므로 가져오기 보고에서 확인한다.
- **지형의 거친 부분:** 2 m 격자, 옹벽·계단은 재현하지 않는다. 음영은 서버 DEM 기준이라 QGIS 미리보기의 톱니 모양은 사라지지만, 다른 형태의 거친 부분은 남을 수 있다.
- **번들 크기:** Cesium이 수 MB 늘어난다. 내부 개발 도구라 허용 범위다.
- **브라우저 창이 숨겨져 있으면 렌더링이 멈춘다.** Lab 때와 같다. 화면 확인은 직접 보면서 한다.

## 8. 후속 (이번 범위 밖)

- **DEM 통일 재검토:** Codex 방식(선형 삼각망)으로 서버 지형 버전을 새로 만든다. 그다음 같은 세션들을 두 DEM으로 각각 fusion-v4 재처리해 지면 접촉 잔차(MAD)와 세션 간 높이 일치(813468d0 ↔ fbaa781d)를 비교하고, 좋은 쪽을 활성화한다. 지형 버전을 바꾸면 프리뷰도 자동으로 따라간다.
- **층 단면:** 층 보정값(출입층·층고)으로 선택 건물의 층 판을 표시한다.
- **실내 LiDAR:** 건물별 3D Tiles(점군·메시)로 얹는다. 정합은 2묶음 앵커(출입구 문턱, 계단 시작점)를 기준으로 한다.
- **이동 공간 표시:** 3묶음의 corridor·광장·포털 레이어를 같은 장면에 그린다.
