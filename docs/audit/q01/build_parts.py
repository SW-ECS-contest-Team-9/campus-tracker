"""Q01: 남은 차이를 구조물 상자로 고친다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/q01-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 전부 estimated. 근거 그림은 볼트의 데이터/보완자료/3d-map-audit-20261009/ 아래.
  1. 은주2관 서경로 쪽 면 양 끝의 흰 박공 덩어리(전경 사진 01·16·17·20): 그 사이에 청록 긴 아치 칸 14개가 남는다."""
import json, pathlib, sys
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'p02'))
import parts2
from parts2 import box, poly, frame, SP
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
FEATS = []; parts2.FEATS = FEATS
r2 = lambda v: round(float(v), 2)

def eunju_gables():
    SRC = '사용자-학교전경-20261012/17-수인관-남쪽면-원경.jpg·16-전경-남서-원경2.jpg·01·20, 동 노트 은주관(2관 외곽, 처마 159.7 m, 낮은 단 146.8 m)'
    G = '원천(아치 칸 줄의 양 끝에 흰 박공 덩어리, 박공에 둥근 창, 덩어리마다 아치 칸 둘: 사용자 사진 17·16), 추정(폭 10 m·내민 깊이·박공 높이)'
    A, B = np.array([201132.96, 557210.62]), np.array([201189.76, 557160.88])   # 2관 서경로 쪽 면(북서 끝 → 남동 끝), 동 노트의 2관 외곽
    L = float(np.hypot(*(B - A))); R, P = frame(A, B - A, (-1, -1))            # 바깥 = 남서(낮은 단 쪽)
    Z0, EAVE, PEAK, W, D = 146.8, 159.7, 163.4, 10.0, 0.6
    WHITE, TEAL, BAND = '#e9e6dd', '#2e9a9c', '#d8d4c8'
    for nm, s0 in (('NW', 0.0), ('SE', L - W)):
        pid = f'Q01-EUNJU2-GABLE-{nm}'; base = '은주2관 서경로 쪽 벽면(낮은 단 지붕 146.8 m 위)'
        box(f'{pid}-BODY', 'wall', R(s0, s0 + W, -0.1, D), Z0, EAVE, '흰 박공 덩어리의 몸(벽면에서 0.6 m 내밈, 폭 10 m)', SRC, G, base, color=WHITE)
        # 박공: 가운데로 오르는 두 기운 윗면(처마 159.7 → 꼭대기 163.4)
        for side, (a, b) in (('L', (s0, s0 + W / 2)), ('R', (s0 + W, s0 + W / 2))):
            o = P(a, 0.0); d = (P(b, 0.0) - o) / (W / 2)
            FEATS.append({'type': 'Feature', 'properties': {'id': f'{pid}-PEDIMENT-{side}', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': G, 'basePlane': f'{pid}-BODY', 'fromM': EAVE, 'toM': PEAK, 'bottomM': EAVE,
                'topProfile': {'origin': [r2(o[0]), r2(o[1])], 'direction': [float(d[0]), float(d[1])], 'points': [[0.0, EAVE + 0.05], [W / 2, PEAK]]}, 'assumption': '박공(세모 머리): 처마에서 가운데 꼭대기로 오르는 면', 'source': SRC, 'color': WHITE},
                'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in R(min(a, b), max(a, b), -0.1, D)]]}})
        c = s0 + W / 2
        box(f'{pid}-ROUND-WINDOW', 'wall', R(c - 0.8, c + 0.8, D, D + 0.06), 159.9, 161.5, '박공의 둥근 창(네모로 줄임)', SRC, G, f'{pid}-BODY', color=TEAL)
        for k, sc in enumerate((c - 2.3, c + 2.3)):
            box(f'{pid}-ARCH-{k + 1}', 'wall', R(sc - 1.5, sc + 1.5, D, D + 0.06), Z0 + 0.6, 156.3, '덩어리 안의 청록 긴 아치 칸(몸)', SRC, G, f'{pid}-BODY', color=TEAL)
            box(f'{pid}-ARCH-{k + 1}-HEAD-1', 'wall', R(sc - 1.3, sc + 1.3, D, D + 0.06), 156.3, 157.0, '아치 머리(계단 모양 조각)', SRC, G, f'{pid}-BODY', color=TEAL)
            box(f'{pid}-ARCH-{k + 1}-HEAD-2', 'wall', R(sc - 0.8, sc + 0.8, D, D + 0.06), 157.0, 157.5, '아치 머리(계단 모양 조각)', SRC, G, f'{pid}-BODY', color=TEAL)
        box(f'{pid}-BAND', 'wall', R(s0 - 0.05, s0 + W + 0.05, D, D + 0.1), 158.2, 158.6, '처마 밑 돌 띠', SRC, G, f'{pid}-BODY', color=BAND)

def write():
    eunju_gables()
    out = {'type': 'FeatureCollection', 'name': 'q01-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'provenance': {'script': 'docs/audit/q01/build_parts.py', 'note': 'Q01: 남은 차이를 구조물 상자로. 전부 estimated'}, 'features': FEATS}
    ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]
    (STR / 'q01-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(len(FEATS), 'features')
if __name__ == '__main__': write()
