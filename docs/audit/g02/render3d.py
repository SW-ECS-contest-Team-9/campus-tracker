"""G02: 구조물 파일(기단 + 상자)을 근거 사진과 같은 시점에서 직접 그려 본다(프런트가 아직 구조물을 그리지 않으므로 오프라인 그림).
그리고 근거 사진 | 시험 지도 갈무리 | 이 그림 을 나란히 붙여 g02/비교-*.png 로 저장한다. DB 접근 없음.
  python render3d.py
칠하는 차례는 멀리 있는 면부터(화가 방식)라 면이 엇갈리는 곳에 작은 오류가 있을 수 있다. 재질 색은 임의다.
"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import Polygon, Point, box as sbox
from shapely.ops import unary_union
W, H = 1255, 944
feats = json.loads((HERE.parents[2] / 'frontend/public/structures/g02-way.geojson').read_text(encoding='utf-8'))['features']
views = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
blds = json.loads((G02 / 'scene-buildings-after.json').read_text(encoding='utf-8'))
grid = np.fromfile(G02 / 'terrain-recipe-d230d1170749c2f0.f32', dtype='<f4').reshape(464, 450); X0, Y0, R = 200668, 556798, 2
def gz(x, y):  # 지형 격자 쌍선형
    fx = (x - X0) / R - 0.5; fy = (y - Y0) / R - 0.5; ix = int(np.floor(fx)); iy = int(np.floor(fy)); a = fx - ix; b = fy - iy
    return float(grid[iy, ix] * (1 - a) * (1 - b) + grid[iy, ix + 1] * a * (1 - b) + grid[iy + 1, ix] * (1 - a) * b + grid[iy + 1, ix + 1] * a * b)
polys = []  # (3D 꼭짓점 목록, 색, 외곽선 여부)
def add(pts, col, edge=False): polys.append((np.array(pts, float), col, edge))
def rings(g):
    gs = [g] if g.geom_type == 'Polygon' else [q for q in getattr(g, 'geoms', []) if q.geom_type == 'Polygon']
    return [np.array(q.exterior.coords)[:-1] for q in gs if q.area > 0.01]

# 건물: 바닥~지붕 기둥. 벽은 4 m 마디 × 세로 6 m 띠로 나눔
bpolys = []
for b in blds:
    for pc in (b['g']['coordinates'] if b['g']['type'] == 'MultiPolygon' else [b['g']['coordinates']]):
        r = np.array(pc[0])[:, :2]; pg = Polygon(r)
        if not pg.is_valid: pg = pg.buffer(0)
        if pg.distance(Point(201080, 557330)) > 110: continue
        bpolys.append(pg); z0, z1 = b['base'], b['roof']
        for k in range(len(r) - 1):
            n = max(1, int(np.hypot(*(r[k + 1] - r[k])) // 4))
            for q in range(n):
                a = r[k] + (r[k + 1] - r[k]) * q / n; c = r[k] + (r[k + 1] - r[k]) * (q + 1) / n
                for zz in np.arange(z0, z1, 6.0):
                    add([[*a, zz], [*c, zz], [*c, min(zz + 6, z1)], [*a, min(zz + 6, z1)]], (203, 197, 183))
        add([[x, y, z1] for x, y in r[:-1]], (222, 218, 206))
BU = unary_union(bpolys)
# 기단: 뒤에 적힌 것이 겹친 곳을 차지한다(조리법 surface 단계와 같음). 광장은 맨 먼저
plats = [f for f in feats if f['properties']['kind'] == 'platform']; plats.sort(key=lambda f: f['properties']['id'] != 'G02-PLATFORM-PLAZA')
shapes = [Polygon(f['geometry']['coordinates'][0]).buffer(0) for f in plats]
def top(f, x, y):
    p = f['properties']
    if 'topM' in p: return p['topM']
    return float(way_z(xy_to_st(x, y)[0]))
eff = []
for k, (f, sh) in enumerate(zip(plats, shapes)):
    e = sh.difference(unary_union(shapes[k + 1:])) if k + 1 < len(shapes) else sh
    eff.append(e.difference(BU))
ALLP = unary_union(shapes)
def surface_at(x, y):  # 그 자리의 윗면 높이(기단 → 지형), 건물 안이면 None
    pt = Point(x, y)
    if BU.contains(pt): return None
    for f, e in zip(plats[::-1], eff[::-1]):
        if e.contains(pt): return top(f, x, y)
    return gz(x, y)
STRIP = [(-5.5, -3.5, (150, 148, 140)), (-3.5, -1.9, (139, 135, 128)), (-1.9, 3.3, (104, 104, 108)), (3.3, 5.5, (168, 164, 154)), (5.5, 17.5, (176, 172, 160))]
for f, e in zip(plats, eff):
    nm = f['properties']['id']
    if nm == 'G02-PLATFORM-WAY':   # 길을 따라 2 m 마디, 폭 방향으로는 세 줄 색
        for s0 in np.arange(-2, 114, 2.0):
            for t0, t1, col in STRIP:
                if s0 >= 69.3 and t0 == -3.5: t0, t1 = -2.5, -0.6
                if s0 >= 69.3 and t0 == -1.9: t0 = -0.6
                cell = Polygon([st_to_xy(s0, t0), st_to_xy(s0 + 2, t0), st_to_xy(s0 + 2, t1), st_to_xy(s0, t1)])
                for r in rings(cell.intersection(e)): add([[x, y, top(f, x, y)] for x, y in r], col)
    else:
        col = (60, 61, 66) if 'PLAZA' in nm else (186, 181, 168)
        bx = e.bounds
        for x in np.arange(np.floor(bx[0]), bx[2], 3.0):
            for y in np.arange(np.floor(bx[1]), bx[3], 3.0):
                for r in rings(sbox(x, y, x + 3, y + 3).intersection(e)): add([[px, py, top(f, px, py)] for px, py in r], col)
    for r in rings(e):   # 옆면: 바깥쪽이 더 낮을 때만, 그 높이까지
        r = np.vstack([r, r[:1]])
        for k in range(len(r) - 1):
            L = np.hypot(*(r[k + 1] - r[k])); n = max(1, int(L // 2)); d = (r[k + 1] - r[k]) / max(L, 1e-9); nrm = np.array([d[1], -d[0]])
            for q in range(n):
                a = r[k] + (r[k + 1] - r[k]) * q / n; c = r[k] + (r[k + 1] - r[k]) * (q + 1) / n; m = (a + c) / 2
                za, zc = top(f, *a), top(f, *c)
                for sgn in (1, -1):
                    o = m + sgn * nrm * 0.3
                    if e.contains(Point(o)): continue
                    zo = surface_at(*o)
                    if zo is None or zo >= min(za, zc) - 0.05: continue
                    add([[*a, zo], [*c, zo], [*c, zc], [*a, za]], (150, 146, 136)); break
# 기단 밖 지형(창 안): 2 m 칸, 꼭짓점 높이는 쌍선형
win = Polygon([st_to_xy(-60, -40), st_to_xy(135, -40), st_to_xy(135, 45), st_to_xy(-60, 45)]).difference(ALLP).difference(BU)
bx = win.bounds
for x in np.arange(np.floor(bx[0]), bx[2], 4.0):
    for y in np.arange(np.floor(bx[1]), bx[3], 4.0):
        for r in rings(sbox(x, y, x + 4, y + 4).intersection(win)): add([[px, py, gz(px, py)] for px, py in r], (214, 212, 190))
# 상자
COL = {'stair_step': (205, 200, 188), 'landing': (200, 196, 186), 'planter': (92, 122, 74), 'wall': (214, 210, 198), 'deck': (150, 108, 70), 'canopy': (88, 92, 96), 'barrier': (228, 190, 40)}
SIDE = {'planter': (128, 126, 120)}
for f in feats:
    p = f['properties']
    if p['kind'] != 'extrude': continue
    r = np.array(f['geometry']['coordinates'][0])[:-1]; z0, z1 = p['fromM'], p['toM']; col = COL.get(p['type'], (180, 180, 180))
    if p['id'] == 'G02-BARRIER-ARM': col = (220, 60, 50)
    add([[x, y, z1] for x, y in r], col, True)
    for k in range(len(r)):
        a, c = r[k], r[(k + 1) % len(r)]; add([[*a, z0], [*c, z0], [*c, z1], [*a, z1]], SIDE.get(p['type'], tuple(int(v * 0.86) for v in col)), True)

def clip_near(P, near=0.4):
    out = []
    for k in range(len(P)):
        a, b = P[k], P[(k + 1) % len(P)]
        if a[2] >= near: out.append(a)
        if (a[2] >= near) != (b[2] >= near): t = (near - a[2]) / (b[2] - a[2]); out.append(a + (b - a) * t)
    return np.array(out)
LIGHT = np.array([0.35, -0.45, 0.82]); LIGHT = LIGHT / np.linalg.norm(LIGHT)
def render(v, flip=False):
    pos, tgt = np.array(v['pos'], float), np.array(v['tgt'], float); fwd = (tgt - pos) / np.linalg.norm(tgt - pos)
    up0 = np.array([0, 0, 1.0]) if abs(fwd[2]) < 0.999 else np.array([0, -1.0 if flip else 1.0, 0])
    right = np.cross(fwd, up0); right /= np.linalg.norm(right); up = np.cross(right, fwd); f = (W / 2) / np.tan(np.radians(v['fov']) / 2)
    items = []
    for P, col, edge in polys:
        C = np.stack([(P - pos) @ right, (P - pos) @ up, (P - pos) @ fwd], 1)
        if C[:, 2].max() < 0.4: continue
        C = clip_near(C)
        if len(C) < 3: continue
        n = np.cross(P[1] - P[0], P[2] - P[0]); ln = np.linalg.norm(n); sh = 0.62 + 0.38 * abs(float(n @ LIGHT) / ln) if ln > 1e-9 else 1
        px = np.stack([W / 2 + f * C[:, 0] / C[:, 2], H / 2 - f * C[:, 1] / C[:, 2]], 1)
        if px[:, 0].max() < -200 or px[:, 0].min() > W + 200 or px[:, 1].max() < -200 or px[:, 1].min() > H + 200: continue
        items.append((float(np.linalg.norm(C, axis=1).mean()), [tuple(q) for q in np.clip(px, -4000, 4000)], tuple(int(c * sh) for c in col), edge))
    im = Image.new('RGB', (W, H), (226, 233, 236)); d = ImageDraw.Draw(im)
    for _, px, col, edge in sorted(items, key=lambda q: -q[0]): d.polygon(px, fill=col, outline=(70, 70, 70) if edge else None)
    return im
try: FONT = ImageFont.truetype('malgun.ttf', 22)
except Exception: FONT = ImageFont.load_default()
def fit(im, h=640, w=None):
    im = im.convert('RGB'); w = w or round(im.width * h / im.height); s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s))); l = (im.width - w) // 2; t = (im.height - h) // 2; return im.crop((l, t, l + w, t + h))
for name, v in views.items():
    k = name[0]; mine = render(v, flip=(k == '6'))
    if k == '6':   # 근거 = 편 정사 그림(북이 위). 지도 갈무리는 남이 위로 찍혀 180도 돌림
        o = Image.open(G02 / 'smap-ortho-rectified-01m.png'); ext = 2 * (421 - 138) * np.tan(np.radians(10)); hh = ext * H / W
        ev = Image.new('RGB', (round(ext * 10), round(hh * 10)), (0, 0, 0)); ev.paste(o, (round((201030 - (201080 - ext / 2)) * 10), round(((557333 + hh / 2) - 557366) * 10)))
        mp = Image.open(G02 / f'지도-{k}.jpg').rotate(180); mine = mine.rotate(180)
    else:
        ev = Image.open(AUDIT / v['evidence']); mp = Image.open(G02 / f'지도-{k}.jpg')
    hgt = 640; a = fit(ev, hgt, round(hgt * W / H) if k != '1' and k != '8' and k != '7' else None); b = fit(mp, hgt); c = fit(mine, hgt)
    out = Image.new('RGB', (a.width + b.width + c.width + 20, hgt + 44), (255, 255, 255)); d = ImageDraw.Draw(out); x = 0
    for im, lab in ((a, '근거: ' + v['evidence'].split('/')[-1]), (b, '시험 지도(지금 화면, 구조물 안 그려짐)'), (c, '구조물 파일을 그리면(오프라인 그림, 프런트 미반영)')):
        out.paste(im, (x, 44)); d.text((x + 6, 8), lab[:60], fill=(0, 0, 0), font=FONT); x += im.width + 10
    out.save(G02 / f'비교-{name}.png'); print(name, out.size)
