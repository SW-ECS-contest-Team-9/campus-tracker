"""corridor-surface-v4(다른 작업자: 사잇길 내부 S-MAP 표본 TIN) → 앱 보정 레이어 파일 + 렌더 삼각형 JSON.

- SF-CORRIDOR-V4: 삼각형 519개(꼭짓점 = S-MAP 표본 원값)를 그대로 MultiPolygon 평면 조각으로 둠 → Cesium 렌더 z = 삼각형 평면(재삼각화 영향 없음).
  Corrected를 켜면 경계 정점만 있던 SF-CORRIDOR(v3)를 대체(replaces). v3는 파일에 남아 비교용.
- 빈칸 24곳: 채우지 않고 선(미검증)으로만.
- 출력: frontend/public/corrections/corridor-surface-v4.geojson, <tris.json>(cut_from_render_tris.py 입력)
사용: python integrate_corridor_v4.py <운동장구조 폴더> <repo-root> <tris.json>
"""
import hashlib, json, sys
from pathlib import Path

SRC, ROOT, TRIS = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
raw = (SRC / 'corridor-surface-v4.geojson').read_bytes()
V = json.loads(raw)
tris = [f for f in V['features'] if f['properties']['kind'] == '사잇길 표면 삼각형']
gaps = [f for f in V['features'] if f['properties']['kind'].startswith('빈칸')]
src = 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/corridor-surface-v4.geojson'
feats = [{'type': 'Feature', 'properties': {
    'id': 'SF-CORRIDOR-V4', 'type': 'corridor_tin', 'kind': 'surface', 'replaces': 'SF-CORRIDOR', 'estimated': True,
    'assumption': f'사잇길 면 = 내부 S-MAP 표본 TIN 삼각형 {len(tris)}개(꼭짓점 원값, 구역 평탄/경사/급경사·계단 후보). 빈칸은 보간하지 않음', 'source': src + ' (S-MAP 메시 내부 표본)'},
    'geometry': {'type': 'MultiPolygon', 'coordinates': [t['geometry']['coordinates'] for t in tris]}}]
for k, g in enumerate(gaps, 1):
    feats.append({'type': 'Feature', 'properties': {
        'id': f'CORRIDOR-V4-GAP-{k}', 'type': 'gap_unverified', 'kind': 'line', 'estimated': True,
        'assumption': '빈칸(표본 없음·다른 면 경계): 미검증, 채우지 않음(보간 없음). 선 z = 빈칸 경계 정점 z(입력 그대로)', 'source': src},
        'geometry': {'type': 'LineString', 'coordinates': g['geometry']['coordinates'][0]}})
fc = {'type': 'FeatureCollection', 'name': 'corridor-surface-v4', 'crs': V['crs'],
      'provenance': {'source': src, 'sha256': hashlib.sha256(raw).hexdigest(), 'generator': 'docs/audit/field/integrate_corridor_v4.py', 'status': V['properties']['status'],
                     'gaps': len(gaps)}, 'features': feats}
nz = sum(1 for g in gaps if len(g['geometry']['coordinates'][0][0]) < 3)
if nz:  # 빈칸 선에 z가 없으면 선을 그리지 않음(임의 고도 금지), 개수만 기록
    fc['features'] = [f for f in feats if not (f['properties']['type'] == 'gap_unverified' and len(f['geometry']['coordinates'][0]) < 3)]
    fc['provenance']['gaps_without_z_not_drawn'] = nz
(ROOT / 'frontend/public/corrections/corridor-surface-v4.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
TRIS.write_text(json.dumps([t['geometry']['coordinates'][0][:3] for t in tris]), encoding='utf-8')
print('tris', len(tris), 'gaps', len(gaps), 'gaps without z', nz)
