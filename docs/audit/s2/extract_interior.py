"""사2: 시험용 DB 실내 길(indoor-roads.json) -> 동 노트 머리에 붙일 `실내_구조` 초안(YAML 글).

  python docs/audit/s2/extract_interior.py 북악관 [--notes <동 노트 폴더>]

한 번만 쓰는 도구다. 나온 글을 동 노트에 붙이고 손으로 다듬은 뒤로는 노트가 원본이다.
- 평평한 길(높이 차 0.9 m 이하): 복도. 평면이 같은 길은 층 목록 하나로 묶는다.
- 계단: 꼭짓점을 감싸는 가장 작은 직사각형 + 계단 폭의 반. 평면이 같은 계단은 묶고, 양 끝의 층을 모두 적는다.
- 승강기: 같은 자리의 토막을 묶어 서는 층을 모두 적는다.
층은 노트 머리 `층_바닥_높이.층` 에서 1.0 m 안의 가장 가까운 것. 어느 층에도 안 드는 끝(바깥, 층이 아닌 높이)은 버린다.
indoor-roads.json 은 시험용 DB(DRAFT)에서 뽑은 것: README 의 psql 명령.
"""
import argparse, json, math, pathlib, sys
import yaml
from shapely.geometry import MultiPoint, LineString

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / 'registry'))
import building_registry as reg  # noqa: E402

LEVEL_SPAN = 0.9
FLOOR_MATCH = 1.0


def floors_of(head):
    table = ((head.get('층_바닥_높이') or {}).get('층') or {})
    return {name: v['값'] for name, v in table.items() if isinstance(v, dict) and isinstance(v.get('값'), (int, float))}


def floor_at(floors, z):
    best = min(floors.items(), key=lambda kv: abs(kv[1] - z), default=None)
    return best[0] if best and abs(best[1] - z) <= FLOOR_MATCH else None


def key(coords):
    return tuple((round(c[0], 1), round(c[1], 1)) for c in coords)


def rect_around(points, margin):
    """Smallest rotated rectangle round the plan points, grown by margin (a ring, closed)."""
    hull = MultiPoint([tuple(p[:2]) for p in points])
    shape = hull.minimum_rotated_rectangle if len(points) > 2 else LineString([tuple(p[:2]) for p in points])
    grown = shape.buffer(margin, join_style=2, cap_style=2)
    return [[round(x, 2), round(y, 2)] for x, y in grown.exterior.coords]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('building')
    ap.add_argument('--notes', default=reg.DEFAULT_NOTES)
    ap.add_argument('--stair-width', type=float, default=1.4)
    a = ap.parse_args(argv)
    head = reg.read_head((pathlib.Path(a.notes) / f'{a.building}.md').read_text(encoding='utf-8'))
    floors = floors_of(head)
    order = list(floors)
    roads = [r for r in json.load(open(HERE / 'indoor-roads.json', encoding='utf-8')) if r['buildingId'] == a.building]
    corridors, stairs, lifts = {}, {}, {}
    for r in roads:
        c = r['coordinates']; zs = [p[2] for p in c]
        if r['structure'] == 'elevator':
            k = (round(c[0][0], 1), round(c[0][1], 1))
            e = lifts.setdefault(k, {'floors': set(), 'roads': [], 'at': c[0][:2]})
            for z in (zs[0], zs[-1]):
                f = floor_at(floors, z)
                if f: e['floors'].add(f)
            e['roads'].append(r['id'][:8])
        elif r['structure'] == 'stairs' or max(zs) - min(zs) > LEVEL_SPAN:
            k = frozenset(key(c))
            e = stairs.setdefault(k, {'floors': set(), 'roads': [], 'coords': c, 'name': r['name']})
            for z in (zs[0], zs[-1]):
                f = floor_at(floors, z)
                if f: e['floors'].add(f)
            e['roads'].append(r['id'][:8])
        else:
            f = floor_at(floors, (min(zs) + max(zs)) / 2)
            if not f: continue
            k = key(c)
            e = corridors.setdefault(k, {'floors': set(), 'roads': [], 'coords': c, 'name': r['name'], 'width': r['widthM']})
            e['floors'].add(f); e['roads'].append(r['id'][:8])
    by_order = lambda s: sorted(s, key=order.index)
    items = []
    for e in corridors.values():
        items.append({'종류': '복도', '이름': (e['name'] or '이름 없는 길').split(' (')[0], '층': by_order(e['floors']),
                      '선': [[round(p[0], 2), round(p[1], 2)] for p in e['coords']], **({'폭': e['width']} if e['width'] else {}),
                      '길': e['roads'], '등급': '추정'})
    for e in stairs.values():
        if not e['floors']: continue
        items.append({'종류': '계단실', '이름': (e['name'] or '이름 없는 계단').split(' (')[0], '층': by_order(e['floors']),
                      '외곽': rect_around(e['coords'], a.stair_width / 2), '길': e['roads'], '등급': '추정'})
    for e in lifts.values():
        items.append({'종류': '승강기', '이름': '승강기', '층': by_order(e['floors']), '중심': [round(e['at'][0], 2), round(e['at'][1], 2)], '길': e['roads'], '등급': '추정'})
    sys.stdout.reconfigure(encoding='utf-8')
    print(yaml.safe_dump({'실내_구조': {'공간': items}}, allow_unicode=True, sort_keys=False, default_flow_style=None, width=400))


if __name__ == '__main__':
    main()
