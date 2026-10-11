"""P02 구조물(운동장 바닥 밖의 것): 바위 정원, 수인관 남동쪽 유리 덩어리, 회차 공간 바닥 표시, 유담관 3층 입구(서경스포렉스), 유담관 공도 쪽 기단의 기와 띠, 생활관 3동 글자 판, 보국문로16라길 바닥 표시.
전부 estimated. 높이·자리의 근거는 S-MAP 메시(볼트의 smap-mesh-*.txt)와 사용자 사진이고 치수는 눈대중이다. DB·네트워크 접근 없음."""
import json, math, pathlib, random
import numpy as np
from shapely.geometry import Polygon as SP, Point, shape
from shapely.ops import unary_union
import field
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
EV = '데이터/보완자료/3d-map-audit-20261009/'
FEATS = None
def poly(pid, typ, g, z0, z1, what, src, grade, base, **extra):
    gs = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.003]; assert z1 > z0, pid
    for n, q in enumerate(gs):
        FEATS.append({'type': 'Feature', 'properties': {'id': pid if len(gs) == 1 else f'{pid}-{n + 1}', 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(z0), 'toM': r2(z1), 'assumption': what, 'source': src, **extra},
                      'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in q.exterior.coords]] + [[[r2(x), r2(y)] for x, y in h.coords] for h in q.interiors]}})
def box(pid, typ, pts, z0, z1, what, src, grade, base, **extra): poly(pid, typ, SP(pts), z0, z1, what, src, grade, base, **extra)
def unit(v): v = np.array(v, float); return v / np.hypot(*v)
def frame(o, along, out):
    o, a = np.array(o, float), unit(along); n = np.array([-a[1], a[0]]); n = n if n @ np.array(out, float) > 0 else -n
    return (lambda s0, s1, d0, d1: [o + a * s0 + n * d0, o + a * s1 + n * d0, o + a * s1 + n * d1, o + a * s0 + n * d1]), (lambda s, d: o + a * s + n * d)
def sq(c, h): return [(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)]
def ngon(c, r, n=8): return [(c[0] + r * math.cos(2 * math.pi * k / n + 0.39), c[1] + r * math.sin(2 * math.pi * k / n + 0.39)) for k in range(n)]
def tree(tid, c, z, what, src, base, s=1.0):
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.18, 0.0, 3.0), ('CROWN', 'foliage', 1.3, 2.8, 4.2), ('TOP', 'foliage', 0.75, 4.2, 5.2)):
        box(f'{tid}-{part}', 'tree', sq(c, h * s), z + z0 * s, z + z1 * s, f'{what}: 단순한 나무(실제 그루 수·자리·수종의 모양이 아니다)', src, '원천(이 자리에 소나무: 사진), 추정(그루 수·자리·크기)', base, material=mat)
_PLAT = None
def ground(x, y):
    """그 점을 덮는 기단 윗면 가운데 가장 높은 값(바닥 표시를 그 위에 얹으려고)."""
    global _PLAT
    if _PLAT is None:
        _PLAT = []
        for f in sorted(STR.glob('z0*.geojson')):
            for ft in json.loads(f.read_text(encoding='utf-8'))['features']:
                if ft['properties'].get('kind') == 'platform': _PLAT.append((shape(ft['geometry']).buffer(0), ft['properties']))
    best = None; pt = Point(x, y)
    for g, p in _PLAT:
        if not g.contains(pt): continue
        if p.get('topM') is not None: z = p['topM']
        else:
            pr = p['topProfile']; t = (x - pr['origin'][0]) * pr['direction'][0] + (y - pr['origin'][1]) * pr['direction'][1]; ps = pr['points']
            z = float(np.interp(t, [q[0] for q in ps], [q[1] for q in ps]))
        best = z if best is None else max(best, z)
    assert best is not None, (x, y); return best
FONT = dict(field.FONT, B='11110 10001 10001 11110 10001 10001 11110', **{'3': '11110 00001 00001 01110 00001 00001 11110', '0': '01110 10001 10011 10101 11001 10001 01110'})
def paint(pid, pts, what, src, grade, base, color='#f2f2ee', lift=0.22):   # 차도 면(길의 꼭짓점 높이로 그려진다)이 기단 윗면보다 조금 높아 그 위로 띄운다
    """바닥의 칠: 그 자리 기단 윗면 위 lift 에 두께 3 cm 판."""
    g = SP(pts); c = g.centroid; z = ground(c.x, c.y) + lift
    poly(pid, 'wall', g, z, z + 0.03, what + '(바닥의 칠을 얇은 판으로 나타냄)', src, grade, base, color=color, surfaceMark=True)
def letters(pid, text, P, s0, d0, cw, ch, what, src, grade, base, color='#f2f2ee', lift=0.22):
    """P(s, d) 틀에서 s 로 읽어 나가는 글자(윗줄이 d 가 큰 쪽)."""
    for i, c in enumerate(text):
        cells = [SP([P(s0 + i * cw * 6 + col * cw, d0 + (6 - row) * ch), P(s0 + i * cw * 6 + (col + 1) * cw, d0 + (6 - row) * ch), P(s0 + i * cw * 6 + (col + 1) * cw, d0 + (7 - row) * ch), P(s0 + i * cw * 6 + col * cw, d0 + (7 - row) * ch)]) for row, bits in enumerate(FONT[c].split()) for col, b in enumerate(bits) if b == '1']
        g = unary_union(cells).buffer(0.001); c0 = g.centroid; z = ground(c0.x, c0.y) + lift
        poly(f'{pid}-{i + 1}-{c}', 'wall', g, z, z + 0.03, f'{what}: 글자 {c}', src, grade, base, color=color, surfaceMark=True)

# ================= 1. 굽잇길 아래 바위 정원 =================
# R01: 가운데 옹벽의 기단을 다시 잡았다(z05/build_inputs.py): 아랫벽 면 = 동좌표 201102.9 의 곧은 선, 그 위 소나무 턱 125.5 m, 굽이 아래 돌 단 117.8 m. 바위 덩이는 아랫벽 면 앞에 얹는다
WALLX, LEDGE_Z, TERR_Z = 201102.9, 125.5, 117.8
def rocks():
    SRC = '사용자-학교전경-20261012/04-한림관-원통-아래에서-바위정원-계단.jpg, 사용자-네이버거리뷰-20261012/09·10-네이버거리뷰-전방위.jpg, S-MAP 0.5 m 메시(z03/smap-mesh-z03-plaza-05m-c·d)'
    G = '원천(큰 바위 절벽과 소나무, 그 위 콘크리트 윗벽: 사용자 사진 04·거리뷰 09), S-MAP(바위 면의 발치와 머리: 남쪽 덩이 동좌표 201098.7 → 201103(117.8 → 125 m)·북좌표 557227~557240, 굽이 아래 돌 단 뒤 동좌표 201102.6~201105, 북쪽 덩이 북좌표 557252~557256), 추정(바위 낱덩이의 자리·크기·모양, 남쪽 덩이의 남쪽 끝 북좌표 557227: 거리뷰 09 에서 그 남쪽은 짙은 돌 옹벽)'
    rnd = random.Random(402); COL = ['#b7b2a6', '#a59f93', '#c4bfb3', '#958f84', '#aeb0ab']
    def blob(c, r):   # 모난 바위 평면
        n = rnd.randint(5, 7); a0 = rnd.random() * 6.28
        return SP([(c[0] + r * rnd.uniform(0.7, 1.15) * math.cos(a0 + 2 * math.pi * k / n), c[1] + r * rnd.uniform(0.7, 1.15) * math.sin(a0 + 2 * math.pi * k / n)) for k in range(n)]).buffer(0)
    Z03 = [(shape(f['geometry']).buffer(0), f['properties']['toM']) for f in json.loads((STR / 'z03-fountain.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'].startswith('Z03-EAST-')]
    def stand(g, embed=0.0):   # 바위 조각·화단이 딛는 높이: 그 자리 계단식 인도(Z03)의 참·단 윗면(그 위에 선다: 겹치지 않게), 없으면 기단 윗면에서 embed 만큼 묻는다
        c = g.representative_point(); on = [t for q, t in Z03 if q.intersects(g)]; return max(on) if on else ground(c.x, c.y) - embed
    k = [0]
    def rock(tag, g, top, what, base):
        if g.is_empty or g.area < 0.15: return
        b0 = stand(g, 0.5); k[0] += 1; poly(f'P02-ROCKGARDEN-ROCK-{tag}{k[0]:02d}', 'wall', g, b0, max(top, b0 + 0.6), what, SRC, G, base, color=COL[k[0] % len(COL)])
    # 남쪽 덩이: 아랫벽 면에서 서쪽으로 4 m 나온 바위(발치 동좌표 201098.8). 벽 쪽이 높고 발치로 낮아지는 네 줄
    y = 557226.4
    while y < 557240.3:
        w = rnd.uniform(1.7, 3.0); yc = y + w / 2; f = ground(201099.3, min(yc, 557240.0)); taper = min(1.0, 0.45 + (yc - 557226.4) / 4.0)   # 남쪽 끝은 낮게 시작
        for xc, half, hr, pr in ((WALLX - 0.6, 1.25, None, 1.0), (WALLX - 1.9, 1.05, (5.4, 7.0), 1.0), (WALLX - 3.0, 0.95, (3.2, 5.0), 1.0), (WALLX - 3.75, 0.7, (0.9, 2.3), 0.7)):
            if rnd.random() > pr: continue
            top = LEDGE_Z + rnd.uniform(0.2, 1.7) if hr is None else f + rnd.uniform(*hr) * taper
            y1 = min(y + w + 0.5, 557240.5)
            g = blob((xc + rnd.uniform(-0.15, 0.15), yc + rnd.uniform(-0.3, 0.3)), w * rnd.uniform(0.5, 0.66)).intersection(SP([(xc - half, y - 0.5), (xc + half, y - 0.5), (xc + half, y1), (xc - half, y1)]))
            rock('S', g, top, '바위 정원(남쪽 덩이)의 바위 조각', 'Z05-PLATFORM-EUNJU-CENTRAL-LEDGE 의 서쪽 벽면(아랫벽) 앞')
        y += w * 0.8
    # 굽이 아래 돌 단의 뒤(동쪽) 바위 면: 아랫벽 면에 붙은 얇은 바위 켜와 발치의 낮은 조각
    y = 557240.7
    while y < 557253.6:
        w = rnd.uniform(1.6, 2.8); yc = y + w / 2
        g = blob((WALLX - 0.35, yc), w * rnd.uniform(0.5, 0.64)).intersection(SP([(WALLX - 1.0, y - 0.4), (WALLX + 0.35, y - 0.4), (WALLX + 0.35, y + w + 0.4), (WALLX - 1.0, y + w + 0.4)]))
        rock('E', g, LEDGE_Z + rnd.uniform(0.2, 1.5), '바위 정원(돌 단 뒤 바위 면)의 바위 조각', 'Z05-PLATFORM-EUNJU-CENTRAL-LEDGE 의 서쪽 벽면(아랫벽)')
        if rnd.random() < 0.6 and not 557245.3 < yc < 557250.3:   # 돌 단으로 내려서는 단 앞은 비운다
            g = blob((WALLX - 1.3, yc + rnd.uniform(-0.3, 0.3)), w * 0.42).intersection(SP([(WALLX - 1.9, y), (WALLX - 0.9, y), (WALLX - 0.9, y + w), (WALLX - 1.9, y + w)]))
            rock('E', g, TERR_Z + rnd.uniform(1.0, 3.4), '돌 단 뒤 바위 면 발치의 바위 조각', 'Z05-PLATFORM-EUNJU-ROCK-TERRACE')
        y += w * 0.8
    # 북쪽 덩이: 굽이 안쪽 섬(125.4 m)의 남쪽 면(북좌표 557255.5)과 턱의 북쪽 끝(동좌표 201100 동쪽은 북좌표 557253.8) 앞
    x = 201093.2
    while x < WALLX - 0.2:
        w = rnd.uniform(1.5, 2.6); xc = x + w / 2; fy = 557255.5 if xc < 201100.0 else 557253.8; x1 = min(x + w + 0.5, WALLX - 0.05)
        for dy, hr in ((0.1, (5.2, 7.4)), (-0.6, (2.0, 4.6)), (-1.2, (0.6, 1.8))):
            g = blob((xc, fy + dy), w * rnd.uniform(0.5, 0.66)).intersection(SP([(x - 0.5, fy - 1.9), (x1, fy - 1.9), (x1, fy + 0.7), (x - 0.5, fy + 0.7)]))
            if g.is_empty or g.area < 0.15: continue
            f = stand(g, 0.0); top = min(f + rnd.uniform(*hr), 126.4) if xc > 201095 else f + rnd.uniform(*hr) * 0.6
            rock('N', g, top, '바위 정원(북쪽 덩이: 굽이 안쪽 섬의 남쪽 면)의 바위 조각', 'Z05-PLATFORM-UPPER-HAIRPIN-ISLAND 의 남쪽 면')
        x += w * 0.8
    # 아랫벽 머리의 바위와 턱 위의 소나무(사진: 바위 꼭대기마다 소나무, 그 뒤 윗벽)
    for j, (yy, up) in enumerate(((557229.0, 0.9), (557234.5, 1.5), (557239.0, 1.1), (557246.0, 0.8), (557251.0, 1.2))):
        g = blob((WALLX + 0.7, yy), 1.0).intersection(SP([(WALLX + 0.4, yy - 1.5), (WALLX + 1.9, yy - 1.5), (WALLX + 1.9, yy + 1.5), (WALLX + 0.4, yy + 1.5)]))
        poly(f'P02-ROCKGARDEN-ROCK-CAP{j + 1}', 'wall', g, LEDGE_Z - 0.3, LEDGE_Z + up, '아랫벽 머리 위로 솟은 바위', SRC, G, 'Z05-PLATFORM-EUNJU-CENTRAL-LEDGE', color=COL[j % len(COL)])
    for j, (xx, yy, sc) in enumerate(((201105.3, 557208.5, 1.0), (201104.6, 557214.5, 0.9), (201105.6, 557220.5, 1.0), (201104.4, 557226.5, 0.9), (201105.2, 557231.5, 1.0), (201104.3, 557236.8, 0.9), (201104.4, 557243.0, 0.8), (201104.3, 557248.5, 0.9), (201103.9, 557254.6, 0.8))):
        tree(f'P02-ROCKGARDEN-PINE-S{j + 1}', (xx, yy), LEDGE_Z, '아랫벽 위 턱의 소나무', SRC, 'Z05-PLATFORM-EUNJU-CENTRAL-LEDGE', s=sc)
    # 돌 화분: 계단식 인도의 참(Z03)과 돌 단 위
    TG = '원천(넓은 돌 단과 계단, 돌 화분: 사용자 사진 04·거리뷰 09), S-MAP(단 117.8 m), 추정(화분의 자리·크기)'
    for j, (c, z, base) in enumerate((((201096.0, 557240.6), 117.83, 'Z03-EAST-LANDING'), ((201096.6, 557243.0), 117.83, 'Z03-EAST-LANDING'), ((201097.3, 557246.2), 118.76, 'Z03-EAST-LANDING'), ((201098.2, 557249.2), 118.76, 'Z03-EAST-LANDING'),
                                      ((201100.6, 557242.0), TERR_Z, 'Z05-PLATFORM-EUNJU-ROCK-TERRACE'), ((201101.3, 557244.6), TERR_Z, 'Z05-PLATFORM-EUNJU-ROCK-TERRACE'))):
        box(f'P02-ROCKGARDEN-URN-{j + 1}', 'wall', ngon(c, 0.42), z, z + 0.75, '돌 단 위의 둥근 돌 화분', SRC, TG, base, color='#c9c5ba')
        box(f'P02-ROCKGARDEN-URN-{j + 1}-FLOWER', 'wall', ngon(c, 0.36), z + 0.75, z + 1.0, '돌 화분의 꽃', SRC, TG, 'P02-ROCKGARDEN-URN', color='#c9566a' if j % 2 else '#e6c84e')
    # 돌 단으로 내려서는 낮은 단(인도의 참 118.76 m 에서 돌 단 117.8 m 로): 참의 동쪽 변을 따라 세 단
    a, b = np.array([201099.93, 557245.73]), np.array([201100.93, 557249.71]); R, P = frame(a, b - a, (1, 0))
    for n in range(3):
        box(f'P02-ROCKGARDEN-STEP-S{n + 1:02d}', 'stair_step', R(0.3, 3.8, n * 0.32, (n + 1) * 0.32), TERR_Z - 0.3, 118.76 - (n + 1) * 0.24, '인도의 참에서 돌 단으로 내려서는 낮은 단 셋(메시: 인도 118.4~119, 돌 단 117.8)', SRC, 'S-MAP(높이 차 1 m), 추정(단이 있는지·자리·수)', 'Z05-PLATFORM-EUNJU-ROCK-TERRACE', color='#c8c3b6', stair='P02-ROCKGARDEN-STEP')
    # 바위 덩이 앞 참의 둥근 화단(거리뷰 09: 계단 오른쪽, 바위 발치의 흰 돌 화단과 소나무)과 옹벽 발치의 화단 넷(거리뷰 10: 짙은 돌 옹벽 앞의 굽은 흰 돌 화단, 소나무, 긴 의자)
    PG = '원천(바위·옹벽 발치의 굽은 흰 돌 화단과 소나무, 긴 의자: 거리뷰 09·10), S-MAP(화단 자리의 땅이 인도보다 1 m 안팎 높게 읽힘), 추정(화단의 수·자리·크기)'
    def planter(pid, g, base, pine=None):
        z = stand(g, 0.4); poly(pid, 'planter', g, z, z + 0.8 + (0.4 if z < ground(g.centroid.x, g.centroid.y) else 0.0), '바위·옹벽 발치의 흰 돌 화단(높이 0.8 m)', SRC, PG, base, color='#cfcbc0', topColor='#8a7a55')
        if pine: tree(pid + '-PINE', pine, FEATS[-1]['properties']['toM'], '화단의 소나무', SRC, pid, s=0.85)
    planter('P02-ROCKGARDEN-PLANTER-1', SP(ngon((201097.6, 557230.0), 0.8, 10)), 'Z03-EAST-LANDING-3', (201097.6, 557230.0))
    planter('P02-ROCKGARDEN-PLANTER-2', SP(ngon((201097.45, 557236.0), 0.8, 10)), 'Z03-EAST-LANDING-4')
    for j, yy in enumerate((557208.2, 557213.4, 557218.6, 557223.6)):   # 벽에 붙은 반달꼴
        g = SP([(WALLX - 0.05 - 2.9 * math.cos(t), yy + 2.1 * math.sin(t)) for t in np.linspace(-math.pi / 2, math.pi / 2, 9)]).buffer(0)
        planter(f'P02-ROCKGARDEN-WALLPLANTER-{j + 1}', g, 'Z05-PLATFORM-GATE-ROAD-EAST-EDGE', (201101.5, yy))
    for j, yy in enumerate((557210.8, 557221.1)):
        g = SP([(201099.2, yy - 0.9), (201099.65, yy - 0.9), (201099.65, yy + 0.9), (201099.2, yy + 0.9)]); z = stand(g, 0.3)
        poly(f'P02-ROCKGARDEN-BENCH-{j + 1}', 'wall', g, z, z + 0.75, '화단 사이의 긴 돌 의자', SRC, PG, 'Z05-PLATFORM-GATE-ROAD-EAST-EDGE', color='#bdb9ad')

# ================= 2. 수인관 남동쪽의 유리 덩어리 =================
SUIN = [[201102.94, 557190.11], [201125.57, 557204.29], [201192.29, 557144.08], [201174.74, 557125.62], [201148.21, 557110.27]]
def suin_glass():
    SRC = '사용자-학교전경-20261012/20-전경-남서-원경3.jpg·17·16·07-풋살장-바로위에서-수인관옥상.jpg, S-MAP 1 m 메시(z04/smap-mesh-z04-1m-e0)'
    G = '원천(수인관 기둥 면 남동쪽에 틈을 두고 선 짙은 유리 덩어리, 흰 돌 틀, 지붕 정원과 정자 둘: 사용자 사진 20·07), S-MAP(윗면 135.3 m, 북서 변이 수인관 모서리에서 8 m, 길 쪽 면이 기둥 면보다 13 m 뒤, 앞으로 나온 날개 136.1 m), 추정(남동 끝: 메시 밖이라 사진 07 의 길이 34 m, 유리 칸 나눔, 무엇인지: 학교 건물인지 모름)'
    o = np.array(SUIN[4]); R, P = frame(o, o - np.array(SUIN[0]), (1, 1))   # s = 수인관 길 쪽 면을 따라 남동으로(남쪽 모서리 0), d = 북동(길 반대쪽)
    STONE, GLASS = '#c2bfb5', '#27323a'
    box('P02-SUIN-GLASSBLOCK-MAIN', 'wall', R(19, 42, 13, 30), 109.5, 135.3, '수인관 남동쪽 유리 덩어리의 본체(길 쪽 면 23 m, 깊이 17 m, 윗면 135.3 m 는 지붕 정원)', SRC, G, 'Z05-PLATFORM-EUNJU-GLASSBLOCK-STREET(덩어리 앞 땅, R01)', color=STONE, topColor='#7f9a6b')
    box('P02-SUIN-GLASSBLOCK-WING', 'wall', R(8, 19, 7, 30), 109.5, 136.1, '유리 덩어리의 북서쪽 날개(길 쪽으로 6 m 나옴, 윗면 136.1 m)', SRC, G, 'P02-SUIN-GLASSBLOCK-MAIN', color=STONE, topColor='#8a8d86')
    for j, (s0, s1, d) in enumerate(((9.0, 18.0, 7.0), (20.0, 32.5, 13.0), (34.0, 41.0, 13.0))):
        box(f'P02-SUIN-GLASSBLOCK-GLASS-{j + 1}', 'wall', R(s0, s1, d - 0.12, d), 113.0, 133.2, '길 쪽 면의 짙은 유리 벽(흰 돌 틀 안. 칸 나눔 추정)', SRC, G, 'P02-SUIN-GLASSBLOCK-MAIN', color=GLASS)
        for m in range(1, 5): box(f'P02-SUIN-GLASSBLOCK-GLASS-{j + 1}-BAR{m}', 'wall', R(s0, s1, d - 0.16, d - 0.12), 113.0 + m * 4.04 - 0.12, 113.0 + m * 4.04 + 0.12, '유리 벽의 층 띠', SRC, G, 'P02-SUIN-GLASSBLOCK-GLASS', color='#4a585f')
    box('P02-SUIN-GLASSBLOCK-SIGN', 'wall', R(21.0, 31.5, 12.8, 13.0), 133.6, 134.6, '유리 벽 위 흰 돌 띠의 글자 줄(글자는 읽지 못함: 짙은 띠로 나타냄)', SRC, G, 'P02-SUIN-GLASSBLOCK-MAIN', color='#6b6f72')
    for j, (s, d) in enumerate(((26.0, 21.0), (35.0, 23.0))):
        c = P(s, d)
        for q, (ds, dd) in enumerate(((-1.4, -1.4), (1.4, -1.4), (1.4, 1.4), (-1.4, 1.4))): box(f'P02-SUIN-GLASSBLOCK-PAVILION-{j + 1}-POST{q + 1}', 'wall', sq(P(s + ds, d + dd), 0.12), 135.3, 137.7, '지붕 정원 정자의 기둥', SRC, G, 'P02-SUIN-GLASSBLOCK-MAIN', color='#5b4a3c')
        box(f'P02-SUIN-GLASSBLOCK-PAVILION-{j + 1}-ROOF', 'wall', ngon(c, 2.5, 4), 137.7, 138.1, '정자 지붕(네모 모임지붕을 판으로 줄임)', SRC, G, 'P02-SUIN-GLASSBLOCK-MAIN', color='#6a6d70')
        box(f'P02-SUIN-GLASSBLOCK-PAVILION-{j + 1}-ROOF2', 'wall', ngon(c, 1.4, 4), 138.1, 138.7, '정자 지붕 윗단', SRC, G, 'P02-SUIN-GLASSBLOCK-MAIN', color='#6a6d70')
    for j, (s, d) in enumerate(((22.0, 16.0), (30.5, 26.5), (39.0, 17.0), (21.5, 27.0))): tree(f'P02-SUIN-GLASSBLOCK-TREE-{j + 1}', P(s, d), 135.3, '지붕 정원의 나무', SRC, 'P02-SUIN-GLASSBLOCK-MAIN', s=0.8)

# ================= 3. 회차 공간 바닥 표시 =================
def turnaround():
    SRC = '사용자-네이버거리뷰-20261012/02·15·01·20-네이버거리뷰-전방위.jpg, 사용자-회차공간서쪽-유담관아케이드-20261012/12-거리뷰화면-사용자표시-유담관입구.webp'
    G = '원천(본관 서쪽 끝 화단 앞과 아치 건물 남쪽 화단 앞의 흰 테두리 버스 칸과 글자 BUS, 북쪽·서쪽의 횡단보도: 거리뷰), 추정(자리 ±3 m, 크기, 줄 수)'
    BASE = 'Z05-PLATFORM-TURN(회차 공간 포장면)'
    BW_A, BW_B = np.array([201033.39, 557319.39]), np.array([201044.69, 557344.2])
    def bay(pid, R, P, s0, s1, d0, d1, flip, what):
        t = 0.15
        for q, (a, b, c, d) in enumerate(((s0, s1, d0, d0 + t), (s0, s1, d1 - t, d1), (s0, s0 + t, d0, d1), (s1 - t, s1, d0, d1))): paint(f'{pid}-LINE{q + 1}', R(a, b, c, d), what + '의 흰 테두리', SRC, G, BASE)
        cw = 0.34; L = 3 * 6 * cw - cw; sm = (s0 + s1) / 2; dm = (d0 + d1) / 2; ch = 0.3
        if flip: letters(pid + '-TEXT', 'BUS', lambda s, d: P(2 * sm - s, 2 * dm - d), sm - L / 2, dm - 3.5 * ch, cw, ch, what, SRC, G, BASE)
        else: letters(pid + '-TEXT', 'BUS', P, sm - L / 2, dm - 3.5 * ch, cw, ch, what, SRC, G, BASE)
    R1, P1 = frame(BW_A, BW_B - BW_A, (-1, 0.4))   # 본관 서쪽 끝 면: s 북으로, d 회차 공간 쪽
    bay('P02-TURN-BUSBAY-1', R1, P1, 1.5, 13.5, 6.2, 9.4, True, '본관 서쪽 끝 화단 앞 버스 칸(12 × 3.2 m)')
    AO = (201007.7 + (557308.0 - 557250) * (200983.5 - 201007.7) / 176 + 9.8, 557308.0); R2, P2 = frame(AO, (200983.5 - 201007.7, 176.0), (1, 0))   # 아치 건물 정면: s 북으로(남쪽 끝 0), d 동
    bay('P02-TURN-BUSBAY-2', R2, P2, -7.5, 3.5, 7.0, 10.2, False, '아치 건물 남쪽 끝 화단 앞 버스 칸(11 × 3.2 m)')
    for n, (s0, d0, d1, what) in enumerate(((36.5, 3.0, 9.4, '아치 건물 북쪽 문 앞 횡단보도'), (58.5, 4.0, 13.0, '회차 공간 북쪽 어귀(북악관 앞)의 횡단보도'))):
        m = 0; d = d0
        while d + 0.45 <= d1:
            m += 1; paint(f'P02-TURN-CROSSWALK-{n + 1}-{m:02d}', R2(s0, s0 + 4.0, d, d + 0.45), what + '의 흰 줄(길이 4 m, 폭 0.45 m, 사이 0.45 m)', SRC, G, BASE); d += 0.9

# ================= 4. 유담관 3층 입구(서경스포렉스 간판, 우편취급국 옆) =================
WEST_O, WEST_A = np.array([201007.7, 557250.0]), unit((200983.5 - 201007.7, 176.0))   # 서쪽 옹벽 선(= 지도의 벽 면)
ENT_S = float((np.array([200994.6, 557307.6]) - WEST_O) @ WEST_A); ENT_FLOOR = 104.0
ER, EP = frame(WEST_O + WEST_A * ENT_S, WEST_A, (-1, 0))   # s = 벽을 따라 북으로(입구 가운데 0), d = 길 쪽(서)
ENT_DOOR, ENT_FOOT = EP(-0.8, 1.0), EP(-0.8, 5.0)   # 문 앞(현관 바닥 104.0), 계단 발치(보도)
def street_z(s, d): p = EP(s, d); return ground(p[0], p[1])
def entrance3():
    SRC = '사용자-SP카페·대일관계단·3생활관-20261012/06-유담관-3층입구-서경스포렉스.jpg, 사용자-학교전경-20261012/13-서경스포렉스간판-입구-우체통.jpg, 사용자-출입구·주차장-20261010/06-유담관3층입구-우체국옆.jpg·07, S-MAP 1 m 메시(z04/smap-mesh-z04-1m-w2)'
    G = '확정(서경스포렉스 간판의 이 입구 = 유담관 3층 입구, 바깥 길 쪽 벽·우편취급국 옆: 사용자 2026-10-10·10-12), 원천(큰 둥근 화강석 기둥, 깊고 어두운 현관과 유리문, 짙은 간판 띠, 넓은 돌계단 8단쯤과 왼쪽 경사로·난간, 빨간 우체통, 왼쪽 가게 창, 위의 창 줄과 기와 띠, 붉은 블록 보도와 노란 점자 띠: 사용자 사진), S-MAP(문 앞 길 103.0~103.3 m), 추정(현관 바닥 104.0 m = 건물 노트, 폭·깊이·기둥 굵기, 창 줄 높이. 지도의 벽 면이 메시의 건물 면보다 2.8 m 동쪽이라 현관을 벽 앞으로 2 m 내어 만들었다)'
    BASE = 'Z05-PLATFORM-WEST-STREET'; GR, DARK = '#a9a8a3', '#17191d'; F = ENT_FLOOR
    box('P02-YUDAM3-PORCH-FLOOR', 'landing', ER(-5.3, 5.3, -0.05, 2.0), 101.0, F, '현관 바닥(3층 104.0 m, 벽 앞 2 m)', SRC, G, BASE, color='#8e8f8c')
    box('P02-YUDAM3-PORCH-RECESS', 'wall', ER(-4.0, 4.0, -0.02, 0.1), F, F + 5.0, '깊은 현관 안(어두운 판으로 나타냄: 벽을 파지 않는다)', SRC, G, BASE, material='opening', color=DARK)
    for j, (s0, s1) in enumerate(((-2.6, -1.35), (-1.3, -0.05), (0.05, 1.3), (1.35, 2.6))): box(f'P02-YUDAM3-DOOR-{j + 1}', 'wall', ER(s0, s1, 0.1, 0.16), F, F + 2.5, '유리문 넷(짙은 유리)', SRC, G, 'P02-YUDAM3-PORCH-RECESS', color='#2f4048')
    box('P02-YUDAM3-DOOR-TRANSOM', 'wall', ER(-2.6, 2.6, 0.1, 0.16), F + 2.6, F + 4.2, '문 위 유리', SRC, G, 'P02-YUDAM3-PORCH-RECESS', color='#263339')
    for j, s in enumerate((-4.7, 4.7)): box(f'P02-YUDAM3-COLUMN-{j + 1}', 'wall', ngon(EP(s, 1.5), 0.7, 12), 101.0, F + 6.6, '현관 양옆의 큰 둥근 화강석 기둥(지름 1.4 m)', SRC, G, BASE, color=GR)
    box('P02-YUDAM3-SIGNBAND', 'wall', ER(-5.5, 5.5, 0.0, 2.3), F + 5.0, F + 6.6, '현관 위 짙은 간판 띠("서경스포렉스")', SRC, G, 'P02-YUDAM3-COLUMN', color='#2a2530')
    box('P02-YUDAM3-SIGNBAND-TEXT', 'wall', ER(-3.6, 0.8, 2.3, 2.36), F + 5.45, F + 6.1, '간판의 흰 글자 줄(글자를 밝은 띠로 줄임)', SRC, G, 'P02-YUDAM3-SIGNBAND', color='#e8e6e0')
    NS, RISE, TREAD = 8, 0.156, 0.33
    for k in range(1, NS + 1): box(f'P02-YUDAM3-STAIR-S{k:02d}', 'stair_step', ER(-4.0, 2.3, 2.0 + (k - 1) * TREAD, 2.0 + k * TREAD), 101.0, F - k * RISE, f'넓은 돌계단 {NS}단(단 높이 {RISE} m, 디딤 {TREAD} m, 폭 6.3 m): 길이 북으로 오르므로 남쪽 끝에서 8단, 북쪽 끝에서는 길에 묻혀 3단쯤', SRC, G, BASE, color='#9c9b96')
    for k in range(4): box(f'P02-YUDAM3-RAMP-{k + 1}', 'landing', ER(2.4, 4.0, 2.0 + k * 0.9, 2.9 + k * 0.9), 101.0, F - (k + 0.5) * 0.11, '계단 왼쪽(북쪽)의 경사로(폭 1.6 m, 길이 3.6 m, 낮은 판 넷으로 나타냄)', SRC, G, BASE, color='#8e8f8c')
    for j, s in enumerate((2.32, 4.02)):
        box(f'P02-YUDAM3-RAMP-RAIL-{j + 1}', 'wall', ER(s, s + 0.06, 2.0, 5.4), F + 0.55, F + 0.62, '경사로 난간', SRC, G, 'P02-YUDAM3-RAMP', color='#2b2d30')
        for q, d in enumerate((2.05, 3.7, 5.35)): box(f'P02-YUDAM3-RAMP-RAIL-{j + 1}-POST{q + 1}', 'wall', ER(s, s + 0.06, d, d + 0.06), 101.5, F + 0.55, '난간 기둥', SRC, G, 'P02-YUDAM3-RAMP', color='#2b2d30')
    zb = street_z(5.9, 2.9); box('P02-YUDAM3-POSTBOX', 'wall', sq(EP(5.9, 2.9), 0.24), zb - 0.3, zb + 1.25, '빨간 우체통(왼쪽 기둥 발치)', SRC, G, BASE, color='#c8231f')
    zs = street_z(10.0, 0.5)
    box('P02-YUDAM3-SHOP-WINDOW', 'wall', ER(6.4, 13.6, -0.02, 0.1), zs + 0.8, zs + 3.3, '입구 왼쪽(북쪽)의 가게 창(우편취급국)', SRC, G, BASE, color='#8fa3aa')
    box('P02-YUDAM3-SHOP-SIGN', 'wall', ER(6.2, 13.8, -0.02, 0.35), zs + 3.4, zs + 4.2, '가게 창 위 붉은 간판 띠', SRC, G, BASE, color='#c9302a')
    for j, z in enumerate((F + 8.2, F + 12.0, F + 15.8)):   # 위의 창 줄과 단마다 기와 띠
        box(f'P02-YUDAM3-UPPER-WINDOWS-{j + 1}', 'wall', ER(-2.5, 15.0, -0.02, 0.1), z, z + 1.5, '입구 위 벽의 창 줄(띠창으로 나타냄)', SRC, G, BASE, color='#6f8794')
        box(f'P02-YUDAM3-UPPER-TILE-{j + 1}', 'wall', ER(-2.8, 15.3, -0.02, 0.45), z - 1.0, z - 0.6, '층 사이의 기와 띠(짧은 차양)', SRC, G, BASE, color='#3c3f44')
    s = -11.0
    while s < 15.0:   # 붉은 블록 보도와 노란 점자 띠: 길이 오르므로 0.5 m 조각마다 그 자리 높이
        for nm, d0, d1, col, lift in (('SIDEWALK', 4.7, 7.2, '#b0584a', 0.04), ('TACTILE', 5.8, 6.1, '#e2c23a', 0.08)):
            if nm == 'SIDEWALK' or True:
                z = street_z(s + 0.25, (d0 + d1) / 2) + lift; box(f'P02-YUDAM3-{nm}-{int(round((s + 11) * 2)) + 1:02d}', 'wall', ER(s, s + 0.5, d0, d1), z - 0.12, z + 0.04, '입구 앞 붉은 블록 보도' if nm == 'SIDEWALK' else '보도의 노란 점자 띠', SRC, G, BASE, color=col, surfaceMark=True)
        s += 0.5

# ================= 5. 유담관 공도 쪽 기단의 기와 띠, 생활관 3동 글자 판, 보국문로16라길 바닥 표시 =================
def dorm_street():
    SRC = '사용자-SP카페·대일관계단·3생활관-20261012/04-제3생활관-인근-바깥길.jpg, 사용자-학교전경-20261012/12-서쪽바깥길에서-유담관-옹벽-저층날개.jpg, 사용자-서문-공연실습소-생활관-20261010/외국인생활관.jpg·공연실습소.webp'
    z11 = {f['properties']['id']: f for f in json.loads((STR / 'z11-parts.geojson').read_text(encoding='utf-8'))['features']}
    plinth = shape(z11['Z11-YUDAM-STREET-PLINTH']['geometry']).buffer(0)
    ring = plinth.buffer(0.4, join_style=2).difference(plinth)
    rows = sorted({round(f['properties']['toM'], 2) for k, f in z11.items() if k.startswith('Z11-YUDAM-STREET-WINDOW-')})
    G = '원천(길을 따라 굽은 회색 벽, 창 줄 서넛, 단마다 기와 띠: 사용자 사진 04·12), 추정(이 벽이 유담관 공도 쪽 기단이라는 것, 띠의 높이 = 창 줄 머리 위 0.5 m, 내민 깊이 0.4 m)'
    for j, z in enumerate(rows): poly(f'P02-YUDAM-STREET-TILEBAND-{j + 1}', 'wall', ring, z + 0.5, z + 0.9, '유담관 공도 쪽 기단 벽의 층 사이 기와 띠(짧은 차양)', SRC, G, 'Z11-YUDAM-STREET-PLINTH', color='#3c3f44')
    # 생활관 3동(외국인 생활관) 북쪽 면의 글자 판
    DG = '확정(붉은 벽돌 건물 = 생활관 3동: 사용자·간판), 원천(벽돌 면의 초록 표장과 흰 글자 "서경대학교 제3 생활관": 사용자 사진 04), 추정(어느 면인지: 회전교차로 쪽 북쪽 면의 동쪽 끝, 판의 크기. 글자는 밝은 띠로 줄임)'
    A, B = np.array([200987.5, 557232.5]), np.array([201001.5, 557231.5]); R, P = frame(B, A - B, (0, 1))   # s = 북쪽 면의 동쪽 모서리에서 서쪽으로, d = 길 쪽(북)
    box('P02-DORM3-SIGN-WALL', 'wall', R(0.3, 5.3, 0.0, 0.1), 96.0, 104.0, '글자가 붙은 벽돌 면(창 없는 면)', SRC, DG, '추가-외국인생활관', color='#8a4534')
    box('P02-DORM3-SIGN-LOGO', 'wall', R(1.0, 4.6, 0.1, 0.16), 102.2, 103.3, '초록 표장(SEOKYEONG UNIVERSITY)', SRC, DG, 'P02-DORM3-SIGN-WALL', color='#3f9450')
    for j, (z, s0, s1) in enumerate(((100.6, 0.9, 4.7), (99.2, 1.3, 4.3))): box(f'P02-DORM3-SIGN-TEXT-{j + 1}', 'wall', R(s0, s1, 0.1, 0.16), z, z + 0.75, '흰 글자 줄("서경대학교" / "제3 생활관")', SRC, DG, 'P02-DORM3-SIGN-WALL', color='#ece8dc')
    # 바닥 표시: 횡단보도와 속도 표시 30
    RG = '원천(오르막 차도의 횡단보도와 바닥 글자 30: 사용자 사진 04), 추정(자리 ±4 m: 회전교차로 동쪽 어귀)'
    R3, P3 = frame((200994.0, 557240.5), (0.9, -0.33), (0.33, 0.9))   # s = 길을 따라 동남동으로, d = 북쪽(유담관 쪽)
    for m in range(9): paint(f'P02-DORMSTREET-CROSSWALK-{m + 1:02d}', R3(1.0, 4.0, -3.6 + m * 0.9, -3.6 + m * 0.9 + 0.45), '생활관 3동 앞 횡단보도의 흰 줄', SRC, RG, 'Z05-PLATFORM-GATE-ROUNDABOUT')
    letters('P02-DORMSTREET-30', '30', lambda s, d: P3(8.0 + d, 0.9 - s), 0.0, 0.0, 0.3, 0.42, '차도 바닥의 속도 표시 30', SRC, RG, 'Z05-PLATFORM-GATE-STREET-SW')

# ================= 6. 북악관 정면 서쪽 화단: 자전거 거치대와 붉은 관목 =================
def bukak_front():
    SRC = '사용자-네이버거리뷰-20261012/24-거리뷰화면-아치줄건물정면-창배열.webp, 20·02·15-네이버거리뷰-전방위.jpg'
    G = '원천(정면 서쪽의 긴 밝은 돌 화단 벽, 소나무 줄과 붉은 관목, 벽 발치의 자전거 거치대: 표시 그림 24), 추정(거치대 수·자리, 관목 덩이의 자리·크기)'
    A, B = np.array([201009.5, 557379.9]), np.array([201033.1, 557367.5]); R, P = frame(A, B - A, (-0.4, -1))   # Z10 화단(W1~W4)의 회차 공간 쪽 변: s 동으로, d 회차 공간 쪽
    PL = [(shape(f['geometry']).buffer(0), f['properties']['toM']) for f in json.loads((STR / 'z10-parts.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'].startswith('Z10-BUKAK-FRONT-PLANTER-W')]
    for k in range(7):
        s = 3.0 + k * 3.4; c = P(s, -1.2 - (k % 2) * 1.1)
        g = SP(ngon(c, 0.75 + 0.15 * (k % 3), 7)); t = max(z for q, z in PL if q.intersects(g))
        poly(f'P02-BUKAK-FRONT-SHRUB-{k + 1}', 'wall', g, t, t + 0.55, '화단의 붉은 관목 덩이(겨울 빛)', SRC, G, 'Z10-BUKAK-FRONT-PLANTER-W', color='#8f4e3c')
    for k in range(9):
        s = 7.0 + k * 0.75; z = ground(*P(s, 0.9))
        box(f'P02-BUKAK-FRONT-BIKERACK-{k + 1}', 'wall', R(s, s + 0.05, 0.35, 1.25), z + 0.05, z + 0.8, '화단 벽 발치의 자전거 거치대(가는 틀을 얇은 판으로 나타냄)', SRC, G, 'Z05-PLATFORM-TURN(회차 공간 포장면)', color='#9aa0a6')

PARTS = [rocks, suin_glass, turnaround, entrance3, dorm_street, bukak_front]
def build(feats):
    global FEATS
    FEATS = feats
    for f in PARTS: f()
