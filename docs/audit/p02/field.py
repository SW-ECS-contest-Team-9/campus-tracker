"""P02 운동장 바닥 무늬. 사진 19 를 운동장 평면(148.9 m)으로 펴서 읽었다(시점은 청운관 지붕 모서리 둘, 혜인관 벽 발치 양 끝, 은주관 탑으로 맞춤: 잔차 3 화소)."""
import math
import numpy as np
from shapely.geometry import Polygon as SP
from shapely.ops import unary_union
r2 = lambda v: round(float(v), 2)
FIELD = [[201197.68, 557175.65], [201135.95, 557230.72], [201137.27, 557243.5], [201134.79, 557243.5], [201136.75, 557255.5], [201140.1, 557255.5], [201146.24, 557293.5], [201143.2, 557293.5], [201145.05, 557311.01], [201178.11, 557300.1], [201179.43, 557296.96], [201206.06, 557288.63], [201213.32, 557280], [201221.2, 557275], [201227.21, 557273.8], [201237.3, 557262.9], [201244.16, 557257.31], [201228.26, 557229.99], [201229.84, 557229.09], [201219.73, 557212.37], [201217.86, 557213.44], [201201.71, 557185.81]]
FONT = {'S': '01111 10000 10000 01110 00001 00001 11110', 'E': '11111 10000 10000 11110 10000 10000 11111', 'O': '01110 10001 10001 10001 10001 10001 01110', 'K': '10001 10010 10100 11000 10100 10010 10001', 'Y': '10001 10001 01010 00100 00100 00100 00100', 'N': '10001 11001 10101 10101 10011 10001 10001',
        'G': '01110 10001 10000 10111 10001 10001 01110', 'U': '10001 10001 10001 10001 10001 10001 01110', 'I': '11111 00100 00100 00100 00100 00100 11111', 'V': '10001 10001 10001 10001 01010 01010 00100', 'R': '11110 10001 10001 11110 10100 10010 10001', 'T': '11111 00100 00100 00100 00100 00100 00100'}
W_CORNER, S_CORNER = np.array(FIELD[1]), np.array(FIELD[0])
A = (S_CORNER - W_CORNER) / np.hypot(*(S_CORNER - W_CORNER))   # 남서 변(은주2관 쪽)을 따라 남동으로. 방위 131.7 도
N = np.array([-A[1], A[0]]); N = N if N @ np.array([1, 1]) > 0 else -N   # 운동장 안쪽(북동)
# 주황 띠: 남서 변에서의 거리(m). 사진을 편 그림에서 읽은 것(화소 하나가 0.5~1 m 라 폭은 ±1 m)
BANDS = [(31.0, 32.0), (34.0, 35.5), (37.5, 40.0), (42.5, 44.0), (46.0, 49.0), (52.0, 55.0), (56.0, 58.5), (61.0, 64.5), (66.0, 70.5), (73.0, 77.0), (78.5, 80.5), (83.0, 85.0), (87.0, 89.0)]   # 61 m 너머는 사진에서 뭉개져 나눔이 추정, 80 m 너머(청운관 앞 그늘)는 줄이 이어진다는 것만 보임
TEXT = {'text': 'SEOKYEONG UNIVERSITY', 'u0': 7.5, 'u1': 58.0, 'd0': 22.0, 'd1': 26.0}   # 글줄: 서쪽 모서리에서 변을 따라 7.5~58 m, 변에서 22~26 m. S 가 남동 끝, 글자 위쪽이 남서(북동에서 남서를 보고 읽는다)
SQUARES = [(17.5, 27.5, 14.0, 19.5), (36.5, 48.0, 14.0, 19.5)]
def rect(u0, u1, d0, d1): return SP([W_CORNER + A * u + N * d for u, d in ((u0, d0), (u1, d0), (u1, d1), (u0, d1))])
def build(FEATS):
    SRC = '사용자-학교전경-20261012/19-운동장-위에서-대일관-청운관-혜인관-은주관지붕.jpg 를 운동장 평면으로 편 그림(p02/운동장-사진19-편그림.jpg), 06·02·08(땅에서)'
    G = '확정(운동장은 148.9 m 평면), 원천(회색 바닥, 은주2관 쪽 변과 나란한 주황 띠, 그 변 쪽의 민무늬 회색 구역·주황 네모 둘·흰 글자 SEOKYEONG UNIVERSITY: 사용자 사진 19 를 편 그림), 추정(띠의 폭·자리 ±1 m, 글자 모양)'
    field = SP(FIELD).buffer(0); Z0 = 148.9
    def plates(pid, g, z0, z1, what, color):
        gs = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.05]
        for n, q in enumerate(gs):
            FEATS.append({'type': 'Feature', 'properties': {'id': pid if len(gs) == 1 else f'{pid}-{n + 1}', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': G, 'basePlane': 'Z02-PLATFORM-FIELD(운동장 148.9)', 'fromM': r2(z0), 'toM': r2(z1), 'assumption': what + '. 바닥의 칠(두께 2 cm 판으로 나타냄): 운동장은 평평한 한 면 그대로이고 걷는 면(영역)도 그대로다', 'source': SRC, 'color': color, 'surfaceMark': True},
                          'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in q.exterior.coords]] + [[[r2(x), r2(y)] for x, y in h.coords] for h in q.interiors]}})
    plates('P02-FIELD-BASE', field.buffer(-0.15), Z0 - 0.3, Z0 + 0.02, '운동장 바닥의 회색 바탕', '#8f9193')
    inner = field.buffer(-0.4)
    for k, (d0, d1) in enumerate(BANDS): plates(f'P02-FIELD-STRIPE-{k + 1:02d}', inner.intersection(rect(-60, 120, d0, d1)), Z0 + 0.02, Z0 + 0.04, f'주황 띠 {k + 1}(은주2관 쪽 변에서 {d0}~{d1} m, 변과 나란히 방위 131.7 도. 서쪽 가장자리에서 혜인관 앞까지)', '#dd9a3c')
    t = TEXT; n = len(t['text']); adv = (t['u1'] - t['u0']) / n; cw = adv * 0.78 / 5; ch = (t['d1'] - t['d0']) / 7
    for i, c in enumerate(t['text']):   # i 번째 글자는 남동 끝에서 시작한다(읽는 사람의 왼쪽 = 남동)
        if c == ' ': continue
        uL = t['u1'] - i * adv   # 글자의 왼쪽 변(읽는 쪽에서)
        cells = [rect(uL - (col + 1) * cw, uL - col * cw, t['d0'] + row * ch, t['d0'] + (row + 1) * ch) for row, bits in enumerate(FONT[c].split()) for col, b in enumerate(bits) if b == '1']   # 윗줄(row 0)이 남서(변 쪽)
        plates(f'P02-FIELD-TEXT-{i + 1:02d}-{c}', unary_union(cells).buffer(0.001), Z0 + 0.04, Z0 + 0.06, f'바닥 글자 {c}(높이 {t["d1"] - t["d0"]:.0f} m)', '#f2f2ee')
    for k, (u0, u1, d0, d1) in enumerate(SQUARES): plates(f'P02-FIELD-SQUARE-{k + 1}', rect(u0, u1, d0, d1).intersection(inner), Z0 + 0.04, Z0 + 0.06, f'글자와 은주2관 사이의 주황 네모 {k + 1}({u1 - u0:.0f} × {d1 - d0:.1f} m)', '#e09a3a')
