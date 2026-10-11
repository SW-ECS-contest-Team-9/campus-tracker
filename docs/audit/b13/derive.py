"""B13 혜인관: S-MAP 1 m 메시에서 지붕 단을 읽어 부분 외곽과 높이를 만든다. DB·네트워크 접근 없음.   python derive.py
읽는 것: 볼트 z04/smap-mesh-z04-1m-e1.txt, e2.txt (S-MAP 3D 뷰어 건물 모델 면, 2026-10-10). 쓰는 것: parts.json (동 노트 머리의 부분에 그대로 옮긴다).
메시가 보여 주는 것(벽 축 좌표 s, d):
 - 둘레 1.8 m 띠가 166.1 m: 벽돌 본체의 처마(그 위 기와 띠 = 5층). 그 안쪽 전체가 172~180 m 의 옥상 상자들(건물 깊이 전체. 얇은 벽이 아니다)
 - 북동 끝 s 74~86: 180.3(전원 버튼 원판이 붙은 높은 상자), s 64~74·d<6: 172.4(난간 있는 낮은 곳), 남서 끝 s<8·d<10: 173.4, 가운데 뒤 s 38~46·d>=9: 180.0, 뒤쪽 s 28~34 와 s 70~74 의 d>=10: 172.4, 나머지 178.1
 - 운동장 쪽 d -4~0, s 35~55 에 157.0 의 낮은 덩어리 = 줄무늬 출입부(가운데 s 45.0). 양옆 화단은 s 36.7 과 56.3 에서 끝난다(가운데 46.5). 사진 02·08 의 출입부 가운데는 원근을 풀면 s 46.5·45.4. 출입부 가운데 = 화단 틈의 가운데 46.5 로 둔다(frame.C. 메시 덩어리와 1.5 m, 학교 지하도 지도의 초록 점 s 44.7 과 1.8 m)"""
import json, pathlib, collections
import numpy as np
from shapely.geometry import Polygon, Point, box as sbox
from shapely.ops import unary_union
from shapely import affinity
from frame import *
V = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\z04'); HERE = pathlib.Path(__file__).parent
pts = {}
for fn, y0 in (('smap-mesh-z04-1m-e1.txt', 557169), ('smap-mesh-z04-1m-e2.txt', 557252)):
    for line in (V / fn).read_text(encoding='utf-8').splitlines():
        if line.startswith('#'): continue
        j, z, *_ = line.split('|')
        for i, v in enumerate(z.split(',')):
            if float(v) > 0: pts[(201126 + i, y0 + int(j))] = float(v) / 100
OUT = Polygon([SD(p) for p in RING])   # 벽 축 좌표에서 자른 뒤 좌표로 되돌린다(자르는 선이 축과 나란해 조각이 깨끗하다)
def rect(s0, s1, d0, d1): return sbox(s0, d0, s1, d1)
def world(g): return Polygon([P(*c) for c in g.exterior.coords], [[P(*c) for c in r.coords] for r in g.interiors])
INNER = OUT.buffer(-1.8, join_style=2)
CUTS = [('북동높은상자', '혜인관 북동 끝의 높은 옥상 상자(전원 버튼 원판)', rect(74, 200, -50, 50)),
        ('북동낮은곳', '북동 높은 상자 옆 운동장 쪽의 낮은 곳(난간)', rect(64, 74, -50, 6)),
        ('북동뒤낮은곳', '북동 높은 상자 옆 뒤쪽의 낮은 곳', rect(70, 74, 10, 50)),
        ('남서낮은상자', '남서 끝 운동장 쪽의 낮은 상자', rect(-50, 8, -50, 10)),
        ('가운데높은상자', '가운데 뒤쪽의 높은 상자', rect(38, 46, 9, 50)),
        ('뒤낮은곳', '가운데 남서쪽 뒤의 낮은 곳', rect(28, 34, 10, 50))]
parts, used = [], []
for pid, what, cut in CUTS:
    g = INNER.intersection(cut).difference(unary_union(used) if used else Polygon()); assert g.geom_type == 'Polygon', (pid, g.geom_type); used.append(g); parts.append((pid, what, g))
main = INNER.difference(unary_union(used).buffer(1e-6, join_style=2)).simplify(1e-5);   # 맞닿은 변이 소수 오차로 구멍이 되지 않게
assert main.geom_type == 'Polygon' and not main.interiors, main.geom_type
parts.insert(0, ('옥상상자', '옥상 상자들의 큰 덩어리(위 두 층)', main))
ring = OUT.difference(INNER); assert ring.geom_type == 'Polygon' and len(ring.interiors) == 1
out = []
def stats(g, shrink=0.7):
    zs = [z for (x, y), z in pts.items() if g.buffer(-shrink).contains(Point(*SD((x, y))))]; a = np.array(zs)
    med = float(np.median(a)); return med, len(a), float(np.percentile(a, 10)), float(np.percentile(a, 90)), float((np.abs(a - med) <= 1.5).mean())
rz, rn, r10, r90, rin = stats(ring, 0.45)
r2 = lambda v: round(float(v), 2)
def rings(g): g = world(g); return [[[r2(x), r2(y)] for x, y in r.coords] for r in [g.exterior, *g.interiors]]
out.append({'id': '본체', 'what': '벽돌 본체(지하 1층~3층)와 처마 둘레 띠', 'roofM': 166.1, 'areaM2': round(ring.area, 1), 'cells': rn, 'p10': r10, 'p90': r90, 'within1_5': round(rin, 2), 'median': rz, 'polygon': rings(ring)})
for pid, what, g in parts:
    med, n, p10, p90, w = stats(g)
    out.append({'id': pid, 'what': what, 'roofM': round(med, 1), 'areaM2': round(g.area, 1), 'cells': n, 'p10': p10, 'p90': p90, 'within1_5': round(w, 2), 'polygon': rings(g)})
tot = sum(Polygon(o['polygon'][0], o['polygon'][1:]).area for o in out); print('footprint', round(OUT.area, 1), 'parts', round(tot, 1))
for o in out: print(o['id'], o['roofM'], o['areaM2'], o['cells'], o['p10'], o['p90'], o['within1_5'], o.get('median', ''))
(HERE / 'parts.json').write_text(json.dumps({'frame': {'origin': RING[2], 'along': U.tolist(), 'inward': N.tolist(), 'lengthM': r2(LEN), 'entranceCentreS': C}, 'parts': out}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
