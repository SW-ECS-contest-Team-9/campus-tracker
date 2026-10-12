"""B15 은주1관 서쪽 면: 처마 밑 띠의 작은 네모 창, 돌출부 위 박공과 장미창, 발치의 아치 문 둘. DB·네트워크 접근 없음.   python eunju1.py
쓰는 파일: frontend/public/structures/b15-eunju1.geojson. 아치 칸 자리는 프런트(building-appearance.ts 의 bays: 간격 4.6, 폭 3.2, 벽 가운데 맞춤)와 같은 식으로 계산한다."""
import json, math, pathlib
import numpy as np
from shapely.geometry import Polygon
REPO = pathlib.Path(__file__).parents[3]; r2 = lambda v: round(float(v), 2)
SRC = '사용자-청운관현관·은주1관돌계단-20261012/07·08·09·10, 건물 노트 은주관 B15 절'
TOP, BAND = 155.5, 2.8      # 그려지는 벽 꼭대기(지붕 156.8 - 오름 2.6 의 반: building-appearance.ts wallTopM), 처마 밑 띠
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, grade, **extra):
    assert toM > fromM, id
    FEATS.append({'type': 'Feature', 'properties': {'id': 'B15-EUNJU1-' + id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': '건물 은주관(1관) 서쪽 벽', 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': SRC, **extra},
                  'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in Polygon(poly).exterior.coords]]}})
def face(a, b):
    a, b = np.array(a, float), np.array(b, float); u = (b - a) / np.linalg.norm(b - a); n = np.array([-u[1], u[0]])   # 남→북으로 가는 변의 왼쪽 = 서쪽(바깥)
    L = float(np.linalg.norm(b - a)); count = int((L - 0.6) // 4.6); start = (L - count * 4.6) / 2 + 0.7
    return (lambda s0, s1, d0, d1: [a + u * s0 + n * d0, a + u * s1 + n * d0, a + u * s1 + n * d1, a + u * s0 + n * d1]), [start + c * 4.6 + 1.6 for c in range(count)], L
FACES = {'S': ([201119.84, 557229.54], [201122.3, 557246.32]), 'B': ([201118.53, 557246.9], [201120.46, 557258.18]), 'N': ([201124.53, 557257.51], [201131.69, 557301.74])}
GW = '확정에 준함(아치 위에 작은 네모 창 줄: 사진 09·10), 추정(칸마다 둘, 크기)'
for tag, (a, b) in FACES.items():
    R, bays, L = face(a, b)
    for k, c in enumerate(bays):
        for j, off in enumerate((-0.85, 0.85)):
            box(f'ATTIC-{tag}{k + 1:02d}{"ab"[j]}', 'wall', R(c + off - 0.45, c + off + 0.45, 0.0, 0.16), TOP - BAND + 0.9, TOP - BAND + 1.9, '아치 머리와 처마 사이 띠의 작은 네모 창', GW, color='#33474d')
R, bays, L = face(*FACES['B'])
GG = '확정(가운데쯤 앞으로 나온 박공 덩어리, 위에 둥근 장미창, 아래 아치 문 둘: 사진 07~10), 추정(박공 높이 4.2 m, 장미창 반지름 1.3 m, 문 크기)'
K, APEX = 9, 4.2
for k in range(K):   # 박공: 돌출부 폭 전체, 계단 모양 조각(굽은·기운 면이 없어서). 깊이는 돌출 4.1 m, 윗면은 지붕 색
    x0, x1 = (L / 2) * k / K, (L / 2) * (k + 1) / K; h = APEX * (k + 1) / K
    for side, (s0, s1) in (('L', (x0, x1)), ('R', (L - x1, L - x0))):
        box(f'GABLE-{side}{k + 1}', 'wall', R(s0, s1, -4.1, 0.0), TOP, TOP + h, '돌출부 위의 박공(세모 벽과 그 뒤 지붕)을 계단 모양 조각으로', GG, color='#e3ded2', topColor='#6a6663')
ZC, RR, KD = TOP + 1.7, 1.3, 7
for k in range(-KD, KD):
    x0, x1 = RR * k / KD, RR * (k + 1) / KD; h = math.sqrt(max(RR * RR - ((x0 + x1) / 2) ** 2, 0.0))
    if h > 0.1: box(f'ROSE-{k + KD + 1:02d}', 'wall', R(L / 2 + x0, L / 2 + x1, 0.0, 0.18), ZC - h, ZC + h, '박공의 둥근 장미창(세로 조각으로 둥글게)', GG, color='#2f4046')
DOOR, DW, DH = 131.3, 2.6, 2.0
for n, c in enumerate(bays):
    box(f'DOOR{n + 1}', 'wall', R(c - DW / 2, c + DW / 2, 0.0, 0.2), DOOR, DOOR + DH, '아치 문(은주1관 입구(1), 1층 131.3 m): 굽은 돌계단 위 테라스에서 드는 문 둘', GG, material='opening')
    box(f'DOOR{n + 1}-SURROUND', 'wall', R(c - DW / 2 - 0.5, c + DW / 2 + 0.5, 0.0, 0.14), DOOR, DOOR + DH + DW / 2 + 0.6, '아치 문 둘레의 밝은 돌 면(창 줄과 문 사이)', GG, color='#e3ded2')
    for k in range(-6, 6):
        x0, x1 = (DW / 2) * k / 6, (DW / 2) * (k + 1) / 6; h = math.sqrt(max((DW / 2) ** 2 - ((x0 + x1) / 2) ** 2, 0.0))
        if h > 0.1: box(f'DOOR{n + 1}-HEAD{k + 7:02d}', 'wall', R(c + x0, c + x1, 0.0, 0.2), DOOR + DH, DOOR + DH + h, '아치 문의 둥근 머리', GG, material='opening')
out = {'type': 'FeatureCollection', 'name': 'b15-eunju1', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/b15/eunju1.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '은주1관 서쪽 면에 붙는 표시용 조각. 건물 외곽·지붕·창 줄은 건물 보정 파일(겉모습)에 있다'}, 'features': FEATS}
(REPO / 'frontend/public/structures/b15-eunju1.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(FEATS), 'features')
