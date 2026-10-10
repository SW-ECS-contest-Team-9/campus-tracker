"""길 사슬 후보 그래프 v2(다른 작업자: 볼트 claude-user-20261010/길사슬/path-graph-candidate-v2.json) → 앱 표시 GeoJSON(값 변경 없음).

표시 층 두 가지(서로 다른 높이):
1) 그래프 상태(+0.3 m)
   - path_graph_connected '그래프상 연결': 경로 사슬 legs(found=true)에 쓰인 도로. 분할된 도로는 원 도로 전체가 아니라 최종 분할 부품(#A, #B#A …)을 각자 ID·선으로.
   - path_drawn_only '그림만': 후보 도로 status '그린 후보선만'
   - path_unverified '미검증·보류·끊김': 그 밖 후보 도로, 끊긴 leg(양 끝 좌표 있을 때 직선), 사슬 지역 끊긴 끝
   - path_candidate_node '그래프 후보 노드(미검증)': 후보 노드(운영 노드와 구분)
2) 표면 접속 상태(+1.0 m, 그래프상 연결 도로에만): 사슬의 surface_connection
   - surface_unverified '표면 접속 미검증(후보 노드 포함)' / surface_operational_only '운영 노드만(물리 접속 별도 검증)'
z: 스냅샷 도로는 좌표 z(운영 DRAFT), 분할 부품은 끝 노드 xyz(중간 꼭짓점은 길이 비례, 표시용), 후보 도로는 노드 z_cand. z 없으면 그리지 않고 skipped.
사용: python integrate_path_graph.py <path-graph-candidate-v2.json> <repo-root>
"""
import hashlib, json, sys
from collections import Counter
from pathlib import Path
import numpy as np

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
raw = SRC.read_bytes()
G = json.loads(raw)
roads_raw = (ROOT / 'docs/audit/m16/preview/data/roads-live-2.json').read_bytes()
base_ok = hashlib.sha256(roads_raw).hexdigest() == G['base']['sha256']
roads = json.loads(roads_raw)['items']
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


# 최종 분할 부품(더 쪼개지지 않은 것)
parts = {}
for o in G['ops']:
    if o['op'] == 'split_road':
        parts.pop(o['road'], None)
        for p in o['parts']:
            parts[p['id']] = p
split_roots = {pid.split('#')[0] for pid in parts}
# 도로 → 사슬(그래프상 연결 legs)과 표면 접속 상태
road_chains = {}
for c in G['chains']:
    for leg in c['legs']:
        if leg.get('found'):
            for rid in leg['roads']:
                road_chains.setdefault(rid, []).append((c['chain'], c['graph_label'], c['surface_connection']))
used = set(road_chains)
in_used = lambda rid: any(rid.startswith(u) or u.startswith(rid) for u in used)
chains_of = lambda rid: [v for u, vs in road_chains.items() if rid.startswith(u) or u.startswith(rid) for v in vs]
feats, skipped, omitted_paths = [], [], []
LEG = {'path_graph_connected': '그래프상 연결', 'path_drawn_only': '그림만(그래프 미연결)', 'path_unverified': '미검증·보류·끊김',
       'path_candidate_node': '그래프 후보 노드(미검증)', 'surface_unverified': '표면 접속 미검증(후보 노드 포함)', 'surface_operational_only': '표면 접속: 운영 노드만(물리 접속 별도 검증)'}


def add(fid, typ, coords, status, src, lift=0.3, extra=None):
    if any(len(c) < 3 or c[2] is None for c in coords):
        skipped.append(fid)
        return
    feats.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'legend': LEG[typ], 'kind': 'line', 'estimated': True, 'status': status, **(extra or {}),
                  'assumption': f'길 사슬 후보 표시({LEG[typ]}). 좌표·z는 입력 그대로(스냅샷 도로 z = 운영 DRAFT), 표시 +{lift} m', 'source': src},
                  'geometry': {'type': 'LineString', 'coordinates': [[float(c[0]), float(c[1]), float(c[2]) + lift] for c in coords]}})


def surface_layer(fid, coords, rid):
    for k, (chain, gl, sc) in enumerate(chains_of(rid)):
        typ = 'surface_unverified' if sc.startswith('미검증') else 'surface_operational_only'
        add(f'{fid}-S{k}', typ, coords, f'{chain}: {sc}', 'path-graph-candidate-v2 chains surface_connection', lift=1.0, extra={'chain': chain})


cand = {o['id']: o for o in G['ops'] if o['op'] == 'add_road'}
for r in roads:  # 스냅샷 도로: 그래프상 연결 legs에 쓰였고 분할되지 않은 것만
    if r['id'] in split_roots or not in_used(r['id']):
        continue
    add(f'PG-R-{r["id"][:8]}', 'path_graph_connected', r['coordinates'], '그래프상 연결(스냅샷 도로)', f'roads-live-2 {r["id"]}')
    surface_layer(f'PG-R-{r["id"][:8]}', r['coordinates'], r['id'])
for pid, p in parts.items():  # 분할 부품: 각자 ID·선
    xy = np.array(p['xy'], float)
    z0, z1 = p['from']['xyz'][2], p['to']['xyz'][2]
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    zs = z0 + (z1 - z0) * seg / seg[-1]
    coords = [[x, y, round(float(z), 3)] for (x, y), z in zip(xy, zs)]
    typ = 'path_graph_connected' if in_used(pid.split('#')[0]) else 'path_unverified'
    add(f'PG-P-{pid[:8]}{pid[pid.index("#"):]}', typ, coords, f'분할 부품 {p["structure"]} ({p["from"]["kind"]}→{p["to"]["kind"]})', f'path-graph-candidate-v2 split_road part {pid}',
        extra={'part_of': pid.split('#')[0]})
    if typ == 'path_graph_connected':
        surface_layer(f'PG-P-{pid[:8]}{pid[pid.index("#"):]}', coords, pid.split('#')[0])
for rid, o in cand.items():
    st = o.get('status', '')
    typ = 'path_drawn_only' if '그린 후보선만' in st else 'path_unverified' if ('미검증' in st or '보류' in st or rid not in used) else 'path_graph_connected'
    a, b = node_xyz(o['from']), node_xyz(o['to'])
    xy = o['xy']
    zs = [a[2] if a else None] + [None] * (len(xy) - 2) + [b[2] if b else None]
    if len(xy) > 2 and zs[0] is not None and zs[-1] is not None:
        zs = [zs[0] + (zs[-1] - zs[0]) * k / (len(xy) - 1) for k in range(len(xy))]
    coords = [[*p, z] for p, z in zip(xy, zs)]
    if any(z is None for z in zs):
        omitted_paths.append({'id': rid, 'note': f'{o.get("why", rid)} · {st}. 끝점 고도 미확정으로 선 표시 생략; 실제 길 부재 판정 아님.'})
    add(f'PG-C-{rid}', typ, coords, st, f'path-graph-candidate-v2 ops add_road {rid}')
    if rid in used:
        surface_layer(f'PG-C-{rid}', coords, rid)
for c in G['chains']:
    for k, leg in enumerate(c['legs']):
        if leg.get('found'):
            continue
        a, b = node_xyz(leg['from']), node_xyz(leg['to'])
        if a and b:
            add(f'PG-GAP-{c["chain"][:3].strip()}-{k}', 'path_unverified', [a, b], f'그래프상 끊김: {leg["from"]}→{leg["to"]}', f'path-graph-candidate-v2 chains {c["chain"]}')
        else:
            skipped.append(f'끊김 {leg["from"]}→{leg["to"]}(끝점 좌표 없음)')
for d in G['dangling_in_area']:
    p = node_xyz(d['node'])
    if p:
        add(f'PG-END-{d["node"][:12]}', 'path_unverified', [p, [p[0], p[1], p[2] + 2]], '사슬 지역 끊긴 끝', f'path-graph-candidate-v2 dangling_in_area {d["node"]}')
for nid, (xy, z) in zc.items():
    if z is not None:
        add(f'PG-N-{nid}', 'path_candidate_node', [[*xy, z], [*xy, z + 2.0]], '그래프 후보 노드(미검증)', f'path-graph-candidate-v2 노드 {nid} (z_cand)')
fc = {'type': 'FeatureCollection', 'name': 'path-graph-candidate', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
      'provenance': {'source': f'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/길사슬/{SRC.name}', 'sha256': hashlib.sha256(raw).hexdigest(),
                     'base_roads_sha_match': base_ok, 'generator': 'docs/audit/field/integrate_path_graph.py', 'status': G['status'], 'skipped': skipped, 'legend': LEG,
                     'chains': [{'chain': c['chain'], 'graph': c['graph_label'], 'surface': c['surface_connection']} for c in G['chains']],
                     'constraints_not_drawn': [c['id'] for c in G['constraints']],
                     'constraint_notes': G['constraints'], 'omitted_path_notes': omitted_paths},
      'features': feats}
(ROOT / 'frontend/public/corrections/path-graph-candidate.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
ids = [f['properties']['id'] for f in feats]
print('base sha match', base_ok, 'features', len(feats), Counter(f['properties']['type'] for f in feats), 'dup ids', len(ids) - len(set(ids)), 'skipped', skipped)
print('split parts drawn', [f['properties']['id'] for f in feats if f['properties']['id'].startswith('PG-P-') and '-S' not in f['properties']['id'][-3:]])
