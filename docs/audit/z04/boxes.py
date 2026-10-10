# Z04 build_part2.py 가 같은 이름 공간에서 실행한다: 기단 위에 얹는 상자(계단·화단·문틀·차단기). 치수는 따로 적지 않으면 전부 추정이다.
def quad(p0, p1, w, away_from=None, side=1):
    """선분 p0→p1 의 한쪽으로 폭 w 인 네모. away_from(점)이 있으면 그 점에서 먼 쪽."""
    p0, p1 = np.array(p0, float), np.array(p1, float); v = (p1 - p0) / np.hypot(*(p1 - p0)); nrm = np.array([-v[1], v[0]]) * side
    if away_from is not None and np.dot((p0 + p1) / 2 + nrm - np.array(away_from), nrm) < 0: nrm = -nrm
    return Polygon([p0, p1, p1 + nrm * w, p0 + nrm * w])
def stairs(zone, sid, foot, top, width, n, z0, z1, assumption, source, grade='추정', basePlane=''):
    """foot→top(가운데 선)으로 n 단. 단마다 상자 하나(아래는 발치 높이 − 0.3 까지)."""
    foot, top = np.array(foot, float), np.array(top, float); v = top - foot; L = np.hypot(*v); v = v / L; w = np.array([-v[1], v[0]]) * width / 2
    for k in range(n):
        a, b = foot + v * L * k / n, foot + v * L * (k + 1) / n
        box(zone, f'{sid}-S{k + 1:02d}', 'stair_step', [a + w, b + w, b - w, a - w], z0 - 0.3, z0 + (k + 1) * (z1 - z0) / n, assumption, source, grade=grade, basePlane=basePlane, stair=sid, riseM=r2((z1 - z0) / n), runM=r2(L / n), widthM=width)

# ---- 가10 위쪽 갈래 ----
stairs('upper-branch', 'Z04-HANLIM-FRONT-STAIR', (201107.0, 557272.2), (201107.0, 557278.2), 6.0, 13, 125.2, 127.2,
       '한림관 1층 문 앞 계단: 차도(125.1~125.2 m)에서 북쪽으로 올라 1층 문 앞 단(127.2 m). 13단 = 2.0 m ÷ 0.154(사진 판독은 12단 ±3), 폭 6 m·디딤 0.46 m(눈대중). 자리는 S-MAP 이 6 m 에 걸쳐 오르는 곳',
       '사용자 확정(한림관 1층은 앞 길에서 계단 몇 개 위), 05-한림관1층-가는길-네이버거리뷰-202506.webp, streetview-main-p1-202602-03.png, ' + MESH, grade='확정(계단이 있음), S-MAP(위·아래 높이), 추정(단 수·폭)', basePlane='Z04-UPPER-U1')
stairs('upper-branch', 'Z04-HANLIM-WGAP-STAIR', (201100.4, 557290.5), (201101.6, 557312.0), 2.6, 52, 127.2, 135.3,
       '본관 동쪽 끝과 한림관 사이 틈을 오르는 계단(추정): S-MAP 이 22 m 에 8.1 m 오름. 52단 = 8.1 ÷ 0.156, 폭 2.6 m. 계단인지 경사로인지, 참이 있는지 모른다', MESH + ', 건물 노트 한림관(서쪽 틈 130.3~135.2)', basePlane='Z04-UPPER-HANLIM-WGAP')
# ---- 가11 뒤편·사잇길 ----
stairs('back-paths', 'Z04-MUNYE-3F-STEPS', (201111.2, 557336.4), (201109.4, 557337.3), 3.0, 4, 144.2, 144.8,
       '문예관 3층 로비 문 앞 계단: 갈림 지점 평탄면(144.2 m)에서 좌회전해 3~4칸(확정) -> 4단 × 0.15 m 로 문 앞 144.8 m. 자리는 시험용 DB 길 9112314a 의 선 위(±3 m), 폭 3 m(가정)',
       '사용자 확정(좌회전하고 계단 3~4칸, 오른쪽에 큰 자동문), 09-문예관입구1-3층로비-캠퍼스맵.webp', grade='확정(단 수 3~4), 추정(자리·폭)', basePlane='G02 FORK 144.2')
# ---- 혜인관 둘레: 운동장 남동 변의 화단 띠(입구 앞은 비움) ----
FC = (FIELD.centroid.x, FIELD.centroid.y)
for k, (a, b) in enumerate((((201244.2, 557257.3), (201228.3, 557230.0)), ((201217.9, 557213.4), (201201.7, 557185.8)))):
    box('hyein', f'Z04-HYEIN-PLANTER-{"NS"[k]}', 'planter', quad(a, b, 2.0, away_from=FC), 148.9, 149.5, '혜인관 앞 화단 띠: 운동장 경계(F05)에서 건물 쪽으로 폭 2.0 m(S-MAP 평지 가장자리와 건물 벽 사이 1.9~2.1 m). 높이 0.6 m 는 가정(화단 높이 기록 없음)',
        'docs/audit/e10/field-area-f05.geojson(경계), 실험 E10 F05 절(화단 발치 31.6 m·32.0 m), 01-혜인관-운동장쪽-1층과B1.jpg', grade='S-MAP(자리·폭), 추정(높이)', basePlane='운동장 148.9')
# ---- 은주관 둘레: 운동장 서쪽의 조금 높은 화단 띠(화단 사이 진입로는 비움), 풋살장 울타리 ----
ring_ = np.array(FIELD.exterior.coords); gapbox = sbox(201120, 557243.5, 201160, 557255.5); k = 0
for a, b in zip(ring_[:-1], ring_[1:]):
    if max(a[0], b[0]) < 201153 and 557226 < min(a[1], b[1]) and max(a[1], b[1]) < 557298 and np.hypot(*(b - a)) > 2:
        q = quad(a, b, 3.1, away_from=FC).difference(gapbox).difference(DONE)
        for part in (q.geoms if hasattr(q, 'geoms') else [q]):
            if part.area < 3: continue
            k += 1; box('eunju', f'Z04-EUNJU-FIELD-PLANTER-{k}', 'planter', part, 148.9, 149.65, '운동장 서쪽(은주1관 앞)의 조금 높은 화단 띠: 폭 3.1 m(S-MAP 2.9~3.3), 윗면 운동장 + 0.75 m(S-MAP 0.6~0.9). 북좌표 557243.5~557255.5 는 화단 사이 진입로라 비움',
                    '사용자 주석(운동장-구조표시.png: "조금 높은 화단", "화단 사이 진입로"), 실험 E10 F05 절, ' + MESH, grade='확정(화단과 진입로가 있음), S-MAP(자리·폭·높이)', basePlane='운동장 148.9')
SU = BLD['수인관']; pts_ = np.array(SU.exterior.coords); k = 0
for a, b in zip(pts_[:-1], pts_[1:]):
    L = np.hypot(*(b - a)); n = max(1, int(L // 12))
    for j in range(n):
        p, q = a + (b - a) * j / n, a + (b - a) * (j + 1) / n; k += 1
        box('eunju', f'Z04-FUTSAL-FENCE-{k:02d}', 'wall', LineString([p, q]).buffer(0.06, cap_style=2).intersection(SU.buffer(0.2)), 132.1, 135.6, '풋살장(수인관 옥상) 둘레 울타리: 옥상 가장자리를 따라 높이 3.5 m 그물 울타리로 봄(가정). S-MAP 에는 울타리가 없다. 실제 코트 구획·조명탑은 넣지 않음',
            '사용자 확정(풋살장이 수인관 옥상), 02-카카오위성-풋살파크12번-수인관.webp', grade='확정(옥상이 풋살장), 추정(울타리 자리·높이)', basePlane='수인관 지붕 132.1', material='fence')
# ---- 서문: 옹벽 면의 차량 출입구 두 칸 ----
WG = np.array([200984.0, 557399.5]); wv = np.array([0.0, 1.0])
for k, off in enumerate((-2.9, 0.0, 2.9)):
    c = WG + wv * off; box('west', f'Z04-WESTGATE-PIER-{k + 1}', 'wall', sbox(c[0] - 0.4, c[1] - 0.35, c[0] + 1.2, c[1] + 0.35), 117.0, 121.5, '서문 출입구 기둥(가운데 기둥으로 두 칸): 자리는 옹벽 면 x 200980.8~200986.6, 북좌표 557397~557402(S-MAP), 높이 4.5 m·칸 폭 2.9 m 는 사진 눈대중',
        '사용자-서문-공연실습소-생활관-20261010/서문.jpg, 실험 E09(터널 입구 자리, 문 앞 117.0 m)', grade='S-MAP(자리 ±3 m, 문 앞 높이), 추정(치수)', basePlane='서문 앞 공도 117.0')
box('west', 'Z04-WESTGATE-LINTEL', 'wall', sbox(WG[0] - 0.4, WG[1] - 3.3, WG[0] + 1.2, WG[1] + 3.3), 121.5, 123.0, '서문 문틀 윗보("SEOKYEONG UNIVERSITY WEST GATE" 글자가 있는 돌 옹벽 부분): 두께 1.5 m(눈대중). 터널 안쪽(층·경사·갈림)은 모름이라 만들지 않음', '서문.jpg', basePlane='Z04-WESTGATE-PIER')
# ---- 정문: 가로 보, 차단기 ----
G0 = np.array([201129.2, 557112.8]); gv = LINES['V1'][-1][:2] - LINES['V1'][0][:2]; gv = gv / np.hypot(*gv); gn = np.array([-gv[1], gv[0]]); zg = 107.1
for k, sgn in enumerate((-1, 1)):
    c = G0 + gn * sgn * 7.0; box('gate', f'Z04-GATE-POST-{k + 1}', 'wall', Polygon([c + gv * .5 + gn * .5, c + gv * .5 - gn * .5, c - gv * .5 - gn * .5, c - gv * .5 + gn * .5]), zg - 0.5, zg + 6.0, '정문 가로 보의 받침 기둥: 길 양쪽 7 m(평평한 띠 폭 13 m 의 바깥), 1 m 각, 높이 6 m. 모두 눈대중(보의 치수·기둥 자리 기록 없음)',
        'streetview-seogyeongro-202512.png(도로 위를 가로지르는 가로 보), 실험 E09(정문 표지 201129.2, 557112.8, 107.1 m)', grade='원천(정문 표지 자리), 추정(치수)', basePlane='Z04-GATE-V1')
box('gate', 'Z04-GATE-BEAM', 'canopy', Polygon([G0 + gn * 7.5 + gv * .6, G0 + gn * 7.5 - gv * .6, G0 - gn * 7.5 - gv * .6, G0 - gn * 7.5 + gv * .6]), zg + 5.2, zg + 6.2, '정문 가로 보: 길을 가로지르는 보 하나, 아래 높이 5.2 m·두께 1 m·길이 15 m(눈대중)', 'streetview-seogyeongro-202512.png', grade='원천(자리), 추정(치수)', basePlane='Z04-GATE-POST')
BR = np.array([float(np.interp(557165.0, LINES['V2'][:, 1], LINES['V2'][:, 0])), 557165.0]); zb = float(np.interp(BR[1], LINES['V2'][:, 1], LINES['V2'][:, 2]))
box('gate', 'Z04-GATE-BARRIER-POST', 'barrier', sbox(BR[0] - 3.9, BR[1] - .25, BR[0] - 3.4, BR[1] + .25), zb - 0.3, zb + 1.1, '차단기 기둥: 갈림 바로 위 차도, 북좌표 557165 부근(추정 ±10 m)', 'streetview-yudam-approach-202602-01.png, 실험 E09', basePlane='Z04-GATE-V2S')
box('gate', 'Z04-GATE-BARRIER-ARM', 'barrier', sbox(BR[0] - 3.4, BR[1] - .07, BR[0] + 3.0, BR[1] + .07), zb + 0.9, zb + 1.0, '차단기 막대: 차도 폭을 가로막음(추정)', 'streetview-yudam-approach-202602-01.png', basePlane='Z04-GATE-V2S')
