"""N03 공용: 볼트 경로, 위경도 -> EPSG:5186, 출입구 목록(동 노트 머리 + 학교 장소 목록), 길·영역 그래프.
DB 접근 없음. 입력은 n02.ts state 가 쓴 상태 파일과 편집기 REST GET areas 결과."""
import json, math, pathlib, heapq, glob
import yaml

VAULT = pathlib.Path(r'C:\campus-tracker-backend\데이터')
AUDIT = VAULT / '보완자료' / '3d-map-audit-20261009'
N03 = AUDIT / 'n03'
NOTES = VAULT / '모델링 개선' / '건물'
HERE = pathlib.Path(__file__).parent
REPO = HERE.parents[2]
SAME_Z, NEAR_Z = 0.3, 1.25          # backend/src/modules/editor/topology.ts
AREA_Z, AREA_EDGE = 0.5, 0.5        # backend/src/modules/editor-mcp/area-links.ts


def to5186(lat, lon):
    """GRS80 횡단 메르카토르: 원점 38N 127E, 축척 1, 가산 200000 / 600000."""
    a, f = 6378137.0, 1 / 298.257222101
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    def M(p):
        return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * p - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * p)
                    + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * p) - 35 * e2**3 / 3072 * math.sin(6 * p))
    p, l = math.radians(lat), math.radians(lon); p0, l0 = math.radians(38), math.radians(127)
    N = a / math.sqrt(1 - e2 * math.sin(p)**2); T = math.tan(p)**2; C = ep2 * math.cos(p)**2; A = (l - l0) * math.cos(p)
    x = N * (A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120)
    y = M(p) - M(p0) + N * math.tan(p) * (A**2 / 2 + (5 - T + 9 * C + 4 * C**2) * A**4 / 24 + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720)
    return round(200000 + x, 1), round(600000 + y, 1)


def school_places():
    """학교 캠퍼스맵 '교통 및 출입' 35곳(은주2관 입구(1)은 분류가 비어 있음)."""
    d = json.loads((REPO / 'backend/data/terrain/source/skuniv_places.json').read_text(encoding='utf-8'))
    out = []
    for i in d:
        if i['카테고리'] == '교통 및 출입' or i['장소명'] == '은주2관 입구(1)':
            x, y = to5186(float(i['위도']), float(i['경도']))
            out.append({'name': i['장소명'], 'xy': [x, y], 'desc': i['설명']})
    return out


def note_entrances():
    """동 노트 머리의 출입구(좌표가 숫자인 것만). 바닥_높이가 숫자가 아니면 None."""
    out = []
    for f in sorted(glob.glob(str(NOTES / '*.md'))):
        t = pathlib.Path(f).read_text(encoding='utf-8')
        if not t.startswith('---'): continue
        y = yaml.safe_load(t.split('---')[1])
        for e in y.get('출입구') or []:
            c = e.get('좌표')
            if not (isinstance(c, list) and len(c) == 2): continue
            z = e.get('바닥_높이')
            out.append({'building': pathlib.Path(f).stem, 'name': e['이름'], 'xy': c, 'z': z if isinstance(z, (int, float)) else None,
                        'floor': e.get('층'), 'grade': e.get('등급'), 'ground': e.get('문_앞_지면')})
    return out


class Net:
    def __init__(self, state_file, areas_file):
        S = json.loads(pathlib.Path(state_file).read_text(encoding='utf-8'))
        self.roads = S['roads']; self.nodes = {n['id']: n for n in S['nodes']}; self.places = S['places']; self.S = S
        a = json.loads(pathlib.Path(areas_file).read_text(encoding='utf-8'))
        self.areas = a if isinstance(a, list) else a.get('areas') or a.get('items')
        self.used = {n for r in self.roads for n in (r['fromNodeId'], r['toNodeId'])}
        self.adj = {}
        for r in self.roads:
            self._edge(r['fromNodeId'], r['toNodeId'], r['lengthM'], r['id'][:8], r['pedestrianAccess'], r['vehicleAccess'])
        self.access = {}
        for ar in self.areas:
            if ar.get('elevationM') is None: continue
            rings = self._rings(ar)
            pts = [n for n in self.used if abs(self.nodes[n]['coordinate'][2] - ar['elevationM']) <= AREA_Z and self._on(rings, self.nodes[n]['coordinate'])]
            self.access[ar['id']] = pts
            for i, p in enumerate(pts):
                for q in pts[i + 1:]:
                    cp, cq = self.nodes[p]['coordinate'], self.nodes[q]['coordinate']
                    self._edge(p, q, math.hypot(cp[0] - cq[0], cp[1] - cq[1]), f"area:{ar['id']}", 'allowed', 'unknown')   # 직선 거리(모서리 우회는 서버 검사가 계산)

    def _edge(self, a, b, w, rid, ped, veh):
        self.adj.setdefault(a, []).append((b, w, rid, ped, veh)); self.adj.setdefault(b, []).append((a, w, rid, ped, veh))

    @staticmethod
    def _rings(ar):
        g = ar.get('geometry') or ar
        if isinstance(g, str): g = json.loads(g)
        c = g.get('coordinates')
        if g.get('type') == 'MultiPolygon': c = c[0]
        return c

    @staticmethod
    def _on(rings, p):
        def inside(ring):
            ins = False
            for a, b in zip(ring, ring[1:] + ring[:1]):
                if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]): ins = not ins
            return ins
        def edge_d(ring):
            best = 1e9
            for a, b in zip(ring, ring[1:] + ring[:1]):
                dx, dy = b[0] - a[0], b[1] - a[1]; L = dx * dx + dy * dy
                t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) if L else 0
                best = min(best, math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
            return best
        if min(edge_d(r) for r in rings) <= AREA_EDGE: return True
        return inside(rings[0]) and not any(inside(h) for h in rings[1:])

    def nearest(self, xy, z=None, radius=6.0):
        """반경 안의 쓰이는 노드들: (평면 거리, 높이 차, id). 높이가 주어지면 높이 차가 작은 것 먼저."""
        c = []
        for n in self.used:
            x, y, zz = self.nodes[n]['coordinate']; d = math.hypot(x - xy[0], y - xy[1])
            if d <= radius: c.append((round(d, 2), None if z is None else round(zz - z, 2), n))
        c.sort(key=lambda t: (abs(t[1]) > SAME_Z, abs(t[1]) > NEAR_Z, t[0]) if z is not None else (t[0],))
        return c

    def dijkstra(self, src, mode='walk_assume'):
        ok = {'walk': lambda p, v: p == 'allowed', 'walk_assume': lambda p, v: p != 'prohibited', 'vehicle_assume': lambda p, v: v != 'prohibited'}[mode]
        dist = {src: 0.0}; prev = {}; h = [(0.0, src)]
        while h:
            d, u = heapq.heappop(h)
            if d > dist.get(u, 1e18): continue
            for v, w, rid, ped, veh in self.adj.get(u, []):
                if not ok(ped, veh): continue
                if rid.startswith('area:') and mode.startswith('vehicle'): continue
                nd = d + w
                if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = (u, rid); heapq.heappush(h, (nd, v))
        return dist, prev

    def components(self, mode='walk_assume'):
        seen = {}; k = 0
        for n in self.used:
            if n in seen: continue
            d, _ = self.dijkstra(n, mode)
            for m in d: seen[m] = k
            k += 1
        return seen
