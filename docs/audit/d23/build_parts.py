"""D23(2026-10-23): 대일관 앞 데크·뒤 화단·앞 화단을 사용자 파란 구분선 세 줄대로 다시 놓는다. DB·네트워크 접근 없음.
  python -I build_parts.py
근거: 볼트 데이터/모델링 개선/건물/대일관.md "D23 데크·화단 구분선 다시 놓기" 절.
  사용자 표시 보완자료/학교-전경-20261022/비교-후/사용자표시-대일관-데크-화단-구분선.webp(파란 선 셋) 를
  항공-대일관앞-전후.png 를 만든 변환(blue_lines.json 의 M)으로 EPSG:5186 에 옮긴 값(blue_lines.json).
  건물 → 뒤 화단 → [파랑 1] → 데크 → [파랑 2] → 앞 화단 → [파랑 3] → 운동장.
고치는 파일(id 로 찾아 고침, 몇 번 돌려도 같다):
  frontend/public/structures/z02-daeil-front.geojson  기단 PASSAGE, 데크, 난간, 앞 화단, 서쪽 화단(BASTION), 동쪽 끝 단·참
  frontend/public/structures/x22-photo-fixes.geojson  뒤 화단, 나무 여섯, 운동장 가장자리 가로등 넷, SKON SQUARE 글자
x22/build_parts.py 는 지금 다시 돌릴 수 없다(오르막 가로등 받침 G03-SBED 가 d43e3b2 에서 옮겨짐). 그래서 이 스크립트가 그 뒤에 덧고친다.
좌표 EPSG:5186, 대일관 정면 축 (u, v) 은 z02/common.py."""
import json, math, pathlib, importlib.util
import numpy as np
from shapely.geometry import Polygon

HERE = pathlib.Path(__file__).parent; AUDIT = HERE.parent; REPO = AUDIT.parents[1]
STR = REPO / 'frontend' / 'public' / 'structures'
sp = importlib.util.spec_from_file_location('z02common', AUDIT / 'z02' / 'common.py'); Z = importlib.util.module_from_spec(sp); sp.loader.exec_module(Z)
r2 = lambda v: round(float(v), 2)
def uv(u, v): return tuple(float(c) for c in Z.uv_to_xy(u, v))
V_AX = np.array(uv(0, 1)) - np.array(uv(0, 0)); U_AX = np.array(uv(1, 0)) - np.array(uv(0, 0))
def load(fn): return json.loads((STR / fn).read_text(encoding='utf-8'))
def dump(fn, obj): (STR / fn).write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom_uv(uvs):
    poly = Polygon([uv(a, b) for a, b in uvs]).buffer(0)
    assert poly.geom_type == 'Polygon', uvs
    return {'type': 'Polygon', 'coordinates': [ring(list(poly.exterior.coords)[:-1])]}

# 파란 선 셋: (u, v) 두 끝을 잇는 직선. 끝 밖은 같은 직선을 늘림
BL = json.loads((HERE / 'blue_lines.json').read_text(encoding='utf-8'))['lines']
def line(k):
    (u0, v0), (u1, v1) = BL[k]['uv']
    return lambda u: v0 + (u - u0) * (v1 - v0) / (u1 - u0)
b1, b2, b3 = line(0), line(1), line(2)

SRC = ('사용자 표시 보완자료/학교-전경-20261022/비교-후/사용자표시-대일관-데크-화단-구분선.webp(파란 선 셋: 데크·화단 구분, 2026-10-23), '
       '항공-대일관앞-전후.png 의 변환으로 EPSG:5186 에(docs/audit/d23/blue_lines.json), 사진 운동장에서-대일관-스콘스퀘어.webp(난간)')
GRADE = '확정(데크·뒤 화단·앞 화단 경계가 있다: 사용자 표시), 추정(자리 ±1 m: 항공사진 맞춤, 높이는 기존 값 운동장 148.9·참 151.0·데크 151.3)'
U_W, U_B, U_P, U_WALL, U_E, U_STEP, U_STAIR = 9.0, 10.5, 11.0, 40.1, 49.4, 50.0, 50.6   # 데크 서쪽 끝, 파란 선 시작, 뒤 화단 서쪽 끝, 벽 꺾임(동쪽은 벽 v 1.67), 데크 끝, 단 끝, 계단 서쪽
V_WALL_E = 1.67
UB = [U_P] + list(np.arange(12.0, 40.0, 4.0)) + [40.0]          # 뒤 화단·데크 뒷선(파랑 1) 꼭짓점
UF = [U_B] + list(np.arange(12.0, U_STEP, 4.0)) + [U_WALL, U_E, U_STEP]   # 앞선(파랑 2)
def along(f, us, rev=False):
    p = [(r2(u), r2(f(u))) for u in us]; return p[::-1] if rev else p
def front(us, rev=False): return along(b2, us, rev)

z02 = load('z02-daeil-front.geojson'); F = {f['properties']['id']: f for f in z02['features']}
def setp(fid, uvs, what):
    f = F[fid]; f['geometry'] = geom_uv(uvs); p = f['properties']
    p['grade'] = GRADE; p['source'] = SRC
    p['assumption'] = p.get('assumption', '').split(' D23:')[0] + ' D23: ' + what
# 기단(데크·뒤 화단 밑 콘크리트): 벽 ~ 파랑 2
setp('Z02-PLATFORM-PASSAGE', [(8.4, -0.2), (40.0, -0.2), (U_WALL, 1.46), (U_STEP, 1.47)] + front([u for u in UF if u <= U_STEP], rev=True) + [(U_B, 2.5), (8.4, 2.51)],
     '앞선을 파랑 2(데크 앞선)로')
# 데크: 서쪽 이음(u 9~10.5, v 0~2.5) + 파랑 1 ~ 파랑 2. 벽 꺾임 동쪽은 벽(v 1.67) ~ 파랑 2
setp('Z02-DECK-MAIN', [(U_W, 0.0), (U_P, 0.0)] + along(b1, UB) + [(U_WALL, V_WALL_E)] + front([u for u in UF if u <= U_WALL], rev=True) + [(U_B, 2.5), (U_W, 2.5)],
     f'나무 데크 = 파랑 1 ~ 파랑 2(폭 {b2(12) - b1(12):.1f}~{b2(40) - b1(40):.1f} m). 서쪽 u 9~10.5 는 현관 쪽 이음(v 0~2.5), u 10.5~11 은 벽까지')
setp('Z02-DECK-EAST', [(U_WALL, V_WALL_E), (U_E, V_WALL_E)] + front([U_WALL, U_E], rev=True), '나무 데크 동쪽 구간: 벽(v 1.67) ~ 파랑 2')
setp('Z02-DECK-STEP-E', [(U_E, V_WALL_E), (U_STEP, V_WALL_E)] + front([U_E, U_STEP], rev=True), '데크 끝에서 참으로 내려서는 단, 폭을 데크에 맞춤')
F['Z02-DECK-STEP-E']['properties']['widthM'] = r2(b2(U_STEP) - V_WALL_E)
# 빨간 물결 난간: 데크 운동장 쪽 가장자리 전체(사진: 현관 옆부터 동쪽 끝까지 이어짐) + 서쪽 화단(BASTION) 쪽 꺾임
RT = 0.12
setp('Z02-RAILING-MAIN', [(8.4, 2.38), (U_B + RT, 2.38), (U_B + RT, r2(b2(U_B + RT) - RT))] + [(r2(u), r2(b2(u) - RT)) for u in UF if U_B < u <= U_WALL]
     + front([u for u in UF if u <= U_WALL], rev=True) + [(U_B, 2.5), (8.4, 2.5)], '데크 앞선(파랑 2) 안쪽 0.12 m. 서쪽 화단 쪽(u 10.5) 꺾임 포함')
setp('Z02-RAILING-JOG', [(U_WALL - RT, r2(b2(U_WALL) - RT)), (U_WALL, r2(b2(U_WALL) - RT)), (U_WALL, r2(b2(U_WALL))), (U_WALL - RT, r2(b2(U_WALL - RT)))], '파랑 2 위의 마디(전 꺾임은 없어짐)')
setp('Z02-RAILING-EAST', [(U_WALL, r2(b2(U_WALL) - RT)), (U_STEP, r2(b2(U_STEP) - RT))] + front([U_WALL, U_STEP], rev=True), '데크 동쪽 구간 앞선(파랑 2) 안쪽 0.12 m')
# 앞 화단(옹벽 위 화단): 파랑 2 ~ 파랑 3. 옹벽 앞면 = 파랑 3(전 v 6.3 에서 0.5~1.3 m 운동장 쪽)
UP = [U_B] + list(np.arange(12.0, U_WALL, 4.0)) + [U_WALL]
setp('Z02-PLANTER-MAIN', front(UP) + along(b3, UP, rev=True), '앞 화단 = 파랑 2 ~ 파랑 3(앞면 거친 돌 옹벽 = 파랑 3, 전 v 6.3 보다 서쪽 1.3 m · 동쪽 0.5 m 운동장 쪽). 색 초록')
UPE = [U_WALL, 44.0, 48.0, 50.4]
setp('Z02-PLANTER-EAST', front(UPE) + along(b3, UPE, rev=True), '앞 화단 동쪽 = 파랑 2 ~ 파랑 3, 동쪽 끝은 계단 서쪽 옆(u 50.4)')
# 서쪽 화단(현관 넓은 계단 동쪽 흰 돌 화단): 파란 선이 시작하는 u 10.5 까지, 앞 끝은 파랑 3
setp('Z02-PLANTER-BASTION', [(7.5, 6.2), (8.4, 6.2), (8.4, 2.51), (U_B, 2.5), (U_B, r2(b3(U_B))), (9.0, 9.8), (7.5, 9.8)],
     '동쪽 끝을 파란 선이 시작하는 u 10.5 로(그 동쪽은 데크·앞 화단)')
# 동쪽 끝 참(서쪽 부분): 데크 끝 단 앞선(파랑 2)까지
f = next(f for f in z02['features'] if f['properties']['id'] == 'X22-DAEIL-EAST-LANDING')
f['geometry'] = geom_uv([(U_STEP, V_WALL_E), (54.0, V_WALL_E), (54.0, 2.7), (U_STAIR, 2.7), (U_STAIR, r2(b2(U_STAIR))), (U_STEP, r2(b2(U_STEP)))])
f['properties']['assumption'] = f['properties']['assumption'].split(' D23:')[0] + ' D23: 서쪽 끝을 데크 끝 단 폭(파랑 2)까지'
dump('z02-daeil-front.geojson', z02)

# ---------- x22-photo-fixes: 뒤 화단·나무·가로등·글자 ----------
x22 = load('x22-photo-fixes.geojson'); G = {f['properties']['id']: f for f in x22['features']}
# 뒤 화단: 입구(2) 문(u 31.46) 앞은 문으로 드나드는 틈(u 30.4~32.6, 추정)이라 둘로 나눔
DOOR_GAP = (30.4, 32.6)
BP_W = 'X22-DAEIL-BACK-PLANTER'; BP_E = 'X22-DAEIL-BACK-PLANTER-E'
if BP_E not in G:
    e = json.loads(json.dumps(G[BP_W])); e['properties']['id'] = BP_E; x22['features'].insert(x22['features'].index(G[BP_W]) + 1, e); G[BP_E] = e
BPA = (f'데크 뒤(건물 쪽) 나무 줄 화단 = 원천 외곽(벽) ~ 파랑 1(폭 {b1(12):.1f}~{b1(40):.1f} m). 건물 쪽 경계는 사진의 벽·지붕 선이 아니라 원천 외곽'
       '(사진은 높이 1 m 마다 약 0.2 m 북쪽으로 기울어 보임). 입구(2) 문 앞 u 30.4~32.6 은 틈(추정)')
for fid, a0, a1 in ((BP_W, U_P, DOOR_GAP[0]), (BP_E, DOOR_GAP[1], 40.0)):
    us = [a0] + [u for u in UB if a0 < u < a1] + [a1]
    G[fid]['geometry'] = geom_uv([(a0, 0.0), (a1, 0.0)] + along(b1, us, rev=True))
    G[fid]['properties'].update(grade=GRADE, source=SRC, assumption=BPA)
def translate(f, d):
    f['geometry'] = {'type': 'Polygon', 'coordinates': [[[r2(x + d[0]), r2(y + d[1])] for x, y in r] for r in f['geometry']['coordinates']]}
def centroid(fid): return np.array(Polygon(G[fid]['geometry']['coordinates'][0]).centroid.coords[0])
# 나무 여섯: 줄기를 뒤 화단 가운데(v = 파랑 1 / 2)로. u 는 그대로
for k in range(1, 7):
    c = centroid(f'X22-DAEIL-BACK-TREE-{k}-TRUNK'); cu, cv = (float(t) for t in Z.xy_to_uv(*c))
    tu = 34.5 if k == 5 else cu   # 5 번(u 32)은 문 앞 틈에 걸려 동쪽으로(추정)
    d = V_AX * (b1(tu) / 2 - cv) + U_AX * (tu - cu)
    for part in ('TRUNK', 'CROWN', 'TOP'):
        g = G[f'X22-DAEIL-BACK-TREE-{k}-{part}']; translate(g, d)
        if part == 'TRUNK' or g['properties'].get('basePlane', '').startswith('X22-DAEIL-BACK-PLANTER'): g['properties']['basePlane'] = BP_E if tu > DOOR_GAP[1] else BP_W
        g['properties']['assumption'] = g['properties']['assumption'].split(' D23:')[0] + ' D23: 줄기를 뒤 화단 가운데로(사진의 나무 머리는 기울어 보임만큼 건물 쪽으로 밀려 보임)'
# 운동장 가장자리 가로등 넷: 앞 화단 가운데로(파랑 2·3 사이)
for k in range(1, 5):
    id = f'X22-LAMP-FIELD-{k:02d}'; c = centroid(id); cu, cv = (float(t) for t in Z.xy_to_uv(*c))
    d = V_AX * ((b2(cu) + b3(cu)) / 2 - cv)
    for fid in [i for i in G if i == id or i.startswith(id + '-')]: translate(G[fid], d)
# SKON SQUARE 글자: 옹벽 앞면(파랑 3) 안쪽 0.35 m 로 한꺼번에
sk = [i for i in G if i.startswith('X22-SKON-')]
ys = [float(Z.xy_to_uv(*centroid(i))[1]) for i in sk]; us = [float(Z.xy_to_uv(*centroid(i))[0]) for i in sk]
d = V_AX * (b3((min(us) + max(us)) / 2) - 0.35 - (min(ys) + max(ys)) / 2)
for i in sk: translate(G[i], d)
dump('x22-photo-fixes.geojson', x22)
print('파랑 1·2·3 v (u 12 / 40 / 50):', [tuple(r2(f(u)) for u in (12, 40, 50)) for f in (b1, b2, b3)])
