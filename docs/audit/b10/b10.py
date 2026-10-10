"""B10 — 북악관 층 높이와 B1 길을 지면 판독·보행 기록으로 다시 구한다. 읽기 전용(DB·MCP 쓰기 없음).

  python docs/audit/b10/b10.py <audit-dir> docs/audit/b10/results.json [--write-proposals]

입력
- <audit-dir>/b10/smap-mesh-b10-{front,west,north}-1m.txt : S-MAP 3D 화면 메시 1 m 격자(2026-10-10, e05/collect_grid.js 의 __grid).
    __grid('b10-front-1m', 201018, 557336, 55, 51, 1, 132, 1500), __grid('b10-west-1m', 200984, 557372, 47, 53, 1, 131, 1500),
    __grid('b10-north-1m', 201010, 557374, 87, 51, 1, 133, 1500). 저장은 e05/save_grid.py.
- <audit-dir>/b10/smap-elevation-raw.json : S-MAP 표고 조회 15점(b10/smap_elev_query.py).
- <audit-dir>/claude-live/tracks/*.json : 보행 기록(기압 높이, 보정 안 된 원값), roads-live-2.json : 운영 스냅숏.
하는 일
1) 자리마다 S-MAP 지면(지형 칸만, 반경 1.5 m 중앙값·범위)과 표고 조회 값.
2) 보행 기록의 평평한 구간(높이가 0.35 m 안에서 6점 이상)을 시간 순서로 뽑아 층 사이 오름을 잰다. 휴대 높이와 기압 치우침은
   같은 기록 안의 이웃한 두 구간 차에서는 지워진다. 그래서 절대값은 쓰지 않고 차만 쓴다.
3) 후보 모형 A·B·D 를 사용자 확정(F1~F6)·지면·보행 기록과 견준 표.
4) 층 표. --write-proposals 를 주면 docs/audit/b03/network.json, e09/editor-ops.json 의 북악관 제안 상태를 고치고 모의 적용을 다시 한다.
   (b03/network.py·b08/b08.py·e09/build.py 를 다시 돌리면 이 표시가 지워지므로 그 뒤에 이 스크립트를 다시 돌린다.)
"""
import collections, glob, json, math, os, pathlib, statistics, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'e05'))
from grids import Grid  # noqa: E402

audit, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
TERRAIN = 419430528
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)

# ---- 1. S-MAP 지면
cells = {}
for n in ('front', 'west', 'north'):
    g = Grid(audit / f'b10/smap-mesh-b10-{n}-1m.txt')
    for x, y, z, i in g.cells(): cells.setdefault((x, y), (z, i))
API = {r['name']: json.loads(r['raw'])['result']['dem_z'] for r in json.loads((audit / 'b10/smap-elevation-raw.json').read_text(encoding='utf-8')) if r['status'] == 200}


def read(x, y, r=1.5):
    v = sorted(z for (a, b), (z, i) in cells.items() if i == TERRAIN and math.hypot(a - x, b - y) <= r)
    return None if not v else {'n': len(v), 'medianM': r1(statistics.median(v)), 'rangeM': [r1(v[0]), r1(v[-1])]}


SPOTS = [  # (이름, x, y, 표고 조회 이름, 비고)
    ('횡단보도 본관 쪽 끝', 201045.7, 557350.6, '횡단보도 본관 쪽 끝', '그림 14 를 옮긴 자리(±2 m). 아스팔트'),
    ('횡단보도 북악관 쪽 끝', 201047.5, 557354.3, '횡단보도 북악관 쪽 끝', '아스팔트'),
    ('통로(상자) 남쪽 끝', 201047.3, 557356.5, None, '화단 턱 앞'),
    ('통로(상자) 가운데', 201046.7, 557359.8, '통로 상자 가운데', '정문 계단 동쪽 옆, 소나무 화단 가장자리. 지상 면은 화단 단으로 오른다'),
    ('통로(상자) 북쪽 끝 = 벽 앞 계단 아래', 201047.5, 557362.5, '통로 북쪽(계단 앞)', '정문 차양 남동 모서리 앞. 지상 면은 화단 단 위'),
    ('벽 앞 계단 위(그림 자리)', 201046.0, 557365.4, None, '차양·건물 칸이라 지면이 안 읽힌다'),
    ('정문 계단 아래', 201039.5, 557360.5, '정문 계단 아래', '아스팔트(주차 칸)'),
    ('정문 바깥 계단 위(차양 앞 가장자리)', 201041.5, 557365.0, '정문 바깥 계단 위(차양 앞)', '차양에 가려 계단 윗부분은 일부만 읽힌다'),
    ('정문 동쪽 화단 단', 201052.0, 557360.0, '정문 동쪽 화단 단', '포장 아님(소나무 화단)'),
    ('정문 서쪽 단', 201034.0, 557369.0, None, '계단 서쪽 옆벽 뒤'),
    ('GS25 문 앞(학교 표지를 벽 앞으로 옮긴 자리)', 201008.0, 557395.0, 'GS25 문 앞(학교 표지 옮김)', '서쪽 끝 벽 앞 포장 길'),
    ('서쪽 벽 남쪽 끝', 201005.0, 557386.0, '서쪽 벽 남쪽 끝', '포장 길'),
    ('서쪽 벽 북쪽 끝', 201012.0, 557410.0, '서쪽 벽 북쪽 끝', '포장 길(북쪽으로 오른다)'),
    ('남서 모서리 단(입구(3) 앞 계단 자리)', 201016.0, 557378.0, '남서 모서리 단(입구(3) 앞)', '사진 08 오른쪽의 올라가는 계단으로 읽음(추정)'),
    ('뒤편 북쪽 벽 서쪽', 201024.0, 557411.0, None, '뒤편 산책로 쪽'),
    ('뒤편 북쪽 벽 가운데', 201045.0, 557403.0, '뒤편(북쪽 벽 가운데)', '뒤편 산책로 쪽'),
    ('회차 공간 가운데', 201030.0, 557355.0, '회차 공간 가운데', '아스팔트'),
    ('회차 공간 북악관 정면 서쪽', 201025.0, 557370.0, '회차 공간 북악관 정면 서쪽', '아스팔트 가장자리'),
    ('본관 모서리 앞 계단(그림 자리)', 201040.8, 557342.0, '본관 모서리 앞 계단', '지상 면'),
]
spots = []
for name, x, y, api, note in SPOTS:
    m = read(x, y)
    spots.append({'name': name, 'xy': [x, y], 'mesh': m, 'elevationQueryM': r1(API[api]) if api else None, 'note': note})
wall = lambda x: 557387.19 - (x - 201004.76) * (557387.19 - 557350.57) / (201082.51 - 201004.76)  # 북악관 남쪽 벽 선(원천 외곽)
along_wall = []  # 붉은 선(벽 선) 남쪽 3~5 m 의 지상 면: 벽 앞은 차양·처마 칸이라 조금 떨어져 읽는다
for x in range(201020, 201062, 4):
    y = wall(x) - 4.0 * 0.905; xx = x - 4.0 * 0.426
    along_wall.append([r1(xx), r1(y), (read(xx, y) or {}).get('medianM')])
west_wall = [[x, y, (read(x, y, 1.0) or {}).get('medianM')] for x, y in ((201004, 557384), (201005, 557388), (201006, 557392), (201007, 557395), (201008, 557399), (201009, 557403), (201011, 557407), (201012, 557411))]
plaza_line = [[r1(201040.8 + t * (201039.5 - 201040.8)), r1(557342.0 + t * (557360.5 - 557342.0)), (read(201040.8 + t * (201039.5 - 201040.8), 557342.0 + t * (557360.5 - 557342.0)) or {}).get('medianM')] for t in (0, .2, .4, .6, .8, 1)]
passage_line = [[x, y, (read(x, y, 1.0) or {}).get('medianM')] for x, y in ((201047.5, 557354.3), (201047.4, 557356), (201047.3, 557357.5), (201047.2, 557359), (201047.3, 557360.5), (201047.5, 557362), (201048, 557363))]
G = {s['name']: s for s in spots}
CROSS = G['횡단보도 북악관 쪽 끝']['mesh']['medianM']; FOOT = G['정문 계단 아래']['mesh']['medianM']; DOOR = G['GS25 문 앞(학교 표지를 벽 앞으로 옮긴 자리)']['mesh']['medianM']
CANOPY = G['정문 바깥 계단 위(차양 앞 가장자리)']['mesh']; TERRACE = G['통로(상자) 북쪽 끝 = 벽 앞 계단 아래']['mesh']['medianM']
FRONT = statistics.median([v for v in ((read(x - 8 * 0.426, wall(x) - 8 * 0.905) or {}).get('medianM') for x in range(201016, 201044, 4)) if v])  # 벽에서 8 m 앞(걸은 선)의 회차 공간 면

# ---- 2. 보행 기록
runs = {}
for f in sorted(glob.glob(str(audit / 'claude-live/tracks/*.json'))):
    runs.setdefault(os.path.basename(f)[:-7], []).extend(json.loads(pathlib.Path(f).read_text(encoding='utf-8'))['points'])


def plateaus(key):
    p = [q for q in sorted({q[0]: q for q in runs[key]}.values()) if q[3] is not None]
    segs, cur = [], [p[0]]
    for q in p[1:]:
        if abs(q[3] - sum(c[3] for c in cur) / len(cur)) <= 0.35: cur.append(q)
        else:
            if len(cur) >= 6: segs.append(cur)
            cur = [q]
    if len(cur) >= 6: segs.append(cur)
    return [{'seq': [s[0][0], s[-1][0]], 'n': len(s), 'h': r2(statistics.median(c[3] for c in s)), 'x': [r1(min(c[1] for c in s)), r1(max(c[1] for c in s))], 'y': [r1(min(c[2] for c in s)), r1(max(c[2] for c in s))]} for s in segs]


PL = {k: plateaus(k) for k in ('C01-fbf7a703', 'C02-8754e88c', 'C01-882b5403', 'C01-c79d9908')}
H = lambda k, a, b: next(p['h'] for p in PL[k] if p['seq'][0] >= a and p['seq'][1] <= b)
pts = lambda k: [q for q in sorted({q[0]: q for q in runs[k]}.values()) if q[3] is not None]
low = lambda k, a, b: min(q[3] for q in pts(k) if a <= q[0] <= b)
f = 'C01-fbf7a703'; c = 'C02-8754e88c'; a8 = 'C01-882b5403'; c7 = 'C01-c79d9908'
lad_c01 = [H(f, 66, 210), H(f, 232, 273), H(f, 301, 338), H(f, 359, 425), H(f, 437, 506), H(f, 518, 580), H(f, 597, 639), H(f, 651, 667)]
lad_c02 = [statistics.median([H(c, 64, 102), H(c, 106, 128), H(c, 136, 148), H(c, 174, 185)]), None, H(c, 304, 344), H(c, 359, 393), H(c, 439, 505), H(c, 518, 538), statistics.median([H(c, 604, 615), H(c, 621, 640)]), H(c, 654, 666)]
steps_c01 = [r2(b - a) for a, b in zip(lad_c01, lad_c01[1:])]
steps_c02 = [None, None] + [r2(b - a) for a, b in zip(lad_c02[2:], lad_c02[3:])]
walk = {
    'ladderC01': {'run': f, 'levelsRaw': lad_c01, 'stepsM': steps_c01, 'totalM': r2(lad_c01[-1] - lad_c01[0])},
    'ladderC02': {'run': c, 'levelsRaw': [v and r2(v) for v in lad_c02], 'stepsM': steps_c02, 'firstTwoM': r2(lad_c02[2] - lad_c02[0]), 'totalM': r2(lad_c02[-1] - lad_c02[0])},
    'start1218': {'what': '2026-10-07 12:18Z 걷기 시작: 시작 높이 → 가장 낮은 곳 → 가장 아래 복도',
                  'C01': {'startRaw': H(f, 1, 23), 'lowRaw': low(f, 24, 60), 'corridorRaw': lad_c01[0], 'downM': r2(H(f, 1, 23) - low(f, 24, 60)), 'upM': r2(lad_c01[0] - low(f, 24, 60)), 'corridorMinusStartM': r2(lad_c01[0] - H(f, 1, 23))},
                  'C02': {'startRaw': r2(statistics.median(q[3] for q in pts(c) if q[0] <= 15)), 'lowRaw': low(c, 16, 60), 'corridorRaw': r2(lad_c02[0]), 'downM': r2(statistics.median(q[3] for q in pts(c) if q[0] <= 15) - low(c, 16, 60)), 'upM': r2(lad_c02[0] - low(c, 16, 60)),
                          'corridorMinusStartM': r2(lad_c02[0] - statistics.median(q[3] for q in pts(c) if q[0] <= 15))}},
    'end1218': {'what': '같은 걷기의 끝: 회차 공간(x 201044~201051, y 557343~557353) → 건물 안 → 승강기', 'C01': {'plazaRaw': H(f, 825, 835), 'insideRaw': H(f, 842, 868), 'upM': r2(H(f, 842, 868) - H(f, 825, 835))}},
    'frontRuns': {'what': '다른 두 기록: 위층 → 서쪽 계단으로 내려와 밖으로 → 정면을 따라 30 m 평평 → 가운데로 들어가 → 위층',
                  a8: {'westFloorRaw': H(a8, 90, 100), 'outsideRaw': H(a8, 106, 129), 'insideRaw': H(a8, 135, 151), 'nextRaw': H(a8, 166, 203), 'aboveRaw': H(a8, 37, 65)},
                  c7: {'westFloorRaw': H(c7, 127, 140), 'outsideRaw': H(c7, 148, 179), 'insideRaw': H(c7, 195, 209), 'insideFirstRaw': H(c7, 187, 194), 'nextRaw': H(c7, 226, 251), 'aboveRaw': H(c7, 60, 93)}},
}
fr = walk['frontRuns']
for k in (a8, c7):
    d = fr[k]; d['outsideToInsideM'] = r2(d['insideRaw'] - d['outsideRaw']); d['westFloorToOutsideM'] = r2(d['westFloorRaw'] - d['outsideRaw']); d['insideToNextM'] = r2(d['nextRaw'] - d['insideRaw']); d['nextToAboveM'] = r2(d['aboveRaw'] - d['nextRaw'])
P_up = [fr[a8]['outsideToInsideM'], fr[c7]['outsideToInsideM'], fr[a8]['westFloorToOutsideM'], fr[c7]['westFloorToOutsideM'], walk['end1218']['C01']['upM']]
PQ = [fr[a8]['insideToNextM'], fr[c7]['insideToNextM']]; QR = [fr[a8]['nextToAboveM'], fr[c7]['nextToAboveM']]
L12 = [steps_c01[0]]; L23 = [steps_c01[1], r2(lad_c02[2] - lad_c02[0] - steps_c01[0])]; L34 = [steps_c01[2], steps_c02[2]]
walk['alignment'] = {
    'what': '정면에서 들어간 층(P)이 12:18 걷기의 가장 아래 복도(L1)인지 그 위층(L2)인지: 이어지는 두 오름(P→Q, Q→R)을 사다리와 견준다',
    'P_to_Q_M': PQ, 'Q_to_R_M': QR, 'L1_to_L2_M': L12, 'L2_to_L3_M': [steps_c01[1]], 'L3_to_L4_M': L34,
    'ifP_is_L1_residualM': {'P→Q − L1→L2': [r2(v - L12[0]) for v in PQ], 'Q→R − L2→L3': [r2(v - steps_c01[1]) for v in QR]},
    'ifP_is_L2_residualM': {'P→Q − L2→L3': [r2(v - steps_c01[1]) for v in PQ], 'Q→R − L3→L4': [r2(v - steps_c01[2]) for v in QR]},
    'reading': 'P = L2 일 때만 두 오름이 모두 0.2 m 안에서 맞는다. 즉 정면 계단으로 들어가는 층은 가장 아래 복도보다 한 층(3.6~3.9 m) 위다. 가장 아래 복도는 회차 공간보다 낮다',
}
stored = [132.8, 136.7, 140.6, 143.47, 146.18, 148.92, 151.79, 154.51]

# ---- 4. 층 표 (모형 B·D 공통)
RISER = (0.15, 0.17)
f1 = FOOT + 17 * 0.16; f1_rng = [r1(FOOT + 17 * RISER[0]), r1(FOOT + 17 * RISER[1])]
f1_baro = [r1(FRONT + min(P_up)), r1(FRONT + max(P_up))]
b1_door = [r1(DOOR - 9 * RISER[1]), r1(DOOR - 6 * RISER[0])]
b1_ladder = [r1(f1 - steps_c01[0]), r1(f1 - (lad_c02[2] - lad_c02[0] - steps_c01[1]))]
B1 = 130.5
mean = lambda *v: sum(x for x in v if x is not None) / len([x for x in v if x is not None])
st = [r2(mean(steps_c01[1], PQ[0], PQ[1])), r2(mean(steps_c01[2], steps_c02[2], QR[0], QR[1])), r2(mean(steps_c01[3], steps_c02[3])), r2(mean(steps_c01[4], steps_c02[4])), r2(mean(steps_c01[5], steps_c02[5])), r2(mean(steps_c01[6], steps_c02[6]))]
names = ['B1', '1', '2', '3', '5', '6', '7', '8', '9']
z = [B1, r1(f1)]
for s in st: z.append(z[-1] + s)
z.append(z[-1] + 2.8)
ROOF = 160.7
floors = {n: r1(v) for n, v in zip(names, z)}
storey = {n: r1(b - a) for n, a, b in zip(names, z, z[1:] + [ROOF])}
floor_table = {
    'floorsM': floors, 'storeyHeightM': storey, 'roofSmapM': ROOF,
    'grades': {'B1': f'추정. GS25 문 앞 지면 {DOOR} − 6~9칸 = {b1_door[0]}~{b1_door[1]} (S-MAP + 확정 단수), 1층 − 보행 기록 한 층 = {min(b1_ladder)}~{max(b1_ladder)}. 범위 130.2~131.0',
               '1': f'추정(S-MAP + 확정 단수). 정문 계단 아래 {FOOT} + 17칸(한 칸 0.15~0.17) = {f1_rng[0]}~{f1_rng[1]}. 보행 기록: 정면 지면 {FRONT} + {min(P_up)}~{max(P_up)} = {f1_baro[0]}~{f1_baro[1]}',
               '2~8': '추정. 1층에서 보행 기록의 층 사이 오름(휴대폰 두 대·기록 넷의 평균)을 쌓은 값. 위로 갈수록 ±0.5 m 까지', '9': '추정. 8층 + 보통 층고 2.8 가정(걸은 기록 없음)'},
    'storedMinusTableM': {n: r2(s - floors[n]) for n, s in zip(names, stored)},
    'storedNote': '운영 길의 여덟 단(132.8~154.51)은 B1·1·2·3·5·6·7·8층이고 이름은 맞다. 높이는 보정 안 된 휴대폰 기압 높이라 2.0~2.7 m 높다(휴대 높이 약 1 m + 치우침)',
    'tallStoreys': {'B1': storey['B1'], '1': storey['1'], '7': storey['7'], '보통(2·3·5·6층)': [storey[k] for k in ('2', '3', '5', '6')], 'match': '사용자 확정(지하층·1층·7층이 높다)과 세 층 모두 맞는다'},
    'roofCheck': f"9층 바닥 {floors['9']} 에서 S-MAP 지붕 {ROOF} 까지 {r1(ROOF - floors['9'])} m: 9층 층고 + 경사 지붕. 9층은 걷지 않았다(모름)",
}
stairs = {'main': {'riserCount': '바깥 12 + 안 5 = 17 (확정)', 'footM': FOOT, 'outsideTopComputedM': [r1(FOOT + 12 * RISER[0]), r1(FOOT + 12 * RISER[1])], 'outsideTopSmap': CANOPY, 'floorM': r1(f1)},
          'gs25': {'doorGroundM': DOOR, 'riserCount': '6~9 (확정: 내려간다, 칸 수는 불확실)', 'floorM': b1_door},
          'b1Front': {'riserCount': '4~6 (확정: 올라간다)', 'topM': B1, 'footM': [r1(B1 - 6 * RISER[1]), r1(B1 - 4 * RISER[0])], 'walkRiseFromLowPointM': [walk['start1218']['C01']['upM'], walk['start1218']['C02']['upM']],
                      'lowPointM': [r1(B1 - walk['start1218']['C02']['upM']), r1(B1 - walk['start1218']['C01']['upM'])], 'surfaceAtPassageM': [CROSS, TERRACE]}}

# ---- 3. 모형 대조
row = lambda what, pred, obs, res, ok: {'what': what, 'predicted': pred, 'observed': obs, 'residualM': res, 'fits': ok}
A_b1 = [r1(CROSS + 4 * RISER[0]), r1(TERRACE + 6 * RISER[1])]
models = {
    'A': {'name': '횡단보도·통로가 회차 공간 지상 면이고 계단 4~6칸을 올라 B1', 'b1FloorM': A_b1, 'rows': [
        row('F1 통로는 내려가지 않고 계단 4~6칸 오름', f'B1 = 지상 면 {CROSS}~{TERRACE} + 0.6~1.0', '가정 그대로', 0, True),
        row('F4 GS25 문 안에서 6~9칸 내려감 + 복도 평지', f'문 앞 지면 = B1 + 0.9~1.5 = {r1(A_b1[0] + 0.9)}~{r1(A_b1[1] + 1.5)}', f'S-MAP {DOOR} (서쪽 벽 전체 131.3~132.6)', [r1(DOOR - (A_b1[1] + 1.5)), r1(DOOR - (A_b1[0] + 0.9))], False),
        row('F2·F3·F5 1층 로비는 다른 층, 정문 17칸, B1 천장 높음', f'1층 − B1 = 17칸 − (4~6칸) − 통로 오름 = {r1(f1 - A_b1[1])}~{r1(f1 - A_b1[0])}', '보행 기록 한 층 3.6~3.9', [r1(f1 - A_b1[1] - 3.9), r1(f1 - A_b1[0] - 3.6)], False),
        row('보행 기록: 정면에서 들어간 층 다음의 두 오름', 'P = L1 이면 3.94, 3.84', f'{PQ}, {QR}', walk['alignment']['ifP_is_L1_residualM']['Q→R − L2→L3'], False)]},
    'B': {'name': '횡단보도·통로가 지상 면이고 B1 은 GS25 문 앞 지면에서 6~9칸 아래', 'b1FloorM': b1_door, 'rows': [
        row('F1 계단 방향', f'지상 면 {CROSS}~{TERRACE} 에서 B1 {b1_door} 로: 내려감 {r1(CROSS - b1_door[1])}~{r1(TERRACE - b1_door[0])}', '사용자: 올라간다 4~6칸', '방향이 반대', False),
        row('F4', f'문 앞 {DOOR} − 6~9칸', 'B1 = ' + str(b1_door), 0, True),
        row('F2·F3·F5', f'1층 {r1(f1)} − B1 = {r1(f1 - b1_door[1])}~{r1(f1 - b1_door[0])}', '보행 기록 한 층 3.6~3.9', [r1(f1 - b1_door[1] - 3.9), r1(f1 - b1_door[0] - 3.6)], True),
        row('보행 기록 사다리의 높은 층 자리', 'B1·1층·7층', f"B1 {storey['B1']}, 1층 {storey['1']}, 7층 {storey['7']}", 0, True),
        row('12:18 걷기 시작: 지상에서 B1 로', '내려가기만 0.7~1.3', f"두 휴대폰 모두 {walk['start1218']['C01']['downM']}~{walk['start1218']['C02']['downM']} 내려간 뒤 {walk['start1218']['C01']['upM']}~{walk['start1218']['C02']['upM']} 오름", '오름이 설명 안 됨', False)]},
    'D': {'name': '횡단보도·통로가 회차 공간 아래(지하 차도 높이)이고 계단 4~6칸을 올라 B1. B1 은 회차 공간보다 약 1 m 낮다', 'b1FloorM': [130.2, 131.0], 'rows': [
        row('F1', f"통로 바닥 = B1 − 0.6~1.0 = {stairs['b1Front']['footM']}. S-MAP 지상 면({CROSS}~{TERRACE})보다 1.6~3.3 m 아래: 지상에서는 안 보이는 높이", '사용자: 올라간다. 그림 범례: 붉은 색 = 지하 공간', 0, True),
        row('F1 오름 크기', '4~6칸 = 0.6~1.0', f"보행 기록 {walk['start1218']['C01']['upM']}~{walk['start1218']['C02']['upM']} (통로의 완만한 오름 포함)", [r1(walk['start1218']['C01']['upM'] - 1.0), r1(walk['start1218']['C02']['upM'] - 0.6)], None),
        row('F4', f'문 앞 {DOOR} − 6~9칸 = {b1_door}', 'B1 130.5', 0, True),
        row('F2·F3·F5', f"1층 {r1(f1)}, B1 층고 {storey['B1']}", '보행 기록 한 층 3.6~3.9, 높은 층 = B1·1층·7층', 0, True),
        row('12:18 걷기 시작', '본관 쪽 계단으로 내려가 차도를 건너 올라감', f"내려감 {walk['start1218']['C01']['downM']}~{walk['start1218']['C02']['downM']}, 오름 {walk['start1218']['C01']['upM']}~{walk['start1218']['C02']['upM']}, 복도 − 시작 {walk['start1218']['C01']['corridorMinusStartM']}~{walk['start1218']['C02']['corridorMinusStartM']}", '시작점이 회차 공간이면 B1 = 지상 − 1.2~1.6', True),
        row('F6 두 지하 공간은 지하에서 안 이어지고 횡단보도로만 오간다', '횡단보도가 차도 높이에 있다', '기록에는 "지상 횡단보도"라고 적혀 있다(사용자 표현인지 확인 필요)', '확인 필요', None)]},
}
verdict = {
    'rejected': 'A: 서로 다른 세 가지(GS25 문 앞 지면, 정문 17칸과 한 층 높이, 보행 기록의 층 맞춤)에서 1.3 m 넘게 어긋난다',
    'b1Floor': f'B·D 어느 쪽이든 B1 바닥은 {B1} (130.2~131.0, 추정), 1층은 {r1(f1)} ({f1_rng[0]}~{f1_rng[1]})',
    'cannotBothHold': f'"횡단보도·통로가 회차 공간 지상 면({CROSS} m)에 있다"와 "거기서 계단을 올라가 닿는 평평한 복도 끝에서 GS25 문으로 나가려면 6~9칸을 올라간다"는 함께 설 수 없다. 두 문 앞 지면이 {CROSS} 와 {DOOR} 로 같은데 들어갈 때도 나갈 때도 오르기 때문이다(차 1.5 m 이상)',
    'survivors': 'D(횡단보도가 지하 차도 높이, 계단은 오름)와 B(횡단보도가 지상, 계단은 내림). 보행 기록의 시작 구간(내려갔다가 오름)은 D 쪽',
    'deciding': ['횡단보도를 건널 때 머리 위가 하늘인가(버스 회차 공간 바닥), 본관 쪽 계단을 내려간 아래(지붕 덮인 차도)인가', '편의점 복도에서 정문 로비(1층)로 갈 때 건물 안 계단을 한 층(스무 칸쯤) 오르는가'],
}
res = {'method': __doc__, 'applied': False, 'spots': spots, 'alongWallRedLine': along_wall, 'westWall': west_wall, 'plazaLineMainCornerToStairFoot': plaza_line, 'passageLine': passage_line, 'frontPlazaM': FRONT,
       'walk': walk, 'plateaus': PL, 'stairs': stairs, 'floorTable': floor_table, 'models': models, 'verdict': verdict}

# ---- 5. 제안 고치기와 모의 적용
ROADS = json.loads((audit / 'claude-live/roads-live-2.json').read_text(encoding='utf-8'))['items']
NODES = {n['id'][:8]: n for n in json.loads((audit / 'claude-live/nodes-live-2.json').read_text(encoding='utf-8'))['items']}
bukak_roads = [r for r in ROADS if r.get('buildingId') == '북악관']
lvl = lambda zz: min(range(8), key=lambda i: abs(stored[i] - zz))
shift = []
for r in bukak_roads:
    zs = [p[2] for p in r['coordinates']]; i0, i1 = lvl(zs[0]), lvl(zs[-1])
    shift.append({'id': r['id'][:8], 'structure': r['structure'], 'storedM': [r2(zs[0]), r2(zs[-1])], 'floors': [names[i0], names[i1]], 'targetM': [r1(floors[names[i0]] + zs[0] - stored[i0]), r1(floors[names[i1]] + zs[-1] - stored[i1])]})
DOOR_XY = [201008.5, 557395.0]; IN_XY = [201009.6, 557395.2]; n_f6 = NODES['f645a7b9']['coordinate']
new_ops = [
    dict(b10Id='B10-1', building='북악관', op='shift_z', roadIds=[r['id'] for r in bukak_roads], grade='추정(보행 기록의 층 사이 오름) + S-MAP·확정(1층 = 정문 계단 아래 지면 + 17칸) + S-MAP·확정(B1 = GS25 문 앞 지면 − 6~9칸)',
         targetFloorsM=floors, storedLevelsM=dict(zip(names, stored)), deltaM={n: r2(floors[n] - s) for n, s in zip(names, stored)}, perRoad=shift,
         evidence=floor_table['storedNote'], status='제안(추정). 길 %d개를 한 묶음으로' % len(bukak_roads), rollback='revert_changeset'),
    dict(b10Id='B10-2', building='북악관', op='relabel_level', roadIds=[r['id'] for r in bukak_roads if r.get('levelId')], fromLabel='levelId 북악관_Z143.47 / Z146.18 / Z148.92 / Z151.79 / Z154.51 _추정',
         toLabel='3층 / 5층 / 6층 / 7층 / 8층 (132.8 = B1, 136.7 = 1층, 140.6 = 2층은 이름 그대로)', grade='추정(사다리에서 높은 층 자리가 사용자 확정 B1·1층·7층과 맞는 유일한 이름 붙이기) + 확정(4층 없음)',
         evidence='B03 의 "한 층씩 밀려 있다"(B1→1층 …, 143.47→5층 …)를 거두고 이것으로 바꾼다', status='제안(추정)', rollback='revert_changeset'),
    dict(b10Id='B10-3', building='북악관', op='create_road', roadIds=[], name='북악관 B1 복도 서쪽 끝 ~ GS25 문 안 계단 아래', structure='indoor_corridor', coordinates=[n_f6, IN_XY + [n_f6[2]]],
         grade='확정(복도가 GS25 출입구까지 평지로 곧게 이어진다) / 추정(평면, 저장된 1fc3a2f5 가 그 복도라는 것)', evidence='B08-10 을 바꿈. 높이는 그 복도의 저장 값을 따르고 B10-1 과 함께 %.1f 로 옮긴다' % B1,
         expectedPreState={'nodef645a7b9': n_f6}, status='제안(추정)', rollback='revert_changeset'),
    dict(b10Id='B10-4', building='북악관', op='create_road', roadIds=[], name='GS25 문 안 계단 (B1 복도 ~ 문, 6~9칸)', structure='stairs', coordinates=[IN_XY + [B1], DOOR_XY + [DOOR]],
         grade='확정(문으로 들어가면 계단을 내려간다, 6~9칸) / S-MAP(문 앞 지면) / 추정(평면, 계단 길이)', evidence='오름 %.1f m = 한 칸 0.15~0.17 로 7~8칸. 아래 끝 높이는 B10-1 을 적용한 뒤의 값' % (DOOR - B1), status='제안(추정): B10-1 과 함께', rollback='revert_changeset'),
    dict(b10Id='B10-5', building='북악관', op='create_place', roadIds=[], name='편의점 (북악관 B1)', coordinates=[{'xy': [201048.1, 557381.1], 'z': B1}], grade='확정(계단을 올라 바로 좌회전하면 있다) / 위치 추정(±10 m) / 높이 추정', evidence='B08-11 을 바꿈(높이가 정해짐)', status='제안(위치 추정)', rollback='revert_changeset'),
    dict(b10Id='B10-6', building='북악관', op='create_place', roadIds=[], name='라운지 (북악관 B1)', coordinates=[{'xy': [201048.1, 557381.1], 'z': B1}], grade='확정(계단을 올라 바로 좌회전하면 있다) / 위치 추정(±10 m) / 높이 추정', evidence='B08-12 를 바꿈', status='제안(위치 추정)', rollback='revert_changeset'),
]
HOLD_Q = '횡단보도가 회차 공간 지상 면인지 그 아래 차도 높이인지 받은 뒤'
changes = [  # (고르는 조건, 새 상태, 이유)
    (lambda o: o['building'] == '북악관' and o['op'] == 'relabel_level' and not o.get('b10Id'), '거둠(B10)', '운영 길의 B1·1F·2F 이름은 맞다(사용자 확정: 계단을 올라 닿는 복도가 B1, 정문 로비가 1층. 보행 기록: 정면에서 들어가는 층은 가장 아래 복도보다 한 층 위). B10-2 로 바꿈'),
    (lambda o: o['op'] == 'add_level' and o['building'] == '북악관', '거둠(B10)', 'B1 층은 운영 길에 이미 있다(132.8 m 묶음). 새 층을 만들지 않는다. 높이 128.6 은 거두고 130.5 (130.2~131.0)'),
    (lambda o: o.get('b08Id') == 'B08-1', '보류(B10)', '이 선의 평면·오름(126.8 → 131.1)은 12:18 걷기의 "내려갔다가 올라 B1 로" 구간과 겹친다. 횡단보도가 차도 높이면 이 선이 사용자가 말한 횡단보도·통로이고, 없앨 것이 아니라 보행 길로 고쳐야 한다. ' + HOLD_Q),
    (lambda o: o.get('b08Id') == 'B08-2', '보류(B10)', '지상 면 높이(131.5~132.8)로 그린 선을 운영 노드 18b2d87e 에 붙이면, 그 노드의 실제 높이(B1 − 4~6칸 = 129.5~129.9)와 1.6~3.3 m 단이 생긴다. ' + HOLD_Q),
    (lambda o: o.get('b08Id') == 'B08-3', '보류(B10)', '시작점이 B08-2 의 횡단보도 점이다. B08-2 와 함께'),
    (lambda o: o.get('b08Id') == 'B08-10', '바뀜(B10): B10-3·B10-4', 'B1 바닥이 정해졌다'),
    (lambda o: o.get('b08Id') in ('B08-11', 'B08-12'), '바뀜(B10): B10-5·B10-6', 'B1 바닥이 정해졌다'),
    (lambda o: o['op'] == 'no_change' and '8fde6a04-a05d-474f-b427-f8a83b6bb307' in o.get('roadIds', []), 'B10: f99540e3 는 그대로(오르는 방향이 맞다: 사용자 확정 + 보행 기록 1.7~2.2 m 오름). 방향 고치기 거둠. 8fde6a04 는 보류', None),
]


def summary(rs):
    p = {}

    def fnd(x):
        while p[x] != x: p[x] = p[p[x]]; x = p[x]
        return x
    for r in rs:
        for n in (r['a'], r['b']): p.setdefault(n, n)
    for r in rs: p[fnd(r['a'])] = fnd(r['b'])
    comp = collections.Counter(fnd(r['a']) for r in rs); pairs = collections.Counter(tuple(sorted((r['a'], r['b']))) for r in rs)
    return {'roads': len(rs), 'componentsByRoadCount': sorted(comp.values(), reverse=True), 'selfLoops': [r['id'] for r in rs if r['a'] == r['b']], 'duplicateEdges': [list(k) for k, v in pairs.items() if v > 1]}, (lambda a, b: a in p and b in p and fnd(a) == fnd(b))


base = [dict(id=r['id'][:8], a=r['fromNodeId'][:8], b=r['toNodeId'][:8], ped=r['pedestrianAccess'] != 'prohibited') for r in ROADS]
E = lambda i, a, b, ped=True: dict(id=i, a=a, b=b, ped=ped)
common = [E('B08-4', 'nA', 'nS0'), E('B08-5', 'nS0', 'nS1'), E('B08-8a', 'nSIDE', 'nSIDE2'), E('B08-8b', 'nSIDE2', '7895ac0d'), E('B08-9', 'nSIDE2', 'nDOORout'), E('B10-3', 'f645a7b9', 'nDOORin'), E('B10-4', 'nDOORin', 'nDOORout')]
sets = {
    'before': base,
    'afterB10Now (보류 제외: 8fde6a04 그대로, B08-2·3 없음)': base + common,
    'ifSurfaceCrossing (모형 B: B08-1·2·3 적용)': [r for r in base if r['id'] != '8fde6a04'] + common + [E('B08-2a', 'nA', 'nX1'), E('B08-2b', 'nX1', '18b2d87e'), E('B08-3', 'nX1', '04044da5')],
    'ifDrivewayCrossing (모형 D: 8fde6a04 를 보행 길로, 보행 띠와 이음)': [dict(r, ped=True) if r['id'] == '8fde6a04' else r for r in base] + common + [E('D-횡단보도', 'nS0', '81ff89df')],
}
CH = {'2a 옆길 남쪽 끝 → 뒤편 산책로 → 대일관 측면': ('nSIDE', 'bd4051c1'), '2c 옆길 남쪽 끝 → GS25 출입구(바깥)': ('nSIDE', 'nDOORout'), '2d 북악관 B1 계단 아래 → B1 진입 통로': ('18b2d87e', '7a32499f'),
      'GS25 출입구 바깥 ↔ B1 복도 ↔ B1 계단 아래': ('nDOORout', '18b2d87e'), '북악관 실내 ↔ 뒤편 산책로': ('7a32499f', '7895ac0d'), '본관 모서리 앞 → 북악관 B1 복도 서쪽 끝': ('nA', 'f645a7b9'), '북악관 B1 → 문예관 옆 오르막 보행로 위 끝': ('18b2d87e', '4f294196')}
sim = {}
for name, rs in sets.items():
    s, con = summary(rs); sp, conp = summary([r for r in rs if r['ped']])
    sim[name] = dict(s, pedestrianOnlyComponents=sp['componentsByRoadCount'], chainsWalkable={k: bool(conp(*v)) for k, v in CH.items()})
n18 = NODES['18b2d87e']['coordinate']; n78 = NODES['7895ac0d']['coordinate']; n04 = NODES['04044da5']['coordinate']
sim['zStepsAfterB10-1'] = [
    {'node': '18b2d87e (B1 계단 아래)', 'storedM': n18[2], 'afterShiftM': r1(n18[2] + floors['B1'] - stored[0]), 'smapSurfaceM': TERRACE, 'stepIfJoinedToSurfaceLineM': r1(TERRACE - (n18[2] + floors['B1'] - stored[0])), 'note': '지상 선(B08-2)을 붙일 때만 생기는 단. 보류 이유'},
    {'node': 'GS25 문 안쪽', 'corridorM': B1, 'doorM': DOOR, 'stepM': 0, 'note': '계단 B10-4 가 %.1f m 를 잇는다' % (DOOR - B1)},
    {'node': '7895ac0d (뒤편 산책로 서쪽 끝)', 'storedM': n78[2], 'smapM': 132.5, 'stepM': r1(132.5 - n78[2]), 'note': 'B08 과 같음. 그대로 남는다'},
    {'node': '04044da5 (오르막 보행로 아래 끝)', 'storedM': n04[2], 'smapM': 132.7, 'stepM': r1(132.7 - n04[2]), 'note': 'B08-3 을 적용할 때만'},
    {'node': '81ff89df (8fde6a04 아래 끝)', 'storedM': NODES['81ff89df']['coordinate'][2], 'lowPointFromWalkM': stairs['b1Front']['lowPointM'], 'note': '저장 126.82 는 보행 기록의 가장 낮은 곳(추정 128.3~128.8)보다 1.5~2 m 낮다(둘 다 추정)'},
]
sim['note'] = '지금 적용할 수 있는 묶음(afterB10Now)만으로 북악관 실내가 GS25 문을 거쳐 서쪽 옆길·뒤편 산책로와 걸어서 이어진다. 본관 쪽과는 횡단보도 질문 뒤에 잇는다'
res['proposals'] = {'new': new_ops, 'simulation': sim}
out.write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

if '--write-proposals' in sys.argv:
    npath = HERE.parent / 'b03/network.json'; net = json.loads(npath.read_text(encoding='utf-8'))
    net['proposals'] = [o for o in net['proposals'] if not o.get('b10Id')]
    touched = []
    for o in net['proposals']:
        for cond, status, why in changes:
            if cond(o):
                o['statusBeforeB10'] = o.get('statusBeforeB10', o.get('status')); o['status'] = status
                if why: o['b10Reason'] = why
                touched.append([o.get('b08Id') or o['op'], status]); break
    net['proposals'] += new_ops
    net['b10'] = {'date': '2026-10-10', 'applied': False, 'verdict': verdict, 'floorsM': floors, 'withdrawn': ['f99540e3 방향 고치기', 'B1 바닥 128.6 m', "'B1'→1층 이름 바꾸기(B03 9건)와 그 보류", 'B1 새 층 만들기'],
                  'touched': touched, 'simulation': sim, 'unresolvedU4': '풀림: GS25 문 안쪽 바닥 = B1 %.1f, 문 앞 %.1f, 계단 B10-4' % (B1, DOOR), 'source': 'docs/audit/b10/results.json'}
    net['proposalCounts'] = dict(collections.Counter(f"{o['op']} / {o.get('status') or '제안'}" for o in net['proposals']))
    npath.write_text(json.dumps(net, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    epath = HERE.parent / 'e09/editor-ops.json'; eo = json.loads(epath.read_text(encoding='utf-8'))
    for o in eo['operations']:
        if o['id'] == 'E09-B08-1': o['status'] = '보류(B10)'; o['b10Reason'] = changes[2][2]
    epath.write_text(json.dumps(eo, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('proposals touched', touched, 'network proposals', len(net['proposals']))

print(json.dumps({'spots': [[s['name'], s['mesh'] and s['mesh']['medianM'], s['mesh'] and s['mesh']['rangeM'], s['elevationQueryM']] for s in spots], 'alongWall': along_wall, 'westWall': west_wall, 'plazaLine': plaza_line, 'passageLine': passage_line, 'front': FRONT,
                  'walk': {k: walk[k] for k in ('ladderC01', 'ladderC02', 'start1218', 'end1218', 'frontRuns', 'alignment')}, 'stairs': stairs, 'floorTable': floor_table, 'models': models, 'sim': sim}, ensure_ascii=False, indent=1))
