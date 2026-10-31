"""사2 일치 검사: interiors.geojson(노트의 실내_구조) 의 빈 곳이 시험용 DB 실내 길(indoor-roads.json)과 맞는가.

  python docs/audit/s2/match_roads.py [--min 0.95]

건물·층마다
- 평평한 실내 길(높이 차 0.9 m 이하, 층 표 1.0 m 안) 길이 중 그 층 빈 곳 안에 드는 몫(목표 --min 이상),
- 계단·승강기 길의 양 끝(층 높이 0.5 m 안인 끝)이 그 층의 계단실·승강기 빈 곳(또는 다른 빈 곳) 안인지,
- 빈 곳의 `길` 이 덤프에 있는지.
목표에 못 미치는 층이 있으면 1 로 끝난다. 실내 길이 바뀌면(덤프를 새로 뽑고) 노트를 고친다.
"""
import argparse, json, pathlib, sys
from shapely.geometry import LineString, Point, shape
from shapely.ops import unary_union

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--interiors', default=str(ROOT / 'frontend/public/interiors.geojson'))
    ap.add_argument('--roads', default=str(HERE / 'indoor-roads.json'))
    ap.add_argument('--min', type=float, default=0.95)
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding='utf-8')
    feats = json.load(open(a.interiors, encoding='utf-8'))['features']
    roads = json.load(open(a.roads, encoding='utf-8'))
    ids = {r['id'][:8] for r in roads}
    voids = {}   # (building, floor height) -> [shape]
    for f in feats:
        p = f['properties']
        for m in p['floorsM']: voids.setdefault((p['building'], m), []).append(shape(f['geometry']).buffer(0.05))
        for r in p.get('roads', []):
            if r not in ids: print(f"[길 없음] {p['building']} '{p['name']}': 길 {r} 이 덤프에 없다")
    union = {k: unary_union(v) for k, v in voids.items()}
    heights = {}
    for b, m in union: heights.setdefault(b, []).append(m)
    bad = 0
    stats = {}
    for r in roads:
        b = r['buildingId'] if r['buildingId'] in heights else r['buildingId'].split('#')[0]   # 부분(은주관#2관)의 길은 그 부분의 빈 곳(층 표가 따로인 부분), 없으면 그 동의 빈 곳과 견준다
        if b not in heights: continue
        c = r['coordinates']; zs = [q[2] for q in c]
        if r['structure'] != 'elevator' and r['structure'] != 'stairs' and max(zs) - min(zs) <= 0.9:
            z = (min(zs) + max(zs)) / 2
            m = min(heights[b], key=lambda h: abs(h - z))
            if abs(m - z) > 1.0: continue
            line = LineString([q[:2] for q in c])
            s = stats.setdefault((b, m), [0.0, 0.0, []])
            inside = line.intersection(union[(b, m)]).length
            s[0] += line.length; s[1] += inside
            if inside < line.length * 0.95: s[2].append(r['id'][:8])
        else:
            for q in (c[0], c[-1]):
                m = min(heights[b], key=lambda h: abs(h - q[2]))
                if abs(m - q[2]) > 0.5: continue
                if not union[(b, m)].contains(Point(q[:2])):
                    print(f"[끝 밖] {b} {m}: {r['structure']} {r['id'][:8]} 끝 ({q[0]:.1f}, {q[1]:.1f}) 이 빈 곳 밖"); bad += 1
    for (b, m), (total, inside, out) in sorted(stats.items()):
        share = inside / total if total else 1
        ok = share >= a.min
        bad += not ok
        print(f"{'  ' if ok else '[미달]'} {b} {m:.1f} m: 평평한 길 {total:.0f} m 중 {share:.1%} 가 빈 곳 안" + (f" (밖으로 나간 길 {', '.join(out)})" if out else ''))
    print('일치' if not bad else f'맞지 않는 곳 {bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
