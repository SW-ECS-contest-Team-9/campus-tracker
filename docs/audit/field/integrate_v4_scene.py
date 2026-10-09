"""v4 검토 자료를 scene 추정 레이어 형식으로 복사(값 변경 없음).

- field-boundary-v4: REF-PHOTO15-V4만 참고선으로. SF-FIELD-EDGE-V4(직선화)는 p95 3.04 m > 3 m 검사 실패라 쓰지 않음 → 평지 면은 SF-FIELD 셀 윤곽 유지.
- stair-endpoints-v4: 계단 끝점마다 판정 표지(세로 막대, 계단 z에서 +4 m). 계단·z는 옮기지 않음.
사용: python integrate_v4_scene.py <운동장구조 폴더> <repo-root>
"""
import hashlib, json, sys
from pathlib import Path

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
OUT = ROOT / 'frontend/public/corrections'
VAULT = 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/'
FIELD_Z = 148.9

raw = (SRC / 'field-boundary-v4.geojson').read_bytes()
fb = json.loads(raw)
ref = [f for f in fb['features'] if f['properties']['id'] == 'REF-PHOTO15-V4'][0]
p = ref['properties']
fc = {'type': 'FeatureCollection', 'name': 'field-boundary-v4', 'crs': fb['crs'],
      'provenance': {'source': VAULT + 'field-boundary-v4.geojson', 'sha256': hashlib.sha256(raw).hexdigest(), 'generator': 'docs/audit/field/integrate_v4_scene.py',
                     'excluded': 'SF-FIELD-EDGE-V4(톱니 직선화): 95백분위 편차 3.04 m > 3 m 검사 실패 → 평지 면으로 쓰지 않음, SF-FIELD 셀 윤곽 유지'},
      'features': [{'type': 'Feature', 'properties': {
          'id': 'REF-PHOTO15-V4-EDGE', 'type': 'outline', 'kind': 'line', 'estimated': True,
          'assumption': f'참고선 전용(평지 교체 금지). 선 높이 = 운동장 z {FIELD_Z}. 면적 {p.get("area_m2")} m², SF-FIELD와 IoU {p.get("iou_vs_SF_FIELD")}',
          'source': VAULT + 'field-boundary-v4.geojson REF-PHOTO15-V4(사진15 경계 재대응, 지면 기준점 7·검증점 3)'},
          'geometry': {'type': 'LineString', 'coordinates': [[x, y, FIELD_Z] for x, y, *_ in ref['geometry']['coordinates'][0]]}}]}
(OUT / 'field-boundary-v4.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')

raw2 = (SRC / 'stair-endpoints-v4.json').read_bytes()
se = json.loads(raw2)
feats = []
for k, e in enumerate(se['endpoints'], 1):
    ok = e['verdict'].startswith('소속 후보 확인')
    x, y = e['xy']
    z = e['operational_z']  # 추정 계단이 쓰는 z 그대로(이동 없음)
    feats.append({'type': 'Feature', 'properties': {
        'id': f'EP-{e["stair"]}-{k}', 'type': 'endpoint_confirmed' if ok else 'endpoint_unverified', 'kind': 'line', 'estimated': True,
        'stair': e['stair'], 'role': e['role'], 'verdict': e['verdict'],
        'assumption': f'표지 막대(계단 z {z}에서 +4 m), 계단 위치·z 변경 없음. 판정: {e["verdict"]} — {e["why"]}',
        'source': VAULT + f'stair-endpoints-v4.json endpoints[{k - 1}]'},
        'geometry': {'type': 'LineString', 'coordinates': [[x, y, z], [x, y, z + 4]]}})
fc2 = {'type': 'FeatureCollection', 'name': 'stair-endpoints-v4', 'crs': fb['crs'],
       'provenance': {'source': VAULT + 'stair-endpoints-v4.json', 'sha256': hashlib.sha256(raw2).hexdigest(), 'generator': 'docs/audit/field/integrate_v4_scene.py', 'note': se['note']},
       'features': feats}
(OUT / 'stair-endpoints-v4.geojson').write_text(json.dumps(fc2, ensure_ascii=False), encoding='utf-8')
for f in feats:
    print(f['properties']['id'], f['properties']['type'], f['properties']['verdict'])
