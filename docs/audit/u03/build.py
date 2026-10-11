"""U03: 학교 지하도 안내 글(SKU CAST)의 걷는 길을 시험용 DB 변경 묶음과 구조물로. DB 접근 없음.   python docs/audit/u03/build.py
쓰는 파일: groups/u03.json(적용은 n02/n02.ts apply, 시험용 DB 에만), frontend/public/structures/u03-underground-walk.geojson, model.json.
높이 근거와 맞지 않는 것은 볼트 구역 노트 '운동장 아래 지하층과 지하 차도'의 U03 절. 사진은 볼트에만 있다(블로그-NN = 사용자-운동장지하-20261012/블로그-사진)."""
import json, math, pathlib
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
X0, Y0 = 201000.0, 557000.0
r2 = lambda v: round(float(v), 2)
def pt(x, y, z): return {'xy': [r2(X0 + x), r2(Y0 + y)], 'z': r2(z)}
node = lambda i: {'at': {'nodeId': i}}

# ---------- 높이 (m) ----------
H = {'b1': 141.4,        # 운동장 지하 1층 = 은주관 간판 옆 문(U02)
     'eunju3': 137.8,    # 은주1관 3층 = 파란 문 계단실 = 연결통로 = 한림관 연결 층 = 본관 5층 (계단 없이 이어짐: 블로그-09~11)
     'bon5': 137.8,      # 본관 5층: 입구(3) 문 앞 지면 139.9(S-MAP) − 반 층 계단 11단(블로그-12) = 138.0 ±0.6, 2층에서 두 층
     'e3': 139.9,        # 본관 입구(3) 문 = 5·6층 사이 계단참(학교 지도)
     'bon2': 128.5,      # 본관 2층 = 본관 모서리 앞 계단 발치(유리문 옆 계단) = 지하 보행 구간, 정문 127.8 에서 몇 단
     'main': 127.8, 'glassLow': 127.75,   # 유리문 뒤 4~5단(블로그-17)
     'yu7': 121.6, 'yu9': 129.38, 'stopDoor': 130.97}
BLOG = '학교 지하도 안내 글(SKU CAST, 사용자 제공 2026-10-12, 원천)'
MAP = '학교 캠퍼스맵 지하도 연결 지점(블로그-03, 원천. 좌표 맞춤 잔차 RMS 3.3 m)'
N = {'door': '8e608a71-5268-42d6-9fe9-b64eafda79e3', 'hanW': '5bcc9f6d-6d73-451b-b5b4-b5717418c247', 'bonE': '0ba82e17-c082-4efb-ae45-1269b982f1e5', 'e3': '2995173c-585b-4a1b-9405-54b22ca26bc6',
     'main': '59e77b01-41b4-4d20-b8a4-a01f6a74e4ac', 'lobby': '2b5185cc-9133-44a0-b898-66d2cbc34ea0', 'yu9': '43a7f874-9382-496b-ad7c-62953e1ac02f'}
# ---------- 자리 (201000, 557000 을 뺀 값) ----------
ST = [(142.0, 284.1, H['b1']), (141.2, 279.9, 139.6), (139.4, 280.2, 139.6), (140.1, 284.4, H['eunju3'])]   # 문 안 계단(꺾어 내려감, 추정)
EW = (133.6, 292.3); P1A, P1B = (132.6, 292.4), (127.4, 293.1)                                              # 은주1관 계단실, 연결통로 1 의 두 끝
HAN = [(124.6, 298.6), (119.5, 303.6), (112.5, 305.3), (105.5, 303.4)]                                      # 한림관 안(가운데 원통 북쪽으로 돎, 추정)
EV_B = (68.0, 318.5)                                                                                        # 본관 승강기(중앙 계단 옆, 추정)
HALL2 = (62.6, 307.6); COR2 = [(43.9, 330.3), (45.6, 342.2)]                                                # 2층 홀 ~ 정문, 2층 복도 ~ 북서 끝
GL = (38.9, 346.4); PASS = [(26.2, 296.0), (25.9, 292.3)]                                                   # 유리문 뒤 단 아래, 흰 벽 통로, 유담관 7층 승강기 홀
d = lambda a, b: math.hypot(b[0] - a[0], b[1] - a[1])
L1, L2 = d(GL, PASS[0]), d(PASS[0], PASS[1]); zmid = H['glassLow'] + (H['yu7'] - H['glassLow']) * L1 / (L1 + L2)
passGrade = (H['glassLow'] - H['yu7']) / (L1 + L2) * 100

ops = []
def op(ref, name, args, grade, evidence): ops.append({'ref': ref, 'op': name, 'args': args, 'grade': grade, 'evidence': evidence})
def road(ref, name, structure, path, grade, evidence, width=2, building=None):
    a = {'roadClass': 'pedestrian', 'name': name, 'structure': structure, 'widthM': width, 'vehicleAccess': 'prohibited', 'pedestrianAccess': 'allowed', 'vehicleDirection': 'both', 'pedestrianDirection': 'both', 'path': path, 'zMode': 'explicit', 'densify': False}
    if building: a['buildingId'] = building
    op(ref, 'create_road', a, grade, evidence)
def place(ref, name, cat, building, pos, desc, grade):
    a = {'name': name, 'category': cat, 'description': desc, 'position': pos}
    if building: a['buildingId'] = building
    op(ref, 'create_place', a, grade, f'{MAP}, {BLOG}')

# ---------- 은주1관 ----------
road('은주1관 문 안 계단', f"은주1관 지하통로 문 안 계단 (주차장 쪽 문 {H['b1']} → 3층 {H['eunju3']} m, 한 층 내려감. 있음은 사진, 단 수·모양 추정)", 'stairs', [node(N['door'])] + [pt(*p) for p in ST],
     '원천(문으로 들어가면 3층, 문 안에 난간 계단), 추정(내려가는 높이 3.6 m·모양)', f"{BLOG} 블로그-06: '은주관' 간판 옆 문 안 왼쪽에 아래로 내려가는 난간, 안쪽 창이 문턱보다 낮게 보인다. 3층에서 본관 5층까지는 계단 없이 걷는다(블로그-09~11)이고 본관 5층은 137.8 m 라 문(141.4)과의 차 3.6 m 를 이 계단에 두었다", building='은주관')
road('은주1관 3층 복도', f"은주1관 3층 복도 ~ 계단실 (파란 문 앞, {H['eunju3']} m. 선 추정)", 'indoor_corridor', [pt(*ST[-1]), pt(136.5, 288.8, H['eunju3']), pt(*EW, H['eunju3'])],
     '원천(복도·계단실), 추정(선)', f'{BLOG} 블로그-07(복도), 블로그-08(계단실: 바닥 3층, 오르는 계단 4층 표기, 계단 밑으로 한림관 방향)', building='은주관')
road('한림관–은주1관 연결통로', f"한림관–은주1관 연결통로 (파란 문·파란 둥근 지붕 유리 통로, {H['eunju3']} m 평지. 자리는 학교 지도 ±3.3 m)", 'ordinary', [pt(*EW, H['eunju3']), pt(*P1A, H['eunju3']), pt(*P1B, H['eunju3'])],
     '원천(있음·모양·자리), 추정(높이)', f'{BLOG} 블로그-09·10: 계단실 계단 밑 파란 철문 → 낮은 흰 벽·파란 띠·파란 둥근 지붕의 타일 바닥 통로 → 한림관 안. {MAP}의 갈색 연결통로 (201130.3, 557292.1)', width=2.4)
# ---------- 한림관 ----------
road('한림관 연결 층', f"한림관 연결 층 통로 (은주1관 쪽 통로 ~ 식당 가는 지하 계단을 지나 ~ 본관 쪽 통로. {H['eunju3']} m, 지도 표기 2층·사용자 표기 3층. 선 추정)", 'indoor_corridor', [pt(*P1B, H['eunju3'])] + [pt(*p, H['eunju3']) for p in HAN] + [node(N['hanW'])],
     '원천(한 층으로 이어짐), 추정(선)', f"{BLOG}: '한림관 식당으로 가는 지하 계단을 지나쳐서 쭉 앞으로 가면 본관으로 가는 통로'. 블로그-10(흰 벽·둥근 기둥의 홀). 층 이동 없음", building='한림관')
for rid, part in (('0399773c-4737-4573-a24e-c9e600c9b048', '본관 쪽 문 ~ 가운데'), ('f8bb47f5-9ffd-4cd4-9650-1cf933aad31e', '가운데 ~ 한림관 쪽 문')):
    op(f'본관–한림관 연결통로 이름({part})', 'update_road', {'id': rid, 'expectedRevision': 6, 'attrs': {'name': f"본관 5층–한림관 연결통로 (파란 둥근 지붕 유리 통로 = 사용자가 말한 나무 데크 자리, {part}. {H['bon5']} m, 지하 보행 구간과 같은 높이)"}},
       '확정(자리·이어짐), 원천(모양: 블로그-11)', f"{BLOG} 블로그-11: 파란 둥근 지붕·타일 바닥 통로, 끝에서 오른쪽이 '지하 폭언'(= 지하 보행 구간 2b765aa4). 길·높이는 그대로, 이름만 고침")
# ---------- 본관 ----------
road('본관 5층 계단실 → 입구(3)', f"본관 5층 계단실 ~ 입구(3) 문 (반 층 올라가 내리막길로 나감, {H['bon5']} → {H['e3']} m. 11단쯤, 선 추정)", 'stairs', [node(N['bonE']), pt(99.3, 309.8, 138.85), node(N['e3'])],
     '원천(계단실에서 반 층 위 문이 바깥), 추정(선)', f"{BLOG} 블로그-12: 통로가 닿는 계단실에서 올라가는 계단 11단쯤 위로 바깥(나무)이 보이고 '폭풍의 언덕' 화살표. 학교 지도의 입구(3) = 5·6층 사이 계단", building='본관')
road('본관 5층 복도', f"본관 5층 복도 (동쪽 계단실 ~ 중앙 계단 옆 승강기. {H['bon5']} m, 선 추정)", 'indoor_corridor', [node(N['bonE']), pt(*EV_B, H['bon5'])], '원천(있음), 추정(선·승강기 자리)', f"{BLOG} 블로그-12·13: '본관 중심' 화살표, 승강기 표시등·벽 표지 5", building='본관')
road('본관 승강기', f"본관 승강기 5층–2층 (중앙 계단 왼쪽, {H['bon5']} ↔ {H['bon2']} m. 자리 추정, 3층은 길을 두지 않음)", 'elevator', [pt(*EV_B, H['bon5']), pt(*EV_B, H['bon2'])], '원천(5층에서 타고 2층에서 내림), 추정(자리·2층 높이)', f"{BLOG}: '웅장하고 큰 중앙 계단의 왼쪽 엘리베이터를 타고 본관의 2층으로'", building='본관')
road('본관 2층 홀', f"본관 2층 홀 (승강기 ~ 정문 쪽 문 앞, {H['bon2']} m. 선 추정)", 'indoor_corridor', [pt(*EV_B, H['bon2']), pt(*HALL2, H['bon2'])], '원천(있음), 추정(선·높이)', f"{BLOG} 블로그-14: 대리석 기둥 홀, 왼쪽 '본관 정문'", building='본관')
road('본관 2층 ~ 정문', f"본관 2층 홀 ~ 정문(입구(1)) 문 ({H['bon2']} → {H['main']} m, 몇 단. 단 수 추정)", 'stairs', [pt(*HALL2, H['bon2']), node(N['main'])], '원천(2층 왼쪽 문이 정문·바깥), 추정(높이 차 0.7 m)', f"{BLOG}: '본관 2층 계단의 좌측으로는 본관 정문으로 나가는 문 … 야외 캠퍼스에서 유담관으로'. 학교 지도: 입구(1)은 1층과 2층으로 갈 수 있음", building='본관')
road('본관 2층 복도', f"본관 2층 복도 (승강기 ~ 북서 끝 아치 창 앞에서 우회전 ~ 유리문 앞. {H['bon2']} m, 선 추정)", 'indoor_corridor', [pt(*EV_B, H['bon2'])] + [pt(*p, H['bon2']) for p in COR2] + [node(N['lobby'])],
     '원천(있음), 추정(선·높이)', f"{BLOG} 블로그-14·15·16: 오른쪽 '지하 통로' 복도, 끝의 반원 아치 창 앞에서 우회전, 큰 유리 양문. 유리문 옆 계단('셔틀 정류장')은 본관 모서리 앞 계단 e996a8f7 로 봄", building='본관')
# ---------- 유리문 ~ 유담관 ----------
road('유리문 뒤 단', f"본관 2층 유리문 ~ 지하통로 머리 (유리문 뒤 4~5단, {H['bon2']} → {H['glassLow']} m. 지하, 단 수 추정)", 'stairs', [node(N['lobby']), pt(*GL, H['glassLow'])], '원천(유리문 뒤 몇 단 내려감), 추정(자리·높이)', f'{BLOG} 블로그-16·17')
road('본관–유담관 지하통로', f"본관 2층–유담관 7층 지하통로 (흰 벽의 곧은 통로, {H['glassLow']} → {H['yu7']} m, 경사 {passGrade:.1f} %. 있음·곧음은 원천, 선·높이 추정)", 'ordinary', [pt(*GL, H['glassLow']), pt(*PASS[0], zmid), pt(*PASS[1], H['yu7'])],
     '원천(있음·곧게 내려감·끝이 유담관 7층 승강기), 추정(선·높이)', f"{BLOG} 블로그-17·18: 흰 벽의 좁고 곧은 통로가 아래로 기울며 이어지고 끝이 유담관 7층 승강기. {MAP}의 붉은 선: 본관 북서 모서리 → 버스 정류장 옆", width=2)
road('유담관 지하통로 승강기', f"유담관 지하통로 승강기 7층–9층 (정류장 쪽 문 안 8단 아래, {H['yu7']} ↔ {H['yu9']} m. 자리 추정, 6층에 서는지는 모름)", 'elevator', [pt(*PASS[1], H['yu7']), pt(*PASS[1], H['yu9'])], '원천(7층에서 타고 9층에서 내림), 추정(자리·7층 높이)', f"{BLOG} 블로그-18(층 표지 7)·블로그-19(9층: 승강기 옆 8단 위 유리문 '정류장')", building='유담관')
road('유담관 9층 승강기 앞', f"유담관 9층 승강기 앞 ~ 반 층 계단 아래 ({H['yu9']} m)", 'indoor_corridor', [pt(*PASS[1], H['yu9']), node(N['yu9'])], '원천(승강기 바로 옆이 8단 계단), 추정(자리)', f'{BLOG} 블로그-19. 위의 8단은 있는 길 699d0cbc(1.59 m)', building='유담관')
# ---------- 장소 ----------
op('연결통로 표지(본관–한림관)', 'update_place', {'id': '1192347a-ca9f-4d9d-9bf0-04104590134b', 'expectedRevision': 3, 'name': '본관–한림관 연결통로 (본관 5층 = 한림관 연결 층, 파란 둥근 지붕 유리 통로. 사용자가 말한 나무 데크 자리)',
   'description': f"U03. {BLOG} 블로그-11: 파란 둥근 지붕·낮은 흰 벽·타일 바닥. 끝에서 오른쪽은 지하 보행 구간('지하 폭언'). 한림관 층 표기는 지도 2층·사용자 3층(같은 층으로 봄). 높이 {H['bon5']} m 추정"}, '확정(자리), 원천(모양)', BLOG)
place('연결통로 표지(한림관–은주1관)', '한림관–은주1관 연결통로 (은주1관 3층 = 한림관 연결 층, 파란 둥근 지붕 유리 통로)', 'landmark', None, pt(130.3, 292.6, H['eunju3']), f"U03. 블로그-09·10. 높이 {H['eunju3']} m 추정(본관 5층과 계단 없이 이어짐)", '원천(있음·자리 ±3.3 m), 추정(높이)')
op('은주1관 지하통로 입구 표지', 'update_place', {'id': '5f9c4ea7-95af-4142-968b-dc971bb98d6e', 'expectedRevision': 1, 'name': '지하통로 입구: 은주1관 (연결 층 3층. 주차장 쪽 문 141.4 m, 문 안 계단 아래가 3층 137.8 m. 자리 ±3 m)',
   'description': f"U03. {BLOG} 블로그-06: '은주관' 간판 옆 문. 문 안 계단을 내려가 3층 복도 → 파란 문 → 한림관. 문 오른쪽 계단은 운동장으로"}, '원천(있음·층), 추정(자리·높이)', BLOG)
DOTS = [('버스 정류장 옆', '유담관', pt(19.59, 301.53, H['stopDoor']), '유담관 9층 정류장 쪽 유리문. 안으로 8단쯤 내려가면 9층 승강기 홀, 승강기로 7층 → 본관 2층 가는 지하통로. 지도의 점과 4.9 m', '연결 층 유담관 7층(문은 9층)'),
        ('본관 북서 모서리', '본관', pt(41.1, 347.7, H['bon2']), '지상에서 계단(e996a8f7)을 내려간 자리의 유리문. 본관 2층 복도, 유담관 7층 가는 지하통로, 북악관 지하 1층 가는 지하 횡단보도가 여기서 갈린다. 지도의 점과 8.5 m', '연결 층 본관 2층'),
        ('북악관', '북악관', pt(60.0, 357.0, 130.5), '자리는 지도의 점 그대로(±3.3 m). 있는 지하 횡단보도·통로(0fce276d → 계단 6칸 → 지하 1층 복도)와 13 m 떨어져 있어 같은 문인지 모름. 길은 잇지 않음', '연결 층 지하 1층'),
        ('문예관', '문예관', pt(103.2, 334.3, 136.4), '있는 길 66f166a8(문예관 지하 ~ 지하 차도 갈림, 136.4 m) 위. 지도의 점과 2 m. 여기서 지하 차도를 건너 본관 쪽 보행 구간으로 가는 자리는 모름(잇지 않음)', '연결 층 지하 1층'),
        ('한림관 북쪽', '한림관', pt(122.2, 311.5, H['eunju3']), '자리는 지도의 점 그대로(±3.3 m), 높이는 한림관 연결 층 값(추정). 문 자리·문 안 층·닿는 길 모름. 길은 잇지 않음', '연결 층 한림관 2층(지도 표기)'),
        ('청운관 서', '청운관', pt(209.4, 280.8, 148.9), '자리는 지도의 점 그대로. 청운관 지하 1층(운동장 높이 148.9)에서 운동장 지하 1층 주차장(141.4)으로 7.5 m 내려가는 계단·승강기의 근거가 없어 길은 잇지 않음', '연결 층 지하 1층'),
        ('청운관 동', '청운관', pt(248.6, 262.8, 148.9), '자리는 지도의 점 그대로. 위와 같은 까닭으로 길은 잇지 않음', '연결 층 지하 1층'),
        ('혜인관', '혜인관', pt(221.27, 212.15, 149.3), '혜인관 입구(1) 문 정면, 건물 안 계단 머리(U02 의 길 5aea9b42). 지도의 점과 7.4 m', '연결 층 지하 1층')]
for nm, b, pos, desc, fl in DOTS: place(f'지하통로 입구 표지({nm})', f'지하통로 입구: {nm} ({fl})', 'building_entrance', b, pos, 'U03. 학교 지하도 지도의 초록 점. ' + desc, '원천(있음·층), 추정(자리)')
(HERE / 'groups').mkdir(exist_ok=True)
R_OPS = [o for o in ops if 'place' not in o['op']]; P_OPS = [o for o in ops if 'place' in o['op']]   # 한 묶음은 25개까지
for fn, gid, cm, oo in (('u03.json', 'U03', 'U03: 학교 지하도 걷는 길(은주1관 문 안 계단 ~ 연결통로 둘 ~ 본관 5층·승강기·2층 ~ 유리문 지하통로 ~ 유담관 7층·승강기·9층)', R_OPS), ('u03p.json', 'U03p', 'U03p: 지하통로 입구(초록 점)와 연결통로 표지', P_OPS)):
    (HERE / 'groups' / fn).write_text(json.dumps({'id': gid, 'zone': '운동장 아래 지하층과 지하 차도', 'comment': cm, 'ops': oo}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ================= 구조물 =================
feats = []
SRC = f'{BLOG}. 사진은 볼트 사용자-운동장지하-20261012/블로그-사진'
def ring(c): return [[r2(X0 + x), r2(Y0 + y)] for x, y in c] + [[r2(X0 + c[0][0]), r2(Y0 + c[0][1])]]
def box(i, typ, c, lo, hi, note, grade, color=None, **kw):
    p = {'id': f'U03-{i}', 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'assumption': note, 'source': SRC, 'fromM': r2(lo), 'toM': r2(hi), 'basePlane': kw.pop('basePlane', '없음(뜬 판)')}
    if color: p['color'] = color
    p.update(kw); feats.append({'type': 'Feature', 'properties': p, 'geometry': {'type': 'Polygon', 'coordinates': [ring(c)]}})
def frame(a, b):
    L = d(a, b); u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L); n = (-u[1], u[0])
    return L, (lambda s0, s1, t0, t1: [(a[0] + u[0] * s + n[0] * t, a[1] + u[1] * s + n[1] * t) for s, t in ((s0, t0), (s1, t0), (s1, t1), (s0, t1))])
WHITE, BLUE, GLASS, TILE = '#f1f0ea', '#1f4fa8', '#58b6d6', '#d8d4ca'
def vault(tag, a, b, z, half, grade, walls=('L', 'R'), slab=True):
    """파란 둥근 지붕 통로: 바닥 판, 낮은 흰 벽 + 파란 띠, 파란 아치 갈비(계단 모양 조각), 반투명 지붕 띠."""
    L, R = frame(a, b); G = grade
    if slab: box(f'{tag}-FLOOR', 'deck', R(0, L, -half, half), z - 0.3, z, '통로 바닥 판(타일). 두께 0.3 m 추정', G, TILE)
    for side, sg in (('L', 1), ('R', -1)):
        if side not in walls: continue
        t0, t1 = sorted((sg * (half - 0.22), sg * (half + 0.12)))
        box(f'{tag}-WALL-{side}', 'wall', R(0, L, t0, t1), z, z + 0.95, '낮은 흰 벽(높이 0.95 m 추정)', G, WHITE)
        box(f'{tag}-CAP-{side}', 'wall', R(0, L, t0 - 0.04, t1 + 0.04), z + 0.95, z + 1.07, '벽 위 파란 띠', G, BLUE)
    rad = half; zc = z + 1.07 + 0.55; K = 7
    arc = [(rad * math.cos(math.pi * k / K), zc + rad * math.sin(math.pi * k / K)) for k in range(K + 1)]
    nr = max(2, round(L / 1.3))
    for j in range(nr + 1):
        s = min(max(L * j / nr, 0.06), L - 0.06)
        for side, sg in (('L', 1), ('R', -1)):
            t0, t1 = sorted((sg * (half - 0.06), sg * (half + 0.06))); box(f'{tag}-RIB{j:02d}-POST-{side}', 'wall', R(s - 0.06, s + 0.06, t0, t1), z + 1.07, zc, '아치 갈비의 곧은 다리', G, BLUE)
        for k in range(K):
            (ta, za), (tb, zb) = arc[k], arc[k + 1]; t0, t1 = sorted((ta, tb))
            box(f'{tag}-RIB{j:02d}-A{k}', 'wall', R(s - 0.06, s + 0.06, t0, t1), min(za, zb) - 0.02, max(za, zb) + 0.1, '아치 갈비(굽은 면이 없어 계단 모양 조각)', G, BLUE)
    for k in range(K):
        (ta, za), (tb, zb) = arc[k], arc[k + 1]; t0, t1 = sorted((ta, tb))
        box(f'{tag}-SKIN-{k}', 'canopy', R(0, L, t0, t1), (za + zb) / 2 + 0.1, (za + zb) / 2 + 0.16, '파란 반투명 둥근 지붕(띠 7개로 나눔)', G, GLASS)
    return L
G1 = '원천(있음·모양·색: 블로그-09·10), 추정(자리 ±3.3 m, 치수, 높이 137.8 m)'
G2 = '확정(자리: 사용자 표시), 원천(모양·색: 블로그-11), 추정(치수, 높이 137.8 m)'
len1 = vault('LINK-EUNJU-HANLIM', P1A, P1B, H['eunju3'], 1.3, G1)
for tag, s in (('EUNJU', 0.0), ('HANLIM', 1.0)):
    L, R = frame(P1A, P1B); box(f'LINK-EUNJU-HANLIM-DOOR-{tag}', 'wall', R(L * s - 0.08, L * s + 0.08, -1.0, 1.0), H['eunju3'], H['eunju3'] + 2.2, '통로 끝 문 면(은주1관 쪽은 파란 철문: 블로그-09)', G1, BLUE if tag == 'EUNJU' else None, **({} if tag == 'EUNJU' else {'material': 'opening'}))
DA, DB = (97.6, 302.92), (101.4, 300.83)   # 있는 데크 판 G02-DECK-MAIN-HANLIM 의 축(본관 벽 ~ 한림관 벽)
len2 = vault('LINK-BONGWAN-HANLIM', DA, DB, H['bon5'], 1.45, G2, walls=('R',), slab=False)   # 바닥은 있는 판. 북쪽(L)은 지하 보행 구간이 들어오는 쪽이라 벽 없음. 남쪽 흰 벽이 Z07 의 나무 난간을 감싼다
# 유리문과 그 뒤 단, 흰 벽 통로(빈 곳)
GG = '원천(있음: 블로그-16·17·18), 추정(자리·치수·높이)'
L, R = frame((41.1, 347.7), GL)
box('GLASS-DOOR', 'wall', R(0.25, 0.33, -1.3, 1.3), H['bon2'], H['bon2'] + 2.4, '스테인리스 틀의 큰 유리 양문(폭 2.6 m·높이 2.4 m 추정)', GG, material='glass', inVoid=True, basePlane='U03-VOID-LOBBY 바닥')
for k in range(5):
    box(f'GLASS-STEP-{k + 1}', 'wall', R(0.6 + 0.35 * k, 0.6 + 0.35 * (k + 1), -1.0, 1.0), H['glassLow'] - 0.3, H['bon2'] - 0.15 * (k + 1), '유리문 뒤 내려가는 단(5단, 한 단 0.15 m 추정)', GG, '#b9b6ad', inVoid=True, basePlane='U03-VOID-PASS 바닥')
def void(i, c, lo, hi, name, note):
    feats.append({'type': 'Feature', 'properties': {'id': f'U03-{i}', 'type': 'void', 'kind': 'void', 'estimated': True, 'grade': GG, 'assumption': note, 'source': SRC, 'fromM': r2(lo), 'toM': r2(hi), 'name': name}, 'geometry': {'type': 'Polygon', 'coordinates': [ring(c)]}})
void('VOID-LOBBY', R(-1.6, 0.6, -1.6, 1.6), H['bon2'], H['bon2'] + 2.6, f"본관 2층 유리문 앞 {H['bon2']} m", '유리문 앞 바닥(본관 모서리 앞 계단 발치). 안 높이 2.6 m 추정')
void('VOID-STEPS', R(0.6, L, -1.0, 1.0), H['glassLow'], H['bon2'] + 2.4, '유리문 뒤 단', '단 자리의 빈 곳')
segs = [(GL, PASS[0], H['glassLow'], zmid), (PASS[0], PASS[1], zmid, H['yu7'])]; k = 0
for a, b, za, zb in segs:
    L, R = frame(a, b); n = max(1, round(L))
    for j in range(n):
        zf = za + (zb - za) * (j + 1) / n   # 마디의 낮은 끝
        void(f'VOID-PASS-{k:02d}', R(L * j / n, L * (j + 1) / n, -1.0, 1.0), zf, zf + 2.3, '본관 2층–유담관 7층 지하통로', f'흰 벽 통로(폭 2.0 m·안 높이 2.3 m 추정). 1 m 마디, 바닥 {zf:.2f} m'); k += 1
void('VOID-YUDAM7', [(24.4, 290.8), (27.4, 290.8), (27.4, 293.8), (24.4, 293.8)], H['yu7'], H['yu7'] + 2.6, f"유담관 7층 승강기 홀 {H['yu7']} m", '통로 끝 승강기 홀(3 × 3 m 추정)')
# 본관 정류장 쪽 큰 기둥 열과 큰 처마(블로그-20): 남쪽 면의 서쪽 벽 (33.4,319.4)~(48.2,312.1) 앞
GC = '원천(있음: 블로그-20. 둥근 흰 기둥 5개 이상, 2~3개 층 높이, 깊은 기와 처마), 추정(자리·치수·높이)'
WA, WB = (33.4, 319.4), (48.2, 312.1); L, R = frame(WA, WB)   # 왼손 법선 = 건물 안쪽(북동), 바깥은 t < 0
COLTOP = H['bon5']
for j in range(5):
    s = 1.6 + (L - 3.2) * j / 4; a0, b0 = WA[0] + (WB[0] - WA[0]) * s / L, WA[1] + (WB[1] - WA[1]) * s / L; u = ((WB[0] - WA[0]) / L, (WB[1] - WA[1]) / L); nx, ny = -u[1], u[0]
    cx, cy = a0 - nx * 2.0, b0 - ny * 2.0
    box(f'BONGWAN-COL-{j + 1}', 'wall', [(cx + 0.55 * math.cos(math.pi * q / 4), cy + 0.55 * math.sin(math.pi * q / 4)) for q in range(8)], 127.6, COLTOP, f'둥근 흰 기둥(여덟 모, 지름 1.1 m). 발치 127.6(본관 남쪽 평탄부 S-MAP), 머리 {COLTOP} m(5층 바닥: 2~3개 층 높이로 읽음)', GC, '#f4f2ec', basePlane='본관 남쪽 평탄부 127.6')
box('BONGWAN-COL-BEAM', 'wall', R(0.4, L - 0.4, -2.7, 0.0), COLTOP, COLTOP + 1.2, '기둥 위 보(돌 띠, 높이 1.2 m 추정)', GC, '#e6e1d6')
box('BONGWAN-COL-EAVE', 'canopy', R(-0.8, L + 0.8, -4.6, 0.0), COLTOP + 1.2, COLTOP + 1.75, '기둥 열 위 깊은 기와 처마(벽에서 4.6 m 내밂, 추정). 사진에서는 이 처마 바로 위가 큰 지붕인데 건물 모델의 벽은 그 위로 더 올라간다(본관 서쪽 부분의 지붕 높이 모름)', GC, '#6b7280')
(REPO / 'frontend/public/structures/u03-underground-walk.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
    'provenance': {'script': 'docs/audit/u03/build.py', 'note': '학교 지하도 걷는 길의 구조물: 파란 둥근 지붕 연결통로 둘, 본관 2층 유리문과 단, 본관–유담관 지하통로(빈 곳), 본관 정류장 쪽 기둥 열'}, 'features': feats}, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
model = {'heights': H, 'passage': {'lengthM': r2(L1 + L2), 'dropM': r2(H['glassLow'] - H['yu7']), 'gradePct': r2(passGrade)}, 'links': {'eunjuHanlimM': r2(len1), 'bongwanHanlimM': r2(len2)}, 'nodes': N,
         'points': {'ST': ST, 'EW': EW, 'P1A': P1A, 'P1B': P1B, 'HAN': HAN, 'EV_B': EV_B, 'HALL2': HALL2, 'COR2': COR2, 'GL': GL, 'PASS': PASS}, 'ops': len(ops), 'features': len(feats)}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), len(feats), model['passage'], model['links'])
