"""stair-endpoints-v5 / stairs-moved-v5 → scene 추정 레이어(값 변경 없음, 운영 승격 없음).

- 끝점 표지: v5 xy·z(범위면 하한, 계단참 z 없음은 기존 추정 계단참 z 144.8을 표시 위치로만 사용), 상태 확인=초록 / 미검증=빨강
- 제안 계단 선: stairs-moved-v5 선을 상단 z → 하단 z로(제안·참고선, 기존 추정 계단 형상은 그대로 두고 비교용)
v4 끝점 표지는 v5로 대체(로더에서 제외, 파일은 보존).
사용: python integrate_v5_scene.py <운동장구조 폴더> <repo-root>
"""
import hashlib, json, sys
from pathlib import Path

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
VAULT = 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/'
raw_e = (SRC / 'stair-endpoints-v5.json').read_bytes()
raw_m = (SRC / 'stairs-moved-v5.geojson').read_bytes()
E, M = json.loads(raw_e), json.loads(raw_m)
LANDING_Z = 144.8
feats = []
for k, e in enumerate(E['endpoints'], 1):
    x, y = e['xy']
    z = e['z']
    if isinstance(z, list):
        zz, zn = min(z), f'z 범위 {z} 중 하한을 표시 위치로'
    elif z is None:
        zz, zn = LANDING_Z, f'z 없음 → 표시 위치만 기존 추정 계단참 z {LANDING_Z}(운영 DRAFT)'
    else:
        zz, zn = z, f'z {z}'
    ok = e['status'].startswith('확인')
    feats.append({'type': 'Feature', 'properties': {
        'id': f'EP5-{e["stair"]}-{k}', 'type': 'endpoint_confirmed' if ok else 'endpoint_unverified', 'kind': 'line', 'estimated': True,
        'stair': e['stair'], 'role': e['role'], 'status': e['status'],
        'assumption': f'표지 막대(+4 m). {zn}. 상태: {e["status"]} — {e["why"]}', 'source': f'{VAULT}stair-endpoints-v5.json endpoints[{k - 1}] ({e.get("z_src")})'},
        'geometry': {'type': 'LineString', 'coordinates': [[x, y, zz], [x, y, zz + 4]]}})
for f in M['features']:
    p = f['properties']
    (x0, y0), (x1, y1) = f['geometry']['coordinates']
    zt = min(p['z_top_range']) if 'z_top_range' in p else p['z_top']
    feats.append({'type': 'Feature', 'properties': {
        'id': p['id'], 'type': 'stair_proposal', 'kind': 'line', 'estimated': True, 'status': p['status'],
        'assumption': f'제안 계단 선(참고선): 상단 z {zt} → 하단 z {p["z_bottom"]}, 위치 오차 ±{p["err_xy_m"]} m, 단수·폭 미정. 기존 추정 계단 형상은 바꾸지 않음. {p.get("note", "")}',
        'source': f'{VAULT}stairs-moved-v5.geojson {p["id"]}'},
        'geometry': {'type': 'LineString', 'coordinates': [[x0, y0, zt], [x1, y1, p['z_bottom']]]}})
fc = {'type': 'FeatureCollection', 'name': 'stair-endpoints-v5', 'crs': M['crs'],
      'provenance': {'source': VAULT + 'stair-endpoints-v5.json + stairs-moved-v5.geojson', 'sha256': hashlib.sha256(raw_e).hexdigest(), 'sha256_moved': hashlib.sha256(raw_m).hexdigest(),
                     'generator': 'docs/audit/field/integrate_v5_scene.py', 'status': E['status']},
      'features': feats}
(ROOT / 'frontend/public/corrections/stair-endpoints-v5.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
for f in feats:
    print(f['properties']['id'], f['properties']['type'], f['properties'].get('status'))
