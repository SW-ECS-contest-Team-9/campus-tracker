"""G03: 오르막길 어귀의 네이버 거리뷰 지점 21(정육면체 앞면, 화각 90도)과 전경 사진 18 의 시점.   python -I make_views.py  -> views.json
거리뷰 지점의 자리는 사진에서 다시 잡았다(추정): 길 축과 나란한 선들의 소실점이 앞면 가운데에서 오른쪽 6.1도, 북악관 동쪽 끝 모서리의 방위,
차단기 막대(정사 그림에서 s 16.3 m, 길이 3.4 m)의 화면 폭 -> 길 축 좌표 (s 7, t 0), 눈높이 2.5 m. 지점의 경위도(s 0.2, t 4.6)와는 8 m 다르다."""
import sys, json, math, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'g02'))
from common import st_to_xy, way_z, U, N
V = {}
def v(name, pos, tgt, fov, cam): V[name] = {'pos': [round(float(c), 2) for c in pos], 'tgt': [round(float(c), 2) for c in tgt], 'fov': fov, 'cam': cam}
a = math.radians(6.1); d = math.cos(a) * U + math.sin(a) * N
p = st_to_xy(7.0, 0.0); z = float(way_z(7.0)) + 2.5
v('g03-어귀-위로', (*p, z), (*(p + 50 * d), z), 90, '거리뷰 지점 21 의 앞면: 어귀 아스팔트에서 동쪽 위로(수평, 화각 90도)')
v('g03-하행-사진18', (*st_to_xy(60.0, -0.6), float(way_z(60.0)) + 1.7), (*st_to_xy(15.0, 0.6), float(way_z(15.0)) + 4.0), 70, '전경 사진 18: 내리막길 중턱(문예관 유리 기단부 옆)에서 내려다봄. 자리 추정')
v('g03-상행-사진21', (*st_to_xy(24.0, 0.5), float(way_z(24.0)) + 1.6), (*st_to_xy(60.0, 0.5), float(way_z(60.0)) + 3.0), 90, '사진 21(DAKNAT 3:21): 문예관 기단 옆 계단 앞에서 위로. 자리 추정')
v('g03-흡연장', (*p, z), (*st_to_xy(12.5, -3.6), float(way_z(12.5)) + 1.9), 70, '거리뷰 화면 22: 같은 지점에서 본관 북서 모서리의 흡연장 쪽')
v('g03-하행-사진26', (*st_to_xy(92.0, 0.0), float(way_z(92.0)) + 1.6), (*st_to_xy(40.0, 0.0), float(way_z(40.0)) + 2.0), 90, '사진 26·25(DAKNAT 5:21~5:24): 맨 위에서 내려다봄. 자리 추정')
v('g03-카페-사진02', (*st_to_xy(76.5, 12.6), 147.0), (*st_to_xy(100.0, 14.6), 148.2), 62, 'SP 카페 사진 02: 카페 서쪽 끝 앞에서 데크와 그 너머 계단 쪽(동쪽). 자리 추정')
v('g03-카페-사진03', (*st_to_xy(74.5, 13.6), 146.9), (*st_to_xy(100.0, 14.2), 149.2), 66, 'SP 카페 사진 03(사용자 표시 "대일"): 유리문 앞에서 데크 너머 계단과 대일관 현관. 자리 추정')
p3 = st_to_xy(12.0, 6.0)
v('g03-어귀-위에서', (*st_to_xy(2.0, 1.0), 150.0), (*st_to_xy(30.0, 0.0), 134.0), 60, '어귀를 비스듬히 위에서(띠 나눔·차단기 확인용. 사진과 같은 자리가 아니다)')
v('g03-하행-로고-사진02', (*st_to_xy(76.0, 0.6), float(way_z(76.0)) + 2.4), (*st_to_xy(50.0, 0.3), float(way_z(50.0)) + 0.5), 62, '사용자 사진 02(옛 사진): 문예관 3층 옆 계단 위쪽에서 내려다봄. 자리 추정')
v('g03-고리무늬-가까이', (*st_to_xy(40.0, 0.5), float(way_z(40.0)) + 1.7), (*st_to_xy(46.0, 0.2), float(way_z(46.0))), 70, '차도의 고리 무늬를 걷는 눈높이에서(확인용)')
pathlib.Path(__file__).with_name('views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(V))
