"""B11: 층 높이 모순 넷의 근거 수치, 문예관 저층부(옥상 정원) 외곽, 유담관 탑 띠 6개. 읽기 전용(DB 없음).

  python docs/audit/b11/b11.py            -> docs/audit/b11/results.json

입력: 볼트의 S-MAP 메시 판독(g02 0.5 m, z04 1 m), 동 노트 머리(유담관 탑 띠, 청운관 부분), 원천 외곽(campus.gpkg).
S-MAP 은 독립 측량이 아니다. 좁은 틈(폭 5 m 아래)의 지면 값은 평탄면이 아니면 높이로 쓰지 않는다.
"""
import json, pathlib, statistics, sys
import numpy as np, yaml
from shapely.geometry import Polygon, Point, box
from shapely.ops import unary_union
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / 'b03'))
import mesh
from common import outlines
NOTES = pathlib.Path(r'C:\campus-tracker-backend\데이터\모델링 개선\건물')
med = statistics.median; r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)
head = lambda n: yaml.safe_load((NOTES / f'{n}.md').read_text(encoding='utf-8').split('\n---', 1)[0][3:])
big = lambda g: max(g.geoms, key=lambda q: q.area) if g.geom_type in ('MultiPolygon', 'GeometryCollection') else g
OUT = outlines(HERE.parents[2] / 'backend')
fine = mesh.load(['g02/smap-mesh-*.txt']); coarse = mesh.load(['z04/smap-mesh-*.txt'])
R = {'source': 'S-MAP 3D viewer mesh picks: g02 0.5 m (2026-10-11), z04 1 m (2026-10-10)'}


def cells(pts, x0, x1, y0, y1): return [p for p in pts if x0 <= p[0] <= x1 and y0 <= p[1] <= y1]


def st(v):
    s = sorted(float(x) for x in v); q = lambda p: s[min(len(s) - 1, int(len(s) * p))]
    return {'n': len(s), 'min': r1(s[0]), 'p10': r1(q(.1)), 'median': r1(med(s)), 'p90': r1(q(.9)), 'max': r1(s[-1])} if s else {'n': 0}


# ---- 1a. 본관–한림관 틈: 표지 (201098.0, 557302.7) 둘레의 지형 칸은 평탄면인가
gap = [p for p in cells(fine, 201097, 201104, 557296, 557308) if p[3] == 0]
rows = {}
for x, y, z, m, f, d in gap: rows.setdefault(y, []).append(z)
prof = [(y, r2(med(v)), len(v)) for y, v in sorted(rows.items())]
ys = np.array([p[0] for p in prof]); zs = np.array([p[1] for p in prof]); k, b = np.polyfit(ys, zs, 1)
court = [p[2] for p in cells(fine, 201103, 201112, 557309, 557312) if p[3] == 0]
walk = [p[2] for p in cells(fine, 201097, 201104, 557319, 557322) if p[3] == 0]
R['deck'] = {'marker': [201098.0, 557302.7], 'gapTerrainCells': len(gap), 'gapSouthMidNorth': [prof[0], prof[len(prof) // 2], prof[-1]],
             'gapSlopeMPerM': r2(k), 'gapRangeM': [r1(zs.min()), r1(zs.max())],
             'flatRunsWithin0_15mOver3m': int(sum(1 for i in range(len(zs) - 6) if zs[i:i + 7].max() - zs[i:i + 7].min() <= 0.15)),
             'northCornerCourt': st(court), 'upperWalkwayAtCorner': st(walk),
             'chains': {'본관 5층 (2층 130.7 + 입구(3) 139.9, 계단참 자리 1/4~3/4)': [137.4, 138.9], '한림관 3층 (1층 127.2, 6층 147.9 를 고르게)': 137.6,
                        '보행 구간 = 위 보행로 한 층 아래 (위 보행로 - 덮개 3.5~4.4)': [r1(med(walk) - 4.4), r1(med(walk) - 3.5)], '시험용 DB 보행 구간 연장 2b765aa4 의 북동 모서리 값': 136.4},
             'ifDeck130_5': {'한림관 1→3층 두 층 합': r1(130.5 - 127.2), '한림관 3→6층 두 층 합': r1(147.9 - 130.5), '본관 2층 기준과의 차': r1(130.5 - 130.7)}}

# ---- 1b. 청운관: 현관(1층) 높이 153.1 의 S-MAP 근거와 층 사다리
h = head('청운관'); porch = Polygon(next(p for p in h['부분'] if (p.get('모델_부분') or {}).get('id') == '운동장쪽돌출부')['외곽']['좌표'][0])
body = unary_union([Polygon(p['외곽']['좌표'][0]) for p in h['부분'][:2]])
near = [p for p in coarse if p[2] < 156 and porch.buffer(8).contains(Point(p[0], p[1])) and not body.contains(Point(p[0], p[1]))]   # z04 동쪽 판독은 모델 번호 0 이 지형이 아니라 높이로 가른다
f1, roof = 153.1, 187.8; names = ['1층', '2층', '3층', '5층', '6층', '7층', '8층', '9층', '10층', '11층']; step = (roof - f1) / len(names)
R['cheongun'] = {'terrainCellsNearPorch': len(near), 'level153': st([p[2] for p in near if 152.5 <= p[2] <= 153.7]), 'level149': st([p[2] for p in near if 148.5 <= p[2] <= 149.3]),
                 'porchRoof': 163.8, 'mainRoof': roof, 'floors': {'B1': 148.9, **{n: r1(f1 + i * step) for i, n in enumerate(names)}}, 'storeyAbove1F': r2(step), 'B1to1F': r1(f1 - 148.9)}

# ---- 1a. 본관 사다리(데크 = 5층 = 한림관 3층)
D = 137.8; h23 = (D - 130.7) / 2; h58 = (153.8 - D) / 4
R['bongwan'] = {'deck': D, 'floors': {'1층': r1(130.7 - h23), '2층': 130.7, '3층': r1(130.7 + h23), '5층': D, '6층': r1(D + h58), '7층': r1(D + 2 * h58), '8층': r1(D + 3 * h58)},
                'storey2to5': r2(h23), 'storey5toRoof': r2(h58), 'entrance3LandingFraction': r2((139.9 - D) / h58)}

# ---- 1d. 문예관: 두 읽기
R['munye'] = {'forkFlat': st([p[2] for p in cells(fine, 201111, 201117, 557333, 557336) if p[3] == 0]), 'entrance2Flat': st([p[2] for p in cells(fine, 201084, 201094, 557342, 557345) if p[3] == 0]),
              'readingHigh': {'3층': 144.8, '2→3층': r1(144.8 - 138.9), '실내 계단 6.05 m 아래': r2(144.8 - 6.05)}, 'readingLow': {'3층': 142.44, '2→3층': r1(142.44 - 138.9), '실내 계단 6.05 m 아래': 136.39}}
f3 = 144.8; up = ['5층', '6층', '7층', '8층', '9층', '10층', '11층', '12층', '13층', '14층', '15층']; s5 = (189.4 - 148.8) / len(up)
R['munye']['ladderHigh'] = {'B1': 131.1, '1층': 135.0, '2층': 138.9, '3층': f3, **{n: r1(148.8 + i * s5) for i, n in enumerate(up)}, 'storeyAbove5F': r2(s5), '3to5F': r1(148.8 - f3)}

# ---- 2. 문예관 저층부(옥상 정원): 탑 남서면 앞의 148.8 m 건물 모델 칸
F = big(OUT['문예관'])
low = [(x, y, z) for x, y, z, m, f, d in cells(fine, 201094, 201114, 557330, 557344) if m != 0 and 148.0 <= z <= 150.0]
U = big(unary_union([box(x - .25, y - .25, x + .25, y + .25) for x, y, z in low]).buffer(0.6).buffer(-0.6))
wing = big(Polygon(U.exterior).difference(F.buffer(0.3)).simplify(0.4)); wing = Polygon(wing.exterior)
inside = [z for x, y, z in low if wing.buffer(0.3).contains(Point(x, y))]
edge_ground = [p[2] for p in fine if p[3] == 0 and 0 < wing.distance(Point(p[0], p[1])) <= 2.0]
R['munyeLowWing'] = {'cells': len(low), 'areaM2': r1(wing.area), 'roof': st(inside), 'flatRoofM': r1(med(inside)), 'within0_5m': r2(np.mean([abs(z - med(inside)) <= 0.5 for z in inside])),
                     'groundWithin2m': st(edge_ground), 'overlapWithFootprintM2': r2(wing.intersection(F).area), 'distanceToFootprintM': r2(wing.distance(F)),
                     'polygon5186': [[[r2(x), r2(y)] for x, y in wing.exterior.coords]]}

# ---- 2. 유담관 탑: 띠 3개 -> 6개(기운 지붕을 덜 거칠게)
y = head('유담관'); tw = [p for p in y['부분'] if str((p.get('모델_부분') or {}).get('id', '')).startswith('탑')]
tower = big(unary_union([Polygon(p['외곽']['좌표'][0]).buffer(0.02) for p in tw]).buffer(-0.02))
ax = np.array([0.847, -0.531]); ax /= np.linalg.norm(ax); n = np.array([-ax[1], ax[0]])   # docs/audit/b03/tower.json 의 긴 축(높은 끝 -> 낮은 끝)
roofc = [(x, yy, z) for x, yy, z, m, f, d in coarse if m != 0 and z >= 160 and tower.buffer(1).contains(Point(x, yy))]
c0 = np.array(tower.centroid.coords[0]); T = np.array([(np.array([x, yy]) - c0) @ ax for x, yy, z in roofc]); Z = np.array([z for *_, z in roofc])
tv = [(np.array(c) - c0) @ ax for c in tower.exterior.coords]; t0, t1 = min(tv), max(tv); NB = 6
bands = []
for i in range(NB):
    a, b_ = t0 + (t1 - t0) * i / NB, t0 + (t1 - t0) * (i + 1) / NB
    strip = Polygon([tuple(c0 + ax * a + n * 200), tuple(c0 + ax * b_ + n * 200), tuple(c0 + ax * b_ - n * 200), tuple(c0 + ax * a - n * 200)])
    p = big(tower.intersection(strip))
    zin = Z[(T >= a) & (T < b_ + (1e-9 if i == NB - 1 else 0))]; roof_ = r1(np.median(zin))
    bands.append({'band': i + 1, 'areaM2': r1(p.area), 'roof': st(zin.tolist()), 'flatRoofM': roof_, 'within1_5m': r2(np.mean(np.abs(zin - roof_) <= 1.5)), 'within2_5m': r2(np.mean(np.abs(zin - roof_) <= 2.5)),
                  'polygon5186': [[[r2(x), r2(yy)] for x, yy in p.exterior.coords]], '_p': p})
slope, icpt = np.polyfit(T, Z, 1)
R['yudamTower'] = {'roofCells1m': len(roofc), 'towerAreaM2': r1(tower.area), 'fitHighEndM': r1(icpt + slope * t0), 'fitLowEndM': r1(icpt + slope * t1), 'slopeMPerM': r2(slope),
                   'bandsSumM2': r1(sum(b['_p'].area for b in bands)), 'overlapM2': r2(sum(bands[i]['_p'].intersection(bands[j]['_p']).area for i in range(NB) for j in range(i))),
                   'outsideFootprintM2': r2(sum(b['_p'].difference(big(OUT['유담관'])).area for b in bands)),
                   'maxStepBetweenBandsM': r1(max(abs(bands[i]['flatRoofM'] - bands[i + 1]['flatRoofM']) for i in range(NB - 1))),
                   'old3': [178.4, 174.5, 169.2], 'bands': [{k: v for k, v in b.items() if k != '_p'} for b in bands]}
(HERE / 'results.json').write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding='utf-8')
for k in ('deck', 'cheongun', 'bongwan', 'munye'): print(k, json.dumps(R[k], ensure_ascii=False))
print('munyeLowWing', {k: v for k, v in R['munyeLowWing'].items() if k != 'polygon5186'}, R['munyeLowWing']['polygon5186'])
print('yudamTower', {k: v for k, v in R['yudamTower'].items() if k != 'bands'})
for b in R['yudamTower']['bands']: print('  ', {k: v for k, v in b.items() if k != 'polygon5186'}, len(b['polygon5186'][0]))
