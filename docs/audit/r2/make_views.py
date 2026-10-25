"""R2 갈무리 시점(views.json)을 실제 축 s', t'(판독 R2: 원점 (201042.26, 557346.46), 방위 113.94°)으로 정해 5186 좌표로 쓴다.
눈높이 시점의 높이 = 길 기본 평면(G02-PLATFORM-WAY topProfile) + 1.6 m.   python -X utf8 make_views.py"""
import json, pathlib
import numpy as np
HERE = pathlib.Path(__file__).parent
O = np.array([201042.26, 557346.46]); A = np.array([0.91395, -0.40582]); N = np.array([0.40582, 0.91395])
OM = np.array([201044.0, 557350.0]); U = np.array([60.0, -29.5]); U /= np.hypot(*U)
WAY = [(-3.5, 130.96), (20.0, 133.75), (55.0, 138.95), (100.0, 146.68), (110.0, 148.9)]
def xy(s, t): return O + A * s + N * t
def way(p): return float(np.interp((p - OM) @ U, *zip(*WAY)))
def eye(s, t, dz=1.6): p = xy(s, t); return [round(p[0], 2), round(p[1], 2), round(way(p) + dz, 2)]
def at(s, t, z=None, dz=0.0): p = xy(s, t); return [round(p[0], 2), round(p[1], 2), round(z if z is not None else way(p) + dz, 2)]
V = {
  '오르막-위': {'pos': at(56, -3, 228), 'tgt': at(56, 5, dz=0), 'fov': 62},
  '오르막아래-눈높이': {'pos': eye(10, 4.2), 'tgt': at(60, 3.8, dz=1.0), 'fov': 65},
  '오르막가운데-남쪽옹벽-눈높이': {'pos': eye(36, 3.2), 'tgt': at(58, 0.6, dz=0.6), 'fov': 65},
  '오르막윗구간-눈높이': {'pos': eye(78, 4.0), 'tgt': at(104, 1.0, dz=0.8), 'fov': 65},
  '오르막꼭대기에서-내려다봄': {'pos': eye(108, 4.0), 'tgt': at(60, 4.0, dz=0), 'fov': 65},
  '문예관통계단-눈높이': {'pos': eye(69.0, 3.6), 'tgt': at(70.5, 15, 145.0), 'fov': 70},
  '문예관앞-위': {'pos': at(70, 0, 166), 'tgt': at(71, 12, 142), 'fov': 60},
  '타일마당들머리-눈높이': {'pos': eye(89, 5.5), 'tgt': at(97, 12, 146.6), 'fov': 70},
  '북악관문예관사이계단-눈높이': {'pos': eye(33.0, 3.5), 'tgt': at(37.0, 11.0, 138.3), 'fov': 70},
  '차단기-눈높이': {'pos': eye(6, 1.0), 'tgt': at(17, 6.0, dz=0.8), 'fov': 65},
  '본관모서리아치-눈높이': {'pos': at(-13, -1.5, 132.3), 'tgt': at(2.5, -6.5, 131.2), 'fov': 65},
  '본관모서리-위': {'pos': at(-24, 10, 152), 'tgt': at(0, -4, 130.5), 'fov': 50},
}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print(json.dumps(V, ensure_ascii=False, indent=1))
