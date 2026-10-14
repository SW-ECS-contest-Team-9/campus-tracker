# 시작 높이의 선택적 지도 재료

fusion-v4 rev 11은 기본적으로 기존 Z 처리를 유지한다. Lab의 새 Replay에서
길 3D 고도, 건물의 지도·보정 층별 고도를 각각 켤 수 있다. DRAFT 길은 별도 옵션이다.
이 옵션을 켠 Replay는 실험 스냅샷으로 저장되며 기존 게시 결과를 바꾸지 않는다.

시작 위치의 10 m 이내 길에서는 가장 가까운 선분의 Z를 보간하고 휴대폰 높이 1 m를 더한다.
건물 내부에서는 `building_metadata.metadata.calibration.levels[].orthometricM`을 후보로 사용한다.
그려진 건물의 명시적 층 표(`scene_versions.metadata.appearance[].windows.floorsM`)와
건물·층·고도가 지정된 `mobility.open_areas`도 후보로 사용한다. 지도 층과 영역의 바닥 고도에는 휴대폰 높이를 더한다.
보정 층 고도는 이미 휴대폰 높이이므로 1 m를 다시 더하지 않는다. 건물의 층수나 총높이만으로
등간격 층 고도를 생성하지 않는다. 건물·층 ID를 지정하면 후보를 제한한다.
층 ID는 길의 `level_id`, 지도 층의 `floorNames`(없는 경우 `height:145` 같은 고도 ID),
영역의 `floor`, 보정 층은 입구를 기준으로 한 `relativeFloor` 문자열(0, 1, -1 등)이다.

서로 다른 고도 후보가 겹치면 임의의 층을 고르지 않는다. 지정한 층 또는 후보를 충분히
구분하는 GPS 수직 정확도가 있어야 한다. 수평 위치가 너무 불확실하거나 후보가 없으면
기존 폴백을 유지한다. 선택 결과와 전체 후보는 실행 metrics의 `startHeightSelection`에 기록한다.

우선순위: 검증된 길 통과 앵커 → 실외 지면 접촉 → 신뢰 조건을 통과한 GPS → 선택한 지도 시작 고도 → DEM·기압 → GPS 폴백.
지도 시작 고도는 `MAP_START`로 표시한다. 실내 층을 검증한 측정값이 아닌 임시 기준이다.
시작 고도 기준을 고정한 후 기압 변화량을 누적하므로 수평 이동 때마다 길/층에 다시 스냅하지 않는다.
Replay는 동일한 지도 스냅샷에서 첫 평활 위치를 사용해 기준을 다시 계산한다.

옵션(API Replay overrides 또는 `fusionConfigV4`):

- `startHeightRoadsEnabled=false`
- `startHeightFloorsEnabled=false`
- `startHeightIncludeDrafts=false`
- `startHeightBuildingId=""`, `startHeightLevelId=""`
- `startHeightRoadRadiusM=10`, `startHeightMaxPositionSigmaM=15`
- `startHeightAmbiguityM=0.75`, `startHeightGpsMaxSigmaM=5`, `startHeightMinSigmaM=3`

실시간에 적용하려면 서버의 등록 config에서 해당 옵션을 켠다. 새 세션은 시작 시 지도를 한 번 읽는다.
실행 당시 길과 보정 층 데이터 전체는 run config의 `sessionInput.startHeightMap`에 저장하고,
입력 해시에 포함하므로 지도가 바뀌면 동일한 설정의 완료 실행으로 잘못 건너뛰지 않는다.
데이터 조회는 읽기 전용이며 길이나 건물 데이터를 수정하지 않는다.

## 지나온 길을 Z 앵커로 사용

Lab의 `그려진 길의 연속 통과를 Z 앵커로 활용`을 켜면 시작점 이후에도 길 통과를 판단한다.
옵션은 `roadHeightAnchorsEnabled`이며 기본값은 false다. 시작 높이의 길 옵션과 독립적이다.
DRAFT 길은 `roadHeightAnchorIncludeDrafts=true`로 별도 허용해야 한다.

실제로 감지된 보행 스텝에 대해, 방향이 알려져 있고 수평 불확실성이 8 m 이내인 경우만 평가한다.
길에서 3 m 이내·방향 차 25도 이내로 최소 6스텝·3초·4 m의 연속 진행을 확인한다.
센서/보행 간격이 2초를 넘거나 순간 이동·역진행이 생기면 통과 후보를 다시 시작한다.
길 고도 변화와 기압 Z 변화로 계산한 기준 오프셋의 범위가 1.5 m를 넘으면 매칭을 버린다.
다른 층의 길이 겹치면 `roadHeightAnchorLevelId` 또는 충분히 구분되는 신뢰 고도 기준이 필요하다.

앵커는 `길의 보간 고도 + 휴대폰 높이 - 당시 기압 Z`를 관측한다. 앵커 간격은 최소 5초이고,
고도 불확실성과 완만한 기압 드리프트를 반영해 기준 오프셋을 평활화한다. 길을 벗어난 후에도
기압 변화로 추적을 이어간다. 최종 Replay에서는 평활화된 XY 궤적으로 길 통과를 다시 확인하고,
그 앵커로 지나오기 전 구간의 고도 기준도 다시 추정한다. 전방 실행의 앵커를 그대로 재사용하지 않는다.

이 처리는 Z 기준을 보정하며 XY를 길에 스냅하지 않는다. XY가 길로 강제된 결과를 다시 매칭 증거로
쓰는 순환을 피하기 위해서다. `ROAD_ANCHOR` 출처, 앵커 수, 길 ID, 관측 오프셋은 출력·실행 metrics에 기록한다.
그려진 길의 높이는 측량으로 확정된 층 고도가 아니므로 화면의 층 확정 표시는 허용하지 않는다.
