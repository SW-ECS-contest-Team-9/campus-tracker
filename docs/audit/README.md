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
