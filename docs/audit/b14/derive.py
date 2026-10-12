"""B14 상승관: S-MAP 0.5 m 메시(볼트 b14/smap-mesh-b14-sangseung-05m.txt, 2026-10-12 판독)에서 외곽·지붕·이웃과의 틈을 잰다. DB·네트워크 접근 없음.   python derive.py  -> parts.json
외곽은 frame.py 의 곧은 변 넷(메시 칸 가장자리에 맞춤). 대일관 본체의 뒷벽(상승관 쪽 변)도 같은 메시에서 다시 읽는다(B02 는 2 m 격자로 자른 선이었다)."""
import json, pathlib, numpy as np
from scipy import ndimage
from shapely.geometry import Polygon, Point
from shapely import contains_xy
from mesh import *
from frame import *
HERE = pathlib.Path(__file__).parent
xs, ys, Z, M = load(); S, D, CH, G = M == SANG, M == DAEIL, M == CHEONGUN, M == GROUND
sv = (xs - C[0]) * U[0] + (ys - C[1]) * U[1]; dv = (xs - C[0]) * N[0] + (ys - C[1]) * N[1]
P = Polygon(RING); inP = contains_xy(P, xs, ys)
pc = lambda a: [round(float(v), 2) for v in np.percentile(a, [10, 50, 90])]
main = S & (sv < BLOCK_S - 0.5) & (dv > D_N + 1) & (dv < D_S - 1) & (sv > S_W + 1); block = S & (sv > BLOCK_S + 0.5) & contains_xy(P.buffer(-0.7), xs, ys)
rim = S & (Z > 164.5) & (Z < 165.05) & (sv < BLOCK_S - 0.5)
# 이웃과의 틈: 상승관 칸에서 가장 가까운 이웃 칸까지(칸 가운데 사이 거리 - 0.5 m). 벽을 따라 1 m 마다
def gaps(other, s0, s1):
    dist = ndimage.distance_transform_edt(~other) * STEP; out = []
    for a in np.arange(s0, s1, 1.0):
        m = S & (sv >= a) & (sv < a + 1)
        if m.any(): out.append(round(max(0.0, float(dist[m].min()) - STEP), 2))
    return out
gd = gaps(D, S_W, 10.0); gc = gaps(CH, 13.0, 20.0)
# 청운관 벽(북동 저층부의 북서 변)을 따라: 상승관 동쪽 끝 벽과 청운관 메시 사이
a, b = np.array([201225.03, 557303.23]), np.array([201235.3, 557313.61]); e = (b - a) / np.hypot(*(b - a)); n = np.array([-e[1], e[0]])
t = (xs - a[0]) * e[0] + (ys - a[1]) * e[1]; w = (xs - a[0]) * n[0] + (ys - a[1]) * n[1]; along = []
for t0 in np.arange(0, 11, 1.0):
    cm, sm = CH & (t >= t0) & (t < t0 + 1) & (w > -3), S & (t >= t0) & (t < t0 + 1)
    if cm.any() and sm.any(): along.append(round(max(0.0, float(w[sm].min() - w[cm].max()) - STEP), 2))
slit = G & (dv > D_S) & (dv < DAEIL_FAR) & (sv > S_W) & (sv < DAEIL_STEP_S)
out = {'source': 'S-MAP 3D viewer building model 173604866, 0.5 m grid, read 2026-10-12 (vault b14/smap-mesh-b14-sangseung-05m.txt)',
       'frame': {'centre': C.tolist(), 'bearingDeg': ANG, 'lengthNorthM': round(S_E_N - S_W, 1), 'lengthSouthM': round(S_E_S - S_W, 1), 'widthM': round(D_S - D_N, 2)},
       'footprint': {'ring': RING, 'areaM2': round(P.area, 1), 'meshCells': int(S.sum()), 'meshAreaM2': float(S.sum() * STEP * STEP), 'meshCellsInside': int((S & inP).sum()), 'insideButNotMesh': int((inP & ~S).sum()), 'meshOutside': int((S & ~inP).sum())},
       'roof': {'mainM': pc(Z[main]), 'mainCells': int(main.sum()), 'mainWithin0_3': round(float((np.abs(Z[main] - 163.06) < 0.3).mean()), 3), 'eastBlockM': pc(Z[block]), 'eastBlockCells': int(block.sum()), 'eastBlockFromS': BLOCK_S,
                'mainRing': MAIN, 'mainAreaM2': round(Polygon(MAIN).area, 1), 'eastBlockRing': EAST, 'eastBlockAreaM2': round(Polygon(EAST).area, 1), 'parapetTopM': pc(Z[rim]), 'parapetCells': int(rim.sum())},
       'gapDaeilM': {'perMetre': gd, 'min': min(gd), 'median': float(np.median(gd)), 'max': max(gd), 'touchingM': sum(1 for g in gd if g < 0.3), 'slitGroundM': pc(Z[slit]), 'slitCells': int(slit.sum())},
       'gapCheongunM': {'nearestPerMetre_s13to20': gc, 'min': min(gc), 'alongCheongunWall': along, 'alongMin': min(along), 'alongMedian': float(np.median(along)), 'alongMax': max(along)},
       'ground': {'north': pc(Z[G & (dv < D_N) & (dv > D_N - 3) & (sv > S_W) & (sv < S_E_N)]), 'yardSouthOfEastBlock': pc(Z[G & (dv > D_S) & (dv < D_S + 6) & (sv > 10.5) & (sv < 15.5)])},
       'daeilBackWall': {'ring': [W(-18.57, DAEIL_FAR), W(DAEIL_STEP_S, DAEIL_FAR), W(DAEIL_STEP_S, D_S), W(DAEIL_END_S, D_S)], 'note': 'replaces the B02 cut line (201191.55,557318.68)-(201216.71,557306.86) of the 대일관 main part'}}
# 청운관 북서 덧붙은 부분: 청운관 객체(173670401) 칸 가운데 원천 외곽 밖, 북동 저층부의 북서 변 앞 0~5 m 구간(지붕 162.9). 상승관 동쪽 끝 벽에 닿는다
GP = Polygon([[201246.78, 557271.99], [201248.0, 557270.34], [201244.08, 557264.57], [201241.41, 557265.89], [201238.35, 557263.87], [201229.69, 557273.3], [201228.91, 557273.46], [201221.15, 557275.04], [201211.87, 557280.87], [201212.23, 557290.03], [201212.59, 557290.34], [201219.5, 557296.53], [201218.91, 557297.69], [201223.3, 557304.69], [201225.03, 557303.23], [201225.62, 557302.73], [201235.3, 557313.61], [201261.22, 557286.79], [201251.2, 557276.31], [201251.12, 557276.23]])
lobe = CH & ~contains_xy(GP.buffer(0.01), xs, ys) & (t > -2.5) & (t < 5.3) & (w > 0)
TW = lambda tt, ww: [round(float(v), 2) for v in a + tt * e + ww * n]
wall = lambda tt: float(np.interp(tt, [(np.array(RING[2]) - a) @ e, (np.array(RING[1]) - a) @ e], [(np.array(RING[2]) - a) @ n, (np.array(RING[1]) - a) @ n]))
LOBE = [[201225.03, 557303.23], TW(5.0, 0.0), TW(5.0, wall(5.0)), RING[2], [201223.3, 557304.69], [201225.03, 557303.23]]
LP = Polygon(LOBE); assert LP.is_valid and LP.intersection(P).area < 0.01 and LP.intersection(GP).area < 0.05, (LP.is_valid, LP.intersection(P).area, LP.intersection(GP).area)
inL = contains_xy(LP, xs, ys)
out['cheongunLobe'] = {'ring': LOBE, 'areaM2': round(LP.area, 1), 'meshCellsOutsideSourceOutline': int(lobe.sum()), 'meshCellsInRing': int((lobe & inL).sum()), 'ringCellsNotCheongunMesh': int((inL & ~CH).sum()), 'roofM': pc(Z[lobe & inL & (Z > 162) & (Z < 164.5)]), 'flatCells': int((lobe & inL & (Z > 162) & (Z < 164.5)).sum()), 'groundBesideM': pc(Z[G & (t > -3) & (t < 0.5) & (w > 2.6) & (w < 5)])}
print(json.dumps(out['cheongunLobe'], ensure_ascii=False))
out['door'] = W((DAEIL_END_S + S_E_S) / 2, D_S); out['doorWallFromTo'] = [W(DAEIL_END_S, D_S), W(S_E_S, D_S)]   # 안쪽 마당에 면한 벽(동쪽 끝 덩어리의 대일관 쪽 벽)의 가운데. 문 자리는 추정
(HERE / 'parts.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({k: out[k] for k in ('frame', 'footprint', 'roof', 'gapDaeilM', 'gapCheongunM', 'ground')}, ensure_ascii=False, indent=0))
