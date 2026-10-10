# Z07: boxes_z06.py 뒤에 같은 이름 공간에서 실행한다. 본관–한림관 틈: 지하 보행 구간의 마지막 22 m 를 덮인 복도(밑단·바닥·옆벽·덮개)로, 내리막길 밑 구간은 빈 곳으로, 데크에 난간·보·문 면을.
# 틈 바닥 기단(127.2 / 135.3 m)은 그대로다. 높이는 전부 시험용 DB 길 2b765aa4 의 값(데크 137.8 m 추정에서 10.8 % 로 내려간 것)이고 폭·벽 두께·덮개 높이는 추정이다.
from shapely.geometry import LineString as _LS
_STRIP = [(201083.5, 557329.7, 133.21), (201092.7, 557325.2, 134.32), (201101.9, 557320.6, 135.43), (201106.0, 557311.8, 136.48), (201104.9, 557310.2, 136.69), (201103.8, 557308.5, 136.91), (201102.6, 557306.9, 137.13), (201101.5, 557305.3, 137.34), (201100.4, 557303.6, 137.56), (201098.53, 557302.41, 137.8)]
_OUT = 14.0 / 17.72   # 2b765aa4 의 셋째 마디(201101.9, 557320.6 → 201106, 557311.8)에서 내리막길 기단 밖으로 나오는 자리(마디의 79 %, 북좌표 557313.6: 기단 G02-PLATFORM-WAY 의 남쪽 변에서 1 m 안쪽은 길 옹벽 밑)
ZSRC = '시험용 DB 길 2b765aa4(지하 차도 보행 구간 연장, B11b 뒤 높이), 사용자 확정 2026-10-11(본관–한림관 사이에 바깥 계단·비탈 없음, 데크는 지하 보행 구간에서 높이 차 없이 이어짐), 동 노트 본관·한림관 B11(데크 137.8 m 추정), docs/audit/z05/build_inputs.py 의 틈 기단'
ZG = '확정(이어짐·계단 없음·덮인 지하 보행 구간), 추정(선 ±2 m, 높이 = 데크 137.8 m 추정에서 내려간 값, 폭 2.4 m·벽 0.2 m·안 높이 2.5 m)'
CW, CT, CH = 1.2, 0.2, 2.5   # 복도 반 폭(안), 벽 두께, 안 높이
def _cut(a, b, t0, t1): a, b = np.array(a, float), np.array(b, float); return a + (b - a) * t0, a + (b - a) * t1
def _strip_box(p, q, left, right):
    """p → q 마디를 따라 가운데 선의 왼쪽 left ~ 오른쪽 right 까지의 네모(끝은 0.15 m 씩 겹침)."""
    p, q = np.array(p[:2], float), np.array(q[:2], float); u = unit(q - p); n = np.array([-u[1], u[0]]); p, q = p - u * 0.15, q + u * 0.15
    return Polygon([p + n * left, q + n * left, q + n * right, p + n * right])
_pieces = []   # (이름, 시작 점, 끝 점): 높이는 마디 양 끝의 값
_a, _b = _cut(_STRIP[2], _STRIP[3], _OUT, 1.0); _pieces.append((_a, _b))
for _p, _q in zip(_STRIP[3:-1], _STRIP[4:]): _pieces.append((np.array(_p, float), np.array(_q, float)))
for k, (p, q) in enumerate(_pieces):
    last = k == len(_pieces) - 1; zf = max(p[2], q[2]); nm = f'Z07-CORRIDOR-{k + 1:02d}'
    # Z08: 바닥은 마디마다 길 높이를 따라 기운 면(경사 10.8 %). Z07 은 마디마다 평평하게 두어 0.21~0.24 m 단 여섯이 생겼다: 계단·높이 차 없이 이어진다는 확정 사실에 어긋남
    _len = float(np.hypot(q[0] - p[0], q[1] - p[1]))
    box('upper-branch', nm + '-FLOOR', 'landing', _strip_box(p, q, CW + CT, -CW - CT), 135.3, zf, f'덮인 보행 복도의 밑단과 바닥(마디 {k + 1}/{len(_pieces)}): 윗면 {p[2]:.2f} → {q[2]:.2f} m = 길 높이를 따라 기운 면(단 없음), 아래는 틈 윗부분 기단(135.3 m)까지 막힌 덩어리. 기단을 올리지 않고 복도를 얹었다', ZSRC, grade=ZG, basePlane='Z05-PLATFORM-UPPER-HANLIM-WGAP-UP / NARC 135.3', material='concrete',
        bottomM=135.3, topProfile={'origin': [r2(p[0]), r2(p[1])], 'direction': [r2(q[0] - p[0]), r2(q[1] - p[1])], 'points': [[0, r2(p[2])], [r2(_len), r2(q[2])]]})
    if last: continue   # 마지막 마디(데크로 나가는 2.2 m)는 덮개 없는 바닥만: 데크는 실외(확정)
    for tag, (l, r) in (('L', (CW + CT, CW)), ('R', (-CW, -CW - CT))): box('upper-branch', f'{nm}-WALL-{tag}', 'wall', _strip_box(p, q, l, r), zf, zf + CH, '복도 옆벽(두께 0.2 m, 안 높이 2.5 m: 추정)', ZSRC, grade=ZG, basePlane=nm + '-FLOOR', material='concrete')
    box('upper-branch', nm + '-COVER', 'canopy', _strip_box(p, q, CW + CT + 0.15, -CW - CT - 0.15), zf + CH, zf + CH + 0.25, '복도 덮개 판(두께 0.25 m). 내리막길 밑에서 나온 뒤에도 덮여 있다고 본 것은 추정(지하 보행 구간의 연장이라는 것만 확정)', ZSRC, grade=ZG, basePlane='없음(옆벽 위)', material='concrete')
# 내리막길 기단 밑 구간: 기단 안의 빈 곳(단면도에서 길 밑의 덮인 통로로 보인다). 덮개 = 내리막길 포장면(위로 3.0~5.4 m)
_under = [(_STRIP[0], _STRIP[1]), (_STRIP[1], _STRIP[2]), tuple(_cut(_STRIP[2], _STRIP[3], 0.0, _OUT))]
for k, (p, q) in enumerate(_under):
    zf = min(p[2], q[2])
    BOX['upper-branch'].append({'type': 'Feature', 'properties': {'id': f'Z07-VOID-WALK-{k + 1}', 'type': 'void', 'kind': 'void', 'estimated': True, 'grade': ZG, 'inside': 'G02-PLATFORM-WAY', 'fromM': r2(zf), 'toM': r2(max(p[2], q[2]) + CH),
        'assumption': f'지하 차도 보행 구간이 내리막길 기단 밑을 지나는 자리(마디 {k + 1}/3): 바닥 {p[2]:.2f} → {q[2]:.2f} m, 안 높이 2.5 m, 폭 2.4 m. 덮개는 내리막길 포장면', 'source': ZSRC}, 'geometry': geom(_strip_box(p, q, CW, -CW))})
# 데크(G02-DECK-MAIN-HANLIM, 137.5~137.8 m: 본관 5층 문 ~ 한림관 3층 문에 걸린 판) 에 붙는 것. 벽 자리는 건물 원천 외곽
_dk = np.array([201098.0, 557302.7]); _dv = unit(np.array([201112.0, 557295.0]) - _dk); _dn = np.array([-_dv[1], _dv[0]])
_wb = _LS([(201092.7, 557290.7), (201104.2, 557314.9)]); _wh = _LS([(201099.8, 557299.3), (201102.4, 557304.5)]); _ax = _LS([_dk - 8 * _dv, _dk + 8 * _dv])
_sb = float(np.dot(np.array(_ax.intersection(_wb).coords[0]) - _dk, _dv)); _sh = float(np.dot(np.array(_ax.intersection(_wh).coords[0]) - _dk, _dv))   # 데크 축에서 본관 벽·한림관 벽의 자리
DG = '확정(자리·실외 나무 데크·두 건물의 문을 잇는다), 추정(높이 137.8 m, 판·난간·보·문 치수, 벽 자리는 원천 외곽)'
DSRC = '사용자 확정(그림 01-카카오위성-본관한림관-나무데크-위치, 학교 캠퍼스맵 "본관 5층과 한림관 3층을 연결"), 건물 원천 외곽, 구조물 G02-DECK-MAIN-HANLIM'
def _dR(s0, s1, d0, d1): return Polygon([_dk + _dv * s0 + _dn * d0, _dk + _dv * s1 + _dn * d0, _dk + _dv * s1 + _dn * d1, _dk + _dv * s0 + _dn * d1])
for tag, (d0, d1) in (('N', (1.3, 1.5)), ('S', (-1.5, -1.3))):
    box('upper-branch', f'Z07-DECK-BEAM-{tag}', 'wall', _dR(_sb - 0.3, _sh + 0.3, d0, d1), 137.0, 137.5, '데크 판 밑 가장자리 보(두 건물 벽에 걸림). 아래는 비어 있다: 틈 바닥은 기단 그대로', DSRC, grade=DG, basePlane='없음(두 벽 사이)', material='concrete')
box('upper-branch', 'Z07-DECK-RAIL-S', 'wall', _dR(_sb, _sh, -1.5, -1.4), 137.8, 138.9, '데크 남쪽 난간(높이 1.1 m). 북쪽은 복도가 들어오는 쪽이라 난간을 두지 않았다', DSRC, grade=DG, basePlane='G02-DECK-MAIN-HANLIM', material='timber')
for tag, (s0, s1, wall) in (('BONGWAN', (_sb - 0.05, _sb + 0.15, '본관 5층')), ('HANLIM', (_sh - 0.15, _sh + 0.05, '한림관 3층'))):
    box('upper-branch', f'Z07-DECK-DOOR-{tag}', 'wall', _dR(s0, s1, -0.9, 0.9), 137.8, 140.1, f'{wall} 문 면(폭 1.8 m, 높이 2.3 m: 추정). 벽면의 뚫린 곳을 나타내는 어두운 판', DSRC, grade=DG, basePlane='G02-DECK-MAIN-HANLIM', material='opening')
