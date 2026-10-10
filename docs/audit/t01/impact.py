"""T01 영향 점검: 국소 표본 보정 지형(dem-T01.f32)을 활성화하면 건물 바닥·지붕과 길 높이 차가 어떻게 달라지는가. 읽기 전용.

건물: scene-heights.ts 규칙(외곽선 2 m 이하 간격 표본 + 서버 내부점, 바닥 = 최저 - 1, 지붕 = max(중앙 + 높이, 최고 + 3)).
길: 지형이 바뀐 자리의 꼭짓점마다 (길 z - 지형) 전/후. 실외(건물 소속 없음)와 실내(건물 소속 또는 복도·승강기)를 따로 센다.

  python impact.py <3d-map-audit-20261009 폴더> <dem-T01.f32> <out.json>
"""
import json, sys, math, pathlib
import numpy as np

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']; H, W = meta['height'], meta['width']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(H, W)
new = np.fromfile(sys.argv[2], dtype='<f4').reshape(H, W)
TOL = 0.5


def bilinear(grid, x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    v00, v10, v01, v11 = (float(grid[iy, ix]), float(grid[iy, ix + 1]), float(grid[iy + 1, ix]), float(grid[iy + 1, ix + 1]))
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty


def block(samples, h):  # scene-heights.ts blockHeights
    s = sorted(samples); n = len(s); med = s[n >> 1] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return round(s[0] - 1, 3), round(max(med + h, s[-1] + 3), 3), med + h < s[-1] + 3


scene = {b['name']: b for b in load(live / 'scene-live.json')['buildings']}
inner = {b['buildingId']: b for b in load(live / 'buildings.json')['buildings']}
buildings = []
for o in load(audit / 'building-outlines-5186.json'):
    sc = scene.get(o['name'])
    if not sc: buildings.append({'building': o['name'], 'error': '장면에 없음'}); continue
    pts = []
    for poly in o['coordinates']:
        ring = poly[0]
        for (ax, ay), (bx, by) in zip(ring, ring[1:]):
            n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
            pts += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    p = inner[sc['buildingId']]; pts.append((p['x'], p['y']))
    b0 = block([bilinear(dem, x, y) for x, y in pts], sc['heightM']); b1 = block([bilinear(new, x, y) for x, y in pts], sc['heightM'])
    d = [bilinear(new, x, y) - bilinear(dem, x, y) for x, y in pts]
    buildings.append({'building': o['name'], 'sceneBaseRoof': [sc['baseM'], sc['roofM']], 'nowBaseRoof': b0[:2], 'newBaseRoof': b1[:2],
                      'reproducesScene': abs(b0[0] - sc['baseM']) < 0.01 and abs(b0[1] - sc['roofM']) < 0.01,
                      'baseShiftM': round(b1[0] - b0[0], 2), 'roofShiftM': round(b1[1] - b0[1], 2), 'roofRaisedRule': [b0[2], b1[2]],
                      'outlineSamples': len(pts), 'outlineSamplesChanged': sum(abs(v) > 0.01 for v in d), 'outlineDeltaM': [round(min(d), 2), round(max(d), 2)]})

roads = load(live / 'roads-live-2.json')['items']
kinds = {}; rows = []
for r in roads:
    kind = '실외' if r['buildingId'] is None and r['structure'] in ('ordinary', 'ramp', 'stairs') else '실내'
    k = kinds.setdefault(kind, {'roads': 0, 'roadsTouched': 0, 'vertices': 0, 'verticesInChangedTerrain': 0,
                                'badToOk': 0, 'okToBad': 0, 'okToOk': 0, 'badToBad': 0, 'badToBadCloser': 0, 'badToBadFarther': 0})
    k['roads'] += 1; k['vertices'] += len(r['coordinates'])
    ch = []
    for x, y, z in r['coordinates']:
        t0, t1 = bilinear(dem, x, y), bilinear(new, x, y)
        if abs(t1 - t0) < 1e-6: continue
        a, b = z - t0, z - t1
        ok0, ok1 = abs(a) <= TOL, abs(b) <= TOL
        key = 'badToOk' if not ok0 and ok1 else 'okToBad' if ok0 and not ok1 else 'okToOk' if ok0 else 'badToBad'
        k[key] += 1; k['verticesInChangedTerrain'] += 1
        if key == 'badToBad': k['badToBadCloser' if abs(b) < abs(a) else 'badToBadFarther'] += 1
        ch.append((a, b, key))
    if ch:
        k['roadsTouched'] += 1
        rows.append({'id': r['id'][:8], 'kind': kind, 'structure': r['structure'], 'buildingId': r['buildingId'], 'vertices': len(r['coordinates']), 'changed': len(ch),
                     'badToOk': sum(c[2] == 'badToOk' for c in ch), 'okToBad': sum(c[2] == 'okToBad' for c in ch),
                     'roadMinusTerrainBefore': [round(min(c[0] for c in ch), 2), round(max(c[0] for c in ch), 2)],
                     'roadMinusTerrainAfter': [round(min(c[1] for c in ch), 2), round(max(c[1] for c in ch), 2)]})
report = {'toleranceM': TOL, 'buildings': buildings, 'buildingsOver03': [b for b in buildings if max(abs(b.get('baseShiftM', 0)), abs(b.get('roofShiftM', 0))) > 0.3],
          'roads': kinds, 'roadsTouched': rows}
pathlib.Path(sys.argv[3]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({'buildings': [[b['building'], b.get('reproducesScene'), b.get('baseShiftM'), b.get('roofShiftM'), b.get('nowBaseRoof'), b.get('newBaseRoof'), b.get('outlineSamplesChanged'), b.get('outlineDeltaM')] for b in buildings], 'roads': kinds}, ensure_ascii=False, indent=1))
for row in rows: print(json.dumps(row, ensure_ascii=False))
