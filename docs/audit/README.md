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
python check_candidates.py "$A"
```

Requires Python 3.11+, numpy, shapely 2. Candidates are proposals only: applying them is an editor change set that
must be re-checked against the road revisions at that time.
