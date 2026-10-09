"""길 사슬 후보 그래프(다른 작업자: 볼트 claude-user-20261010/길사슬/path-graph-candidate.json) → 앱 표시 GeoJSON(값 변경 없음).

입력 형식: base(roads-live-2 스냅샷 + SHA), ops(add_node/add_road/split_road), chains(경로별 legs: found, roads), candidate_nodes_z, dangling_in_area.
표시 상태(type):
- path_connected  : 경로 사슬 legs에서 found=true로 쓰인 도로(스냅샷 도로 또는 후보 도로), 단 후보 도로 status에 '미검증'·'보류'가 있으면 path_unverified
- path_drawn_only : 후보 도로 status가 '그린 후보선만'(그래프 미연결)
- path_unverified : 그 밖 후보 도로, 끊긴 leg(found=false, 양 끝 좌표가 있을 때 직선으로 표시), 사슬 지역 끊긴 끝 노드
z: 스냅샷 도로는 좌표 z(운영 DRAFT) 그대로, 후보 도로는 노드 z_cand. z가 없으면 그리지 않고 skipped에 남김(임의 고도 금지). 표시 높이 +0.3 m.
split_road 부품(#A/#B)은 원 도로 전체 선으로 표시(분할 위치는 노드 표지로 보임).
사용: python integrate_path_graph.py <path-graph-candidate.json> <repo-root>
"""
import hashlib, json, sys
from pathlib import Path

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
raw = SRC.read_bytes()
G = json.loads(raw)
roads_raw = (ROOT / 'docs/audit/m16/preview/data/roads-live-2.json').read_bytes()
base_ok = hashlib.sha256(roads_raw).hexdigest() == G['base']['sha256']
roads = json.loads(roads_raw)['items']
byid = lambda pre: [r for r in roads if r['id'].startswith(pre.split('#')[0])]
nodes = {}
for r in roads:
    nodes[r['fromNodeId']] = r['coordinates'][0]
    nodes[r['toNodeId']] = r['coordinates'][-1]
zc = {n['node']: (n['xy'], n.get('z_cand')) for n in G['candidate_nodes_z']}
for o in G['ops']:
    if o['op'] == 'add_node':
        zc[o['id']] = (o['xy'], o.get('z_cand'))


def node_xyz(nid):
    if nid in zc and zc[nid][1] is not None:
        return [*zc[nid][0], zc[nid][1]]
    hit = [v for k, v in nodes.items() if k.startswith(nid)]
    return hit[0] if hit else None


used = set()
for c in G['chains']:
    for leg in c['legs']:
        if leg.get('found'):
            used.update(leg['roads'])
feats, skipped = [], []


def add(fid, typ, coords, status, src):
    if any(len(c) < 3 or c[2] is None for c in coords):
        skipped.append(fid)
        return
    feats.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'line', 'estimated': True, 'status': status,
                  'assumption': f'길 사슬 후보 표시(상태 {status}). 좌표·z는 입력 그대로(스냅샷 도로 z = 운영 DRAFT), 표시 +0.3 m', 'source': src},
                  'geometry': {'type': 'LineString', 'coordinates': [[float(c[0]), float(c[1]), float(c[2]) + 0.3] for c in coords]}})


cand = {o['id']: o for o in G['ops'] if o['op'] == 'add_road'}
for rid in sorted(used):
    if rid in cand:
        continue
    for r in byid(rid):
        add(f'PG-R-{r["id"][:8]}', 'path_connected', r['coordinates'], '경로 사슬 연결(스냅샷 도로)', f'roads-live-2 {r["id"]} (경로 사슬 legs found)')
for rid, o in cand.items():
    st = o.get('status', '')
    typ = 'path_drawn_only' if '그린 후보선만' in st else 'path_unverified' if ('미검증' in st or '보류' in st or rid not in used) else 'path_connected'
    a, b = node_xyz(o['from']), node_xyz(o['to'])
    xy = o['xy']
    zs = [a[2] if a else None] + [None] * (len(xy) - 2) + [b[2] if b else None]
    if len(xy) > 2 and zs[0] is not None and zs[-1] is not None:  # 중간 꼭짓점은 양 끝 z 선형(표시용)
        zs = [zs[0] + (zs[-1] - zs[0]) * k / (len(xy) - 1) for k in range(len(xy))]
    add(f'PG-C-{rid}', typ, [[*p, z] for p, z in zip(xy, zs)], st, f'path-graph-candidate ops add_road {rid}')
for c in G['chains']:
    for k, leg in enumerate(c['legs']):
        if leg.get('found'):
            continue
        a, b = node_xyz(leg['from']), node_xyz(leg['to'])
        if a and b:
            add(f'PG-GAP-{c["chain"][:3].strip()}-{k}', 'path_unverified', [a, b], f'끊김: {leg["from"]}→{leg["to"]}', f'path-graph-candidate chains {c["chain"]}')
        else:
            skipped.append(f'끊김 {leg["from"]}→{leg["to"]}(끝점 좌표 없음)')
for d in G['dangling_in_area']:
    p = node_xyz(d['node'])
    if p:
        add(f'PG-END-{d["node"][:12]}', 'path_unverified', [p, [p[0], p[1], p[2] + 2]], '사슬 지역 끊긴 끝', f'path-graph-candidate dangling_in_area {d["node"]}')
for nid, (xy, z) in zc.items():
    if z is not None:
        add(f'PG-N-{nid}', 'path_connected', [[*xy, z], [*xy, z + 1.5]], '후보 노드', f'path-graph-candidate 노드 {nid} (z_cand)')
fc = {'type': 'FeatureCollection', 'name': 'path-graph-candidate', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
      'provenance': {'source': 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/길사슬/path-graph-candidate.json', 'sha256': hashlib.sha256(raw).hexdigest(),
                     'base_roads_sha_match': base_ok, 'generator': 'docs/audit/field/integrate_path_graph.py', 'status': G['status'], 'skipped': skipped,
                     'constraints_not_drawn': [c['id'] for c in G['constraints']]},
      'features': feats}
(ROOT / 'frontend/public/corrections/path-graph-candidate.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
from collections import Counter
print('base sha match', base_ok, 'features', len(feats), Counter(f['properties']['type'] for f in feats), 'skipped', skipped)
