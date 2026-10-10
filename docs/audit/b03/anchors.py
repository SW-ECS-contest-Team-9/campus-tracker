"""B03 1단계 — 학교 캠퍼스맵 출입구(몇 층 입구인지)와 S-MAP 지면으로 동별 층 바닥 높이를 구한다. 읽기 전용, DB 없음.

  python docs/audit/b03/anchors.py <audit-dir> <backend-dir> <out.json>

입력: <audit-dir>/e05/smap-mesh-*.txt (S-MAP 3D 화면 표면 z 와 모델 id, 2026-10-10 판독. 독립 측량 아님),
<backend-dir>/data/terrain/source/skuniv_places.json (출입구 설명 = 원천), <backend-dir>/data/scene/source/campus.gpkg.

지면 읽는 법(모든 출입구 같음): 표지점 5 m 안(지형 칸이 5개 미만이면 8 m)의 S-MAP 지형 칸 = "둘레", 6 m 안에서 S-MAP 건물 칸에 맞닿은
지형 칸 = "벽 앞". 벽 앞 칸이 3개 이상이면 벽 앞 중앙값을, 아니면 둘레 중앙값을 쓴다. 다르게 고른 곳은 OVERRIDE 에 이유와 함께 적는다.
운동장 쪽 문은 운동장 바닥 측정값(E06, 148.9 m)을 쓰고 S-MAP 값과의 차를 남긴다.

층 높이: 기준층은 그 높이, 기준 사이 층은 실제 층 수로 고르게 나눔, 기준 밖은 PLAN 에 적은 층고로 늘림(등급 추정).
층 번호 4·13 을 건너뛰는지는 동마다 두 가설을 모두 계산해 (1) 기준 사이 층고 (2) 가장 높은 기준층에서 S-MAP 지붕까지의 층고로 견준다.
층고 2.7 m 미만·5.5 m 초과는 implausible 로 표시한다. 어느 가설을 층 사다리에 쓸지는 PLAN 에 이유와 함께 적는다(자동 선택 아님).
"""
import json, math, pathlib, statistics, sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import TERRAIN, FIELD_M, load_cells, entrances, outlines
from shapely.geometry import Point

audit, backend, out = map(pathlib.Path, sys.argv[1:4])
C = load_cells(audit / 'e05'); O = outlines(backend)
med = statistics.median; r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)
st = lambda v: {'n': len(v), 'min': r1(min(v)), 'median': r1(med(v)), 'max': r1(max(v))} if v else {'n': 0}
ok = lambda h: 2.7 <= h <= 5.5


def near(x, y, r):
    c = [(a, b, z, i, s) for (a, b), (z, i, s) in C.items() if math.hypot(a - x, b - y) <= r]
    step = min(k[4] for k in c)
    return [k for k in c if k[4] == step], step


def box(x0, y0, x1, y1):
    return [z for (a, b), (z, i, s) in C.items() if x0 <= a <= x1 and y0 <= b <= y1 and i == TERRAIN]


# 표지점 규칙과 다르게 고른 높이: (칸을 고르는 함수 또는 None=운동장 측정값, 등급, 이유)
OVERRIDE = {
    '유담관 입구(1)': (lambda: box(201060, 557222, 201072, 557234), 'S-MAP', '표지는 비탈 끝(둘레 114~126 m)에 찍혀 있다. 학교 사진의 입구는 평평한 광장 바닥에 있고, 표지 동남쪽 3~15 m 가 분수 광장 평탄면이다(x 201060~201072, y 557222~557234)'),
    '유담관 입구(3)': (lambda: box(200990, 557286, 200998, 557294), 'S-MAP', '표지는 서쪽 벽 비탈(104~119 m) 위에 찍혀 있다. 벽 발치의 낮은 길(표지 서쪽 3.5~11.5 m, 남북 ±4 m)을 읽었다. 길이 남북으로 기울어 4 m 에 0.6 m 달라진다'),
    '은주1관 입구(2)': (None, '측정', '운동장 쪽 문: 운동장 바닥 측정값(E06)'),
    '은주2관 입구(2)': (None, '측정', '운동장 쪽 문: 운동장 바닥 측정값(E06)'),
    '청운관 입구': (None, '측정', '운동장 쪽 문: 운동장 바닥 측정값(E06)'),
}
ENT = []
for e in entrances(backend):
    c, step = near(e['x'], e['y'], 5); r = 5
    if sum(1 for k in c if k[3] == TERRAIN) < 5: c, step = near(e['x'], e['y'], 8); r = 8
    around = [k[2] for k in c if k[3] == TERRAIN]
    c6, _ = near(e['x'], e['y'], 6); b = [(k[0], k[1]) for k in c6 if k[3] != TERRAIN]
    wall = [k[2] for k in c6 if k[3] == TERRAIN and any(max(abs(k[0] - p), abs(k[1] - q)) <= step for p, q in b)]
    use = wall if len(wall) >= 3 else around
    row = {**e, 'gridStepM': step, 'radiusM': r, 'around': st(around), 'wallFoot': st(wall), 'groundM': r1(med(use)), 'groundFrom': 'wallFoot' if use is wall else 'around',
           'spread': [r1(min(use)), r1(max(use))], 'grade': 'S-MAP', 'insideOutlineOf': [n for n, p in O.items() if p.contains(Point(e['x'], e['y']))]}
    if e['name'] in OVERRIDE:
        f, grade, why = OVERRIDE[e['name']]
        if f: v = f(); row.update(groundM=r1(med(v)), spread=[r1(min(v)), r1(max(v))], groundFrom='override', overrideCells=len(v))
        else: row.update(smapGroundM=row['groundM'], groundM=FIELD_M, groundFrom='field (E06)', smapMinusFieldM=r1(row['groundM'] - FIELD_M))
        row.update(grade=grade, why=why)
    ENT.append(row)
G = {e['name']: e for e in ENT}
g = lambda n: G[n]['groundM']


def idx(label, skip):
    """실제 층 순서: B2 -2, B1 -1, 1층 0, 2층 1 ... (skip 에 든 번호는 층이 아니다). 5.5 같은 값은 층 사이 계단참."""
    if isinstance(label, str): return -int(label[1:])
    return label - 1 - sum(1 for s in skip if s < label)


def segments(anchors, skip):
    a = sorted(((idx(l, skip), z, l) for l, z in anchors)); o = []
    for (i0, z0, l0), (i1, z1, l1) in zip(a, a[1:]):
        if i1 == i0: o.append({'from': l0, 'to': l1, 'storeys': 0, 'differenceM': r1(z1 - z0)}); continue
        h = (z1 - z0) / (i1 - i0); o.append({'from': l0, 'to': l1, 'storeys': i1 - i0, 'storeyHeightM': r2(h), 'implausible': not ok(h)})
    return o


def ladder(anchors, labels, skip, h_below, h_above, derived=()):
    """{층: [높이, 'anchor'|'interp'|'extrap']}. 기준 사이는 고르게, 가장 낮은 기준 아래는 h_below, 가장 높은 기준 위는 h_above."""
    a = sorted({idx(l, skip): z for l, z in anchors}.items()); res = {}
    for l in labels:
        if not isinstance(l, str) and l in skip: continue
        k = idx(l, skip); hit = [z for i, z in a if i == k]
        lo = [p for p in a if p[0] < k]; hi = [p for p in a if p[0] > k]
        if hit: res[str(l)] = [r1(hit[0]), 'interp' if l in derived else 'anchor']
        elif lo and hi: (i0, z0), (i1, z1) = lo[-1], hi[0]; res[str(l)] = [r1(z0 + (z1 - z0) * (k - i0) / (i1 - i0)), 'interp']
        elif lo: res[str(l)] = [r1(lo[-1][1] + h_above * (k - lo[-1][0])), 'extrap']
        else: res[str(l)] = [r1(hi[0][1] - h_below * (hi[0][0] - k)), 'extrap']
    return res


def study(labels, skips, anchors, roof_m, top):
    res = {'labels': [str(l) for l in labels], 'anchors': [{'floor': l, 'heightM': z} for l, z in anchors], 'smapRoofM': roof_m, 'hypotheses': {}}
    for hn, skip in skips.items():
        a = sorted(anchors, key=lambda p: idx(p[0], skip)); lo, hi = a[0], a[-1]
        n_up = idx(top, skip) - idx(hi[0], skip) + 1                       # 가장 높은 기준층 바닥에서 지붕까지의 층 수
        h_roof = (roof_m - hi[1]) / n_up
        d = idx(hi[0], skip) - idx(lo[0], skip); h_a = (hi[1] - lo[1]) / d if d else None
        res['hypotheses'][hn] = {'skip': skip, 'storeysAboveGround': idx(top, skip) + 1, 'betweenAnchors': segments(anchors, skip), 'meanBetweenAnchorsM': r2(h_a) if h_a else None,
                                 'topAnchorToSmapRoof': {'storeys': n_up, 'storeyHeightM': r2(h_roof), 'implausible': not ok(h_roof)},
                                 'roofAtAnchorStoreyHeight': None if not h_a else {'roofM': r1(hi[1] + h_a * n_up), 'minusSmapRoofM': r1(hi[1] + h_a * n_up - roof_m)}}
    return res


# 유담관 9층의 두 번째 읽기: 탑 북서 모서리 앞마당(운영 길의 입구 통로가 시작하는 자리, x 201018~201030, y 557288~557296)의 S-MAP 지면
YUDAM_9F = r1(med(box(201018, 557288, 201030, 557296)))
# 동별 계획: 층 표기(학교 호실 목록 = 원천), 가설, 기준(층, 높이), S-MAP 지붕, 사다리에 쓴 가설과 이유.
# 4층 없음은 사용자 확정(2026-10-10 "확실히 4층이 없어. 실제로 가보면 3층 다음 바로 5층이야"): 모든 동에 적용한다.
# 13층 건너뜀은 추정(호실 목록에 13층 호실이 없는 동). ladderAnchors = 사다리에 쓰는 기준(없으면 anchors 전부).
S4 = {'4 건너뜀': [4]}; S413 = {'4·13 건너뜀': [4, 13], '4만 건너뜀': [4]}
PLAN = {
    '유담관': dict(labels=['B2', 'B1', *range(1, 17)], skips=S413, top=16, roof=167.4,
                roofNote='기운 지붕의 낮은 끝(tower.py 직선 맞춤 167.4). 높은 끝은 180.4',
                anchors=[(3, g('유담관 입구(3)')), (6, g('유담관 입구(1)')), (9, YUDAM_9F)], ladderAnchors=[6, 9], use='4·13 건너뜀', doubleHeight=6,
                why='6층(분수 광장, 확정)과 9층(버스 정류장 쪽, 확정)만 기준으로 쓴다. 9층 높이는 탑 북서 모서리 앞마당 지면(YUDAM_9F)이고 입구(2) 표지의 벽 앞 지면(126.9)은 따로 남긴다. 6층은 거의 두 층 높이(사용자 확정, 값은 추정)라 6→9층을 6층 2 : 7층 1 : 8층 1 로 나눴다. 3층 입구 기준은 의심(본문). 13은 추정'),
    '본관': dict(labels=[*range(1, 9)], skips=S4, top=8, roof=153.8, roofNote='S-MAP 건물 칸 중앙값(E05)',
               anchors=[(2, g('본관 입구(2)')), (5.5, g('본관 입구(3)'))], use='4 건너뜀',
               why='2층 입구와 5·6층 사이 계단참 입구. 5.5 = 5층과 6층의 한가운데로 본 가정. 그 층고로 올린 지붕이 S-MAP 지붕과 1 m 안에서 맞는다'),
    '한림관': dict(labels=[*range(1, 17)], skips=S413, top=16, roof=188.1, roofNote='바깥 고리 지붕(B02). 가운데 원판은 197.3',
                anchors=[(1, g('한림관 입구')), (6, FIELD_M)], use='4·13 건너뜀',
                why='6층 = 은주1관 5층 = 운동장 높이(학교 연결통로 설명 + E06). 1→6층이 4개 층 22.4 m, 층당 5.6 m 로 범위(5.5 m)를 조금 넘는다. 13은 추정'),
    '은주1관': dict(labels=[*range(1, 7)], skips=S4, top=6, roof=156.8, roofNote='1관 지붕(E05). 경사 지붕이라 층고 계산에는 참고만',
                 anchors=[(1, g('은주1관 입구(1)')), (5, FIELD_M)], use='4 건너뜀', why='1→5층이 3개 층 17.6 m, 층당 5.87 m 로 범위를 넘는다. 6층은 사용자 확정(있다는 사실만)'),
    '은주2관': dict(labels=[*range(1, 7)], skips=S4, top=6, roof=159.7, roofNote='2관 높은 지붕(E05). 경사 지붕이라 참고만',
                 anchors=[(1, g('은주2관 입구(1)')), (5, FIELD_M)], use='4 건너뜀', why='1관과 같은 층 번호로 본다(추정: 2관 호실은 5층만 등록). 1→5층 3개 층, 층당 5.57 m'),
    '대일관': dict(labels=['B2', 'B1', *range(1, 8)], skips=S4, top=7, roof=172.1, roofNote='본체 지붕(B02). 처마 168~171',
                anchors=[(1, r1(med([g('대일관 입구(2)'), g('대일관 입구(3)')])))], use='4 건너뜀', why='기준은 1층 하나(1층 복도 입구 두 곳의 S-MAP 지면). 지상 6개 층'),
    '청운관': dict(labels=['B1', *range(1, 12)], skips=S4, top=11, roof=187.8, roofNote='본체 지붕(B02)', anchors=[(1, FIELD_M)], use='4 건너뜀', why='기준은 1층 하나(운동장). 지상 10개 층'),
    '혜인관': dict(labels=['B1', *range(1, 8)], skips=S4, top=7, roof=178.1, roofNote='S-MAP 건물 칸 중앙값(E05). 여러 단 166~182',
                anchors=[('B1', r1(med([g('혜인관 입구(1)'), g('혜인관 입구(2)')])))], use='4 건너뜀', why='운동장 높이의 두 입구를 B1 로 읽었다. B1 포함 7개 층 = 대장의 지상 7층과 같은 수'),
    '문예관': dict(labels=['B1', *range(1, 16)], skips=S413, top=15, roof=189.4, roofNote='지붕(E02). 지붕판 188.8~190.2',
                anchors=[(2, g('문예관 입구(2)')), (3, g('문예관 입구(1)'))], ladderAnchors=[2], use='4·13 건너뜀',
                why='두 기준(2층·3층 입구)의 지면 차가 1.9 m 라 층고로 쓸 수 없다(3층 로비 표지가 낮은 날개 지붕 아래라 문 앞 지면을 못 읽음). 2층 기준만 쓰고 층고는 2층~지붕 평균. 13은 추정'),
    '북악관': dict(labels=['B1', *range(1, 10)], skips=S4, top=9, roof=160.6, roofNote='S-MAP 건물 칸 중앙값(E05)',
                anchors=[(1, g('북악관 입구(1)'))], use='4 건너뜀', why='기준은 1층 하나. 지상 8개 층 = 보행 기록의 8단'),
}
B = {}
for name, p in PLAN.items():
    s = study(p['labels'], p['skips'], p['anchors'], p['roof'], p['top'])
    skip = p['skips'][p['use']]; derived = []
    anchors = [q for q in p['anchors'] if 'ladderAnchors' not in p or q[0] in p['ladderAnchors']]
    half = [(l, z) for l, z in anchors if not isinstance(l, str) and not float(l).is_integer()]
    if half:  # 계단참 기준(5층과 6층 사이): 아래 기준과의 층고로 아래·위 층 높이를 낸다
        (l, z), = half; anchors.remove(half[0]); l0, z0 = anchors[0]; hh = (z - z0) / (idx(l, skip) - idx(l0, skip))
        anchors += [(int(l), r1(z - hh / 2)), (int(l) + 1, r1(z + hh / 2))]; derived = [int(l), int(l) + 1]
    a = sorted(anchors, key=lambda q: idx(q[0], skip)); n = idx(a[-1][0], skip) - idx(a[0][0], skip)
    h_mean = (a[-1][1] - a[0][1]) / n if n else None
    h_roof = (p['roof'] - a[-1][1]) / (idx(p['top'], skip) - idx(a[-1][0], skip) + 1)
    h_above = h_roof if ok(h_roof) else h_mean          # 위쪽: S-MAP 지붕에 맞춘 층고(그럴듯할 때), 아니면 기준 사이 평균
    h_below = h_mean if h_mean else h_roof              # 아래쪽: 기준 사이 평균(범위를 넘어도 확정 층 수를 따른 값), 기준이 하나면 지붕까지 평균
    s.update(roofNote=p['roofNote'], ladderHypothesis=p['use'], ladderWhy=p['why'], storeyHeightBelowAnchorsM=r2(h_below), storeyHeightAboveAnchorsM=r2(h_above),
             storeyHeightAboveFrom='S-MAP 지붕까지를 층 수로 나눔(난간 포함)' if ok(h_roof) else '기준 사이 평균(지붕까지 나눈 값은 5.5 m 초과)',
             ladder=ladder(anchors, p['labels'], skip, h_below, h_above, derived))
    if p.get('doubleHeight'):  # 한 층이 두 층 높이: 기준 사이 층 수에 하나를 더해 층고를 내고 그 층만 두 배로 둔다
        d = p['doubleHeight']; z0 = dict(anchors)[d]; z1 = a[-1][1]; hh = (z1 - z0) / (n + 1); lad = s['ladder']
        for l in p['labels']:
            if isinstance(l, str) or l in skip or str(l) not in lad or lad[str(l)][1] == 'anchor': continue
            k = idx(l, skip) - idx(d, skip)
            lad[str(l)] = [r1(z0 + hh * (k + 1)) if 0 < k < n else r1(z1 + hh * (k - n)) if k > n else r1(z0 + hh * k), 'interp' if 0 < k < n else 'extrap']
        for l in ('B1', 'B2'): lad[l] = [r1(z0 + hh * (idx(l, skip) - idx(d, skip))), 'extrap']
        s.update(storeyHeightBelowAnchorsM=r2(hh), storeyHeightAboveAnchorsM=r2(hh), doubleHeightFloor={'floor': d, 'heightM': r2(2 * hh), 'otherStoreysM': r2(hh)},
                 storeyHeightAboveFrom='6층을 두 층 높이로 보고 6→9층을 4등분한 층고(지붕까지 나눈 값은 5.5 m 초과)', alternative9F={'markerWallFootM': g('유담관 입구(2)'), 'thenStoreyM': r2((g('유담관 입구(2)') - z0) / (n + 1))})
    B[name] = s

# 연결통로: 두 동의 층 높이가 같아야 한다
L = lambda b, f: B[b]['ladder'][str(f)][0]
CONN = [
    {'statement': '본관 5층 = 한림관 3층', 'a': ['본관', 5, L('본관', 5)], 'b': ['한림관', 3, L('한림관', 3)]},
    {'statement': '한림관 3층 = 은주1관 2층', 'a': ['한림관', 3, L('한림관', 3)], 'b': ['은주1관', 2, L('은주1관', 2)]},
    {'statement': '한림관 6층 = 은주1관 5층', 'a': ['한림관', 6, L('한림관', 6)], 'b': ['은주1관', 5, L('은주1관', 5)]},
    {'statement': '은주1관 5층 = 운동장 바닥(E06)', 'a': ['은주1관', 5, L('은주1관', 5)], 'b': ['운동장', '-', FIELD_M]},
]
for c in CONN: c['residualM'] = r1(c['a'][2] - c['b'][2])
# 세 동의 사슬이 한 높이에서 만나는지: 본관 5층(본관 서쪽 입구들) / 한림관 3층(한림관 1층 로비 + 운동장) / 은주1관 2층(1관 1층 입구 + 운동장)
test = {'본관 5층 M': L('본관', 5), '한림관 3층 M': L('한림관', 3), '은주1관 2층 M': L('은주1관', 2), '세 값의 범위 M': r1(max(L('본관', 5), L('한림관', 3), L('은주1관', 2)) - min(L('본관', 5), L('한림관', 3), L('은주1관', 2))),
        '한림관 1→6층 층고 M': r2((L('한림관', 6) - L('한림관', 1)) / 4), '은주1관 1→5층 층고 M': r2((L('은주1관', 5) - L('은주1관', 1)) / 3), '본관 층고 M': B['본관']['storeyHeightBelowAnchorsM'],
        '읽기': '본관 사슬은 층고 3.7 m 의 독립된 기준이다. 세 값이 1 m 안에서 만나면 한림관·은주1관의 1층 기준과 운동장 아래 높은 층고(5.6~5.9 m)가 서로 맞는다는 뜻이다'}
json.dump({'method': __doc__, 'fieldM': FIELD_M, 'entrances': ENT, 'buildings': B, 'connectors': CONN, 'connectorChainTest': test}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for e in ENT: print(f"{e['name']:<20} {e['groundM']:6.1f} {str(e['spread']):<16} {e['grade']:<5} {e['groundFrom']:<11} 둘레 {e['around']} 벽앞 {e['wallFoot']}")
for n, s in B.items():
    print(f"\n{n}: 기준 {s['anchors']} 지붕 {s['smapRoofM']}")
    for hn, h in s['hypotheses'].items(): print(f"  [{hn}] 지상 {h['storeysAboveGround']}개 층, 기준 사이 {h['betweenAnchors']}, 지붕까지 {h['topAnchorToSmapRoof']}, 기준 층고로 올린 지붕 {h['roofAtAnchorStoreyHeight']}")
    print(f"  사다리({s['ladderHypothesis']}, 아래 층고 {s['storeyHeightBelowAnchorsM']}, 위 층고 {s['storeyHeightAboveAnchorsM']}): " + ' '.join(f"{k}={v[0]}{'' if v[1] == 'anchor' else '~' if v[1] == 'interp' else '?'}" for k, v in s['ladder'].items()))
for c in CONN: print(c)
print(test)
