"""Z05: Z04 의 자동 기단(평탄면·경사면·2 m 띠의 단 142개)을 손으로 정한 큰 평면으로 바꾼다. DB·네트워크 접근 없음.
  python build_inputs.py [--plan <그림 폴더>]
원칙(사용자 2026-10-11): 기본 평면 먼저, 그 위에 상자. 높이가 다른 두 평면은 벽면 하나로 만난다. 톱니 단·표본에 맞춘 울퉁불퉁한 외곽을 만들지 않는다.
만드는 법: SPEC 의 다각형(곧은 변)마다 윗면 하나(한 높이, 또는 S-MAP 1 m 메시에 맞춘 평면 하나). 앞에 적힌 것이 먼저 자리를 갖는다(겹치면 뒤의 것을 깎는다).
  손으로 정한 길 띠·마당(hand.py) > SPEC 순서. 끝난 세 구역(G02·Z02·Z03)의 기단과 운동장은 건드리지 않는다. 건물 밑은 벽 안쪽 1 m 까지만.
쓰는 파일:
  frontend/public/structures/z05-<구역>.geojson       기단 + 상자(z04-<구역>.geojson 을 대신한다)
  backend/data/terrain/recipes/z05-surface.geojson    같은 기단에서 나온 지형 조리법 surface 입력
  backend/data/terrain/recipes/z05-smooth-ground.json 조리법 = Z03 조리법 단계 + 캠퍼스 밖 남서쪽 S-MAP 표본 + 위 surface
  backend/data/terrain/samples/smap_samples_z05_edge_5186.json  캠퍼스 밖 남서·남쪽 공도 둘레의 S-MAP 지면 표본(2 m 간격)
  docs/audit/z05/model.json"""
import sys; from hand import *
from collections import Counter, defaultdict
ZONES = {'turnaround': '북악관 앞 회차 공간과 본관 앞 포장면', 'upper-branch': '위쪽 갈래(본관·한림관 사이 차도, 한림관 1층 가는 길, 한림관 옆 낮은 곳)', 'back-paths': '문예관–대일관 사잇길, 북악관 옆길, 뒤편 산책로',
         'cheongun': '청운관 앞', 'hyein': '혜인관 둘레', 'eunju': '은주관 둘레(풋살장·수인관)', 'yudam9': '유담관 둘레(9층 쪽 앞마당, 본관 앞 차도 S06)', 'west': '서문과 서쪽 옹벽', 'gate': '정문과 남서쪽 공도'}
ABBR = {'turnaround': 'TURN', 'upper-branch': 'UPPER', 'back-paths': 'BACK', 'cheongun': 'CHEONGUN', 'hyein': 'HYEIN', 'eunju': 'EUNJU', 'yudam9': 'YUDAM9', 'west': 'WEST', 'gate': 'GATE'}
TW, TH, TX0, TY0, TR = 450, 464, 200668, 556798, 2
TERR = np.fromfile(Z04 / 'terrain-recipe-a334b116df79c91e.f32', dtype='<f4').reshape(TH, TW)   # Z04 뒤의 시험용 지형(캠퍼스 밖 높이를 읽는 데만 쓴다)
def terr(x, y): return TERR[((np.asarray(y) - TY0) // TR).astype(int), ((np.asarray(x) - TX0) // TR).astype(int)]

# ---------- 벽 선 ----------
def wx(y): return 201007.0 - 0.1375 * (y - 557255.0)        # 서쪽 옹벽 면(곧은 선 하나): 메시의 윗가장자리(4 m 마디로 읽힘)에 맞춘 선에서 1.5 m 바깥
WDIR = np.array([-0.1375, 1.0]) / np.hypot(0.1375, 1.0)
SA, SB = np.array([201003.0, 557252.0]), np.array([201112.0, 557120.0]); SU = (SB - SA) / np.hypot(*(SB - SA)); SN = np.array([-SU[1], SU[0]])   # 남서쪽 공도의 축(유담관 모서리 -> 정문 앞), SN = 캠퍼스 쪽
def sw(s, t): p = SA + SU * s + SN * t; return (float(p[0]), float(p[1]))
OUT_N = np.array([0.4239, 0.9057])                            # 북쪽 캠퍼스 외곽(201042,557413 -> 201227,557326)의 바깥 방향

SPEC = []
def S(zone, name, coords, top, material, what, grade, fitpoly=None, clip=None, outside=False, **kw):
    SPEC.append(dict(zone=zone, name=name, poly=coords if not isinstance(coords, (list, tuple)) else Polygon(coords), top=top, material=material, what=what, grade=grade, fitpoly=fitpoly, clip=clip, outside=outside, **kw))
PL, PV, CO, AS = 'planting', 'paving', 'concrete', 'asphalt'   # AS(Z06) = 캠퍼스 밖 공도: 윗면을 차도 색(검정)으로
EST = 'S-MAP(높이), 추정(외곽: 곧은 변으로 잡음)'
# --- 서쪽: 옹벽 한 면(wx) + 아래 공도 한 경사면 + 위 화단 ---
# Z09: 유담관 기단 데크의 서쪽 벽과 옹벽 선 사이(북좌표 557266~557305, 폭 1~5 m)는 기단이 없어 중립 바닥이 벽을 타고 올라가 흰 조각으로 보였다. 공도 기단을 건물 벽까지 넓힌다(길가 보도로 봄: 추정)
S('west', 'STREET', unary_union([Polygon([(wx(557246), 557246), (wx(557426), 557426), (wx(557426) - 24, 557426), (wx(557246) - 11, 557246)]), Polygon([(wx(557266) - 0.5, 557266), (wx(557305) - 0.5, 557305), (wx(557305) + 9, 557305), (wx(557266) + 6, 557266)])]),
  {'origin': [r2(wx(557250)), 557250.0], 'direction': [round(float(WDIR[0]), 4), round(float(WDIR[1]), 4)], 'points': [[0, 94.0], [10, 95.6], [20, 97.3], [30, 98.7], [40, 100.2], [50, 101.8], [60, 103.4], [70, 104.5], [80, 105.7], [90, 107.3], [100, 108.9], [110, 110.5], [120, 112.3], [130, 114.0], [150, 117.1], [178, 121.0]]},
  AS, '서쪽 옹벽 아래 공도: 옹벽을 따라 북으로 오르는 한 경사면(종단은 메시의 평평한 띠 값, 10 m 마디). 북좌표 557380 위는 메시 범위 밖이라 서문 앞 117.0 m(E09)에 맞춰 이음. 유담관 기단 데크 앞(북좌표 557266~557305)은 건물 벽까지(Z09)', 'S-MAP(종단), 추정(폭 11~23 m: 캠퍼스 외곽까지, 북쪽 끝, 유담관 벽 앞 틈)', outside=True)
S('west', 'WALLTOP-PLANTER', [(wx(557304), 557304), (wx(557368), 557368), (wx(557368) + 12, 557368), (wx(557304) + 12, 557304)], 131.2, PL,
  '서쪽 옹벽 위 화단 띠(소나무): 포장면 가장자리(130.6~130.7 m)보다 한 턱 높은 한 높이. 메시는 133~135.4 m 로 읽지만 나무 수관으로 봄(위성 그림의 나무 띠 자리와 같다)', '확정(옹벽 위에 소나무 화단이 있음: 서문 사진), 추정(높이·폭)')
S('west', 'WALLTOP-NORTH', [(wx(557368), 557368), (wx(557385), 557385), (201001, 557385), (201001, 557368)], 131.3, PV, '옹벽 위 북쪽 끝(포장면이 옹벽까지 닿는 곳): 한 높이(메시 131.1~132.1)', EST)
S('west', 'GATE-BANK', [(wx(557385), 557385), (wx(557424), 557424), (201001, 557424), (201001, 557385)], 'fit', PL, '서문 위 화단 비탈: 옹벽 머리(126~127 m)에서 옆길(131.5 m)까지 오르는 한 경사면', 'S-MAP(높이), 확정(옹벽 위 화단: 서문 사진), 추정(외곽)', clip=(125.5, 132.0))
# --- 뒤편: 건물 뒤의 단(길) + 바깥 숲 비탈 한 경사면 ---
S('back-paths', 'SIDE-WAY', [(201001, 557366), (201018, 557366), (201018, 557426), (201001, 557426)], 'fit', PV, '북악관 서쪽 옆길(GS25 문 앞 131.7 m): 남에서 북으로 조금 오르는 한 경사면', '확정(GS25 문 = 북악관 지하 1층 입구), S-MAP(높이), 추정(외곽)')
S('back-paths', 'BEHIND-BUKAK-W', [(201018, 557396), (201018, 557426), (201042, 557413), (201070, 557400), (201066, 557380)], 'fit', PV, '북악관 뒤(서쪽 반): 건물 뒷벽과 캠퍼스 외곽 사이의 단', EST)
S('back-paths', 'BEHIND-BUKAK-E', [(201066, 557380), (201070, 557400), (201103, 557384.5), (201097, 557364)], 'fit', PV, '북악관 뒤(동쪽 반): 문예관 뒤 단으로 오르는 한 경사면', EST)
S('back-paths', 'BEHIND-MUNYE', [(201092, 557352), (201103, 557384.5), (201136, 557369), (201128, 557344)], 'med', PV, '문예관 뒤 단: 한 높이', EST)
S('back-paths', 'DAEIL-BACKDOOR', [(201171, 557316), (201176, 557335), (201192, 557328), (201187, 557312)], 152.0, PV, '대일관 뒷문 앞 단 152.0 m(151.9~152.2)', '확정(뒷문 위치: 사용자 그림 13), S-MAP(높이), 추정(외곽)')
S('back-paths', 'BEHIND-DAEIL-W', [(201128, 557336), (201136, 557369), (201168, 557354), (201160, 557330)], 'fit', PV, '대일관 뒤(서쪽): 문예관 뒤 단에서 대일관 뒤로 오르는 한 경사면', EST, clip=(139.5, 148.6))
S('back-paths', 'BEHIND-DAEIL-E', [(201160, 557326), (201168, 557354), (201227, 557326.4), (201246, 557304), (201232, 557300), (201200, 557318)], 'fit', PV, '대일관·상승관 뒤: 거의 평평한 한 면', EST, clip=(147.0, 149.4))
# 숲 비탈: 뒤편 단의 가장자리에서 바깥 지형까지 한 경사면 둘(추정). 윗면은 안쪽 변의 단 높이와 바깥 변의 지형 높이에 맞춘 평면 하나
for nm, a, b, hin in (('BANK-W', (201042.0, 557413.0), (201136.0, 557369.0), ((0.0, 133.4), (0.3, 134.6), (0.62, 137.5), (1.0, 139.4))), ('BANK-E', (201136.0, 557369.0), (201227.0, 557326.4), ((0.0, 139.6), (0.33, 145.5), (0.66, 148.4), (1.0, 148.9)))):
    a, b = np.array(a), np.array(b); DEPTH = 24.0; quad = Polygon([a, b, b + OUT_N * DEPTH, a + OUT_N * DEPTH]); pts = []
    for f, h in hin: pts.append((*(a + (b - a) * f), h - 0.3))
    for f in np.linspace(0, 1, 9): q = a + (b - a) * f + OUT_N * DEPTH; pts.append((*q, float(terr(q[0], q[1]))))
    pts = np.array(pts); co, *_ = np.linalg.lstsq(np.c_[pts[:, 0], pts[:, 1], np.ones(len(pts))], pts[:, 2], rcond=None); g = np.hypot(co[0], co[1]); d = co[:2] / g; o = (a + b) / 2; z0 = co[0] * o[0] + co[1] * o[1] + co[2]
    ext = (np.array(quad.exterior.coords) - o) @ d
    S('back-paths', nm, quad, {'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[r2(ext.min()), r2(z0 + g * ext.min())], [r2(ext.max()), r2(z0 + g * ext.max())]]}, PL,
      f'뒤편 숲 비탈: 뒤편 단의 가장자리에서 바깥으로 {DEPTH:.0f} m 까지 한 경사면(경사 {g * 100:.0f} %). 안쪽 변은 단 높이 − 0.3 m, 바깥 변은 그 자리 지형 높이에 맞춘 평면 하나. 실제 비탈의 모양·산책로 자리는 모른다(S-MAP 메시는 나무 수관을 읽는다)', '추정(평면·범위), 확정(나무 덮인 비탈: 사용자 그림 13)', outside=True)
# --- 한림관 둘레·본관 앞(위쪽 갈래) ---
S('upper-branch', 'HANLIM-WGAP-LOW', [(201096.5, 557283), (201104.0, 557283), (201104.5, 557301), (201097.0, 557301)], 127.2, CO,
  '본관 동쪽 끝과 한림관 사이 틈의 바닥: 한림관 1층 앞 높이 그대로. 바깥 계단·비탈은 없다(사용자 2026-10-11). 북쪽 끝은 벽면(위는 한림관 북쪽 낮은 자리 135.3 m, 그 위로 본관 5층–한림관 3층 나무 데크)', '확정(계단·비탈 없음), 추정(바닥 높이·벽면 자리 북좌표 557301)')
S('upper-branch', 'HANLIM-WGAP-UP', [(201097.0, 557301), (201104.5, 557301), (201104.5, 557313), (201099.0, 557313)], 135.3, CO, '본관·한림관 사이 틈의 윗부분: 한림관 북쪽 낮은 자리(135.3 m)와 같은 높이', 'S-MAP(135.3), 추정(범위)')
S('upper-branch', 'HAIRPIN-ISLAND', [(201093, 557255.5), (201093, 557268), (201100, 557272), (201106, 557268), (201106, 557255.5)], 'med', PL, '위쪽 갈래 굽이 안쪽의 섬(화단으로 봄): 한 높이', 'S-MAP(높이), 추정(외곽·재질)')
S('upper-branch', 'JUNCTION-NE', [(201087, 557263), (201093, 557263), (201093, 557268), (201092.5, 557274), (201088, 557272)], 'fit', PV, '갈림 포장의 북동 모퉁이(위쪽 갈래 굽이 안쪽): 갈림 포장 평면보다 1.2~1.8 m 높아(메시) 따로 한 경사면으로(Z06)', EST, clip=(121.5, 124.3))
S('upper-branch', 'JUNCTION', [(201068, 557250), (201068, 557263), (201074, 557278), (201090, 557280), (201093, 557268), (201093, 557251), (201084, 557250)], 'fit', PV, '본관 앞 차도·위쪽 갈래·주 진입로가 만나는 갈림 포장(굽이 북쪽 모퉁이까지)', EST, clip=(118.8, 123.2),
  fitpoly=Polygon([(201070, 557252), (201070, 557263), (201083, 557270), (201092, 557267), (201092, 557253)]))
S('upper-branch', 'MAIN-FRONT-LOW', [(201052, 557294), (201064, 557291.5), (201070, 557290.5), (201079, 557287), (201091, 557283.5), (201097, 557281.5), (201100.5, 557280.5), (201100.5, 557277), (201096, 557279.5), (201090, 557279), (201083, 557272.5), (201060, 557284)], 'fit', PV,
  '본관 앞 포장의 아랫단(본관 앞 차도 가장자리 띠): 차도와 같이 오르는 한 경사면. 윗단(본관 벽 앞 127 m 안팎)과는 벽면 하나로 만난다. 메시는 북좌표 557280~557288 에서 123.3 → 126.0 m 로 뭉개 읽는다(사용자 핀 U068 124.8 = 계단식 보도). 벽 선은 그 가운데(추정 ±2 m), 계단식 보도의 단 수·자리는 모름(Z06)', 'S-MAP·사용자 핀 U068(높이), 추정(벽 선·외곽)', clip=(121.5, 126.0))
S('upper-branch', 'MAIN-FRONT', [(201034, 557302), (201034, 557320), (201097, 557320), (201097, 557283), (201100.5, 557283), (201100.5, 557277), (201096, 557279.5), (201090, 557279), (201083, 557272.5)], 'fit', PV,
  '본관 앞 포장의 윗단(본관 벽 앞): 한 경사면. 남쪽 변은 아랫단 위의 벽면(Z06)', 'S-MAP(높이), 추정(외곽)', clip=(124.5, 128.4),
  fitpoly=Polygon([(201036, 557304), (201036, 557319), (201096, 557319), (201096, 557286), (201079, 557290), (201064, 557294), (201050, 557298)]))
S('upper-branch', 'HANLIM-FRONT', [(201100.5, 557270), (201111, 557270), (201111, 557277.5), (201100.5, 557277.5)], 'fit', PV, '한림관 1층 문 앞 단(127.2)과 차도 사이: 차도에서 문 앞 계단 발치로 오르는 포장 한 경사면. Z05 에서는 빈 틈이 문 앞 단에 붙어 127.2 m 덩어리가 되어 사용자 핀 U060(126.1)보다 1.1 m 높았다(Z06)', 'S-MAP·사용자 핀 U060(높이), 추정(외곽)', clip=(124.9, 126.6))
S('upper-branch', 'HANLIM-SOUTH', [(201111, 557276), (201111, 557284), (201123, 557284), (201123, 557271.5), (201113, 557272)], 'fit', PV, '한림관 남쪽(1층 문 앞 단의 동쪽)', EST)
# --- 가운데 옹벽(주 진입로와 위쪽 갈래 사이): 벽 한 면, 위는 위쪽 갈래 높이를 따르는 띠 ---
S('eunju', 'CENTRAL-WALLTOP', [(201099.5, 557256), (201110, 557256), (201110, 557205), (201099.5, 557205)], {'origin': [201104.0, 557256.0], 'direction': [0.0, -1.0], 'points': [[0, 127.3], [6, 127.8], [16, 129.3], [26, 130.2], [36, 130.4], [43, 130.8], [51, 131.0]]}, PL,
  '주 진입로(아래)와 위쪽 갈래(위) 사이 옹벽의 윗부분: 위쪽 갈래 차도와 같은 높이로 이어지는 띠. 서쪽 변이 옹벽 면(곧은 선 x 201099.5~201101, Z03 차도 포장 띠의 동쪽 끝). 벽 높이 0(북) → 14 m(남). S-MAP 은 이 벽을 5~8 m 폭 비탈로 읽는다', 'S-MAP·사용자 핀(위쪽 갈래 높이), 추정(벽 면 자리 ±2 m, 띠가 화단인지 보도인지)')
S('eunju', 'CENTRAL-SOUTH', [(201099.5, 557205), (201114, 557205), (201109, 557188), (201099.5, 557190)], 'fit', PL, '가운데 옹벽 남쪽 끝(수인관 북서 모서리 앞): 한 경사면', 'S-MAP(높이), 추정(무엇인지 모름: 비탈·계단 구분 근거 없음)', clip=(126.5, 131.5))
S('eunju', 'EUNJU1-NW', [(201110, 557259), (201123, 557259), (201123, 557273), (201110, 557273)], 'fit', PV, '은주1관 북서 모서리 앞(한림관 1층 문 앞으로 오르는 포장): 차도(125.3)에서 동쪽으로 오르는 한 경사면. Z05 의 127.6 m 한 높이는 문 앞 사용자 핀 U060(126.1)보다 1.5 m 높았다(Z06)', 'S-MAP·사용자 핀 U060(높이), 추정(외곽)', clip=(125.2, 128.6),
  fitpoly=Polygon([(201110, 557262), (201120, 557262), (201120, 557273), (201110, 557273)]))
S('eunju', 'EUNJU1-WEST', [(201110, 557259), (201123, 557259), (201123, 557203), (201110, 557203)], {'origin': [201116.0, 557203.0], 'direction': [0.0, 1.0], 'points': [[0, 131.8], [45, 131.8], [56, 128.2]]}, PV, '은주1관 서쪽(위쪽 갈래와 건물 사이 보도·화단 띠, 입구(1) 131.3 m): 131.8 m 한 높이, 북쪽 끝 11 m 는 차도 높이로 내려가는 경사', 'S-MAP(높이), 원천(입구(1) 표지), 추정(외곽)')
S('eunju', 'EUNJU2-ENTRANCE', [(201118, 557207), (201127, 557214), (201200, 557152), (201191, 557143)], 132.2, PV, '은주2관 1층 로비 입구 앞(수인관 옥상 높이와 이어짐): 132.2 m 한 높이', '원천(입구(1) 표지: 1층 로비), S-MAP(132.0~132.9)')
S('eunju', 'EUNJU2-AREAWAY', [(201136, 557224), (201141, 557229.5), (201201, 557178), (201196, 557172)], 145.0, CO, '은주2관 운동장 쪽 벽 앞의 꺼진 틈: 한 높이(메시 143.0~146.8 m 의 가운데). 운동장 쪽 변은 낮은 담 자리', 'S-MAP(높이 범위), 추정(한 높이·폭)')
S('eunju', 'FIELD-WEST-EDGE', [(201134, 557222), (201152, 557222), (201152, 557302), (201134, 557302)], 148.9, PV, '운동장 서쪽 가장자리(은주1관 벽까지): 운동장 높이. 조금 높은 화단 띠는 상자', '확정(운동장 148.9), 추정(외곽)')
# --- 유담관 둘레 ---
S('turnaround', 'BUKAK-FRONT', [(201014, 557356), (201054, 557356), (201054, 557384), (201014, 557384)], 'fit', PV, '북악관 남서 벽 앞(포장면과 건물 사이)', EST)
S('yudam9', 'PLAZA-NORTH-EDGE', [(201044, 557226), (201080, 557226), (201080, 557252), (201044, 557252)], 114.1, PV, '분수 광장 북쪽 가장자리(광장 판과 유담관 벽 사이): 광장 높이 114.1 m', 'S-MAP(114.1), 추정(외곽)')
S('yudam9', 'V3-SOUTH-EDGE', [(201034, 557262), (201078, 557262), (201078, 557294), (201034, 557294)], 'fit', PV, '본관 앞 차도의 남쪽 가장자리(차도와 유담관 벽 사이)', EST)
S('yudam9', 'YUDAM-NORTH', [(201004, 557280), (201004, 557314), (201036, 557314), (201036, 557280)], 'fit', PV, '유담관 9층 쪽 앞마당 둘레(제2주차장 위)', EST)
S('yudam9', 'MAIN-WEST', [(201022, 557300), (201040, 557300), (201040, 557322), (201047, 557342), (201030, 557342)], 'fit', PV, '본관 서쪽 벽 앞(회차 공간 내리막과 본관 사이)', EST)
S('turnaround', 'WEST-EDGE', [(201006, 557303), (201022, 557303), (201022, 557342), (201006, 557342)], 'fit', PV, '회차 공간 내리막의 서쪽 가장자리(화단 띠와 차도 사이)', EST)
S('yudam9', 'TERRACE-SW', [(201004, 557264), (201004, 557254), (201011, 557247), (201036, 557230.5), (201043, 557226), (201047, 557232), (201047, 557241), (201012, 557266)], 129.2, PV,
  '유담관 9층 높이의 남서쪽 테라스(건물 덩어리 밖으로 나온 띠): 129.2 m 한 높이(메시 128.8~129.8). 남서쪽 변이 공도 위 벽면', 'S-MAP(높이), 추정(외곽)')
# --- 정문·남서쪽 공도 ---
S('gate', 'APRON', unary_union([Polygon([sw(112, 2), sw(205, 2), sw(205, 30), sw(112, 30)]), Polygon([(201083, 557183), (201104, 557183), (201104, 557148), (201090, 557148)])]), 'fit', PV, '정문 안 포장(정문 진입로·주차장 차로·주 진입로 사이와 수인관 벽까지): 한 경사면. 남서쪽 변이 공도 위 옹벽 면(곧은 선)',
  'S-MAP·사용자 핀(높이), 추정(외곽)', fitpoly=Polygon([sw(125, 5), sw(200, 5), sw(200, 22), sw(125, 22)]))
S('gate', 'STREET-SW', [sw(-6, -8), sw(205, -8), sw(205, 2), sw(112, 2), sw(112, 22), sw(-6, 22)],
  {'origin': [r2(SA[0]), r2(SA[1])], 'direction': [round(float(SU[0]), 4), round(float(SU[1]), 4)], 'points': [[-10, 95.0], [0, 93.8], [10, 92.7], [20, 92.2], [30, 92.0], [40, 92.7], [50, 93.5], [60, 94.3], [70, 95.1], [80, 96.0], [90, 96.6], [100, 97.6], [110, 98.5], [120, 99.3], [130, 100.2], [140, 101.2], [150, 102.0], [160, 102.5], [170, 103.3], [180, 104.0], [190, 105.2], [203, 106.9]]},
  AS, '캠퍼스 남서쪽 아래의 공도(유담관·분수 광장 옹벽 아래 ~ 정문 앞): 옹벽과 나란한 축을 따라 오르는 한 경사면(종단은 메시의 평평한 띠 값, 10 m 마디), 폭 방향 평평. 공연실습소가 이 길에 면한다. 캠퍼스 쪽 변은 광장 옹벽·유담관 벽·정문 안 포장의 옹벽',
  'S-MAP(종단), 추정(폭·축)', outside=True)
_v2 = LINES['V2'][np.argsort(LINES['V2'][:, 1])]; _ys = np.arange(557150, 557257, 6.0)
S('gate', 'ROAD-EAST-EDGE', [(201092, 557150), (201127, 557150), (201127, 557197), (201101, 557197), (201101, 557256), (201092, 557256)],
  {'origin': [201097.0, 557150.0], 'direction': [0.0, 1.0], 'points': [[r2(y - 557150), r2(np.interp(y, _v2[:, 1], _v2[:, 2]))] for y in _ys]}, PV,
  '주 진입로의 동쪽 가장자리(차도와 가운데 옹벽·수인관 벽 사이): 차도 종단과 같은 높이의 띠', 'S-MAP·사용자 핀(차도 종단, V02), 추정(외곽)')
S('eunju', 'SUIN-SOUTH-EDGE', [(201150, 557108), (201196, 557108), (201196, 557146), (201150, 557146)], 132.1, CO, '수인관 남동 가장자리(건물 덩어리와 캠퍼스 외곽 사이의 좁은 띠): 옥상 높이로 봄', '추정(S-MAP 128~132 m, 무엇인지 모름)')
S('gate', 'SEOGYEONG-RO', [sw(203, -8), sw(228, -8), sw(228, 16), sw(203, 16)], 'fit', AS, '정문 앞 서경로(캠퍼스 밖 공도, 남서쪽 공도의 축을 25 m 더 이은 네모): 한 경사면', 'S-MAP(높이), 추정(외곽)', outside=True,
  fitpoly=Polygon([sw(205, -6), sw(226, -6), sw(226, 12), sw(205, 12)]), clip=(105.5, 109.8))
# --- 혜인관·청운관 둘레: 운동장 높이의 평지 ---
S('cheongun', 'CHEONGUN-GROUND', [(201200, 557256), (201246, 557304), (201275, 557304), (201275, 557256)], 'med', PV, '청운관 둘레(남·동쪽): 한 높이', EST)
S('hyein', 'HYEIN-GROUND', [(201190, 557130), (201275, 557130), (201275, 557256), (201200, 557256), (201190, 557200)], 149.0, PV, '혜인관 둘레: 149.0 m 한 높이(메시 149.0~149.5). 남서쪽 끝은 수인관 옥상(132.1 m)과 벽면으로 만난다', EST)

# ---------- 자리 정하기: 앞의 것이 먼저 ----------
for h in HAND: h['poly'] = h['poly'].buffer(0)
acc = unary_union([DONE, FIELD]); out = []
for h in HAND:
    if h is not HAND[0]: h['poly'] = big(h['poly'].difference(HAND[0]['poly'])) if not h.get('road') else h['poly'].difference(HAND[0]['poly'])
    for i, p in enumerate(parts(h['poly'], 4)): out.append({**h, 'poly': p, 'name': h['name'] + ('' if i == 0 else f'-{chr(97 + i)}'), 'kind': 'hand'})
acc = unary_union([acc] + [h['poly'] for h in HAND]).buffer(0)
INSIDE = CAMPUS.buffer(2.0)
def top_of(s, poly):
    t = s['top']
    if t == 'med':
        zz, _, _ = M.inside(poly, inset=1.0); zz = zz if len(zz) > 5 else M.inside(poly)[0]; s['fitinfo'] = f'메시 {len(zz)}칸 가운데값(10~90 % {np.percentile(zz, 10):.1f}~{np.percentile(zz, 90):.1f} m)'; return round(float(np.median(zz)), 1)
    if t == 'fit':
        pr, sl, res, n = plane_profile(poly, cells_poly=s['fitpoly'], clip=s['clip']); s['fitinfo'] = f'메시 {n}칸에 맞춘 평면 하나: 경사 {sl:.1f} %, 맞춤 잔차 90 % {res:.2f} m'; return pr
    s['fitinfo'] = ''; return t
for s in SPEC:
    g = s['poly'].buffer(0).difference(acc).difference(UNDER)
    if not s['outside']: g = g.intersection(INSIDE)
    ps = [p.buffer(-0.75).buffer(0.75, join_style=2) for p in parts(g, 20)]; ps = [q for p in ps for q in parts(p, 20)]   # 0.6 m 보다 가는 꼬리는 뗀다
    if not ps: print('EMPTY', s['name']); continue
    main = max(ps, key=lambda q: q.area); s['top'] = top_of(s, main)
    for i, p in enumerate(sorted(ps, key=lambda q: -q.area)): out.append({**s, 'poly': p, 'name': s['name'] + ('' if i == 0 else f'-{chr(97 + i)}'), 'kind': 'spec'})
    acc = unary_union([acc] + ps).buffer(0)
PLATS = out
# 남은 작은 틈(60 ㎡ 미만)은 가장 길게 맞닿은 기단에 붙인다(같은 평면). 중립 바닥 조각이 남지 않게
gapg = CAMPUS.difference(acc).difference(DRAWN.buffer(-1.0)).buffer(-0.4).buffer(0.4)
for gp in parts(gapg, 6):
    if gp.area >= 60: continue
    best = max((q for q in PLATS if not q.get('road')), key=lambda q: gp.buffer(0.5).intersection(q['poly']).area)
    if gp.buffer(0.5).intersection(best['poly']).area > 0.5: best['poly'] = big(unary_union([best['poly'], gp.buffer(0.3)]).buffer(0).difference(unary_union([q['poly'] for q in PLATS if q is not best])).difference(UNDER))

# 벽면에서 틈이 없게: 낮은 기단을 더 높은 이웃 밑으로 0.5 m 넣고, 0.5 m 안의 빈 틈은 메운다(틈이 있으면 그 사이로 중립 바닥이 벽을 타고 올라가 뾰족한 흰 조각으로 보인다)
def _done_top(f): pr = f['properties']; return pr['topProfile'] if 'topProfile' in pr else pr['topM']
OTH = [(q['poly'], q['top'], q) for q in PLATS] + [(Polygon(f['geometry']['coordinates'][0]).buffer(0), _done_top(f), None) for f in DONE_F] + [(FIELD, 148.9, None)]
ALLU = unary_union([o[0] for o in OTH]).buffer(0); newp = []
for q in PLATS:
    ring = q['poly'].buffer(0.5); add = [ring.difference(ALLU)]
    for op, ot, oq in OTH:
        if oq is q or not ring.intersects(op): continue
        it = ring.intersection(op)
        if it.area < 0.05: continue
        c = it.representative_point()
        if float(top_z(ot, c.x, c.y)) > float(top_z(q['top'], c.x, c.y)) + 0.3: add.append(it)
    newp.append(big(unary_union([q['poly']] + add).buffer(0).difference(UNDER)))
for q, g in zip(PLATS, newp): q['poly0'] = q['poly']; q['poly'] = g   # poly0(겹치지 않는 외곽)은 지형 입력에, poly(이웃 밑으로 넣은 외곽)는 구조물 파일에

# ---------- 기단 피처 ----------
def low_around(poly):
    zz, _, _ = M.inside(poly.buffer(4.0)); c = np.array(poly.buffer(3.0).exterior.coords); tz = terr(c[:, 0], c[:, 1]); v = [float(np.nanmin(zz))] if len(zz) else []; return min(v + [float(tz.min())])
def carries(poly): return (not poly.buffer(-1.4).is_empty) and poly.area >= 16
feats = defaultdict(list); surf = []; summary = defaultdict(list)
for q in PLATS:
    zone, top, poly = q['zone'], q['top'], q['poly']; pid = f"Z05-{ABBR[zone]}-{q['name']}"; lo = top if not isinstance(top, dict) else min(p[1] for p in top['points'])
    terrain = carries(q['poly0']); bottom, note = q.get('bottom'), q.get('bottomNote')
    if bottom is None: bottom = round(min(lo, low_around(poly)) - 1.0, 1); note = '둘레 4 m 안 S-MAP 지면·지형의 가장 낮은 값보다 1 m 아래(옆 기단의 윗면보다 아래로 내려 틈이 없게)'
    ass = q['assumption'] if q['kind'] == 'hand' else q['what'] + ('. ' + q['fitinfo'] if q['fitinfo'] else '')
    src = q['source'] if q['kind'] == 'hand' else MESH + ', 구역 노트'
    pr = {'id': 'Z05-PLATFORM-' + pid[4:], 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': q['grade'], 'surfaceName': pid if terrain else '없음(폭이 좁아 지형에 싣지 않음)', 'bottomM': bottom, 'bottomNote': note,
          'material': q['material'], 'assumption': ass, 'source': src}
    if isinstance(top, dict): pr['topProfile'] = top
    else: pr['topM'] = top
    gm = geom(poly); feats[zone].append({'type': 'Feature', 'properties': pr, 'geometry': gm}); q['id'] = pr['id']; q['terrain'] = terrain
    if terrain:
        sp = {'name': pid, 'srid': 5186, 'reason': q['reason'] if q['kind'] == 'hand' else 'Z05 ' + q['what'].split(':')[0], 'grade': q['grade'], 'source': src}
        if isinstance(top, dict): sp['profile'] = top
        else: sp['heightM'] = top
        surf.append((lo, {'type': 'Feature', 'properties': sp, 'geometry': geom(q['poly0'])}))
    summary[zone].append({'id': pr['id'], 'what': ass.split(':')[0], 'top': top if not isinstance(top, dict) else [top['points'][0][1], top['points'][-1][1]], 'area': round(poly.area, 1), 'grade': q['grade'], 'material': q['material'], 'terrain': terrain, 'kind': q['kind']})
def ground(x, y):
    """그 자리 기단 윗면 높이(없으면 None). 겹치면 높은 쪽."""
    p = Point(x, y); best = None
    for q in PLATS:
        if q['poly'].contains(p): v = float(top_z(q['top'], x, y)); best = v if best is None else max(best, v)
    return best

# ---------- 견줌: 기단 윗면과 S-MAP 메시 ----------
own = np.full(Z.shape, -1); topg = np.full(Z.shape, np.nan)
for i, q in enumerate(PLATS):
    m = contains_xy(q['poly'], XS, YS); t = top_z(q['top'], XS[m], YS[m]); better = ~(topg[m] > t); idx = np.nonzero(m); own[idx[0][better], idx[1][better]] = i; topg[idx[0][better], idx[1][better]] = t[better]
okc = M.g & np.isfinite(Z) & (own >= 0); RES = np.where(okc, topg - Z, np.nan)
for i, q in enumerate(PLATS):
    e = RES[(own == i) & okc]; q['res'] = (round(float(np.median(e)), 2), round(float(np.percentile(np.abs(e), 90)), 2), int(e.size)) if e.size else (None, None, 0)
if '--plan' in sys.argv:
    import canvas; outd = pathlib.Path(sys.argv[sys.argv.index('--plan') + 1]); only = sys.argv[sys.argv.index('--plan') + 2].split(',') if len(sys.argv) > sys.argv.index('--plan') + 2 else list(canvas.W)
    for k in only: canvas.draw(k, *canvas.W[k], outd / f'plan-{k}.png', plats=[q for q in PLATS if q['kind'] == 'spec'])
    for q in PLATS:
        if q['kind'] == 'spec': print(f"{q['id']:44s} {q['poly'].area:7.0f} m2 top {q['top'] if not isinstance(q['top'], dict) else [q['top']['points'][0][1], q['top']['points'][-1][1]]} res(med, p90, n) {q['res']} {q.get('fitinfo', '')[:60]}")
exec((HERE5 / 'write_out.py').read_text(encoding='utf-8'))
