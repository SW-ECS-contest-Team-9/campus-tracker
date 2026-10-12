"""W01: 거리뷰 지점에서 보는 시점을 views.json 으로 쓴다(자리 = 색인의 좌표, 높이 = 그 자리 기단 윗면 + 2.3 m, 방위는 나침반 각).   python make_views.py"""
import json, math, pathlib
import numpy as np
from shapely.geometry import shape, Point
REPO = pathlib.Path(__file__).parents[3]
PL = [(shape(f['geometry']).buffer(0), f['properties']) for fn in sorted((REPO / 'frontend/public/structures').glob('*.geojson')) for f in json.loads(fn.read_text(encoding='utf-8'))['features'] if f['properties']['kind'] == 'platform']
def top(p, x, y):
    if 'topProfile' in p: o, d, pts = np.array(p['topProfile']['origin']), np.array(p['topProfile']['direction']), np.array(p['topProfile']['points']); return float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))
    return float(p['topM'])
def ground(x, y):
    v = [top(p, x, y) for g, p in PL if g.contains(Point(x, y))]; return min(v) if v else None
# 이름: (x, y, 방위, 기울기, 화각, 설명[, 높이 고정])
S = {
 '27-유담관-남서모서리': (200994.3, 557236.9, 51, 14, 75, '거리뷰 27 자리에서 북동 위: 유담관 공도 쪽 남서 모서리'),
 '28-서쪽면-북쪽보기': (200994.6, 557265.8, 8, 12, 80, '거리뷰 28 자리에서 북쪽: 서쪽 면과 보도'),
 '29-스포렉스입구': (200990.0, 557299.5, 62, 2, 75, '거리뷰 29 처럼 길에서 입구를 봄(자리는 모델의 입구 남서 10 m: 거리뷰 지점은 길 방향 오차가 큼)'),
 '31-서쪽면-가게칸': (200985.7, 557333.9, 32, 5, 80, '거리뷰 31 자리에서 북북동'),
 '33-북쪽끝-남쪽보기': (200979.5, 557386.0, 172, 6, 75, '유담관 서쪽 날개 북쪽 끝 앞에서 남쪽(거리뷰 33 뒤쪽 면)'),
 '33-서문쪽-북쪽보기': (200980.5, 557372.0, 352, 6, 75, '거리뷰 33 처럼 북쪽: 돌 옹벽과 서문'),
 '34-서문-가까이': (200971.9, 557389.2, 15, 6, 75, '거리뷰 34 자리에서 서문'),
 '35-서문-정면': (200961.3, 557391.4, 47, 6, 70, '거리뷰 35 자리에서 서문 정면', 118.5),
 '36-공연실습소': (201018.0, 557230.4, 140, 12, 75, '거리뷰 36 자리에서 남동: 공연실습소 북서 모서리'),
 '36-제3생활관': (201018.0, 557230.4, 230, 10, 75, '거리뷰 36 자리에서 남서: 제3 생활관 동쪽 끝'),
 '26-회전교차로': (200981.2, 557236.7, 51, 6, 80, '거리뷰 26 자리에서 북동: 회전교차로 너머 유담관', 93.0),
 '38-광장아래-건물면': (201074.9, 557162.9, 330, 12, 80, '거리뷰 38 자리에서 북북서: 분수 광장 아래 건물 면'),
 '39-밝은돌옹벽': (201101.9, 557127.1, 35, 8, 80, '거리뷰 39 자리에서 북동: 정문 북서쪽 길가 옹벽'),
 '40-정문-수인관': (201123.8, 557101.0, 40, 20, 80, '거리뷰 40 자리에서 북동 위: 정문 보와 수인관 서경로 면'),
 '41-수인관-남쪽끝': (201144.7, 557084.4, 20, 12, 80, '거리뷰 41 자리에서 북: 수인관 남쪽 끝과 정문'),
}
out = {}
for k, (x, y, hd, pt, fov, cam, *fix) in S.items():
    z = (fix[0] if fix else ground(x, y)) + 2.3; h, p = math.radians(hd), math.radians(pt); d = 30.0
    out[k] = {'pos': [x, y, round(z, 1)], 'tgt': [round(x + d * math.sin(h) * math.cos(p), 1), round(y + d * math.cos(h) * math.cos(p), 1), round(z + d * math.sin(p), 1)], 'fov': fov, 'cam': cam}
    print(k, out[k]['pos'])
(pathlib.Path(__file__).parent / 'views.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
