"""G02: 내리막길(오르막길)의 기본 평면과 그 위에 얹는 구조물 상자를 만든다. DB·네트워크 접근 없음.
  python -I build_inputs.py
쓰는 파일:
  backend/data/terrain/recipes/g02-surface.geojson       기본 평면(지형 조리법의 surface 단계 입력)
  backend/data/terrain/recipes/g02-smooth-ground.json    조리법 = F05 조리법에서 UPHILL 띠 새김을 빼고 surface 단계를 더한 것
  frontend/public/structures/g02-way.geojson             구조물 상자(프런트 보정 레이어 형식: kind=extrude, fromM→toM)
  docs/audit/g02/model.json                              띠·가운데 선·평면·벽 선과 근거·등급
좌표는 길 축 (s, t) 로 적고 EPSG:5186 으로 옮긴다(common.py). 등급: 확정 / S-MAP / 추정.
"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
REPO = HERE.parents[2]; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
r2 = lambda v: round(float(v), 2)
def ring_xy(pts):
    p = [[r2(x), r2(y)] for x, y in pts]; return p + [p[0]]
def ring(st): return ring_xy([st_to_xy(s, t) for s, t in st])
def rect(s0, s1, t0, t1): return [(s0, t0), (s1, t0), (s1, t1), (s0, t1)]
PROFILE = {'origin': [float(O[0]), float(O[1])], 'direction': [float(U[0]), float(U[1])], 'points': [[s, z] for s, z in WAY_PROFILE]}
SRC_MESH = 'S-MAP 3D 뷰어 메시 0.5 m 판독(g02/smap-mesh-g02-way-05m-a~d.txt, 2026-10-11)'
dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}

# ---------- 1. 기본 평면 (지형이 싣는 것) ----------
T_S, T_N = -5.5, 17.5   # 본관 북벽(t=-4.9)과 북쪽 건물 벽 안쪽까지 덮는다(건물 칸은 조리법이 그대로 둔다)
planes = [
  dict(name='WAY', st=[(-3.42, T_S), (69.3, T_S), (69.3, -2.5), (101, -2.5), (101, -3), (113.2, -3), (112.6, -1), (108.3, 10), (107.5, T_N), (0, T_N), (0, 8.5), (0.65, 8.5)],   # 발치 선(Z06): s = −1.82 + 0.291 t, 길 평면과 회차 공간 포장면이 같은 높이인 직선
       profile=True, grade='S-MAP',
       reason='G02 내리막길 기본 경사면: 가운데 경사로의 S-MAP 높이에 맞춘 평면 조각 4개(폭 방향 평평). 본관 북벽에서 북쪽 건물 벽까지 한 평면. 아래 끝은 회차 공간 포장면(Z04 경사면, 이 자리 131.16 m), 위 끝은 운동장 148.9 m(F05 경계)에 벽 없이 닿는다.'),
  dict(name='LANE', st=rect(0, 31.5, 8.5, T_N), heightM=132.5, grade='S-MAP',
       reason='G02 북악관 동쪽 낮은 마당: S-MAP 132.4~132.9 m, 사용자 핀 U100 132.3·U102 132.5. 길 경사면과는 화단 상자와 벽면으로 만난다.'),
  dict(name='PODIUM', st=rect(31.5, 50, 6.5, T_N), heightM=138.8, grade='S-MAP',
       reason='G02 문예관 기단 테라스: S-MAP 138.7~138.8 m, 사용자 핀 U094·U096 138.8. 서쪽 끝은 낮은 마당 위 6.3 m 벽면.'),
  dict(name='FORK', st=rect(67, 76, 9, T_N), heightM=144.2, grade='S-MAP',
       reason='G02 갈림 지점 평탄면: S-MAP 143.6~144.2 m, 사용자 사진 8 의 144.2, 핀 U089 143.7.'),
  dict(name='TOP', st=rect(76, 93.3, 9.5, T_N), heightM=145.5, grade='S-MAP',
       reason='G02 대일관 서쪽 끝 앞 평탄부: S-MAP 145.3~145.8 m, 사용자 사진 8 의 145.4, 핀 U081·U085 145.6·U088 145.4. 동쪽 끝(s 93.3)에서 길 경사면과 같은 높이.'),
]
feats = []
for p in planes:
    props = {'name': p['name'], 'srid': 5186, 'reason': p['reason'], 'grade': p['grade'], 'source': SRC_MESH}
    if p.get('profile'): props['profile'] = PROFILE
    else: props['heightM'] = p['heightM']
    feats.append({'type': 'Feature', 'properties': props, 'geometry': {'type': 'Polygon', 'coordinates': [ring(p['st'])]}})
dump(REC / 'g02-surface.geojson', {'type': 'FeatureCollection', 'name': 'g02-surface', 'crs': CRS, 'features': feats})

f05 = json.loads((REC / 'f05-smooth-ground.json').read_text(encoding='utf-8'))
steps = json.loads(json.dumps(f05['steps']))
for s in steps:
    if s['type'] == 'corridor': s['lines'] = [l for l in s['lines'] if l != 'UPHILL']
steps.append({'type': 'surface', 'file': 'g02-surface.geojson'})
dump(REC / 'g02-smooth-ground.json', {'crs': 'EPSG:5186', 'protectBuildings': True,
  'reason': 'G02: F05 조리법에서 오르막 보행로 띠 새김(UPHILL, 아래 67 m·폭 9 m)을 빼고, 내리막길 전체(110 m)를 기본 평면으로 넣음: 경사면 하나(평면 조각 4개)와 평탄면 넷(북악관 동쪽 마당 132.5, 문예관 기단 138.8, 갈림 지점 144.2, 대일관 서쪽 끝 앞 145.5 m). 평면끼리는 번짐 없이 벽면으로 만난다. 계단·화단·옹벽은 지형이 아니라 구조물 파일(frontend/public/structures/g02-way.geojson)이 싣는다.',
  'steps': steps})

# ---------- 2. 구조물 상자 (지형 위에 얹는 것) ----------
STAIR_FOOT_S = json.loads((HERE.parent / 'z02' / 'model.json').read_text(encoding='utf-8'))['sideStairFootS']   # 대일관에서 내려오는 계단의 발치(z02/build_inputs.py 가 정함)
# G03(2026-10-12): 띠 경계를 네이버 거리뷰 지점 21(어귀에서 위로 본 앞면)과 S-MAP 정사 그림(0.1 m)으로 다시 잡음. 전부 추정 ±0.5 m
#   남쪽 옹벽 면 t −3.8(정사 그림의 벽 머릿돌 −4.7 ~ −3.8, 벽 뒤 화단이 보이게 0.4~0.8 m 길 쪽으로 둠) | 본관 쪽 보행 띠 2.2 m | 가운데 차로 4.2 m | 북쪽 띠 2.0 m | 북쪽 화단 벽 t 4.6(정사 그림 4.2~4.5)
S_WALL, S_PAVE, RAMP_N, STRIP_N = -3.8, -1.6, 2.6, 4.6
S_GATE = 16.4    # 차단기 선: 정사 그림의 흰 막대(s 16.3, t −1.7~1.7) = 거리뷰에서 아스팔트가 끝나고 블록 포장이 시작하는 선
S_WALL0 = 15.5   # 남쪽 옹벽이 시작하는 곳(거리뷰: 흡연장 끝 바로 뒤, 차단기 선보다 조금 앞. 정사 그림 16)
S_STEP0 = 27.6   # 계단식 보행 띠가 시작하는 곳(추정 ±3 m): 거리뷰 21 에서 차단기 뒤 북쪽 띠는 턱 없는 블록 포장이고 화단 셋째 단쯤에서 밝은 돌판으로 바뀜. 사진 21(문예관 기단 옆 계단 앞)에서는 이미 돌판 계단
boxes = []
def box(id, typ, rng, fromM, toM, assumption, source, grade='추정', basePlane='WAY', **extra):
    boxes.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra},
                  'geometry': {'type': 'Polygon', 'coordinates': [rng]}})
def prof(dz, s0, s1):   # 상자의 s 범위로 자른 종단(프런트는 종단의 가장 낮은 점이 bottomM 보다 높아야 기운 윗면으로 읽는다)
    ss_ = [s0] + [s_ for s_, _ in WAY_PROFILE if s0 < s_ < s1] + [s1]
    return {**PROFILE, 'points': [[r2(s_), r2(way_z(s_) + dz)] for s_ in ss_]}
def pbox(id, typ, st, dz, assumption, source, bottom=None, thick=None, grade='추정', **extra):
    """윗면이 길 경사면과 나란한 상자(경사면 + dz). bottom 을 주면 그 높이까지 내린 벽, thick 을 주면 그 두께의 기운 판."""
    s0 = min(s_ for s_, _ in st); s1 = max(s_ for s_, _ in st)
    pr = {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': 'WAY', 'fromM': r2(way_z(s0) + dz - (thick or 0)) if bottom is None else r2(bottom), 'toM': r2(way_z(s1) + dz), 'topProfile': prof(dz, s0, s1), 'assumption': assumption, 'source': source, **extra}
    if thick: pr['thicknessM'] = thick
    else: pr['bottomM'] = r2(bottom)
    boxes.append({'type': 'Feature', 'properties': pr, 'geometry': {'type': 'Polygon', 'coordinates': [ring(st)]}})
def tree(id, s_, t_, z, what, src, base):
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.16, 0.0, 3.4), ('CROWN', 'foliage', 1.15, 3.2, 4.3), ('TOP', 'foliage', 0.65, 4.3, 5.2)):
        box(f'{id}-{part}', 'tree', ring(rect(s_ - h, s_ + h, t_ - h, t_ + h)), z + z0, z + z1, f'{what}: 화단을 따라 고르게 둔 단순한 소나무(줄기 0.36 m 각, 잎 덩어리 둘, 전체 5.3 m). 그루 수·자리·모양은 실제가 아니다', src, grade='확정(나무 줄이 있음: 사진), 추정(그루 수·자리·크기)', basePlane=base, material=mat)
PH = '사용자 사진 20·21·26·31, 거리뷰 09, SKU 영상 0:52~1:00, DAKNAT 영상 3:12~3:24·5:21~5:35'
SV21 = '네이버 거리뷰 지점 21(2025-02-11, 사용자-오르막길-20261012/01·02), S-MAP 정사 그림 g02/smap-ortho-rectified-01m.png'
ZS = [p[1] for p in WAY_PROFILE]; SS = [p[0] for p in WAY_PROFILE]
LANE = '#9c9b95'     # Q01: 마른 날 사진의 옅은~중간 회색(사진 21·26 의 중간 회색과 사용자 사진 02 의 밝은 회색 사이). 가운데 차도의 블록 포장(마른 날: 사진 21·26. 거리뷰 21 은 눈 녹은 물에 젖어 더 짙다). 전 구간 고리 무늬(사용자 확정 2026-10-12)
DARK = '#70747a'   # 북쪽 계단식 화단의 짙은 회색 화강석(거리뷰 21, 사진 21·18)
# 바닥 칠(두께 3 cm 의 기운 판, 길 면 위에 그려진다): 어귀의 아스팔트, 차단기부터 짙은 회색 블록 포장의 가운데 차로, 양쪽 띠
pbox('G03-PAINT-APRON', 'wall', [(-3.3, -4.9), (S_GATE, -4.9), (S_GATE, STRIP_N), (14.3, STRIP_N), (14.3, 8.5), (0.7, 8.5)], 0.05, '어귀의 아스팔트: 회차 공간의 검은 아스팔트가 차단기 선까지 이어진다(북쪽은 둥근 화단 앞까지)', SV21, thick=0.03, grade='원천(거리뷰 21), 추정(차단기 선 ±1 m)', color='#26282b')
pbox('G03-PAINT-LANE-1', 'wall', rect(S_GATE, 69.3, S_PAVE, RAMP_N), 0.05, '가운데 차로(공사 차량만 다님: 확정): 짙은 회색 무늬 블록, 폭 4.2 m(차단기 막대 3.4 m + 말뚝 둘)', SV21 + ', 사진 21', thick=0.03, color=LANE, pattern='rings')
pbox('G03-PAINT-LANE-2', 'wall', [(69.3, S_PAVE), (73.3, -0.9), (101.0, -0.9), (106.0, 0.5), (106.0, RAMP_N), (69.3, RAMP_N)], 0.05, '가운데 차로 윗구간(본관을 지난 뒤, 한림관 쪽 난간 벽이 t −2.5 로 들어온 만큼 좁아짐)', '사진 26, 정사 그림', thick=0.03, color=LANE, pattern='rings')
# 양쪽 인도(사용자 확정 2026-10-12: "차도를 두고 양쪽 다 인도", "양쪽 모두 약간 턱 있는 인도, 계단 아님"): 길과 나란히 오르는 판, 차도보다 KERB 만큼 높고 차도 쪽에 밝은 경계석 줄
KERB = 0.12        # 턱 높이(추정 0.10~0.15)
STRIP_END = 105.0  # 은주1관 북쪽 끝 옆(사용자 확정 2026-10-11: 띠는 차단기에서 은주관 바로 옆까지)
SIDEWALK, KERBSTONE = '#b6b4ac', '#4f5154'   # 인도는 차도보다 밝은 포장(고리 무늬), 차도와 인도 사이는 짙은 띠(사용자 사진 02)
WALKS = {  # 이름: (인도 외곽, 경계석 줄 외곽, 무엇)
  'S1': (rect(S_WALL0, 69.3, S_WALL, S_PAVE), rect(S_WALL0, 69.3, S_PAVE - 0.25, S_PAVE), '본관 쪽 인도: 옹벽 발치에서 차도까지 폭 2.2 m(거리뷰 21 에서 말뚝 둘 바깥 ~ 옹벽)'),
  'S2': ([(69.3, -2.2), (101.0, -2.2), (105.0, -1.0), (101.0, -0.9), (73.3, -0.9), (69.3, S_PAVE)], [(69.3, S_PAVE - 0.25), (73.3, -1.15), (101.0, -1.15), (101.0, -0.9), (73.3, -0.9), (69.3, S_PAVE)], '본관 쪽 인도 윗구간(한림관 쪽 난간 벽 안쪽, 은주관 옆까지), 폭 1.3 m(추정). 본관을 지나며 4 m 에 걸쳐 안으로 들어옴'),
  'N1': (rect(S_GATE, STRIP_END, RAMP_N, STRIP_N), rect(S_GATE, STRIP_END, RAMP_N, RAMP_N + 0.25), '북악관·문예관 쪽 인도: 차도에서 화단 벽까지 폭 2.0 m(거리뷰 21 에서 차단기 기둥 ~ 화단 벽)'),
}
for nm, (ring_st, kerb_st, what) in WALKS.items():
    pbox(f'G03-SIDEWALK-{nm}', 'wall', ring_st, KERB, what + f'. 차도보다 {KERB} m 높은 턱(추정 0.10~0.15), 길과 같은 기울기, 차도보다 밝은 블록 포장. 계단이 아니다(사용자 확정). 사진 21·31·전경 18 에는 문예관 쪽 띠가 넓적한 돌판 단으로 보이나 사용자 확정을 따른다', SV21 + ', 사진 21·26, 사용자 답 2026-10-12', thick=KERB + 0.02, grade='확정(양쪽 인도, 약간 턱, 계단 아님, 고리 무늬: 사용자 2026-10-12), 추정(폭·턱 높이)', color=SIDEWALK, pattern='rings')
    pbox(f'G03-KERB-{nm}', 'wall', kerb_st, KERB + 0.01, '차도와 인도 사이의 짙은 띠(턱, 폭 0.25 m): 사용자 사진 02', SV21 + ', 사용자-오르막길-20261012/02', thick=KERB + 0.03, color=KERBSTONE)
# 남쪽(본관 쪽): 허리 높이의 밝은 돌 옹벽 한 줄(윗선이 길 경사와 나란함) + 그 뒤 좁은 화단 띠와 소나무 줄. 본관으로 통하는 문 앞은 비움
for nm, (a, b) in {'A': (S_WALL0, 59.2), 'B': (63.4, 69.3)}.items():
    pbox(f'G03-SWALL-{nm}', 'wall', rect(a, b, S_WALL - 0.25, S_WALL), 0.95, '본관 쪽 옹벽: 밝은 거친 돌판을 세워 붙인 허리 높이 벽(길 + 0.95 m, 추정 0.9~1.1: 거리뷰에서 지나가는 사람 허리), 윗선은 길과 나란히 오름, 두께 0.25 m. 흡연장 끝 바로 뒤(s 15.5)에서 시작. s 59.2~63.4 는 본관으로 통하는 문 앞이라 비움(자리 추정 ±3 m)', SV21 + ', ' + PH + ', SKU 0:58', bottom=way_z(a) - 0.3, color='#d6d1c2')
    pbox(f'G03-SBED-{nm}', 'planter', rect(a, b, -4.9, S_WALL - 0.25), 0.85, '옹벽 뒤 화단 띠(소나무·바위): 실제 폭은 약 2 m(벽 머릿돌에서 본관 벽까지)로 보이나 건물 외곽(처마 선, t −4.9)까지 0.85 m 만 둠', SV21 + ', ' + PH, bottom=way_z(a) - 0.3, color='#d6d1c2', topColor='#7f9a6b')
k = 0
for sc in np.arange(18.0, 68.5, 5.5):
    if 58.5 < sc < 64.0: continue
    k += 1; tree(f'G03-TREE-S{k:02d}', sc, -4.45, way_z(sc) + 0.85, '본관 쪽 화단 띠의 소나무 줄', SV21 + ', 사진 21·26', 'G03-SBED')
# 어귀 북쪽: 둥근 머리의 밝은 콘크리트 화단(차단기 기둥 바로 왼쪽), 그 앞의 노란 통. 그 뒤로 짙은 화강석 계단식 화단
box('G03-NPLANT-DRUM', 'planter', ring([(14.3, 5.6), (14.9, 4.75), (S_GATE + 0.2, STRIP_N), (S_GATE + 0.2, 8.5), (14.9, 8.4), (14.3, 7.6)]), min(132.5, way_z(14.3)) - 0.2, way_z(15.4) + 1.0, '어귀 왼쪽의 둥근 머리 화단(밝은 콘크리트 벽, 높이 약 1 m, 바위와 관목). 자리는 정사 그림의 화단 섬 서쪽 끝(s 14.5~16.5)', SV21, color='#c9c7c0', topColor='#7f9a6b')
box('G03-GRIT-BIN', 'barrier', ring(rect(13.2, 13.9, 4.3, 5.5)), way_z(13.2) - 0.1, way_z(13.5) + 0.8, '둥근 화단 앞의 노란 통(제설함), 1.2 × 0.7 × 0.8 m(눈대중)', SV21, color='#e2b320')
TIER = (31.5 - (S_GATE + 0.2)) / 4
for j in range(4):
    a = S_GATE + 0.2 + j * TIER; b = a + TIER
    box(f'G03-NPLANT-A{j + 1}', 'planter', ring(rect(a, b, STRIP_N, 8.5)), min(132.5, way_z(a)) - 0.2, way_z(b) + 0.5,
        f'북쪽 계단식 화단(북악관 동쪽 마당과 길 사이) {j + 1}단: 짙은 회색 화강석 벽, 단마다 윗면이 수평이고 {TIER:.1f} m 마다 한 단씩 오름(윗면 = 단의 위쪽 끝 길 높이 + 0.5 m: 아래쪽 끝에서 약 1.05 m). 관목과 소나무 줄. 단 길이는 눈대중(추정 3.5~5 m)', SV21 + ', ' + PH, color=DARK, topColor='#7f9a6b')
    tree(f'G03-TREE-NA{j + 1}', (a + b) / 2, 6.6, way_z(b) + 0.5, '북쪽 계단식 화단의 소나무 줄', SV21 + ', 사진 21', f'G03-NPLANT-A{j + 1}')
# 문예관 기단으로 오르는 옆 계단(s 31.5~34): 띠(t 4.6)에서 기단(138.8)까지
z0 = float(way_z(32.5)); nr = int(round((138.8 - z0) / 0.157)); run = 0.30
for k in range(nr):
    box(f'G02-PODIUM-STAIR-S{k + 1:02d}', 'stair_step', ring(rect(31.5, 34.0, STRIP_N + k * run, STRIP_N + (k + 1) * run)), z0 - 0.5, z0 + (k + 1) * (138.8 - z0) / nr,
        f'문예관 기단(138.8 m)으로 오르는 옆 계단: {nr}단 = (138.8 − {z0:.2f}) ÷ 0.157, 디딤 0.30 m, 폭 2.5 m(모두 가정). 자리는 정사 그림에서 화단이 끊기는 곳과 사진 21 의 가로등 옆 계단', '사용자 사진 21, SKU 0:54, g02/smap-ortho-rectified-01m.png', stair='G02-PODIUM-STAIR')
for j in range(4):
    a = 34.0 + j * 4.0; b = a + 4.0
    box(f'G03-NPLANT-B{j + 1}', 'planter', ring(rect(a, b, STRIP_N, 6.5)), way_z(a) - 0.2, way_z(b) + 0.5, '문예관 기단 앞의 계단식 화단: 짙은 회색 화강석, 4 m 마다 한 단(윗면 수평). 그 뒤는 기단(138.8 m)의 벽면', PH + ', ' + SV21, color=DARK, topColor='#7f9a6b')
    if j % 2 == 0: tree(f'G03-TREE-NB{j // 2 + 1}', (a + b) / 2, 5.55, way_z(b) + 0.5, '문예관 기단 앞 화단의 소나무', '사진 21·18', f'G03-NPLANT-B{j + 1}')
for j, a in enumerate(np.arange(50.0, 65.9, 5.34)):
    b = min(a + 5.34, 66.0)
    box(f'G03-NPLANT-C{j + 1}', 'planter', ring(rect(a, b, STRIP_N, 9.5)), way_z(a) - 0.2, way_z(b) + 1.2,
        '문예관 낮은 날개 앞 화단: 큰 짙은 화강석 상자에 관목과 소나무, 윗면 = 마디 위쪽 끝 경사면 + 1.2 m(S-MAP 이 +1~+2 m 로 읽힘, 사진 26·18 눈대중)', '사용자 사진 25·26, 전경 사진 18, ' + SRC_MESH, color=DARK, topColor='#7f9a6b')
    tree(f'G03-TREE-NC{j + 1}', (a + b) / 2, 7.0, way_z(b) + 1.2, '문예관 낮은 날개 앞 화단의 소나무', '사진 25·26, 전경 사진 18', f'G03-NPLANT-C{j + 1}')
# 갈림 계단(길 141.0 → 갈림 지점 144.2): 시험용 DB 길 040d4571 의 선을 따라 2 m 폭
fork = np.array([(201106.2, 557324.7), (201108.9, 557326.2), (201110.8, 557328.5), (201111.6, 557330.8), (201111.8, 557333.1)])
d = np.r_[0, np.cumsum(np.hypot(*np.diff(fork, axis=0).T))]
zb = float(way_z(xy_to_st(*fork[0])[0])); nr = int(round((144.2 - zb) / 0.16))
at = lambda q: np.array([np.interp(q, d, fork[:, 0]), np.interp(q, d, fork[:, 1])])
for k in range(nr):
    pa, pb = at(d[-1] * k / nr), at(d[-1] * (k + 1) / nr); v = (pb - pa) / np.hypot(*(pb - pa)); w = np.array([-v[1], v[0]])
    box(f'G02-FORK-STAIR-S{k + 1:02d}', 'stair_step', ring_xy([pa + w, pb + w, pb - w, pa - w]), zb - 0.3, zb + (k + 1) * (144.2 - zb) / nr,
        f'갈림 계단(문예관 3층 로비로 가는 옆 계단): {nr}단 = (144.2 − {zb:.2f}) ÷ 0.16, 폭 2 m(가정). 선은 사용자 그림 10 을 옮긴 시험용 DB 길 040d4571(±3 m)', '사용자 확정(오르막길 중간에 옆으로 빠지는 계단), 그림 10, 시험용 DB 길 040d4571', stair='G02-FORK-STAIR')
for a in np.arange(76.0, 91.9, 5.34):
    b = min(a + 5.34, 92.0)
    box(f'G02-NPLANT-D{int(round(a)):02d}', 'planter', ring(rect(a, b, STRIP_N, 9.5)), way_z(a) - 0.2, 145.5 + 0.45, '대일관 서쪽 끝 앞 평탄부(145.5 m)와 길 사이 화단: 짙은 화강석, 윗면 = 145.5 + 0.45 m(추정). 평면은 정사 그림의 나무 자리', '사용자 사진 8·25, 그림 11, g02/smap-ortho-rectified-01m.png', color=DARK, topColor='#7f9a6b')
    tree(f'G03-TREE-ND{int(round(a)):02d}', (a + b) / 2, 7.0, 145.95, '대일관 서쪽 끝 앞 화단의 소나무', '사진 25', f'G02-NPLANT-D{int(round(a)):02d}')
pbox('G02-HWALL', 'wall', rect(69.3, 101.0, -2.5, -2.2), 1.0, '한림관 쪽 가장자리 난간 벽: 윗선은 길과 나란히 오름(길 + 1.0 m), 두께 0.3 m, 선 자리 t = −2.5 는 S-MAP 이 꺼지기 시작하는 곳(±1.5 m). 모두 추정. 본관 쪽 인도는 이 벽 안쪽으로 은주관 옆까지 이어진다', '사용자 사진 25·26·30, 그림 11, 사용자 답 2026-10-11, ' + SRC_MESH, bottom=way_z(69.3) - 0.3, color='#d6d1c2')
# 본관 5층–한림관 3층 나무 데크: 학교 표지 "본관-한림관 연결통로"(201098.0, 557302.7) 자리. 위치 확정(사용자), 크기 추정
dk = np.array([201098.0, 557302.7]); dv = np.array([201112.0, 557295.0]) - dk; dv = dv / np.hypot(*dv); dw = np.array([-dv[1], dv[0]]) * 1.5
box('G02-DECK-MAIN-HANLIM', 'deck', ring_xy([dk - 1.8 * dv + dw, dk + 3.0 * dv + dw, dk + 3.0 * dv - dw, dk - 1.8 * dv - dw]), 137.5, 137.8,
    '본관 5층–한림관 3층 나무 데크: 윗면 137.8 m(추정, 범위 136.0~138.9) = 본관 5층 = 한림관 3층의 층 사슬 값(B11). 지하 보행 구간이 이 높이까지 계단·높이 차 없이 올라와 이어진다(사용자 확정 2026-10-11). 앞의 130.5 m 는 표지 자리 S-MAP 칸 값(평탄면이 아닌 좁은 틈, 덮인 길)이라 거둠(B11b). 두 건물 벽 사이에 걸린 판이고 아래 틈 바닥(Z05 기단)은 그대로. 두께 0.3 m, 길이 4.8 m, 폭 3 m 는 추정', '사용자 확정(그림 01-카카오위성-본관한림관-나무데크-위치, 학교 표지), 동 노트 본관·한림관 B11, docs/audit/b11/results.json', grade='확정(위치·보행 구간과 같은 높이), 추정(크기·높이 값)', basePlane='없음(두 건물 벽 사이에 걸린 판)')
# 북악관 정문: 광장 평면(130.6) 위. 바깥 계단 12단(확정) → 현관 바닥 132.9 → (안쪽 5단) 1층 134.1. 평면은 S-MAP 메시의 132~133 m 단과 시험용 DB 길 8f8c716f
BUKAK_FOOT = 131.39   # Z04: 회차 공간 경사면이 정문 계단 발치 (201041.7, 557360.5) 에서 갖는 높이(docs/audit/z04/model.json plaza.atBukakStairFoot)
PB = '거리뷰 10(북악관 정문 계단 2025-02), 사용자 확정(바깥 12단 + 안쪽 5단), ' + SRC_MESH + ', 시험용 DB 길 8f8c716f'
for k in range(12):
    box(f'G02-BUKAK-STAIR-S{k + 1:02d}', 'stair_step', ring(rect(-13.3, -4.3, 7.4 + k * 0.4, 7.4 + (k + 1) * 0.4)), 130.0, BUKAK_FOOT + (k + 1) * (132.9 - BUKAK_FOOT) / 12,
        '북악관 정문 바깥 계단: 12단(확정), 폭 9 m·디딤 0.4 m(거리뷰 눈대중). 맨 위 132.9 m(S-MAP). 발치 131.39 m = 회차 공간 경사면(Z04)이 이 자리에서 갖는 높이(S-MAP 131.4), 한 단 약 0.126 m', PB, basePlane='Z04-TURN-PLAZA', stair='G02-BUKAK-MAIN-STAIR', riseM=r2((132.9 - BUKAK_FOOT) / 12), runM=0.4, widthM=9.0)
box('G02-BUKAK-PORCH-FLOOR', 'landing', ring(rect(-14.3, -3.3, 12.2, 17.0)), 130.6, 132.9, '북악관 현관 바닥(돌출부): 132.9 m, 앞뒤 4.8 m·폭 11 m(추정)', PB, basePlane='Z04-TURN-PLAZA')
for k, sc in enumerate((-13.8, -8.8, -3.8)):
    box(f'G02-BUKAK-PORCH-PIER{k + 1}', 'wall', ring(rect(sc - 0.5, sc + 0.5, 12.3, 13.3)), 132.9, 137.6, '현관 아치 기둥(아치 둘 = 기둥 셋), 1 m 각, 높이 4.7 m(추정)', PB, basePlane='G02-BUKAK-PORCH-FLOOR', material='stone')
# Z06: 현관을 거리뷰 10 처럼(돌 벽에 아치 둘, 흰 처마 띠, 짙은 기와 모임지붕을 두 단 상자로). 치수는 전부 눈대중(추정)
for k, (ta, tb) in enumerate(((12.3, 13.3), (16.0, 17.0))):
    for j2, sc2 in enumerate((-14.3, -4.3)):
        box(f'G02-BUKAK-PORCH-SIDE-{k + 1}{j2 + 1}', 'wall', ring(rect(sc2, sc2 + 1.0, ta, tb)), 132.9, 137.6, '현관 옆면의 돌 기둥(옆면도 아치로 뚫려 있어 모서리 기둥만 세움), 추정', PB, basePlane='G02-BUKAK-PORCH-FLOOR', material='stone')
box('G02-BUKAK-PORCH-HEADER', 'wall', ring(rect(-14.3, -3.3, 12.3, 13.3)), 136.3, 137.6, '아치 위 돌 벽(아치 꼭대기 136.3 m = 바닥 + 3.4 m, 눈대중). 아치의 둥근 모양은 싣지 않음. 현수막 자리', PB, basePlane='없음(기둥 위)', material='stone')
for j2, sc2 in enumerate((-14.3, -4.3)):
    box(f'G02-BUKAK-PORCH-SIDE-HEADER-{j2 + 1}', 'wall', ring(rect(sc2, sc2 + 1.0, 13.3, 16.0)), 136.3, 137.6, '현관 옆면 아치 위 돌 벽, 추정', PB, basePlane='없음(기둥 위)', material='stone')
box('G02-BUKAK-PORCH-EAVE', 'canopy', ring(rect(-15.5, -2.1, 11.1, 17.0)), 137.6, 138.0, '현관 처마 띠(흰 돌), 벽보다 1.2 m 내밂(눈대중)', PB, basePlane='없음(벽 위)', material='stone')
box('G02-BUKAK-PORCH-CANOPY', 'canopy', ring(rect(-14.6, -3.0, 12.0, 17.0)), 138.0, 138.9, '현관 기와 모임지붕 아랫단(지붕 기울기를 두 단 상자로 줄임), 추정', PB, basePlane='G02-BUKAK-PORCH-EAVE', material='roof_tile')
box('G02-BUKAK-PORCH-CANOPY-2', 'canopy', ring(rect(-12.8, -4.8, 13.8, 17.0)), 138.9, 139.6, '현관 기와 모임지붕 윗단, 추정', PB, basePlane='G02-BUKAK-PORCH-CANOPY', material='roof_tile')
for nm, (sa, sb) in {'W': (-13.9, -13.3), 'E': (-4.3, -3.7)}.items():
    box(f'G02-BUKAK-STAIR-CHEEK-{nm}1', 'wall', ring(rect(sa, sb, 7.4, 9.8)), 130.6, 132.3, '계단 옆 벽(아래 반), 추정', PB, basePlane='Z04-TURN-PLAZA')
    box(f'G02-BUKAK-STAIR-CHEEK-{nm}2', 'wall', ring(rect(sa, sb, 9.8, 12.2)), 130.6, 133.4, '계단 옆 벽(위 반), 추정', PB, basePlane='Z04-TURN-PLAZA')
box('G02-BUKAK-PLANTER-E', 'planter', ring(rect(-3.3, 0.0, 9.0, 17.0)), 130.6, 132.5, '정문 동쪽 화단(화강석 벽 + 소나무): 윗면 132.5 m = 동쪽 마당 높이(S-MAP 132.2~132.9)', PB, basePlane='Z04-TURN-PLAZA')
box('G03-BARRIER-POST', 'barrier', ring(rect(S_GATE - 0.2, S_GATE + 0.2, RAMP_N - 0.4, RAMP_N)), way_z(S_GATE) - 0.1, way_z(S_GATE) + 1.05, '차단기 기둥(노란 상자 0.4 m 각, 높이 1.05 m): 차도의 문예관 쪽 가장자리(인도 턱 바로 앞)', SV21, grade='원천(거리뷰 21·정사 그림), 추정(자리 ±1 m)', color='#e0a41c')
box('G03-BARRIER-POST-CAP', 'barrier', ring(rect(S_GATE - 0.2, S_GATE + 0.2, RAMP_N - 0.4, RAMP_N)), way_z(S_GATE) + 1.05, way_z(S_GATE) + 1.2, '기둥 머리(회색)', SV21, color='#b9bbbd')
for j in range(6):
    box(f'G03-BARRIER-ARM-{j + 1}', 'barrier', ring(rect(S_GATE - 0.05, S_GATE + 0.05, RAMP_N - 3.8 + j * 3.4 / 6, RAMP_N - 3.8 + (j + 1) * 3.4 / 6)), way_z(S_GATE) + 0.95, way_z(S_GATE) + 1.05, '차단기 막대: 붉은·흰 띠, 길이 3.4 m(정사 그림), 가운데 차로만 막음', SV21, grade='원천(거리뷰 21·정사 그림)', color='#d9534a' if j % 2 == 0 else '#f1eee6')
for j, tc in enumerate((-1.1, -1.75)):
    for q, (za, zb, col) in enumerate(((0.0, 0.42, '#1d1f22'), (0.42, 0.56, '#e2b320'), (0.56, 0.78, '#1d1f22'))):
        box(f'G03-BOLLARD-{j + 1}-{q + 1}', 'barrier', ring(rect(S_GATE - 0.08, S_GATE + 0.08, tc - 0.08, tc + 0.08)), way_z(S_GATE) + za - (0.1 if q == 0 else 0), way_z(S_GATE) + zb, '막대 끝과 본관 쪽 띠 사이의 말뚝 둘(검정 바탕·노란 띠, 높이 0.78 m)', SV21, grade='원천(거리뷰 21)', color=col)
# 흡연장(P01 의 P01-SMOKING-BOOTH-* 를 옮겨 다시 만듦. 사용자 2026-10-12: "노란 박스는 흡연장", "높은 화단이랑 겹쳤다"): 본관 북서 모서리의 북쪽 벽에 붙은 노란 세로 살 상자.
# 자리는 거리뷰 21 의 앞면·오른쪽 면에서 다시 잡음(추정 ±1 m): 서쪽 끝 = 본관 벽 모서리(s 4.6), 동쪽 끝 s 14.0(그 바로 뒤 s 15.5 에서 옹벽이 시작), 앞면 t −3.4, 높이 한 층(3.0 m)
BS0, BS1, BT, BZ = 4.9, 14.0, -3.4, float(way_z(9.3))
SB = '사용자-네이버거리뷰-20261012/22-사용자표시-노란상자는-흡연장-X.webp·21-네이버거리뷰-면-r.jpg, 사용자-오르막길-20261012/01·02'
SG = '확정(노란 세로 살 상자 = 흡연장, 입구 아님: 사용자 2026-10-12), 원천(본관 북서 모서리의 북쪽 벽 앞: 거리뷰 21), 추정(자리 ±1 m, 길이 9.4 m·깊이 1.5 m·높이 3.0 m)'
box('G03-SMOKING-BOOTH', 'wall', ring(rect(BS0, BS1, -4.9, BT)), way_z(BS0) - 0.4, BZ + 3.0, '흡연장: 노란 세로 살로 싼 한 층 높이 상자, 본관 북쪽 벽에 붙어 섬. 길을 잇지 않는다', SB, grade=SG, color='#d39a2c')
for j in range(int((BS1 - BS0) / 0.5)):
    box(f'G03-SMOKING-BOOTH-SLAT-{j + 1:02d}', 'wall', ring(rect(BS0 + 0.15 + 0.5 * j, BS0 + 0.33 + 0.5 * j, BT, BT + 0.05)), way_z(BS0 + 0.5 * j) + 0.05, BZ + 3.0, '살 사이의 어두운 틈(세로 살로 읽히게)', SB, grade=SG, basePlane='G03-SMOKING-BOOTH', color='#8a6a1c')
box('G03-SMOKING-BOOTH-DOOR', 'wall', ring(rect(10.5, 12.7, BT, BT + 0.09)), way_z(10.5) + 0.05, BZ + 2.45, '들어간 어두운 문 판(왼쪽에 세로 살 문, 노란 원 표지)', SB, grade=SG, basePlane='G03-SMOKING-BOOTH', color='#35373a')
for q in range(4):
    za, zb = -0.26 + 0.13 * q, -0.26 + 0.13 * (q + 1); hw = (0.26 ** 2 - ((za + zb) / 2) ** 2) ** 0.5
    box(f'G03-SMOKING-BOOTH-SIGN-{q + 1}', 'wall', ring(rect(11.3 - hw, 11.3 + hw, BT + 0.09, BT + 0.13)), BZ + 1.75 + za, BZ + 1.75 + zb, '문 판의 노란 원 표지', SB, grade=SG, basePlane='G03-SMOKING-BOOTH-DOOR', color='#e3b322')
box('G03-SMOKING-BOOTH-NOTICE', 'wall', ring(rect(8.1, 10.2, BT, BT + 0.09)), BZ + 0.75, BZ + 2.45, '문 오른쪽의 어두운 알림 판', SB, grade=SG, basePlane='G03-SMOKING-BOOTH', color='#3d3d3f')
box('G03-SMOKING-BOOTH-MAP', 'wall', ring(rect(5.0, 7.6, BT, BT + 0.09)), BZ + 0.9, BZ + 2.2, '서쪽 끝 쪽의 캠퍼스 안내도 판', SB, grade=SG, basePlane='G03-SMOKING-BOOTH', color='#3d3d3f')
box('G03-SMOKING-BOOTH-INFO', 'wall', ring(rect(BS0 - 0.1, 6.0, -4.3, BT + 0.1)), BZ + 3.0, BZ + 3.6, '서쪽 끝 위의 ⓘ INFORMATION 판', SB, grade=SG, basePlane='G03-SMOKING-BOOTH', color='#4a4a4c')
boxes.append({'type': 'Feature', 'properties': {'id': 'G03-SMOKING-BOOTH-PLANTER', 'type': 'planter', 'kind': 'extrude', 'estimated': True, 'grade': '원천(거리뷰 22), 추정(외곽)', 'basePlane': 'WAY', 'fromM': 130.3, 'toM': 132.4, 'material': 'white_stone',
    'assumption': '흡연장의 회차 공간 쪽(모서리)의 낮은 돌 화단. P01 의 P01-SMOKING-BOOTH-PLANTER 에서 본관 서쪽 끝 북쪽 화단(P01-BONGWAN-WPLANTER-N)·흡연장과 겹치던 부분을 뺀 조각', 'source': SB}, 'geometry': {'type': 'Polygon', 'coordinates': [[[201045.35, 557346.12], [201045.73, 557346.96], [201046.55, 557346.18], [201045.95, 557344.95], [201045.35, 557346.12]]]}})
# ---------- 2c. SP 카페(대일관 서쪽 끝 아래층, 길 맨 위 평탄부 145.5 m 에 면함)와 그 앞 조각 돌 포장 ----------
# 근거: 사용자-SP카페·대일관계단·3생활관-20261012/01·02·03·05, 사진 25·26(카페 간판과 차양이 길 북쪽 붉은 벽돌 건물 아래층에 보임). 자리는 대일관 원천 외곽의 남쪽 벽(s 76.4~102.3)과 S-MAP 메시의 평탄부(145.3~145.5 m). 치수는 전부 사진 눈대중(추정)
CF = '사용자-SP카페·대일관계단·3생활관-20261012/01·02·03·05, 사용자 사진 25·26, 건물 원천 외곽(대일관), ' + SRC_MESH
CG = '확정(대일관 앞 SP 카페, 그 데크 끝 너머로 대일관에서 내려오는 계단: 사용자 2026-10-12), 원천(붉은 벽돌 아래층·데크·차양: 사진), 추정(자리 ±2 m·치수)'
ZT = 145.5
def tw(s_): return 16.2 + (17.1 - 16.2) * (s_ - 76.4) / (102.3 - 76.4)     # 대일관 남쪽 벽 선
def CR(s0, s1, d0, d1): return ring([(s0, tw(s0) - d0), (s1, tw(s1) - d0), (s1, tw(s1) - d1), (s0, tw(s0) - d1)])   # d = 벽에서 길 쪽으로 나온 거리
def cbox(id, typ, rng, z0, z1, what, **extra): box('G03-CAFE-' + id, typ, rng, z0, z1, what, CF, grade=CG, basePlane='TOP', **extra)
D0, D1, DD, DZ = 81.6, 92.0, 3.2, ZT + 0.45      # 데크: 벽을 따라 10.4 m, 깊이 3.2 m, 계단 3단(0.45 m) 위
cbox('ENTRANCE-GLASS', 'wall', CR(76.9, 80.3, 0.0, 0.08), ZT, ZT + 2.7, '왼쪽 유리문 출입구(어두운 유리 면, 폭 3.4 m)', color='#22262b')
cbox('SIGN', 'wall', CR(76.9, 80.3, 0.0, 0.1), ZT + 3.5, ZT + 4.7, '출입구 위의 어두운 간판 판("CAFE SP")', color='#2c2e33')
cbox('PIER', 'wall', CR(80.4, 80.95, 0.0, 0.35), ZT, ZT + 5.6, '출입구와 데크 사이의 붉은 벽돌 기둥', material='brick')
cbox('FRONT-GLASS', 'wall', CR(D0, D1, 0.0, 0.08), DZ, DZ + 2.6, '데크 뒤의 유리 벽(실제는 뒤로 물러나 있으나 건물 외곽 안쪽이라 벽 면에 어두운 유리 판으로만)', color='#22262b')
cbox('CLADDING', 'wall', CR(D0, D1, 0.0, 0.12), DZ + 3.0, DZ + 5.2, '차양 위의 짙은 가로 판 벽', color='#3b3e43')
cbox('DECK', 'deck', CR(D0, D1, 0.0, DD), ZT - 0.1, DZ, '짙은 나무 데크(바닥에서 0.45 m, 야외 탁자 자리)', color='#4b423b')
for k in range(2):
    cbox(f'DECK-STEP-{k + 1}', 'stair_step', CR(D0 - 0.3 * (2 - k), D0 - 0.3 * (1 - k), 0.0, DD), ZT - 0.1, ZT + 0.15 * (k + 1), '데크 서쪽 끝의 계단(3단: 0.15 m 씩, 맨 윗단이 데크 바닥)', stair='G03-CAFE-DECK-STAIR', riseM=0.15, runM=0.3, widthM=DD, color='#4b423b')
RAILC = '#565b63'
cbox('RAIL-S', 'wall', CR(D0 + 2.6, D1, DD - 0.06, DD), DZ, DZ + 1.0, '데크 길 쪽 세로 살 난간(높이 1.0 m). 사진 02 는 짙은 회색, 사진 03(다른 시기)은 붉은색', color=RAILC)
cbox('RAIL-E', 'wall', CR(D1 - 0.06, D1, 0.0, DD), DZ, DZ + 1.0, '데크 동쪽 끝 난간', color=RAILC)
cbox('RAIL-W', 'wall', CR(D0 + 2.6, D0 + 2.66, DD - 0.9, DD), DZ, DZ + 1.0, '데크 난간의 서쪽 끝(계단 옆은 트임)', color=RAILC)
for k, sc in enumerate((D0 + 2.6, D0 + 6.4, D1 - 0.1)):
    cbox(f'AWNING-POST-{k + 1}', 'wall', CR(sc - 0.04, sc + 0.04, DD - 0.1, DD - 0.02), DZ, DZ + 2.75, '긴 차양을 받치는 가는 기둥', color='#2f3136')
STRIPE = ('#d9627c', '#f3ece6')    # 분홍·흰 줄무늬(사진 01·02). 사진 03 은 붉은·초록
ns = int(round((D1 + 0.2 - (D0 - 0.3)) / 0.52))
for k in range(ns):
    a = D0 - 0.3 + k * (D1 + 0.5 - D0) / ns; b = D0 - 0.3 + (k + 1) * (D1 + 0.5 - D0) / ns
    cbox(f'AWNING-{k + 1:02d}', 'canopy', CR(a, b, 0.0, DD + 0.3), DZ + 2.75, DZ + 3.0, '데크 위의 긴 줄무늬 차양(상자 띠로 줄임, 기울기 없음)', color=STRIPE[k % 2])
for k in range(7):
    a = 76.7 + k * 3.8 / 7; b = 76.7 + (k + 1) * 3.8 / 7
    cbox(f'ENTRANCE-AWNING-{k + 1}', 'canopy', CR(a, b, 0.0, 1.5), ZT + 2.8, ZT + 3.3, '출입구 위의 줄무늬 차양', color=STRIPE[k % 2])
# 데크 끝과 계단 사이, 계단 왼쪽(건물 쪽): 돌 화단이 계단을 따라 한 단씩 오름. 둥근 관목(사진 02·03)
ZSTAIR = lambda s_: float(np.interp(s_, [STAIR_FOOT_S, 111.5], [way_z(STAIR_FOOT_S), 151.3]))
for k, (a, b) in enumerate(((92.6, 95.2), (95.2, 98.6), (98.6, 101.6))):
    t_s = 15.3 if b <= STAIR_FOOT_S else 16.0     # 계단 옆 단은 계단 북쪽 가장자리 밖으로
    top = (ZT + 0.9) if k == 0 else ZSTAIR(b) + 0.7
    cbox(f'PLANTER-{k + 1}', 'planter', ring([(a, t_s), (b, t_s), (b, tw(b) - 0.05 + (0.9 if a >= 94 else 0)), (a, tw(a) - 0.05 + (0.9 if a >= 94 else 0))]), ZT - 0.2, top, '데크 끝과 계단 사이의 밝은 돌 화단(둥근 관목, 계단을 따라 한 단씩 오름). 건물 벽이 물러난 자리(S-MAP 건물 칸 t 18)까지', color='#cfcbc0', topColor='#7f9a6b')
    for q, sc in enumerate(np.arange(a + 0.8, b - 0.6, 1.5)):
        cbox(f'SHRUB-{k + 1}-{q + 1}', 'tree', ring(rect(sc - 0.55, sc + 0.55, t_s + 0.3, t_s + 1.4)), top, top + 0.9, '화단의 둥글게 다듬은 관목(상자로 줄임)', material='foliage')
# 조각 돌 포장(여러 색의 깨진 돌판): 평탄부(145.5 m)와 계단 발치까지. 두께 2 cm 바탕 판 + 조각. 걷는 면은 그대로
rng_ = np.random.default_rng(20261012)
PV0, PV1 = 76.0, STAIR_FOOT_S
pave_ring = [(PV0, 9.5), (93.3, 9.5), (93.3, 10.6), (PV1, 10.6), (PV1, 15.3), (92.6, 15.3), (92.6, tw(92.6)), (PV0, tw(PV0))]
pbox('G03-CRAZY-PAVING-BASE-2', 'wall', [(93.3, 10.6), (PV1, 10.6), (PV1, 15.3), (93.3, 15.3)], 0.05, '조각 돌 포장의 줄눈 바탕(평탄부 동쪽, 계단 발치까지의 길 경사면 위)', CF, thick=0.03, grade=CG, color='#8f8a82')
box('G03-CRAZY-PAVING-BASE-1', 'wall', ring([(PV0, 9.5), (93.3, 9.5), (93.3, tw(93.3)), (PV0, tw(PV0))]), ZT + 0.02, ZT + 0.04, '조각 돌 포장의 줄눈 바탕(대일관 서쪽 끝 앞 평탄부 145.5 m)', CF, grade=CG, basePlane='TOP', color='#8f8a82')
COL = ('#b9b3a8', '#c8bfae', '#a8a39b', '#b7a79a', '#9c9a97', '#c2b9b0')
nk = 0
for a in np.arange(PV0 + 0.1, 93.2, 0.62):
    for t0 in np.arange(9.6, 16.4, 0.58):
        if a + 0.6 > D0 - 0.7 and t0 + 0.55 > tw(a) - DD - 0.05: continue     # 데크·데크 계단 자리
        if t0 + 0.55 > tw(a) - 0.1: continue
        j = rng_.uniform(-0.09, 0.09, (4, 2)); q = [(a + 0.04 + j[0, 0], t0 + 0.04 + j[0, 1]), (a + 0.56 + j[1, 0], t0 + 0.04 + j[1, 1]), (a + 0.56 + j[2, 0], t0 + 0.52 + j[2, 1]), (a + 0.04 + j[3, 0], t0 + 0.52 + j[3, 1])]
        nk += 1; box(f'G03-CRAZY-PAVING-{nk:03d}', 'wall', ring(q), ZT + 0.04, ZT + 0.055, '조각 돌 포장의 돌판 하나(자리·모양은 무늬를 내려고 흩은 것)', CF, grade=CG, basePlane='TOP', color=COL[int(rng_.integers(len(COL)))])
# ---------- 2d. 길 가운데의 학교 로고(큰 짙은 나뭇잎)와 글자 "SEOKYEONG UNIVERSITY" ----------
# 근거: 사용자-오르막길-20261012/02(위에서 내려다본 옛 사진: 고리 무늬, 나뭇잎, 그 아래쪽 글자), 사진 31(아래에서 올려다봄: 글자가 길을 따라 두 줄, 남쪽 줄 SEOKYEONG·북쪽 줄 UNIVERSITY, 위쪽 끝이 S).
# 자리(추정 ±8 m): 사진 02 에서 나뭇잎이 문예관 3층 옆 계단(s 62~70) 옆, 글자는 그 아래. 방향: 글자는 문예관 쪽 인도에서 본관 쪽을 보며 읽는 방향(사진 31 판독. 색인의 "올라오며 읽는 방향" 옮겨 적은 글과 다름: 사진이 있는 쪽을 따름)
from shapely.geometry import Polygon as _SP, LineString as _LS
from shapely.ops import unary_union as _uu
INK = '#4a4c50'
LG = '확정(길 가운데 학교 로고와 글자, 전 구간 고리 무늬: 사용자 2026-10-12), 추정(자리 ±8 m·크기·모양)'
LS_ = '사용자-오르막길-20261012/02-오르막길-하행-링무늬-로고-옛사진.jpg, 사용자 사진 31'
def ppoly(id, geom_st, dz, thick, what, color):
    geom_st = geom_st.simplify(0.003)   # 한 줄에 놓인 꼭짓점을 걷는다(좌표를 cm 로 맞추면 실 같은 조각이 생겨 덩어리가 안 닫힌다)
    for q, g in enumerate(getattr(geom_st, 'geoms', [geom_st])):
        if g.is_empty or g.area < 0.004: continue
        xs = [c[0] for c in g.exterior.coords]; s0, s1 = min(xs), max(xs)
        rings = [ring(list(r.coords)[:-1]) for r in [g.exterior, *g.interiors]]
        boxes.append({'type': 'Feature', 'properties': {'id': id if q == 0 else f'{id}-{q + 1}', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': LG, 'basePlane': 'WAY', 'fromM': r2(way_z(s0) + dz - thick), 'toM': r2(way_z(s1) + dz),
            'topProfile': prof(dz, s0, s1), 'thicknessM': thick, 'assumption': what, 'source': LS_, 'color': color}, 'geometry': {'type': 'Polygon', 'coordinates': rings}})
A0, A1 = np.array([70.0, 1.7]), np.array([60.3, -0.7])      # 잎자루 쪽 끝(위·문예관 쪽) → 잎 끝(아래·본관 쪽), 길이 10 m. Q01: 차도 폭(4.2 m)을 거의 채우게(사진 02: 잎이 양쪽 짙은 띠에 닿을 듯)
ax = (A1 - A0) / np.hypot(*(A1 - A0)); nx_ = np.array([-ax[1], ax[0]]); LL = float(np.hypot(*(A1 - A0)))
aa = np.linspace(0, 1, 28); hw = 1.8 * np.sin(np.pi * aa) ** 0.7 * (1 - 0.25 * aa)
leaf = _SP([tuple(A0 + ax * LL * a + nx_ * w) for a, w in zip(aa, hw)] + [tuple(A0 + ax * LL * a - nx_ * w * 0.92) for a, w in zip(aa[::-1], hw[::-1])]).buffer(0)
stem = _LS([tuple(A0 + ax * 0.6), tuple(A0 - ax * 0.8 + nx_ * 0.1), tuple(A0 - ax * 1.7 - nx_ * 0.25), tuple(A0 - ax * 2.3 - nx_ * 0.75)]).buffer(0.17)
rib = _LS([tuple(A0 + ax * 0.7), tuple(A0 + ax * LL * 0.9)]).buffer(0.06)
veins = _uu([_LS([tuple(A0 + ax * 1.6), tuple(A0 + ax * 2.4 + nx_ * 0.9)]).buffer(0.045), _LS([tuple(A0 + ax * 1.2), tuple(A0 + ax * 2.3 - nx_ * 0.8)]).buffer(0.045)])
ppoly('G03-LOGO-LEAF', _uu([leaf, stem]).difference(_uu([rib, veins])), 0.065, 0.015, '학교 로고의 큰 짙은 나뭇잎(길이 약 9 m, 폭 약 3 m: 차도 폭을 거의 채움)과 잎자루. 가운데 잎맥은 비워 둠. 모양은 사진 02 를 눈으로 옮긴 것', INK)
FONT = {'S': '01111 10000 10000 01110 00001 00001 11110', 'E': '11111 10000 10000 11110 10000 10000 11111', 'O': '01110 10001 10001 10001 10001 10001 01110', 'K': '10001 10010 10100 11000 10100 10010 10001', 'Y': '10001 10001 01010 00100 00100 00100 00100', 'N': '10001 11001 10101 10101 10011 10001 10001',
        'G': '01110 10001 10000 10111 10001 10001 01110', 'U': '10001 10001 10001 10001 10001 10001 01110', 'I': '11111 00100 00100 00100 00100 00100 11111', 'V': '10001 10001 10001 10001 01010 01010 00100', 'R': '11110 10001 10001 11110 10100 10010 10001', 'T': '11111 00100 00100 00100 00100 00100 00100'}
# Q01: 글자 줄은 길을 가로질러 놓인다: 한 줄 길이 ≈ 차도 폭(사용자 가까이 사진 (나), 색인.md). 아래에서 올라오며 읽는 방향(글자 머리가 위쪽, 왼쪽이 문예관 쪽). 나뭇잎 바로 아래에 SEOKYEONG, 그 아래에 UNIVERSITY(사진 02)
T_HI, T_LO = RAMP_N - 0.25, S_PAVE + 0.25
for word, s_top, hgt in (('SEOKYEONG', 58.6, 1.5), ('UNIVERSITY', 56.6, 1.0)):
    adv = (T_HI - T_LO) / len(word); cw = adv / 6; ch = hgt / 7
    for i, c_ in enumerate(word):
        cells = [_SP([(s_top - (row + 1) * ch, T_HI - i * adv - (col + 1) * cw), (s_top - row * ch, T_HI - i * adv - (col + 1) * cw), (s_top - row * ch, T_HI - i * adv - col * cw), (s_top - (row + 1) * ch, T_HI - i * adv - col * cw)]) for row, bits in enumerate(FONT[c_].split()) for col, b_ in enumerate(bits) if b_ == '1']
        ppoly(f'G03-LOGO-TEXT-{word}-{i + 1:02d}', _uu(cells).buffer(0), 0.065, 0.015, f'바닥 글자 "{word}"의 {c_}: 5 × 7 칸 글꼴(실제는 굵은 세리프체), 글자 높이 {hgt} m, 줄 길이 {T_HI - T_LO:.1f} m ≈ 차도 폭. 길을 가로질러 놓이고 올라오며 읽는다(방향은 사용자 확인 대기)', INK)
# ---------- 2b. 기단(땅 덩어리): 기본 평면을 구조물로. 지형 조리법의 surface 입력(g02-surface.geojson)은 이 정의에서 나온 것과 같다 ----------
BOTTOM = {'WAY': 125.0, 'LANE': 128.0, 'PODIUM': 132.5, 'FORK': 139.0, 'TOP': 139.0}
BOTTOM_WHY = {'WAY': '지하 차도 바닥(128.5 m)보다 아래의 안전 깊이. 지하 차도 자리는 G02-VOID-UNDERGROUND-ROAD 가 비운다', 'LANE': '옛 지형 최저보다 아래의 안전 깊이', 'PODIUM': '서쪽 낮은 마당 높이(132.5 m)', 'FORK': '옆 길 경사면(141 m)보다 아래', 'TOP': '옆 길 경사면(142.6 m)보다 아래'}
platforms = []
for p, f in zip(planes, feats):
    pr = {'id': 'G02-PLATFORM-' + p['name'], 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': p['grade'] + '(윗면 높이), 추정(외곽 ±1~1.5 m, 바닥)', 'surfaceName': p['name'],
          'bottomM': BOTTOM[p['name']], 'bottomNote': BOTTOM_WHY[p['name']], 'material': 'paving', 'assumption': '외곽은 S-MAP 0.5 m 메시에서 높이가 바뀌는 선과 건물 외곽. 건물 평면과 겹치는 곳은 건물이 우선', 'source': SRC_MESH + ', ' + p['reason']}
    if p.get('profile'): pr['topProfile'] = PROFILE
    else: pr['topM'] = p['heightM']
    platforms.append({'type': 'Feature', 'properties': pr, 'geometry': f['geometry']})
plaza = [x for x in json.loads((REC / 'f05-plateaus.geojson').read_text(encoding='utf-8'))['features'] if x['properties']['name'] == 'plaza'][0]
platforms.append({'type': 'Feature', 'properties': {'id': 'G02-PLATFORM-PLAZA', 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': '확정(한 포장면, 사용자 그림 11), S-MAP·사용자 핀(130.6 m)', 'surfaceName': 'plaza (f05-plateaus.geojson)',
    'topM': plaza['properties']['heightM'], 'bottomM': 126.0, 'bottomNote': '지하 차도·통로(128.5 m)보다 아래의 안전 깊이', 'material': 'paving', 'assumption': '외곽은 T06·F05 조리법의 포장면 다각형 그대로(다시 그리지 않음)', 'source': 'backend/data/terrain/recipes/f05-plateaus.geojson (T06)'}, 'geometry': plaza['geometry']})
# 지하 차도: 길 경사면 기단 아래의 빈 곳. 바닥은 시험용 DB 길 951c157d 의 높이, 천장은 위 기단 윗면 − 0.6 m(슬래브 두께 가정)
ug = np.array([(201053.9, 557349.2, 128.5), (201056.2, 557348.2, 128.6), (201081.2, 557336.5, 132.2), (201100.3, 557327.6, 136.4)])
voids = []
for k in range(len(ug) - 1):
    for q in range(4):
        pa = ug[k] + (ug[k + 1] - ug[k]) * q / 4; pb = ug[k] + (ug[k + 1] - ug[k]) * (q + 1) / 4; v = (pb - pa)[:2]; v = v / np.hypot(*v); w = np.array([-v[1], v[0]]) * 3.6
        zc = float(way_z(xy_to_st((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)[0])) - 0.6
        voids.append({'type': 'Feature', 'properties': {'id': f'G02-VOID-UNDERGROUND-ROAD-{k}{q}', 'type': 'void', 'kind': 'void', 'estimated': True, 'grade': '확정(위 길보다 한 층 아래 지하 차도가 나란히 있음), 추정(선·폭·높이)',
            'fromM': r2(min(pa[2], pb[2])), 'toM': r2(zc), 'inside': 'G02-PLATFORM-WAY', 'assumption': '바닥 = 시험용 DB 길 951c157d 높이(추정), 폭 7.2 m(그림에서 4.1 m 로도 읽힘), 천장 = 길 경사면 − 0.6 m(슬래브 두께 가정). 남는 높이 %.1f m' % (zc - max(pa[2], pb[2])),
            'source': '사용자 확정(지하 차도), 그림 14, 시험용 DB 길 951c157d'}, 'geometry': {'type': 'Polygon', 'coordinates': [ring_xy([pa[:2] + w, pb[:2] + w, pb[:2] - w, pa[:2] - w])]}})
_fork = _uu([_SP(f['geometry']['coordinates'][0]) for f in boxes if f['properties']['id'].startswith('G02-FORK-STAIR-')]).buffer(0.02)
for f in boxes:   # 인도 판·턱 띠는 문예관 3층 옆 계단의 발치 자리를 비운다(겹침 없게)
    if f['properties']['id'] in ('G03-SIDEWALK-N1', 'G03-KERB-N1'):
        g = _SP(f['geometry']['coordinates'][0]).difference(_fork); g = max(getattr(g, 'geoms', [g]), key=lambda q: q.area)
        f['geometry']['coordinates'] = [[[r2(x), r2(y)] for x, y in r.coords] for r in [g.exterior, *g.interiors]]
boxes = [f for f in platforms if f['properties']['id'] != 'G02-PLATFORM-PLAZA'] + voids + boxes   # Z04: 포장면 기단은 z04-turnaround.geojson 의 한 경사면(Z04-PLATFORM-TURN-PLAZA)으로 옮김
STRUCT = REPO / 'frontend' / 'public' / 'structures' / 'g02-way.geojson'; STRUCT.parent.mkdir(exist_ok=True)
dump(STRUCT, {'type': 'FeatureCollection', 'name': 'g02-way', 'crs': CRS,
  'provenance': {'builder': 'docs/audit/g02/build_inputs.py', 'basePlanes': 'backend/data/terrain/recipes/g02-surface.geojson', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '모든 상자는 기본 평면 위에 얹힌다. 치수는 사진 눈대중이라 전부 estimated.'},
  'features': boxes})

# ---------- 3. 모델 요약(띠·가운데 선·벽 선) ----------
def line(st, zf): return [[*[r2(c) for c in st_to_xy(s_, t_)], r2(zf(s_))] for s_, t_ in st]
ss = [0, 5, 10, 20, 30, 40, 55, 67, 76, 85, 93.3, 100, 110]
strips = [
  dict(id='south_planter', t=[-4.9, S_WALL], s=[S_WALL0, 69.3], top='경사면 + 0.95 m(옹벽), + 0.85 m(화단)', grade='추정', carried_by='구조물'),
  dict(id='south_sidewalk', t=[S_WALL, S_PAVE], s=[S_WALL0, 105], note='본관을 지난 s 69.3 부터는 t −2.2~−0.6 (추정)', top=f'경사면 + {KERB} m(약간 턱 있는 인도)', grade='확정(인도, 약간 턱: 사용자 2026-10-12), 추정(폭·턱 높이)', carried_by='구조물(기운 판)'),
  dict(id='ramp', t=[S_PAVE, RAMP_N], s=[0, 110], top='경사면', grade='S-MAP(높이), 추정(폭 4.2 m)', carried_by='지형(경사면)'),
  dict(id='north_sidewalk', t=[RAMP_N, STRIP_N], s=[S_GATE, STRIP_END], top=f'경사면 + {KERB} m(약간 턱 있는 인도, 계단 아님)', grade='확정(인도, 약간 턱, 계단 아님: 사용자 2026-10-12), 추정(폭·턱 높이)', carried_by='구조물(기운 판)'),
  dict(id='north_planters', t=[STRIP_N, '6.5~9.5'], s=[14.3, 92], top='마디마다 다름(구조물 파일)', grade='추정', carried_by='구조물'),
]
for st_ in strips:
    if st_['id'] in ('south_sidewalk', 'ramp', 'north_sidewalk'):
        tm = (st_['t'][0] + st_['t'][1]) / 2; st_['centreline'] = line([(s_, tm) for s_ in ss if st_['s'][0] <= s_ <= st_['s'][1]], way_z)
walls = [
  dict(id='podium_west_wall', line=line([(31.5, 6.5), (31.5, T_N)], lambda s_: 138.8), topM=138.8, bottomM=132.5, grade='S-MAP', source=SRC_MESH + ' (기울기 그림에서 가장 가파른 줄)'),
  dict(id='podium_south_wall', line=line([(31.5, 6.5), (50, 6.5)], lambda s_: 138.8), topM=138.8, bottomM='경사면 135.5~138.2', grade='S-MAP(높이), 추정(선 ±1 m)', source=SRC_MESH),
  dict(id='lane_south_wall', line=line([(12.3, 8.5), (31.5, 8.5)], way_z), topM='경사면 132.5~135.5', bottomM=132.5, grade='S-MAP(높이), 추정(선)', source=SRC_MESH),
  dict(id='fork_south_wall', line=line([(67, 9), (76, 9)], lambda s_: 144.2), topM=144.2, bottomM='경사면 141.0~142.6', grade='S-MAP(높이), 추정(선)', source=SRC_MESH),
  dict(id='fork_top_step', line=line([(76, 9.5), (76, T_N)], lambda s_: 145.5), topM=145.5, bottomM=144.2, grade='S-MAP', source='사진 8(144.2/145.4), 시험용 DB 계단 a7a51d3c'),
  dict(id='top_south_wall', line=line([(76, 9.5), (93.3, 9.5)], lambda s_: 145.5), topM=145.5, bottomM='경사면 142.6~145.5', grade='S-MAP(높이), 추정(선)', source=SRC_MESH),
  dict(id='hanlim_side_wall', line=line([(69.3, -2.5), (101, -2.5)], way_z), topM='경사면 141.4~146.9', bottomM='모름(S-MAP 133~137, 본관·한림관 사이 꺼진 자리)', grade='추정', source=SRC_MESH + ', 사진 30'),
  dict(id='barrier_line', line=line([(S_GATE, S_WALL), (S_GATE, STRIP_N)], way_z), topM='경사면', bottomM='경사면', grade='원천(거리뷰 21·정사 그림), 추정(±1 m)', source=SV21),
  dict(id='main_building_wall', line=line([(3.3, -4.9), (69.3, -4.9)], way_z), topM='건물', bottomM='경사면', grade='원천(건물 외곽)', source='building-outlines-5186.json'),
]
dump(HERE / 'model.json', {'crs': 'EPSG:5186', 'axis': {'origin': [float(O[0]), float(O[1])], 'unit': [float(U[0]), float(U[1])], 'north_unit': [float(N[0]), float(N[1])], 'note': 's = 아래 끝에서 위로, t = 북쪽(문예관 쪽) +'},
  'way_profile': [{'s': s_, 'z': z_} for s_, z_ in WAY_PROFILE], 'base_planes': [{'name': p['name'], 'heightM': p.get('heightM', 'profile'), 'grade': p['grade'], 'st': p['st']} for p in planes],
  'strips': strips, 'stepped_strip': '없음(G03: 사용자 확정 2026-10-12 "양쪽 모두 약간 턱 있는 인도, 계단 아님". G02 의 디딤판 106칸을 거둠)',
  'walls': walls, 'underground': {'road': '951c157d 지하 차도', 'note': '경사면 아래의 따로 떨어진 상자(빈 곳). 지형에 새기지 않는다. 덮개 두께는 preview.py'}})
print('platforms', len(platforms), 'voids', len(voids), 'features', len(boxes))
