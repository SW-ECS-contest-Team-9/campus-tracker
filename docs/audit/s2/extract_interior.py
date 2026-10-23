"""사2: 시험용 DB 실내 길(indoor-roads.json) -> 동 노트 머리의 `실내_구조` 초안.

  python docs/audit/s2/extract_interior.py 북악관 [--notes <동 노트 폴더>] [--apply]

한 동에 한 번만 쓰는 도구다. --apply 는 노트 머리 끝(닫는 --- 앞)에 실내_구조 를 넣는다(이미 있으면 하지 않는다).
그 뒤로는 노트가 원본이고 손으로 다듬는다.
- 층: 길의 levelId '건물_1F' -> '1층', '건물_B1' -> 'B1'. levelId 가 없거나 층 표에 없는 이름이면 높이로(층 표에서 1.0 m 안).
  층 표에 없는 층(북악관 '8F_추정' 등)의 길은 버린다.
- 평평한 길(높이 차 0.9 m 이하, 문턱 이음 포함): 복도(폭 2.4). 이름에 '홀'·'로비' -> 로비(폭 4.0), '연결 통로' -> 연결.
  평면이 같은 길은 층 목록 하나로 묶는다.
- 계단(또는 높이 차 0.9 m 넘는 길): 끝이 층 높이에서 0.5 m 안인 층만 적는다. 꼭짓점을 감싸는 가장 작은 직사각형 + 계단 폭의 반. 평면이 같은 계단은 묶고 양 끝 층을 모두 적는다.
- 승강기: 1.0 m 안의 토막을 한 대로 묶어 서는 층을 모두 적는다(중심은 평균).
indoor-roads.json 은 시험용 DB(DRAFT·APPROVED, building_id 있는 길)에서 뽑은 것:
  docker exec campus-tracker-test-db psql -U campus -d campus -Atc "select json_agg(json_build_object('id',id,'buildingId',building_id,
    'structure',structure,'levelId',level_id,'widthM',width_m,'name',name,'coordinates',(st_asgeojson(geom,2)::json)->'coordinates')
    order by building_id, level_id, id) from mobility.road_segments where building_id is not null and status in ('DRAFT','APPROVED')"
    > docs/audit/s2/indoor-roads.json
"""
import argparse, json, math, pathlib, re, sys
import yaml
from shapely.geometry import MultiPoint, LineString

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / 'registry'))
import building_registry as reg  # noqa: E402
from interior import scene_id  # noqa: E402

LEVEL_SPAN = 0.9
FLOOR_MATCH = 1.0
STAIR_MATCH = 0.5   # a stair end counts for a floor only this near (an entrance stair from outside does not carve the floor below)
LIFT_JOIN = 1.0


def floors_of(head):
    table = ((head.get('층_바닥_높이') or {}).get('층') or {})
    return {str(name): v['값'] for name, v in table.items() if isinstance(v, dict) and isinstance(v.get('값'), (int, float))}


def floor_at(floors, z):
    best = min(floors.items(), key=lambda kv: abs(kv[1] - z), default=None)
    return best[0] if best and abs(best[1] - z) <= FLOOR_MATCH else None


def floor_of_level(floors, level):
    """'북악관_1F' -> '1층', '혜인관_B1' -> 'B1'; None when the table has no such floor."""
    tail = str(level or '').rsplit('_', 1)[-1] if level else ''
    m = re.fullmatch(r'(\d+)F', tail)
    name = f'{m.group(1)}층' if m else tail
    return name if name in floors else None


def key(coords):
    return tuple((round(c[0], 1), round(c[1], 1)) for c in coords)


def rect_around(points, margin):
    """Smallest rotated rectangle round the plan points, grown by margin (a ring, open)."""
    pts = [tuple(p[:2]) for p in points]
    shape = MultiPoint(pts).minimum_rotated_rectangle
    if shape.geom_type != 'Polygon': shape = LineString(pts)
    grown = shape.buffer(margin, join_style=2, cap_style=2)
    return [[round(x, 2), round(y, 2)] for x, y in list(grown.exterior.coords)[:-1]]


def short(name, fallback):
    return re.split(r' \(', name or '')[0].strip() or fallback


def draft(head, roads, stair_width=1.4):
    floors = floors_of(head)
    order = list(floors)
    by_order = lambda s: sorted(s, key=order.index)
    corridors, stairs, lifts = {}, {}, []
    for r in roads:
        c = r['coordinates']; zs = [p[2] for p in c]
        near = lambda z: (lambda f: f if f and abs(floors[f] - z) <= STAIR_MATCH else None)(floor_at(floors, z))
        ends = {f for f in (near(zs[0]), near(zs[-1])) if f}
        if r['structure'] == 'elevator':
            at = c[0][:2]
            e = next((e for e in lifts if math.dist(e['at'], at) <= LIFT_JOIN), None)
            if not e: e = {'floors': set(), 'roads': [], 'pts': [], 'at': at}; lifts.append(e)
            e['floors'] |= ends; e['roads'].append(r['id'][:8]); e['pts'].append(at)
            e['at'] = [sum(p[0] for p in e['pts']) / len(e['pts']), sum(p[1] for p in e['pts']) / len(e['pts'])]
        elif r['structure'] == 'stairs' or max(zs) - min(zs) > LEVEL_SPAN:
            e = stairs.setdefault(frozenset(key(c)), {'floors': set(), 'roads': [], 'coords': c, 'name': r['name']})
            e['floors'] |= ends; e['roads'].append(r['id'][:8])
        else:
            f = floor_of_level(floors, r['levelId']) if r['levelId'] else floor_at(floors, (min(zs) + max(zs)) / 2)
            if not f: continue
            e = corridors.setdefault(key(c), {'floors': set(), 'roads': [], 'coords': c, 'name': r['name']})
            e['floors'].add(f); e['roads'].append(r['id'][:8])
    items = []
    for e in corridors.values():
        name = short(e['name'], '복도')
        kind = '연결' if re.search('연결.{0,3}통로', name) else '로비' if re.search('홀|로비', name) else '복도'
        items.append({'종류': kind, '이름': name, '층': by_order(e['floors']), '선': [[round(p[0], 2), round(p[1], 2)] for p in e['coords']],
                      **({'폭': 4.0} if kind == '로비' else {}), '길': sorted(e['roads']), '등급': '추정'})
    for e in stairs.values():
        if not e['floors']: continue
        items.append({'종류': '계단실', '이름': short(e['name'], '계단'), '층': by_order(e['floors']),
                      '외곽': rect_around(e['coords'], stair_width / 2), '길': sorted(e['roads']), '등급': '추정'})
    for k, e in enumerate(lifts, 1):
        if not e['floors']: continue
        items.append({'종류': '승강기', '이름': f'승강기 {k}' if len(lifts) > 1 else '승강기', '층': by_order(e['floors']),
                      '중심': [round(e['at'][0], 2), round(e['at'][1], 2)], '길': sorted(e['roads']), '등급': '추정'})
    return items


def block(items):
    flow = lambda v: yaml.safe_dump(v, allow_unicode=True, default_flow_style=True, width=100000, sort_keys=False).strip()
    lines = ['실내_구조:',
             f"  기본값: {flow({'복도_폭': 2.4, '계단_폭': 1.4, '승강기': [2.0, 2.0], '방향': 0, '등급': '추정'})}",
             '  비고: "사2 층 펼치기 화면 전용(interiors.geojson). 시험용 DB 실내 길(아1·옛 길, 모두 추정)에서 docs/audit/s2/extract_interior.py 로 뽑음. '
             '장면 보정 파일로 가지 않아 규칙 4(추정은 모델에 넣지 않음)의 예외. 현장 확인 뒤 고친다"',
             '  공간:']
    lines += [f'    - {flow(it)}' for it in items]
    return '\n'.join(lines) + '\n'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('building', help='동 노트 이름')
    ap.add_argument('--notes', default=reg.DEFAULT_NOTES)
    ap.add_argument('--roads', default=str(HERE / 'indoor-roads.json'))
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args(argv)
    path = pathlib.Path(a.notes) / f'{a.building}.md'
    text = path.read_text(encoding='utf-8')
    head = reg.read_head(text)
    sid = scene_id(head)
    roads = [r for r in json.load(open(a.roads, encoding='utf-8')) if r['buildingId'] == sid]
    items = draft(head, roads)
    out = block(items)
    sys.stdout.reconfigure(encoding='utf-8')
    if not a.apply:
        print(out); return 0
    if '실내_구조' in head:
        print(f'{a.building}: 노트에 실내_구조 가 이미 있다(노트가 원본, 덮어쓰지 않음)'); return 1
    if not items:
        print(f'{a.building}: 뽑을 실내 길이 없다'); return 1
    lines = text.split('\n')
    close = lines.index('---', 1)
    lines[close:close] = out.rstrip('\n').split('\n')
    path.write_text('\n'.join(lines), encoding='utf-8', newline='\n')
    print(f'{a.building}: 실내_구조 {len(items)}개 넣음 (길 {len(roads)}개, 서버 id {sid})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
