"""UV1(2026-10-25): 구조물 자료에서 빠진 지하 빈 곳(void)과 청운관 계단실 참을 채운다. DB·네트워크 접근 없음.
  python -X utf8 build_parts.py          # 고쳐 씀
  python -X utf8 build_parts.py --dry    # 쓰지 않고 수치만
근거: 볼트 구역 노트 운동장 아래 지하층과 지하 차도·동 노트 청운관의 "2026-10-25 지하 빈 곳 보완" 절, 작업로그 2026-10-25-길-검사-지형-경고(#35 남은 20 의 "가").
길 선·높이는 시험 DB 길 그대로(roads.json, 읽기만 해 둔 것). 길은 움직이지 않는다. 땅은 구조물이고 지하는 기단 사이 빈 곳(AGENTS.md).

A 지하 차도(서문 터널 1cdf7601 → 합류 → 7f52c32e → f666ce65 → G02 빈 곳 첫 마디): 폭 7.2 m(본관 옆 구간 G02 와 같음, 추정).
B 지하 차도 P1 갈래(b85c41a9 → 합류): 폭 7.2 m(추정).
C 지하 보행 구간(b1758181, R2 연결 빈 곳 → Z07 보행 빈 곳 첫 마디): 폭 2.4 m(Z07 와 같음).
D 지하 횡단보도·북악관 B1 통로(33371f63 + 0fce276d): 폭 3.0 m(U06 북악관 문 폭).
  마디: 길을 따라 1 m(STRUCTURES.md: 빈 곳은 바닥이 평평한 상자라 잘게 나눔). 바닥 = 마디 안 길 높이의 가장 낮은 값,
  천장 = min(마디 안 길 높이의 가장 높은 값 + 안 높이(차도 3.5, 사람 2.5: U02·Z07), 마디 위 기단 윗면의 가장 낮은 값 - 0.6(G02 덮개 판)).
  천장 - 바닥 < 1.0 이면 그 마디는 만들지 않음(길이 땅 위·땅과 같은 높이: 어귀 바깥).
  이미 있는 빈 곳·앞에서 만든 빈 곳과 높이가 겹치는 자리는 뺌(겹침 없음). inside 는 적지 않음(겹치는 모든 기단에서 비움).
  덮는 기단의 밑(bottomM)이 빈 곳 바닥 - 1.0(기초 판, U01 과 같음)보다 높으면 밑을 그만큼 내림(빈 곳이 기단 덩어리 안에 들게).
E 청운관 계단실(X22-CHEONGUN-STAIRWELL 140.0~149.2 안): 길 c9319f92·1eccfdaf·b0d07a1b·b34a475c 의 꼭짓점대로
  앞방 참 143.5, 위 줄 가운데 참 146.35, 아래 되돌림 참 141.75, 단(위 줄 12+12, 아래 줄 9+9), B1·B2 문 통로 빈 곳(계단실 ↔ 학교 지도 꼭짓점 "청운관 서").
  세 줄은 나란히(위 줄 가운데, 아래 두 줄 양옆, 폭 0.8 m): 길 꼭짓점 y 557282.85 / 557283.65 / 557282.05 가 0.8 m 간격이라 포개면 머리 높이가 모자람(추정).
r5/build_parts.py 처럼 처음 실행 때 고치는 지물의 원본을 base.json 에 남기고, 다음 실행은 원본에서 다시 시작한다(몇 번 돌려도 같다).
고치는 파일(frontend/public/structures): uv1-underground-voids(새), 기단 밑을 내리는 파일(z05-turnaround 등, 결과 줄 참고)."""
import json, pathlib, copy, sys, math
from shapely.geometry import Polygon, LineString, Point, shape, box
from shapely.ops import unary_union, substring
from shapely.strtree import STRtree

DRY = '--dry' in sys.argv
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'
BASEF = HERE / 'base.json'
OUT = 'uv1-underground-voids.geojson'
r2 = lambda v: round(float(v), 2)
ROADS = {k: v['coords'] for k, v in json.loads((HERE / 'roads.json').read_text(encoding='utf-8'))['roads'].items()}
SRC = '시험 DB 길(docs/audit/uv1/roads.json), 구역 노트 운동장 아래 지하층과 지하 차도·동 노트 청운관 "2026-10-25 지하 빈 곳 보완"'
COVER = 0.6; MINCLEAR = 1.0; FOOT = 1.0; SEG = 1.0

def dump(path, obj):
    if not DRY: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

D = {fp.name: json.loads(fp.read_text(encoding='utf-8')) for fp in sorted(STR.glob('*.geojson')) if fp.name != OUT}
BASE = json.loads(BASEF.read_text(encoding='utf-8')) if BASEF.exists() else {'features': {}}
for fn, orig in BASE['features'].items():   # 다시 돌릴 때: 원본으로 되돌림
    D[fn]['features'] = [copy.deepcopy(orig[f['properties']['id']]) if f['properties']['id'] in orig else f for f in D[fn]['features']]
WHERE = {f['properties']['id']: (fn, f) for fn in D for f in D[fn]['features'] if not fn.startswith('a2-')}

def top_fn(p):
    if p.get('topProfile') is None: return lambda x, y: float(p['topM'])
    tp = p['topProfile']; (ox, oy), (dx, dy) = tp['origin'], tp['direction']; n = math.hypot(dx, dy); pts = sorted(tp['points'])
    def f(x, y):
        d = ((x - ox) * dx + (y - oy) * dy) / n
        if d <= pts[0][0]: return float(pts[0][1])
        for (a, h), (b, k) in zip(pts, pts[1:]):
            if d <= b: return h + (k - h) * (d - a) / (b - a)
        return float(pts[-1][1])
    return f
PLATS = [(i, shape(f['geometry']).buffer(0), top_fn(f['properties'])) for i, (fn, f) in WHERE.items()
         if f['properties'].get('kind') == 'platform' and ('topM' in f['properties'] or 'topProfile' in f['properties'])]
PTREE = STRtree([g for _, g, _ in PLATS])
def top_at(x, y):
    hit = [PLATS[k] for k in PTREE.query(Point(x, y)) if PLATS[k][1].contains(Point(x, y))]
    return max((t(x, y), i) for i, g, t in hit) if hit else None
OLDV = [(i, shape(f['geometry']).buffer(0), f['properties']['fromM'], f['properties']['toM']) for i, (fn, f) in WHERE.items()
        if f['properties'].get('kind') == 'void']

SOLIDS = [(i, shape(f['geometry']).buffer(0), f['properties']) for i, (fn, f) in WHERE.items()
          if f['properties'].get('kind') not in ('platform', 'void') and f['properties'].get('type') not in ('tree', 'surface', 'curb')
          and isinstance(f['properties'].get('fromM'), (int, float)) and isinstance(f['properties'].get('toM'), (int, float))]
STREE = STRtree([g for _, g, _ in SOLIDS])
def zrange(p, g):
    """상자의 밑·위(기운 얇은 판이면 그 자리 높이)."""
    if p.get('topProfile') and p.get('thicknessM'):
        c = g.representative_point(); hi = top_fn(p)(c.x, c.y); return hi - float(p['thicknessM']), hi
    return float(p['fromM']), float(p['toM'])
MASS_SET = None
MASS = [k for k, (i, g, p) in enumerate(SOLIDS) if p.get('type') == 'wall' and str(i).startswith('W01-') and g.area >= 5 and p['toM'] - p['fromM'] >= 4]
def mass_at(x, y, floor):
    """길이 지나가는 옹벽 덩어리(서문 뒤 W01 MASS·WESTWALL: 기단이 아닌 wall 상자)의 윗면."""
    hs = [SOLIDS[k][2]['toM'] for k in STREE.query(Point(x, y)) if k in MASS_SET and SOLIDS[k][1].contains(Point(x, y)) and SOLIDS[k][2]['fromM'] <= floor + 0.5]
    return (max(hs), 'W01 옹벽 덩어리') if hs else None
MASS_SET = set(MASS)
REPORT, NEW, NEWV = [], [], []   # NEWV: (id, geom, from, to) 만든 빈 곳
def ring1(coords, ccw=True):
    p = []
    for x, y in list(coords)[:-1]:
        q = [r2(x), r2(y)]
        if not p or q != p[-1]: p.append(q)
    if p[0] == p[-1]: p.pop()
    if Polygon(p).exterior.is_ccw is not ccw: p = p[::-1]
    return p + [p[0]]
def parts(g):
    g = g.buffer(0)
    return [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.05]
def feat(fid, typ, g, z0, z1, what, grade, kind='extrude', **extra):
    assert z1 > z0, fid
    g = g.buffer(0); assert g.geom_type == 'Polygon' and g.area > 0.0005, (fid, g.geom_type)
    NEW.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': kind, 'estimated': True, 'grade': grade,
                'fromM': r2(z0), 'toM': r2(z1), 'assumption': 'UV1: ' + what, 'source': SRC, **extra},
                'geometry': {'type': 'Polygon', 'coordinates': [ring1(g.exterior.coords)] + [ring1(h.coords, False) for h in g.interiors]}})
    if kind == 'void': NEWV.append((fid, shape(NEW[-1]['geometry']).buffer(0), r2(z0), r2(z1)))

def zline(coords):
    """평면 선과 그 위 거리 s 에서의 길 높이."""
    xy = [(c[0], c[1]) for c in coords]; line = LineString(xy)
    ss = [0.0]
    for a, b in zip(xy, xy[1:]): ss.append(ss[-1] + math.dist(a, b))
    zs = [c[2] for c in coords]
    def z(s):
        for k in range(len(ss) - 1):
            if s <= ss[k + 1] or k == len(ss) - 2:
                t = 0 if ss[k + 1] == ss[k] else (s - ss[k]) / (ss[k + 1] - ss[k]); return zs[k] + (zs[k + 1] - zs[k]) * min(max(t, 0), 1)
    return line, ss, z

def band(prefix, coords, half, head, name, grade, what, ext_end=0.0):
    """길 선을 따라 폭 2*half 의 띠를 1 m 마디 빈 곳으로."""
    if ext_end:   # 끝 꼭짓점이 빈 곳 변 위에 오지 않게 길 방향으로 조금 더
        (x0, y0, z0), (x1, y1, z1) = coords[-2], coords[-1]; L = math.dist((x0, y0), (x1, y1))
        coords = coords + [[x1 + (x1 - x0) / L * ext_end, y1 + (y1 - y0) / L * ext_end, z1]]
    line, ss, z = zline(coords)
    whole = line.buffer(half, cap_style='flat', join_style='mitre')
    L = line.length; n = max(1, math.ceil(L / SEG - 1e-9)); taken = None; made = 0; skipped = []; lows = []; uncovered = []; caps = []; spans = []; first = len(NEWV)
    for k in range(n):
        a, b = k * L / n, (k + 1) * L / n
        sub = substring(line, a, b)
        piece = whole.intersection(sub.buffer(half + 1.0, cap_style='flat', join_style='mitre'))
        if taken is not None: piece = piece.difference(taken)
        taken = piece if taken is None else unary_union([taken, piece])
        zz = [z(a + (b - a) * t / 4) for t in range(5)]; lo, hi = min(zz), max(zz)
        tops = []
        for s in (a, (a + b) / 2, b):
            p = line.interpolate(s); q = line.interpolate(min(L, s + 0.05)); r = line.interpolate(max(0, s - 0.05))
            dx, dy = q.x - r.x, q.y - r.y; m = math.hypot(dx, dy) or 1; nx, ny = -dy / m, dx / m
            for o in (-half, 0, half):
                qx, qy = p.x + nx * o * 0.98, p.y + ny * o * 0.98
                cand = [t for t in (top_at(qx, qy), mass_at(qx, qy, lo)) if t]
                if cand: tops.append(max(cand))
        if not tops: skipped.append(k); continue
        tmin, tid = min(tops)
        ceil = min(hi + head, tmin - COVER)
        capped = None
        for j in STREE.query(piece):   # 위에 놓인 상자(밑이 바닥 + 0.5 보다 높은 것) 밑까지만. 서문 W01 상자는 빼고 겹침으로만 적음(길 선이 기둥·옹벽을 비스듬히 지남)
            i2, g2, p2 = SOLIDS[j]
            if p2.get('underground') or p2.get('inVoid') or str(i2).startswith('W01-'): continue
            inter = g2.intersection(piece)
            if inter.area < 0.3: continue
            b0, b1 = zrange(p2, inter)
            if b1 > lo + 0.01 and b0 < ceil - 0.01 and b0 > lo + 0.5: ceil, capped = b0, i2
        if ceil - lo < MINCLEAR: skipped.append(k); continue
        cover = [PLATS[j][1] for j in PTREE.query(piece) if (lambda g: g.area > 0.01 and PLATS[j][2](*g.representative_point().coords[0]) >= ceil + COVER - 0.05)(PLATS[j][1].intersection(piece))]
        cover += [SOLIDS[j][1] for j in MASS if SOLIDS[j][2]['toM'] >= ceil + COVER - 0.05 and SOLIDS[j][2]['fromM'] <= lo + 0.5 and SOLIDS[j][1].intersects(piece)]
        a0 = piece.area; piece = piece.intersection(unary_union(cover)) if cover else piece.difference(piece)
        if a0 - piece.area > 0.05: uncovered.append((k, round(a0 - piece.area, 1)))   # 위가 트인 자리(덮는 기단·옹벽이 없음)는 뺌
        if capped: caps.append((k, capped, round(ceil - lo, 2)))
        for oid, og, of, ot in OLDV + NEWV:   # 높이가 겹치는 빈 곳 자리는 뺌
            if ot > lo + 0.01 and of < ceil - 0.01 and og.intersects(piece): piece = piece.difference(og)
        ps = parts(piece)
        for j, part in enumerate(ps):
            fid = f'{prefix}-{k:02d}' + (f'-{j + 1}' if len(ps) > 1 else '')
            feat(fid, 'void', part, lo, ceil, f'{what}: 1 m 마디 {k + 1}/{n}, 바닥 = 길 높이 {lo:.2f}, 천장 = min(길 + {head}, 위 기단 {tid} {tmin:.2f} - {COVER}){f", 위 상자 {capped} 밑" if capped else ""}), 안 높이 {ceil - lo:.2f} m',
                 grade, kind='void', name=name)
            made += 1
        lows.append(ceil - lo); spans.append((lo, ceil))
    REPORT.append(f'{prefix} {name}: 길이 {L:.1f} m, 마디 {n}, 빈 곳 {made}, 안 만든 마디 {skipped[:3]}..{skipped[-3:] if skipped else ""}({len(skipped)}), '
                  f'안 높이 {min(lows):.2f}~{max(lows):.2f} m' if lows else f'{prefix}: 없음')
    if spans:
        b = unary_union([v[1] for v in NEWV[first:]]).bounds
        REPORT.append(f'  {prefix} 바닥 {min(x for x, _ in spans):.2f}~{max(x for x, _ in spans):.2f}, 천장 {min(y for _, y in spans):.2f}~{max(y for _, y in spans):.2f}, '
                      f'넓이 {sum(v[1].area for v in NEWV[first:]):.0f} ㎡, 범위 ({b[0]:.1f}, {b[1]:.1f})~({b[2]:.1f}, {b[3]:.1f})')
    if uncovered: REPORT.append(f'  {prefix} 위가 트여 뺀 자리(마디, ㎡): {uncovered}')
    if caps: REPORT.append(f'  {prefix} 위 상자 밑까지로 낮춘 마디: {caps}')
    return whole

G_ROAD = '확정(지하 차도가 있고 서문·P1 입구 두 곳에서 들어간다: 사용자 2026-10-10, 길 = 사용자 트래킹·확정 경로), 추정(폭 7.2 m·천장·어귀 자리: 길 선·높이가 추정이라 그대로 따름)'
G_WALK = '확정(본관 쪽 사람 다니는 구간·지하 횡단보도가 있다: 사용자 2026-10-10·그림 14·C02 10-15 기압 128.1), 추정(폭·천장)'
MAIN = ROADS['1cdf7601'] + ROADS['7f52c32e'][1:] + ROADS['f666ce65'][1:]
band('UV1-ROAD-WEST', MAIN, 3.6, 3.5, '지하 차도(서문 터널 ~ 본관 옆)', G_ROAD, '지하 차도 서문 터널 ~ 합류 ~ 지하 횡단보도 자리 ~ 본관 옆 구간 아래 끝(길 1cdf7601·7f52c32e·f666ce65), 폭 7.2 m')
band('UV1-ROAD-P1', ROADS['b85c41a9'], 3.6, 3.5, '지하 차도(P1 갈래)', G_ROAD, '지하 차도 P1 입구 ~ 합류(길 b85c41a9), 폭 7.2 m')
band('UV1-WALK', ROADS['b1758181'], 1.2, 2.5, '지하 보행 구간', G_WALK, '지하 차도 보행 구간 본관 북쪽 벽 옆(길 b1758181), 폭 2.4 m(Z07 와 같음)')
band('UV1-CROSS', ROADS['33371f63'] + ROADS['0fce276d'][1:], 1.5, 2.5, '지하 횡단보도·북악관 B1 통로', G_WALK,
     '보행 구간 ~ 지하 횡단보도 ~ 북악관 B1 문 ~ 통로 ~ 계단 아래(길 33371f63·0fce276d), 폭 3.0 m(U06 북악관 문 폭)', ext_end=0.5)

# ===================== E 청운관 계단실 =====================
G_ST = '확정(계단실·앞방·B1 문·B2 로 내려가는 계단이 있다: 영상 2·사용자 2026-10-22, 높이 149.2/143.5/140.0: 사용자 결정), 추정(평면·단 수·참 자리: 길 꼭짓점대로)'
UG = dict(underground=True, inVoid=True)
X0, XA, XL0, XL1, XE = 201207.5, 201208.3, 201211.3, 201212.0, 201215.22   # 계단실 서쪽 끝, 앞방 끝, 가운데 참, 위 줄 머리
YU = (557282.45, 557283.25); YN = (557283.25, 557284.05); YS = (557281.65, 557282.45); YW = (557281.4, 557284.3)
Z_TOP, Z_MID, Z_B1, Z_LOW, Z_B2 = 149.2, 146.35, 143.5, 141.75, 140.0
def R(x0, x1, y): return box(min(x0, x1), y[0], max(x0, x1), y[1])
feat('UV1-CHEONGUN-ANTE', 'landing', unary_union([R(X0, XA, YW), R(X0, 201210.0, (YW[0], YS[1]))]), Z_B1 - 0.3, Z_B1,
     '청록 앞방 바닥 143.5(지하 1층 문 높이). 서쪽 끝 0.8 m 와 남쪽 줄 위(B1 문으로 가는 길 b0d07a1b 자리), 판 0.3 m. 밑은 B2 발치', G_ST, color='#8e8f8c', **UG)
NU = 12; RU = (Z_TOP - Z_MID) / (NU + 1)
for k in range(1, NU + 1):   # 위 줄 첫째: 붉은 벽 칸(149.2) → 가운데 참(146.35), 서쪽으로
    T = (XE - XL1) / NU; x1 = XE - (k - 1) * T; z = Z_TOP - k * RU
    feat(f'UV1-CHEONGUN-UP1-{k:02d}', 'stair_step', R(x1 - T, x1, YU), z - 0.35, z, f'위 줄 첫째 {k}/{NU} 단(붉은 벽 칸 → 가운데 참, 단 {RU:.3f} m, 판 0.35 m: 밑으로 아래 되돌림 참이 지남)', G_ST,
         color='#9a9b98', stair='UV1-CHEONGUN-UP1', riseM=round(RU, 3), runM=round(T, 3), widthM=0.8, **UG)
feat('UV1-CHEONGUN-MID', 'landing', R(XL0, XL1, YU), Z_MID - 0.35, Z_MID, '위 줄 가운데 참 146.35(길 c9319f92 꼭짓점 둘), 판 0.35 m', G_ST, color='#8e8f8c', **UG)
RD = (Z_MID - Z_B1) / (NU + 1)
for k in range(1, NU + 1):   # 위 줄 둘째: 가운데 참 → 앞방(143.5)
    T = (XL0 - XA) / NU; x1 = XL0 - (k - 1) * T; z = Z_MID - k * RD
    feat(f'UV1-CHEONGUN-UP2-{k:02d}', 'stair_step', R(x1 - T, x1, YU), z - 0.35, z, f'위 줄 둘째 {k}/{NU} 단(가운데 참 → 앞방, 단 {RD:.3f} m)', G_ST,
         color='#9a9b98', stair='UV1-CHEONGUN-UP2', riseM=round(RD, 3), runM=round(T, 3), widthM=0.8, **UG)
NL = 9; RL = (Z_B1 - Z_LOW) / (NL + 1)
for k in range(1, NL + 1):   # 아래 북쪽 줄: 앞방(143.5) → 되돌림 참(141.75), 동쪽으로. 밑은 계단실 바닥까지 채움
    T = (XL0 - XA) / NL; x0 = XA + (k - 1) * T; z = Z_B1 - k * RL
    feat(f'UV1-CHEONGUN-DN1-{k:02d}', 'stair_step', R(x0, x0 + T, YN), Z_B2, z, f'아래 북쪽 줄 {k}/{NL} 단(앞방 → 되돌림 참, 단 {RL:.3f} m)', G_ST,
         color='#9a9b98', stair='UV1-CHEONGUN-DN1', riseM=round(RL, 3), runM=round(T, 3), widthM=0.8, **UG)
feat('UV1-CHEONGUN-TURN', 'landing', R(XL0, XL1 + 0.4, (YS[0], YN[1])), Z_B2, Z_LOW, '아래 되돌림 참 141.75(길 1eccfdaf 꼭짓점 둘). 위로 위 줄 가운데 참(146.35)이 지남', G_ST, color='#8e8f8c', **UG)
XS = 201208.9   # 남쪽 줄 발치: B2 문으로 가는 길 b34a475c 가 줄을 밟지 않게 0.6 m 동쪽에서 끝냄
for k in range(1, NL + 1):   # 아래 남쪽 줄: 되돌림 참 → B2(140.0), 서쪽으로
    T = (XL0 - XS) / NL; x1 = XL0 - (k - 1) * T; z = Z_LOW - k * RL
    feat(f'UV1-CHEONGUN-DN2-{k:02d}', 'stair_step', R(x1 - T, x1, YS), Z_B2, z, f'아래 남쪽 줄 {k}/{NL} 단(되돌림 참 → 지하 2층 140.0, 단 {RL:.3f} m)', G_ST,
         color='#9a9b98', stair='UV1-CHEONGUN-DN2', riseM=round(RL, 3), runM=round(T, 3), widthM=0.8, **UG)
DOOR = box(201208.6, 557280.2, 201210.4, 557281.5)   # 계단실 남쪽 변(557281.4) ~ 학교 지도 꼭짓점 "청운관 서"(201209.4, 557280.8) 너머 B1·B2 안
feat('UV1-CHEONGUN-DOOR-B1', 'void', DOOR, Z_B1, Z_B1 + 2.2, '계단실 앞방 → 지하 1층 문 통로(길 b0d07a1b 끝 = 학교 지도 꼭짓점, 계단실 빈 곳과 B1 빈 곳 사이 0.6 m 틈)', G_ST, kind='void', name='청운관 계단실 문(B1)')
feat('UV1-CHEONGUN-DOOR-B2', 'void', DOOR, Z_B2, Z_B2 + 2.2, '계단실 발치 → 지하 2층 문 통로(길 b34a475c 끝)', G_ST, kind='void', name='청운관 계단실 문(B2)')

# ===================== 기단 밑 내림 · 검사 =====================
MODS = {}
for vid, vg, vf, vt in NEWV:
    if vid.startswith('UV1-CHEONGUN'): continue   # 계단실 문: 계단실 빈 곳(X22)처럼 기단 밑을 두지 않음(Z02 APRON 141.0 은 B2 빈 곳도 이미 밑을 지남)
    c = vg.representative_point()
    for k in PTREE.query(vg):
        pid, pg, pt = PLATS[k]
        if pg.intersection(vg).area < 0.3: continue
        fn, f = WHERE[pid]; p = f['properties']; ztop = pt(c.x, c.y)
        if ztop < vt + 0.3 - 1e-6 and pg.contains(c) and not mass_at(c.x, c.y, vf): REPORT.append(f'뚫음? {vid} 천장 {vt} vs {pid} 윗면 {ztop:.2f}')
        if ztop > vt and float(p.get('bottomM', -1e9)) > vf - FOOT + 1e-6: MODS[pid] = min(MODS.get(pid, 1e9), r2(vf - FOOT))
for pid, nb in sorted(MODS.items()):
    fn, f = WHERE[pid]; p = f['properties']
    BASE['features'].setdefault(fn, {}).setdefault(pid, copy.deepcopy(f))
    REPORT.append(f'기단 밑 내림 {fn} {pid}: {p["bottomM"]} → {nb}')
    p['assumption'] = p.get('assumption', '').split(' [UV1')[0] + f' [UV1 2026-10-25: 밑 {p["bottomM"]} → {nb}(밑을 지나는 지하 빈 곳 바닥 - 기초 판 {FOOT} m)]'
    p['bottomM'] = nb
for vid, vg, vf, vt in NEWV:   # 빈 곳 안에 든 상자(지하 표시 아님): 겹침
    for k in STREE.query(vg):
        i, g, p = SOLIDS[k]
        if p.get('underground') or p.get('inVoid') or p['toM'] <= vf + 0.01 or p['fromM'] >= vt - 0.01: continue
        a = g.intersection(vg).area
        if a <= 0.05: continue
        b0, b1 = zrange(p, g.intersection(vg))
        if b1 > vf + 0.01 and b0 < vt - 0.01: REPORT.append(f'겹침 {vid} ({vf}~{vt}) × {i} ({b0:.2f}~{b1:.2f}) {a:.2f} ㎡')
NB = [(f['properties']['id'], shape(f['geometry']).buffer(0), f['properties']) for f in NEW if f['properties']['kind'] != 'void']
for a in range(len(NB)):   # 새 상자끼리
    for b in range(a + 1, len(NB)):
        (i, g, p), (j, h, q) = NB[a], NB[b]
        if p['toM'] > q['fromM'] + 0.01 and q['toM'] > p['fromM'] + 0.01 and g.intersection(h).area > 0.01: REPORT.append(f'새 상자 겹침 {i} × {j}')
# 길 꼭짓점이 어느 빈 곳·참 위인지(#35 판정 흉내: 가장 가까운 면 1.5 m)
WALK = [(i, shape(f['geometry']), f['properties']) for i, (fn, f) in WHERE.items() if f['properties'].get('kind') == 'void'] + \
       [(f['properties']['id'], shape(f['geometry']), f['properties']) for f in NEW]
for rid, cs in ROADS.items():
    bad = []
    for x, y, z in cs:
        hs = [(abs(z - (p['fromM'] if p['kind'] == 'void' else p['toM'])), i) for i, g, p in WALK if g.contains(Point(x, y))]
        t = top_at(x, y); hs += [(abs(z - t[0]), t[1])] if t else []
        best = min(hs) if hs else (99, '-')
        if best[0] > 1.5: bad.append(f'({x}, {y}, {z}) {best[1]} {best[0]:.2f}')
    REPORT.append(f'길 {rid}: ' + ('꼭짓점 모두 1.5 m 안' if not bad else '남음 ' + '; '.join(bad)))

for fn in sorted({WHERE[pid][0] for pid in MODS}): dump(STR / fn, D[fn])
if MODS and not DRY: dump(BASEF, BASE)
dump(STR / OUT, {'type': 'FeatureCollection', 'name': 'uv1-underground-voids', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': NEW})
print('\n'.join(REPORT)); print(f'{OUT}: {len(NEW)} (빈 곳 {len(NEWV)})', '(dry)' if DRY else '')
