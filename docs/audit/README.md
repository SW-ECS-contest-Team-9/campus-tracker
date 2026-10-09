# Read-only 3D model audit (2026-10-09)

Scripts that read a vault snapshot and write JSON reports. They never connect to the database and change nothing.
Inputs live in the work vault folder `데이터/보완자료/3d-map-audit-20261009/` (`claude-live/` = live snapshot taken
through the editor MCP read tools and the public scene/terrain API; the DEM there is byte-identical to the live grid).

| Script | Output | What it answers |
|---|---|---|
| `bukak_munye_levels.py` | `claude-bukak-munye-levels.json` | 북악관/문예관 levels, the 12:18Z walk crossing 북악관→문예관, crossing height from two walks, floor-label and 문예관 height candidates |
| `walk_1218_levels.py` | `claude-walk-1218-levels.json` | Per-phone height plateaus of the 2026-10-07 12:18Z walk (C01 + C02) |
| `c02_topology.py` | `claude-c02-topology.json` | C02 and its 1–3 hop neighbourhood (shared node ids), grades, walks along C02 |
| `c02_surface_fit.py` | `claude-c02-surface-fit.json` | Which surface (S-MAP / 2015 DEM / current road Z) has the C02 walk's barometric shape |
| `c02_candidate.py` | `claude-c02-candidate-v1.json` | C02 field re-level candidate (2 hops) and every boundary road it would affect |
| `c02_integrated.py` | `claude-c02-integrated-candidate.json`, `claude-field-terrain-candidate.f32`, `.png` | CT-M02: field polygon from walls, flat field terrain + 4 m open-edge band, merged road candidate, boundary decisions, all checks |
| `terrain_candidate_impact.py` | `claude-terrain-impact.json` | CT-M04: per-building terrain change and recomputed base/roof, edge runs, steep-cell clusters |
| `scene_heights_repro.py` | `claude-scene-heights-repro.json` | CT-M07: exact server base/roof reproduction (GPKG + PostGIS interior point), edge classes with CX-01..03, wall-strip options |
| `roof_edge_variant.py` | `claude-roof-edge-variant.json`, `claude-field-terrain-variantB.f32` | CT-M09: edge runs vs footprints, roof-side transition blocked (variant B), same-scope A/B comparison, roof-as-ground check |
| `node_merge_candidate.py` | `claude-m12/M13-노드병합후보.json` | CT-M13: 북악관 stair ends on coincident corridor nodes — merge candidate checks (self loop, duplicate edge, cross-level Z, validator case) |
| `check_candidates.py` | exit code | Snapshot = archive, no junction gaps, Z-only change, stair direction kept, cross-walk agreement |

Run in this order (later scripts read earlier outputs):

```bash
A="<vault>/데이터/보완자료/3d-map-audit-20261009"
python bukak_munye_levels.py "$A" "$A/claude-bukak-munye-levels.json"
python walk_1218_levels.py "$A" "$A/claude-walk-1218-levels.json"
python c02_topology.py "$A" "$A/claude-c02-topology.json"
python c02_surface_fit.py "$A" "$A/claude-c02-surface-fit.json"
python c02_candidate.py "$A" "$A/claude-c02-candidate-v1.json"
python c02_integrated.py "$A" "$A/claude-c02-integrated-candidate.json" "$A/claude-field-terrain-candidate.f32" "$A/claude-c02-integrated-candidate.png"
python terrain_candidate_impact.py "$A" "$A/claude-terrain-impact.json"
python scene_heights_repro.py "$A" "<repo>/backend/data/scene/source/campus.gpkg" "$A/claude-scene-heights-repro.json"
python roof_edge_variant.py "$A" "<repo>/backend/data/scene/source/campus.gpkg" "$A/claude-roof-edge-variant.json" "$A/claude-field-terrain-variantB.f32"
python check_candidates.py "$A"
```

Requires Python 3.11+, numpy, shapely 2. Candidates are proposals only: applying them is an editor change set that
must be re-checked against the road revisions at that time.

### 추가 검증 (CT-M13·CT-M15)

- `node_merge_candidate.py <audit-dir> <output.json>`: 스냅샷 복사 그래프에 5개 병합을 동시에 적용해 참조·자기 루프·중복·좌표·고도 불변을 검사한다. 실제 계단 위치와 연결은 미확정이므로 운영 적용 근거로 사용하지 않는다.
- `bukak_b1_constraint.py <audit-dir> <output.json>`: 사용자 확인인 “북악관 B1은 실제 뒤편 산책로보다 낮다”를 보존하고 주변 DEM 표본을 출력한다. 산책로 위치와 절대 층고가 미확인이라 두 층 가설 모두 미판정이다. 주변 DEM을 산책로 고도로 대체하거나 층 라벨 변경 근거로 쓰지 않는다.

두 스크립트는 운영 DB·모델을 수정하지 않는다. 입력 자료는 위 Obsidian 감사 폴더에 있으며 저장소에 복사하지 않는다.
## M16·M17·S01S02 후보 (2026-10-09, 운영 미반영)

미리보기 전용 후보다. 모두 `accuracyVerified=false`이며 **운영 DB·원본 GPKG에는 반영하지 않았다**. 모델 개선을 적용했다는 뜻이 아니다.
모든 스크립트는 입력·출력 경로를 인자로 받는다. 기본 절대 경로는 없다.

### 입력 파일
| 파일 | 저장소 사본 | 볼트에만 있음 |
|---|---|---|
| terrain-grid-meta.json, terrain-grid.f32, building-outlines-5186.json, roads-live-2.json, scene-live.json | `m16/preview/data/` | — |
| yudam-gpkg.json (campus.gpkg 유담관 추출, SHA 26c66faa…) | `m17/` | — |
| smap-elevation-raw-20261009.json | — | `claude-m16/` |
| smap-surface-grid-2m.txt, smap-modelid-grid-2m.txt, ortho-camera-recovery.json | — | `claude-m17/` |

볼트 폴더 = `데이터/보완자료/3d-map-audit-20261009/`. 위 4개 볼트 파일이 없으면 M16·M17은 재현할 수 없다.
S-MAP 조회 스크립트(`m16/smap_elev_query.py`, `m17/smap_buldz_query.py`)와 뷰어 기록(격자·카메라 역투영)은 외부 조회 결과이며 재실행 대상이 아니다.

### 실행 (Python 3.11.9, numpy 2.4.6, shapely 2.1.2, matplotlib 3.11.1; matplotlib은 그림에만 사용)
```bash
W=<작업폴더>; PD=<미리보기 data 폴더, 예: docs/audit/m16/preview/data>
# W/audit/{terrain-grid-meta.json,terrain-grid.f32,building-outlines-5186.json,claude-live/roads-live-2.json}
# W/m16/smap-elevation-raw-20261009.json
# W/m17/{yudam-gpkg.json,smap-surface-grid-2m.txt,smap-modelid-grid-2m.txt,ortho-camera-recovery.json}
python m16/build_and_check.py "$W/m16" "$W/audit"                 # S06·S07 선 후보 → candidates-5186.geojson
cp "$W/m16/candidates-5186.geojson" "$PD/"
python m17/gpkg_yudam.py <campus.gpkg> "$W/m17/yudam-gpkg.json"   # 선택: 원본 GPKG에서 재추출(읽기 전용, SHA 검사)
python m17/analyze_grid.py "$W/m17" "$W/m17/yudam-gpkg.json"
python m17/build_m17.py "$W/m17" "$W/m17/yudam-gpkg.json" "$PD"   # Y-A/B/C 분리 → tower-sample-class.json
python m17/build_roof_surface.py "$W/m17" "$PD"                   # Y-A 상단 표면(지붕 표본만)
python m17/analyze_panels.py "$W/m17" "$PD"                       # 패널/건물 지붕 분류 + 건물 지붕 후보
python s01s02/match_roads.py "$W/s01s02" "$W/audit/claude-live/roads-live-2.json"
```
FAIL 검사가 하나라도 있으면 종료 코드 1이다. 미리보기: `python -m http.server <포트> --bind 127.0.0.1 --directory docs/audit/m16/preview`

### 미리보기 유담관 모드 (`window.preview.setYudam`)
| 모드 | 내용 |
|---|---|
| 원본 | campus.gpkg 외곽선, baseM~roofM 단일 돌출 |
| 분리 후보(수평 중앙값) | Y-A 타워(지붕 분류 표본 중앙값 174.7) + Y-B 데크 129.1 + Y-C 보존(원본 roofM). 하단은 모두 원본 baseM(미확정) |
| 표면 상단 | Y-A 위를 지붕 표본(x,y,z 원값) 삼각망으로 대체. 3 m 연속 기준, 구멍 1(옥상 정원 20 m²) |
| 건물 지붕 후보 | 패널 상면 표본을 빼고 건물 지붕 표본 292개 원값 + 패널 위치 165곳 보간 |

### 미확정·보간 범위
- 미확정: Y-A·Y-B 하단(baseZ), Y-B 아래 저층부 여부, Y-C(서측 띠·광장 아래) 건물 여부, 타워 판독불가 36·측벽 5, 패널 미판정 19, 옥상 정원 구멍. S06 CX-16·CX-18, S07 지하 바닥, CX-08 위치, S01·S02 위치(후보만 있음).
- 보간: 건물 지붕 후보의 패널 상면 위치 165곳만. 톱니 방향(148°)으로 양쪽 건물 지붕 표본(한 주기 6.5 m 이내) 사이를 선형 보간했고, 정점마다 원천 두 표본과 비율을 기록했다. 금지 셀 통과 0.
- 2026-10-09 재현: 깨끗한 임시 폴더에서 위 명령이 모두 종료 코드 0이었다. 미리보기 GeoJSON 4개, yudam-gpkg.json, 검사·중간 JSON이 커밋본·볼트본과 SHA-256 일치했다(PNG는 비교하지 않음).
