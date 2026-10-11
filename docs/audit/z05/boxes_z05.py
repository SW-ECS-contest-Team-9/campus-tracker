# Z05 boxes.py 가 같은 이름 공간에서 실행한다: Z05 에서 새로 얹는 상자. 치수는 따로 적지 않으면 전부 사진 눈대중(추정)이다.
U1D, U3D = '사용자-출입구·주차장-20261010/', '사용자-SMAP높이-20261010/'
def unit(v): v = np.array(v, float); return v / np.hypot(*v)
def rect(c, along, half_len, half_w):
    c, a = np.array(c, float), unit(along); n = np.array([-a[1], a[0]]); return Polygon([c - a * half_len - n * half_w, c + a * half_len - n * half_w, c + a * half_len + n * half_w, c - a * half_len + n * half_w])
def portal(zone, pid, c, into, width, z0, height, assumption, source, grade, basePlane):
    """벽면의 차량 출입구: 기둥 둘 + 윗보 + 어두운 안쪽 판(뚫린 곳으로 읽히게). c = 문턱 가운데, into = 들어가는 방향."""
    c, d = np.array(c, float), unit(into); a = np.array([-d[1], d[0]])
    for k, s in enumerate((-1, 1)): box(zone, f'{pid}-PIER-{k + 1}', 'wall', rect(c + a * s * (width / 2 + 0.3) + d * 0.4, d, 0.5, 0.3), z0, z0 + height, assumption, source, grade=grade, basePlane=basePlane)
    box(zone, f'{pid}-LINTEL', 'wall', rect(c + d * 0.4, d, 0.5, width / 2 + 0.6), z0 + height, z0 + height + 0.8, assumption, source, grade=grade, basePlane=basePlane)
    box(zone, f'{pid}-OPENING', 'canopy', rect(c + d * 1.0, d, 0.1, width / 2), z0, z0 + height, assumption + ' 어두운 판은 뚫린 곳을 나타내는 표시다(안쪽 빈 곳은 만들지 않음: 안의 선·바닥 높이 모름)', source, grade=grade, basePlane=basePlane, material='opening')

# ---- 청운관 운동장 쪽 열린 기둥부(사용자 2026-10-11: 좌우 계단은 한 층 위 1층 로비 앞 현관에서 만난다. 운동장 높이의 문은 지하 1층) ----
CH = Polygon([(201221.15, 557275.04), (201211.87, 557280.87), (201212.23, 557290.03), (201212.59, 557290.34), (201228.91, 557273.46)])
cA, cB = np.array([201221.15, 557275.04]), np.array([201211.87, 557280.87]); ce = unit(cA - cB); cn = np.array([ce[1], -ce[0]]); cn = cn if cn[1] < 0 else -cn; cC = (cA + cB) / 2; cL = float(np.hypot(*(cA - cB)))
CSRC = U3D + '사진-23-청운관-열린돌출부.png, 사진-16-청운관-지붕-계단.png, 건물 노트 청운관(돌출부 외곽·지붕 163.8 m), 사용자 답 2026-10-11'
CG = '확정(열린 기둥 구조·넓은 지붕·좌우 계단이 한 층 위 현관에서 만남), S-MAP(외곽·지붕 163.8·1층 153.1), 추정(판 높이·기둥 자리·계단 치수)'
CLV = [153.1, 156.65, 160.2]   # 1층 현관 판(S-MAP 이 돌출부 안쪽과 안쪽 마당에서 읽는 153.1 m), 그 위 두 판은 지붕까지를 같은 간격으로 나눈 값(사진에서 운동장~지붕 네 칸)
for k, z in enumerate(CLV):
    box('cheongun', f'Z05-CHEONGUN-PORCH-SLAB-{k + 1}', 'deck', CH, z - 0.4, z, f'청운관 열린 기둥부의 층 판 {k + 1}/3: 윗면 {z} m' + (' = 1층 로비 앞 현관 바닥(좌우 계단이 만나는 곳)' if k == 0 else '') + '. 두께 0.4 m, 평면은 S-MAP 돌출부 외곽 그대로(사진의 네모 평면과 다를 수 있다)', CSRC, grade=CG, basePlane='없음(기둥 위 뜬 판)', material='concrete')
box('cheongun', 'Z05-CHEONGUN-PORCH-ROOF', 'canopy', CH.buffer(1.2, join_style=2), 163.2, 163.8, '청운관 열린 기둥부의 넓은 지붕: 윗면 163.8 m(S-MAP), 판보다 1.2 m 내밂(사진 눈대중), 두께 0.6 m', CSRC, grade=CG, basePlane='없음(기둥 위)', material='concrete')
for k in range(4):
    c = cB + ce * (0.6 + k * (cL - 1.2) / 3) - cn * 0.5
    box('cheongun', f'Z05-CHEONGUN-PORCH-COLUMN-{k + 1}', 'wall', rect(c, ce, 0.35, 0.35), 148.9, 163.2, '청운관 열린 기둥부의 앞줄 기둥 4개(세 칸): 0.7 m 각기둥, 운동장 바닥에서 지붕 밑까지. 자리는 앞 변을 고르게 나눈 것(사진에서 기둥 넷)', CSRC, grade=CG, basePlane='운동장 148.9')
for tag, sg in (('L', -1), ('R', 1)):
    stairs('cheongun', f'Z05-CHEONGUN-PORCH-STAIR-{tag}', cC + ce * sg * 8.6 + cn * 1.4, cC + ce * sg * 1.3 + cn * 1.4, 2.0, 26, 148.9, 153.1,
           f'청운관 현관으로 오르는 {"왼쪽" if sg < 0 else "오른쪽"} 비스듬한 계단(운동장에서 볼 때): 앞 변과 나란히 바깥 끝에서 가운데로 오른다. 26단 = 4.2 m ÷ 0.162, 디딤 0.28 m, 폭 2 m. 발치·꼭대기 자리는 사진 눈대중',
           CSRC, grade=CG, basePlane='운동장 148.9')
box('cheongun', 'Z05-CHEONGUN-PORCH-LANDING', 'deck', rect(cC + cn * 1.2, ce, 1.3, 1.2), 152.7, 153.1, '좌우 계단이 만나는 참(1층 현관 판과 이어짐). 아래는 비어 있다: 지하 1층 문(운동장 높이)으로 드나드는 자리', CSRC, grade=CG, basePlane='없음(뜬 판)', material='concrete')

# ---- 혜인관 운동장 쪽 현관: 운동장 높이의 문은 B1, 오른쪽 계단을 오르면 1층 로비(사용자 확정 2026-10-10) ----
hD = np.array([201218.7, 557213.7]); hw = unit((45.0, 77.0)); hn = np.array([-hw[1], hw[0]]); hR = -hw   # hw = 운동장 쪽 벽 방향(북동으로), hn = 운동장 쪽, hR = 운동장에서 볼 때 오른쪽
HSRC2 = U1D + '01-혜인관-운동장쪽-1층과B1.jpg, 건물 노트 혜인관(입구(1) 표지, 층고 4.11 m)'
HG = '확정(운동장 높이 문 = B1, 오른쪽 계단 위가 1층), 원천(문 자리), 추정(현관·계단 치수, 1층 153.1 m = 149.0 + 층고 4.11)'
for k, s in enumerate((-1, 1)): box('hyein', f'Z05-HYEIN-PORCH-PIER-{k + 1}', 'wall', rect(hD + hw * s * 3.2 + hn * 1.9, hn, 1.9, 0.4), 149.0, 157.0, '혜인관 현관 돌출부의 옆 벽(붉은 벽돌): 폭 7.2 m, 깊이 3.8 m, 높이 8 m(두 층)', HSRC2, grade=HG, basePlane='혜인관 둘레 149.0')
box('hyein', 'Z05-HYEIN-PORCH-FLOOR-1F', 'deck', rect(hD + hn * 1.9, hw, 3.6, 1.9), 152.7, 153.1, '혜인관 현관 돌출부의 1층 바닥(계단 위 로비 앞): 153.1 m. 아래는 B1 문(운동장 높이)', HSRC2, grade=HG, basePlane='없음(뜬 판)', material='concrete')
box('hyein', 'Z05-HYEIN-PORCH-ROOF', 'canopy', rect(hD + hn * 2.0, hw, 4.1, 2.4), 157.0, 158.6, '혜인관 현관 돌출부의 붉은 지붕(사진의 모임지붕을 납작한 덩어리로)', HSRC2, grade=HG, basePlane='현관 옆 벽')
stairs('hyein', 'Z05-HYEIN-PORCH-STAIR', hD + hR * 11.1 + hn * 1.6, hD + hR * 3.6 + hn * 1.6, 2.6, 26, 149.0, 153.1, '혜인관 현관 오른쪽 계단(운동장에서 볼 때): 벽을 따라 현관 쪽으로 올라 1층 바닥에 닿는다. 26단 = 4.1 m ÷ 0.158, 디딤 0.29 m, 폭 2.6 m(사진 눈대중)', HSRC2, grade=HG, basePlane='혜인관 둘레 149.0')

# ---- 북악관 입구(3): 남서 모서리의 1층 복도 문 앞 계단(계단이 있다는 것과 높이차 2.6~2.9 m 는 보행 기록, 방향·단 수는 추정) ----
# Z10: 입구(3) 계단을 건물 서쪽 모서리 옆으로 옮긴다. 거리뷰 GS25 01·02: 문은 정면의 맨 서쪽 칸(GS25 간판이 붙은 모서리 기둥 바로 옆)이고, 계단은 회차 공간 쪽으로 곧게 내려오며 양옆에 비스듬한 화강석 난간벽이 있다. Z05 의 자리(모서리에서 9.5 m)는 표지 ±7 m 로 잡은 것이었다
bf = unit((78.0, -41.0)); bn = np.array([bf[1], -bf[0]]); bn = bn if bn[1] < 0 else -bn   # bf = 남서 정면 방향, bn = 포장면 쪽
b3 = np.array([201004.8, 557387.2]) + bf * 4.0   # 서쪽 모서리에서 정면을 따라 4.0 m = 계단 가운데(모서리 기둥 1.5 m + 계단 폭 5 m 의 반)
# Z11: 바깥 계단은 12단(거리뷰 02 에서 센 수)이고 문 앞 참은 133.3 m 다. 1층 복도 134.1 m 까지 남는 0.8 m 는 문 안의 단(정문이 바깥 12단 + 안쪽 5단인 것과 같은 짜임: 사용자 확정은 정문만, 입구(3)은 추정).
#      보행 기록의 2.6~2.9 m 는 1층 복도에서 바깥 바닥까지라 그대로다(줄이지 않는다). 17단은 그 전체를 바깥 계단 하나에 실은 계산이었다
BSRC = '건물 노트 북악관(입구(3): 1층 복도 134.1 m, 문 앞 참 133.3 m, 문 앞 지면 131.4 m, 보행 기록의 높이차 2.6~2.9 m = 바깥 12단 1.9 m + 문 안 0.8 m), streetview-bukak-gs25-202502-01.png, streetview-bukak-gs25-202502-02.png'
BG = '확정(자리: 정면 맨 서쪽 칸, 회차 공간 쪽으로 곧게 내려옴, 양옆 화강석 난간벽: 거리뷰), 원천(층), S-MAP(문 앞 지면), 확정(바깥 계단 12단 안팎: 거리뷰에서 셈), 추정(단 높이 0.158 m·폭 5 m, 문 앞 참 133.3 = 131.4 + 12단, 문 안의 단 0.8 m)'
stairs('back-paths', 'Z05-BUKAK-ENTRANCE3-STAIR', b3 + bn * 6.2, b3 + bn * 1.4, 5.0, 12, 131.4, 133.3, '북악관 입구(3) 앞 계단: 포장면(131.4 m)에서 정면 벽 쪽으로 12단(단 높이 0.158 m, 디딤 0.40 m) 올라 문 앞 참(133.3 m). 1층 복도(134.1 m)까지 남는 0.8 m 는 문 안의 단(추정)', BSRC, grade=BG, basePlane='회차 공간 포장면')
box('back-paths', 'Z05-BUKAK-ENTRANCE3-LANDING', 'landing', rect(b3 + bn * 0.7, bf, 2.5, 0.7), 131.1, 133.3, '북악관 입구(3) 문 앞 참 133.3 m(유리문이 이 높이에 있다: 거리뷰 02)', BSRC, grade=BG, basePlane='회차 공간 포장면')
for _side, _s in (('W', -2.5), ('E', 2.5)):   # 비스듬한 화강석 난간벽: 네 마디로 줄임(윗선 = 그 마디 위쪽 끝의 디딤 높이 + 0.9 m), 문 앞 참 옆은 한 높이
    for _j in range(4):
        _d0, _d1 = 6.2 - 4.8 * _j / 4, 6.2 - 4.8 * (_j + 1) / 4
        box('back-paths', f'Z10-BUKAK-ENTRANCE3-CHEEK-{_side}{_j + 1}', 'wall', rect(b3 + bf * (_s + (0.2 if _s > 0 else -0.2)) + bn * (_d0 + _d1) / 2, bn, (_d0 - _d1) / 2, 0.2), 131.0, 131.4 + 1.9 * (_j + 1) / 4 + 0.9, '입구(3) 계단 옆의 비스듬한 화강석 난간벽(두께 0.4 m, 디딤 위 0.9 m: 거리뷰 눈대중). 네 마디의 단으로 줄여 그림', BSRC, grade=BG, basePlane='회차 공간 포장면', material='stone')
    box('back-paths', f'Z10-BUKAK-ENTRANCE3-CHEEK-{_side}5', 'wall', rect(b3 + bf * (_s + (0.2 if _s > 0 else -0.2)) + bn * 0.7, bn, 0.7, 0.2), 131.0, 134.2, '입구(3) 문 앞 참 옆 난간벽', BSRC, grade=BG, basePlane='회차 공간 포장면', material='stone')
box('back-paths', 'Z10-BUKAK-ENTRANCE3-DOOR', 'wall', rect(b3 + bn * 0.06, bf, 2.0, 0.08), 133.3, 136.2, '입구(3) 유리문 면(폭 4 m, 높이 2.9 m: 거리뷰 눈대중)', BSRC, grade=BG, basePlane='Z05-BUKAK-ENTRANCE3-LANDING', material='glass')

# ---- 주차장 입구(벽면의 문틀) ----
pl = LINES['P-LOW']; pu = LINES['P-UP']
portal('gate', 'Z05-PARKING1-PORTAL', pl[-1, :2], pl[-1, :2] - pl[-4, :2], 6.0, float(pl[-1, 2]), 3.2, '제1주차장(표지판 P2) 입구: 차로 끝(문턱 106.1 m, 덮개 직전)의 문틀. 폭 6 m·높이 3.2 m 는 사진 눈대중.',
       U1D + '02-제1주차장-정문옆.jpg, 실험 E09(입구 201099.8, 557146.2)', '확정(자리), S-MAP(문턱 높이), 추정(치수)', 'Z05-GATE-PLOW')
portal('yudam9', 'Z05-PARKING2-PORTAL', (201021.9, 557307.1), pu[-1, :2] - pu[0, :2], 6.0, 127.9, 3.0, '제2주차장(표지판 P1) 입구: 사용자 표시 자리(문턱 127.9 ±1.5 m)의 문틀. 곡선 석축 화단 아래로 내려간다. 폭 6 m·높이 3 m 는 눈대중, 들어가는 방향은 차로 방향.',
       '사용자-서문·제2주차장·수인관-20261010/01-SMAP-서문·제2주차장-사용자표시.webp, 실험 E09', '확정(자리: 사용자 표시), S-MAP(문턱 높이), 추정(치수·방향)', 'Z05-YUDAM9-PUP')
box('west', 'Z05-WESTGATE-OPENING', 'canopy', sbox(wx(557399.5) - 0.2, 557399.5 - 2.9, wx(557399.5), 557399.5 + 2.9), 117.0, 121.5, '서문 터널 입구: 옹벽 면의 뚫린 곳을 나타내는 어두운 판(두 칸). 터널 안(층·경사·갈림)은 모름이라 비우지 않았다', '사용자-서문-공연실습소-생활관-20261010/서문.jpg, 실험 E09', grade='S-MAP(자리 ±3 m), 추정(치수)', basePlane='Z05-WEST-STREET', material='opening')
