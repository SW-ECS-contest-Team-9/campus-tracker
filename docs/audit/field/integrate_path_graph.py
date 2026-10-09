"""길 사슬 후보 그래프(다른 작업자: 볼트 claude-user-20261010/길사슬/path-graph-candidate.json) → 앱 표시 GeoJSON.

기대 입력(형식이 다르면 실패하고 키 목록을 출력): {"nodes":[{"id","x","y","z"?,"status"?}], "edges":[{"id","from","to","coords"?:[[x,y,z?],...],"status"}]}
EPSG:5186. status는 그대로 보존하고 색 구분용 type으로만 매핑: 그림만(drawn-only) / 그래프 연결(graph-connected) / 그 밖(미검증·보류).
z가 없으면 표시 위치용 0이 아니라 피처를 건너뛰고 목록에 남긴다(임의 고도 금지).
사용: python integrate_path_graph.py <path-graph-candidate.json> <repo-root>
"""
import hashlib, json, sys
from pathlib import Path

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
raw = SRC.read_bytes()
G = json.loads(raw)
if not isinstance(G, dict) or 'edges' not in G or 'nodes' not in G:
    sys.exit(f'형식 다름: 최상위 키 {list(G) if isinstance(G, dict) else type(G).__name__}')


def typ(st):
    s = str(st or '').lower()
    if 'drawn' in s or '그림' in s:
        return 'path_drawn_only'
    if 'connected' in s or '연결' in s and '미' not in s:
        return 'path_connected'
    return 'path_unverified'


N = {n['id']: n for n in G['nodes']}
feats, skipped = [], []
for e in G['edges']:
    coords = e.get('coords') or [[N[e['from']].get('x'), N[e['from']].get('y'), N[e['from']].get('z')], [N[e['to']].get('x'), N[e['to']].get('y'), N[e['to']].get('z')]]
    if any(len(c) < 3 or c[2] is None for c in coords):
        skipped.append(e['id'])
        continue
    feats.append({'type': 'Feature', 'properties': {'id': f"PG-E-{e['id']}", 'type': typ(e.get('status')), 'kind': 'line', 'estimated': True, 'status': e.get('status'),
                  'assumption': f"길 사슬 후보 간선(상태 {e.get('status')}), 좌표·z는 입력 그대로", 'source': f'길사슬/path-graph-candidate.json edges[{e["id"]}]'},
                  'geometry': {'type': 'LineString', 'coordinates': [[float(c[0]), float(c[1]), float(c[2]) + 0.3] for c in coords]}})
for n in G['nodes']:
    if n.get('z') is None:
        skipped.append(n['id'])
        continue
    feats.append({'type': 'Feature', 'properties': {'id': f"PG-N-{n['id']}", 'type': typ(n.get('status')), 'kind': 'line', 'estimated': True, 'status': n.get('status'),
                  'assumption': f"길 사슬 후보 노드 표지(+2 m 막대), 상태 {n.get('status')}", 'source': f'길사슬/path-graph-candidate.json nodes[{n["id"]}]'},
                  'geometry': {'type': 'LineString', 'coordinates': [[n['x'], n['y'], n['z']], [n['x'], n['y'], n['z'] + 2]]}})
fc = {'type': 'FeatureCollection', 'name': 'path-graph-candidate', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
      'provenance': {'source': 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/길사슬/path-graph-candidate.json', 'sha256': hashlib.sha256(raw).hexdigest(),
                     'generator': 'docs/audit/field/integrate_path_graph.py', 'skipped_no_z': skipped}, 'features': feats}
(ROOT / 'frontend/public/corrections/path-graph-candidate.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
print('features', len(feats), 'skipped(no z)', len(skipped))
