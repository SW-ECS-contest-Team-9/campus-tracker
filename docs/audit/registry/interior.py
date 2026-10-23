"""사2 건물 안 구조: 동 노트 머리의 `실내_구조` -> frontend/public/interiors.geojson (층 펼치기 화면 전용).

building_registry.py 가 부른다(write·check 에 함께 들어간다). 노트 양식(건물 규칙서 "동 노트 양식"의 사2 항목):
  실내_구조:
    기본값: {복도_폭: m, 계단_폭: m, 승강기: [가로, 세로], 방향: 도(가로 변이 동쪽에서 반시계로 돈 각), 등급}
    공간:
      - {종류: 복도|로비|연결|계단실|승강기, 이름, 층: [층_바닥_높이.층 의 이름, ...], 등급, 출처(없어도 됨), 길: [실내 길 id 앞 8자리, ...](없어도 됨),
         층_표: 층_바닥_높이 안의 표 이름(은주1관 등. 동에 표가 여럿일 때. 없으면 동의 표. 그 표를 창에 쓰는 겉모습의 첫 대상이 building),
         모양은 셋 중 하나:
           선: [[x, y], ...] + 폭(없으면 복도·로비·연결은 복도_폭, 계단실은 계단_폭)   # 토막마다 끝을 폭의 반만큼 늘린 띠
           외곽: [[x, y], ...]                                                          # 다각형(닫지 않아도 됨)
           중심: [x, y] + 크기: [가로, 세로](승강기는 없으면 기본값) + 방향(없으면 기본값)  # 직사각형
        }
좌표는 EPSG:5186 m. 층은 그 동의 층 표에 있어야 하고 높이는 표에서 읽는다(표에 없는 이름이면 실패).
표시 전용이라 등급 추정도 싣는다(등급을 그대로 함께 싣는다). 모름은 적지 않는다.
"""
import math

GENERATED = 'Generated from the building notes (실내_구조) by docs/audit/registry/building_registry.py (write); do not edit by hand.'
ABOUT = ('Inside of buildings for the exploded floor view (level-view-layer.ts): every feature is an empty space (corridor, lobby, link, '
         'stairwell, elevator shaft) carved out of the floors it names; floorsM are the floor heights of the note. Display only.')
KINDS = {'복도': 'corridor', '로비': 'lobby', '연결': 'link', '계단실': 'stair', '승강기': 'elevator'}
GRADES = ('확정', '원천', 'S-MAP', '추정')
r2 = lambda v: round(float(v), 2)
num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
pt = lambda p: isinstance(p, (list, tuple)) and len(p) >= 2 and num(p[0]) and num(p[1])


def floor_table(head, name=None):
    t = head.get('층_바닥_높이') if isinstance(head.get('층_바닥_높이'), dict) else {}
    if name: t = t.get(name) if isinstance(t.get(name), dict) else {}
    t = t.get('층') or {}
    return {str(k): v['값'] for k, v in t.items() if isinstance(v, dict) and num(v.get('값'))}


def close(ring):
    ring = [[r2(p[0]), r2(p[1])] for p in ring]
    return ring if ring[0] == ring[-1] else ring + [ring[0]]


def band(line, width):
    """Rectangles of the segments of a line, each grown by width/2 at both ends (joints are covered)."""
    out = []
    h = width / 2
    for a, b in zip(line, line[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        if n < 1e-6: continue
        ux, uy = dx / n, dy / n
        nx, ny = -uy * h, ux * h
        a2, b2 = (a[0] - ux * h, a[1] - uy * h), (b[0] + ux * h, b[1] + uy * h)
        out.append([close([[a2[0] - nx, a2[1] - ny], [b2[0] - nx, b2[1] - ny], [b2[0] + nx, b2[1] + ny], [a2[0] + nx, a2[1] + ny]])])
    return out


def box(c, size, deg):
    a = math.radians(deg)
    ux, uy, vx, vy = math.cos(a), math.sin(a), -math.sin(a), math.cos(a)
    w, d = size[0] / 2, size[1] / 2
    return [close([[c[0] + sx * w * ux + sy * d * vx, c[1] + sx * w * uy + sy * d * vy] for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])]


def scene_id(head):
    """The scene building of the note: 모델_추가.건물_id (a building added to the scene), else 서버_건물_id (its first word), else 이름."""
    added = (head.get('모델_추가') or {}).get('건물_id') if isinstance(head.get('모델_추가'), dict) else None
    return str(added or ((head.get('모델_id') or {}).get('서버_건물_id')) or head.get('이름')).split(' ')[0]


def part_of(head, table):
    """The scene part of a named floor table: the first 대상 of the 겉모습 whose 창 uses it (은주2관 -> 은주관#2관), else None."""
    if not table: return None
    for e in head.get('겉모습') or []:
        if isinstance(e, dict) and (e.get('창') or {}).get('층_표') == table and e.get('대상'): return str(e['대상'][0])
    return None


def from_note(head):
    """(features, problems) of the note's 실내_구조; ([], []) when it has none."""
    s = head.get('실내_구조')
    if s is None: return [], []
    problems = []
    if not isinstance(s, dict) or not isinstance(s.get('공간'), list):
        return [], ['실내_구조 는 {기본값, 공간: [...]}']
    base = s.get('기본값') or {}
    building = scene_id(head)
    out = []
    for i, it in enumerate(s['공간']):
        at = f"실내_구조.공간[{i}] '{(it or {}).get('이름')}'"
        if not isinstance(it, dict): problems.append(f'{at}: 항목이 아니다'); continue
        kind = KINDS.get(it.get('종류'))
        if not kind: problems.append(f"{at}: 종류 는 {'·'.join(KINDS)} 중 하나"); continue
        if not it.get('이름'): problems.append(f'{at}: 이름 이 없다')
        g = str(it.get('등급') or '')
        if not g.startswith(GRADES): problems.append(f'{at}: 등급 은 확정·원천·S-MAP·추정 중 하나로 시작')
        floors = it.get('층')
        if not isinstance(floors, list) or not floors: problems.append(f'{at}: 층 목록이 없다'); continue
        table = floor_table(head, it.get('층_표'))
        missing = [str(f) for f in floors if str(f) not in table]
        if missing: problems.append(f"{at}: 층 {missing} 이 층_바닥_높이{'.' + str(it['층_표']) if it.get('층_표') else ''}.층 에 없다"); continue
        if it.get('선') is not None:
            line = it['선']
            width = it.get('폭', base.get('계단_폭' if kind == 'stair' else '복도_폭'))
            if not isinstance(line, list) or len(line) < 2 or not all(pt(p) for p in line): problems.append(f'{at}: 선 은 점 둘 이상'); continue
            if not num(width) or width <= 0: problems.append(f'{at}: 폭 이 없다(기본값도 없음)'); continue
            polys = band(line, float(width))
        elif it.get('외곽') is not None:
            ring = it['외곽']
            if not isinstance(ring, list) or len(ring) < 3 or not all(pt(p) for p in ring): problems.append(f'{at}: 외곽 은 점 셋 이상'); continue
            polys = [[close(ring)]]
        elif it.get('중심') is not None:
            size = it.get('크기', base.get('승강기') if kind == 'elevator' else None)
            deg = it.get('방향', base.get('방향', 0))
            if not pt(it['중심']) or not (isinstance(size, list) and len(size) == 2 and all(num(v) and v > 0 for v in size)) or not num(deg):
                problems.append(f'{at}: 중심·크기·방향 이 숫자가 아니다'); continue
            polys = [box(it['중심'], size, float(deg))]
        else:
            problems.append(f'{at}: 모양(선 / 외곽 / 중심) 이 없다'); continue
        props = {'building': part_of(head, it.get('층_표')) or building, 'kind': kind, 'name': it.get('이름'), 'floors': [str(f) for f in floors], 'floorsM': [table[str(f)] for f in floors],
                 'grade': g, **({'source': it['출처']} if it.get('출처') else {}), **({'roads': [str(r) for r in it['길']]} if it.get('길') else {})}
        geometry = {'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1 else {'type': 'MultiPolygon', 'coordinates': polys}
        out.append({'type': 'Feature', 'properties': props, 'geometry': geometry})
    return (out, problems) if not problems else ([], problems)


def document(features):
    return {'type': 'FeatureCollection', 'about': ABOUT, 'generated': GENERATED, 'features': features}
