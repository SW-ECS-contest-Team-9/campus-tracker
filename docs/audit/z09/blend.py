# Z09: z05/write_out.py 가 같은 이름 공간에서 실행한다(캠퍼스 밖 S-MAP 표본을 쓴 바로 뒤).
# 캠퍼스 밖으로 나간 기단(공도 셋, 뒤편 숲 비탈 둘)의 바깥 가장자리에서 지형이 기단 윗면과 턱 없이 만나게 하는 "이음 표본"을 만든다.
#  - S-MAP 값이 아니다(추정): 기단 바깥 변에서 1.5·4.5·7.5 m 밖에, 가장 가까운 변의 기단 윗면 높이를 3 m 간격으로 놓는다.
#    국소 표본 단계가 표본에서 6 m 까지 그 높이로 맞추고 12 m 에서 원래 지형으로 돌아간다 -> 기단 끝의 4~5 m 턱이 13~20 m 폭의 완만한 땅으로 바뀐다.
#  - S-MAP 표본(z05_edge_sw)이 8 m 안에 있으면 놓지 않는다(잰 값이 먼저다). 건물에서 18 m 안, 캠퍼스 안, 다른 기단 안에도 놓지 않는다(건물 칸을 바꾸지 않게).
from shapely.ops import nearest_points
_real = shapely.MultiPoint([(p[0], p[1]) for p in pts]).buffer(8.0) if pts else Polygon()
_keep_off = unary_union([DRAWN.buffer(18.0), BLD_ALL.buffer(18.0), CAMPUS.buffer(1.0), unary_union([q['poly0'] for q in PLATS if not q.get('keepSamples')]).buffer(1.0), DONE.buffer(1.0), FIELD.buffer(1.0), _real]).buffer(0)
BLEND_PTS = []; BLEND_BY = {}
for q in PLATS:
    if not q.get('outside') or q.get('noBlend'): continue   # R01: noBlend = 이음 표본을 놓지 않는 기단(건물 옆의 좁은 앞마당)
    n0 = len(BLEND_PTS)
    for d in (1.5, 4.5, 7.5):
        ring = q['poly0'].buffer(d, join_style=1).exterior
        for s in np.arange(0.0, ring.length, 3.0):
            c = ring.interpolate(float(s))
            if _keep_off.contains(c): continue
            e = nearest_points(q['poly0'], c)[0]
            BLEND_PTS.append([r2(c.x), r2(c.y), r2(float(top_z(q['top'], e.x, e.y)))])
    BLEND_BY[q['name']] = len(BLEND_PTS) - n0
if BLEND_PTS:
    dump(REPO / 'backend/data/terrain/samples/z09_edge_blend_5186.json', {'crs': 'EPSG:5186', 'reason': 'Z09: 캠퍼스 밖으로 나간 기단(서쪽 공도·남서쪽 공도·정문 앞 서경로, 뒤편 숲 비탈)의 바깥 가장자리에서 지형이 기단 윗면과 턱 없이 만나게 한다. 전에는 서경로 판이 바깥 지형보다 4~5 m 솟아 뭉툭하게 끊겼다',
      'note': '잰 값이 아니다(추정). 기단 바깥 변에서 1.5·4.5·7.5 m 밖에 그 변의 기단 윗면 높이를 놓은 이음 표본이다. S-MAP 표본에서 8 m 안, 건물에서 18 m 안, 캠퍼스·기단 안에는 없다. 만드는 스크립트 docs/audit/z09/blend.py',
      'groups': [{'area': 'z09_edge_blend', 'source': 'estimate-platform-edge', 'collected': '2026-10-11', 'originalFile': 'docs/audit/z09/blend.py (구조물 기단의 바깥 변)', 'points': BLEND_PTS}]})
print('blend samples', len(BLEND_PTS), BLEND_BY)
