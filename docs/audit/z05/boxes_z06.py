# Z06: boxes.py 뒤에 같은 이름 공간에서 실행한다. 사진과 나란히 놓고 본 뒤 다시 만든 상자: 청운관 열린 기둥부(네모 평면), 혜인관 현관, 서문. 치수는 전부 사진 눈대중(추정)이다.
for _z in list(BOX):
    BOX[_z] = [f for f in BOX[_z] if not any(f['properties']['id'].startswith(p) for p in ('Z05-CHEONGUN-PORCH', 'Z05-HYEIN-PORCH', 'Z05-WESTGATE'))]
def frame(o, along, out):
    """벽 축 좌표계: o 에서 along 으로 s, 벽에서 바깥(out)으로 d. 돌려줌: R(s0, s1, d0, d1) = 그 네모, P(s, d) = 그 점."""
    o, a, n = np.array(o, float), unit(along), unit(out)
    return (lambda s0, s1, d0, d1: Polygon([o + a * s0 + n * d0, o + a * s1 + n * d0, o + a * s1 + n * d1, o + a * s0 + n * d1])), (lambda s, d: o + a * s + n * d)

# ---- 청운관 열린 기둥부: 사진 23·16 처럼 본체 벽에 붙은 네모 평면(Z05 는 S-MAP 외곽의 사다리꼴이었다) ----
# 본체의 운동장 쪽 벽: (201212.59, 557290.34) → (201228.91, 557273.46). S-MAP 돌출부 외곽의 앞 모서리 둘은 이 벽에서 4.5 m·7.1 m, 벽을 따라 6.3~17.0 m 자리다. 폭 11 m·깊이 6 m 의 네모로 잡았다.
cR, cP = frame((201212.59, 557290.34), (16.32, -16.88), (-16.88, -16.32))
CS0, CS1, CD = 6.2, 17.2, 6.0
CG6 = '확정(열린 기둥 구조·넓은 지붕·좌우 계단이 한 층 위 현관에서 만남·운동장 높이 문은 지하 1층), S-MAP(벽 선·지붕 163.8·1층 153.1), 추정(네모 평면 11 x 6 m, 판 높이, 기둥·난간·유리 치수, 계단 치수)'
for k, z in enumerate(CLV):
    box('cheongun', f'Z06-CHEONGUN-PORCH-SLAB-{k + 1}', 'deck', cR(CS0, CS1, 0, CD), z - 0.6, z, f'청운관 열린 기둥부의 층 판 {k + 1}/3: 윗면 {z} m' + (' = 1층 로비 앞 현관 바닥(좌우 계단이 만나는 곳)' if k == 0 else '') + '. 두께 0.6 m(사진에서 보의 두께가 기둥 폭과 비슷), 네모 평면', CSRC, grade=CG6, basePlane='없음(기둥 위 뜬 판)', material='concrete')
    gaps = [(CS0, 10.4), (13.0, CS1)] if k == 0 else [(CS0, CS1)]   # 1층 판은 계단 참이 닿는 가운데를 비운다
    for j, (a, b) in enumerate(gaps): box('cheongun', f'Z06-CHEONGUN-PORCH-RAIL-{k + 1}F{j + 1}', 'wall', cR(a, b, CD - 0.18, CD), z, z + 1.0, '층 판 앞 가장자리의 흰 난간벽(높이 1.0 m, 눈대중)', CSRC, grade=CG6, basePlane=f'Z06-CHEONGUN-PORCH-SLAB-{k + 1}', material='white_stone')
    for j, (a, b) in enumerate(((CS0, CS0 + 0.18), (CS1 - 0.18, CS1))): box('cheongun', f'Z06-CHEONGUN-PORCH-RAIL-{k + 1}S{j + 1}', 'wall', cR(a, b, 0, CD), z, z + 1.0, '층 판 옆 가장자리의 흰 난간벽', CSRC, grade=CG6, basePlane=f'Z06-CHEONGUN-PORCH-SLAB-{k + 1}', material='white_stone')
    box('cheongun', f'Z06-CHEONGUN-PORCH-GLASS-{k + 1}', 'wall', cR(CS0 + 0.5, CS1 - 0.5, 0.0, 0.25), z, (CLV[k + 1] - 0.6) if k < 2 else 163.0, f'현관 안쪽 벽(본체 벽 앞의 창·유리문 면, 층 {k + 1}). 문 자리·창 나눔은 모름', CSRC, grade=CG6, basePlane=f'Z06-CHEONGUN-PORCH-SLAB-{k + 1}', material='glass')
box('cheongun', 'Z06-CHEONGUN-PORCH-GLASS-B1', 'wall', cR(CS0 + 0.5, CS1 - 0.5, 0.0, 0.25), 148.9, CLV[0] - 0.6, '운동장 높이의 안쪽 벽(지하 1층 문이 있는 유리 면). 문 자리는 모름', CSRC, grade=CG6, basePlane='운동장 148.9', material='glass')
for k, sc in enumerate(np.linspace(CS0 + 0.45, CS1 - 0.45, 4)):
    for j, dc in enumerate((CD - 0.45, 0.45)):
        box('cheongun', f'Z06-CHEONGUN-PORCH-COLUMN-{k + 1}{"FB"[j]}', 'wall', cR(sc - 0.45, sc + 0.45, dc - 0.45, dc + 0.45), 148.9, 163.0, '청운관 열린 기둥부의 기둥: 0.9 m 각기둥(사진에서 칸 폭의 1/4쯤), 앞줄 4 + 벽 쪽 4, 운동장 바닥에서 지붕 밑까지', CSRC, grade=CG6, basePlane='운동장 148.9', material='white_stone')
box('cheongun', 'Z06-CHEONGUN-PORCH-EAVE', 'canopy', cR(CS0 - 1.8, CS1 + 1.8, 0.0, CD + 1.8), 163.0, 163.4, '넓은 지붕의 처마(판보다 1.8 m 내밂, 눈대중)', CSRC, grade=CG6, basePlane='없음(기둥 위)', material='concrete')
box('cheongun', 'Z06-CHEONGUN-PORCH-ROOF', 'canopy', cR(CS0 - 0.6, CS1 + 0.6, 0.0, CD + 0.6), 163.4, 163.8, '넓은 지붕의 윗부분: 윗면 163.8 m(S-MAP). 처마가 들린 모양은 싣지 않음', CSRC, grade=CG6, basePlane='Z06-CHEONGUN-PORCH-EAVE', material='concrete')
for tag, s_foot, s_top in (('L', 3.1, 10.4), ('R', 20.3, 13.0)):
    stairs('cheongun', f'Z06-CHEONGUN-PORCH-STAIR-{tag}', cP(s_foot, CD + 1.2), cP(s_top, CD + 1.2), 2.0, 26, 148.9, 153.1,
           f'청운관 현관으로 오르는 {"왼쪽" if tag == "L" else "오른쪽"} 비스듬한 계단(운동장에서 볼 때): 앞면과 나란히 바깥 끝에서 가운데로 오른다. 26단 = 4.2 m ÷ 0.162, 디딤 0.28 m, 폭 2 m. 계단 밑은 막힌 덩어리(사진의 흰 밑단)', CSRC, grade=CG6, basePlane='운동장 148.9')
    for j in range(4):
        a, b = s_foot + (s_top - s_foot) * j / 4, s_foot + (s_top - s_foot) * (j + 1) / 4; zt = 148.9 + 4.2 * (j + 1) / 4
        box('cheongun', f'Z06-CHEONGUN-PORCH-STAIR-{tag}-RAIL{j + 1}', 'wall', cR(min(a, b), max(a, b), CD + 2.2, CD + 2.38), 148.6, zt + 0.9, '계단 바깥쪽 흰 난간벽(네 마디로 줄임)', CSRC, grade=CG6, basePlane='운동장 148.9', material='white_stone')
box('cheongun', 'Z06-CHEONGUN-PORCH-LANDING', 'deck', cR(10.4, 13.0, CD, CD + 2.2), 152.5, 153.1, '좌우 계단이 만나는 참(1층 현관 판과 이어짐). 아래는 비어 있다: 지하 1층 문(운동장 높이)으로 드나드는 자리', CSRC, grade=CG6, basePlane='없음(뜬 판)', material='concrete')
box('cheongun', 'Z06-CHEONGUN-PORCH-LANDING-RAIL', 'wall', cR(10.4, 13.0, CD + 2.2, CD + 2.38), 153.1, 154.0, '참 앞 난간벽', CSRC, grade=CG6, basePlane='Z06-CHEONGUN-PORCH-LANDING', material='white_stone')

# ---- 혜인관 운동장 쪽 현관: 사진 01 처럼 붉은 벽돌 덩어리(아래 B1 문, 위 1층 아치), 붉은 기와 모임지붕, 오른쪽 계단 ----
hRc, hP = frame(hD, hw, hn)   # s = 벽을 따라(북동으로 +), d = 운동장 쪽
HG6 = HG + ', 추정(벽·아치·지붕 모양: 사진 눈대중)'
for k, (a, b) in enumerate(((-3.6, -3.2), (3.2, 3.6))): box('hyein', f'Z06-HYEIN-PORCH-SIDE-{k + 1}', 'wall', hRc(a, b, 0, 3.8), 149.0, 153.1, '혜인관 현관 아래층(B1) 옆 벽: 붉은 벽돌. 폭 7.2 m, 깊이 3.8 m', HSRC2, grade=HG6, basePlane='혜인관 둘레 149.0', material='brick')
for k, (a, b) in enumerate(((-3.6, -1.4), (1.4, 3.6))): box('hyein', f'Z06-HYEIN-PORCH-FRONT-{k + 1}', 'wall', hRc(a, b, 3.4, 3.8), 149.0, 152.7, '현관 아래층 앞 벽(벽돌). 가운데 2.8 m 는 B1 유리문', HSRC2, grade=HG6, basePlane='혜인관 둘레 149.0', material='brick')
box('hyein', 'Z06-HYEIN-PORCH-DOOR-B1', 'wall', hRc(-1.4, 1.4, 3.45, 3.7), 149.0, 151.6, 'B1 유리문(운동장 높이의 문): 폭 2.8 m·높이 2.6 m 눈대중', HSRC2, grade=HG6, basePlane='혜인관 둘레 149.0', material='glass')
box('hyein', 'Z06-HYEIN-PORCH-DOOR-HEAD', 'wall', hRc(-1.4, 1.4, 3.4, 3.8), 151.6, 152.7, 'B1 문 위 벽(간판 자리)', HSRC2, grade=HG6, basePlane='없음', material='brick')
box('hyein', 'Z06-HYEIN-PORCH-FLOOR-1F', 'deck', hRc(-3.6, 3.6, 0, 3.8), 152.7, 153.1, '혜인관 현관의 1층 바닥(계단 위 로비 앞): 153.1 m. 아래는 B1 문 안쪽', HSRC2, grade=HG6, basePlane='없음(벽 위)', material='concrete')
for k, sc in enumerate((-3.3, -1.1, 1.1, 3.3)):
    box('hyein', f'Z06-HYEIN-PORCH-PIER-{k + 1}', 'wall', hRc(sc - 0.3, sc + 0.3, 3.2, 3.8), 153.1, 156.3, '1층 현관 앞면의 벽돌 기둥(기둥 넷 = 아치 셋, 사진 눈대중)', HSRC2, grade=HG6, basePlane='Z06-HYEIN-PORCH-FLOOR-1F', material='brick')
for k, sc in enumerate((-3.3, 3.3)):
    box('hyein', f'Z06-HYEIN-PORCH-PIER-B{k + 1}', 'wall', hRc(sc - 0.3, sc + 0.3, 0.0, 0.6), 153.1, 156.3, '1층 현관 옆면의 벽 쪽 기둥', HSRC2, grade=HG6, basePlane='Z06-HYEIN-PORCH-FLOOR-1F', material='brick')
box('hyein', 'Z06-HYEIN-PORCH-HEADER', 'wall', hRc(-3.6, 3.6, 3.2, 3.8), 155.5, 156.3, '아치 위 벽돌 벽(아치 꼭대기 155.5 m, 둥근 모양은 싣지 않음)', HSRC2, grade=HG6, basePlane='없음(기둥 위)', material='brick')
for k, (a, b) in enumerate(((-3.6, -3.0), (3.0, 3.6))): box('hyein', f'Z06-HYEIN-PORCH-SIDE-HEADER-{k + 1}', 'wall', hRc(a, b, 0.0, 3.2), 155.5, 156.3, '옆면 아치 위 벽돌 벽', HSRC2, grade=HG6, basePlane='없음(기둥 위)', material='brick')
box('hyein', 'Z06-HYEIN-PORCH-EAVE', 'canopy', hRc(-4.3, 4.3, 0, 4.5), 156.3, 156.7, '흰 처마 띠(벽보다 0.7 m 내밂)', HSRC2, grade=HG6, basePlane='없음(벽 위)', material='white_stone')
box('hyein', 'Z06-HYEIN-PORCH-ROOF-1', 'canopy', hRc(-3.9, 3.9, 0, 4.1), 156.7, 157.7, '붉은 기와 모임지붕 아랫단(기울기를 두 단 상자로 줄임)', HSRC2, grade=HG6, basePlane='Z06-HYEIN-PORCH-EAVE', material='roof_red')
box('hyein', 'Z06-HYEIN-PORCH-ROOF-2', 'canopy', hRc(-2.6, 2.6, 0, 2.8), 157.7, 158.6, '붉은 기와 모임지붕 윗단', HSRC2, grade=HG6, basePlane='Z06-HYEIN-PORCH-ROOF-1', material='roof_red')
stairs('hyein', 'Z06-HYEIN-PORCH-STAIR', hP(-11.1, 1.6), hP(-3.6, 1.6), 2.6, 26, 149.0, 153.1, '혜인관 현관 오른쪽 계단(운동장에서 볼 때): 벽을 따라 현관 쪽으로 올라 1층 바닥에 닿는다. 26단 = 4.1 m ÷ 0.158, 디딤 0.29 m, 폭 2.6 m(사진 눈대중)', HSRC2, grade=HG6, basePlane='혜인관 둘레 149.0')
for j in range(4):
    a, b = -11.1 + 7.5 * j / 4, -11.1 + 7.5 * (j + 1) / 4
    box('hyein', f'Z06-HYEIN-PORCH-STAIR-RAIL{j + 1}', 'wall', hRc(a, b, 2.9, 3.1), 148.7, 149.0 + 4.1 * (j + 1) / 4 + 0.9, '계단 운동장 쪽 돌 난간벽(네 마디로 줄임)', HSRC2, grade=HG6, basePlane='혜인관 둘레 149.0', material='white_stone')

# ---- 서문: 사진처럼 넓은 문 세 칸(차량 두 칸 3.8·3.4 m + 좁은 칸 2.0 m), 그 위는 글자가 있는 돌 옹벽 면. Z05 는 2.9 m 두 칸이라 좁았다 ----
_w0 = np.array([wx(557399.5), 557399.5]); wR, wP = frame(_w0, WDIR, (-1.0, -0.1375))   # s = 옹벽 면을 따라 북으로, d = 공도 쪽
WSRC = '사용자-서문-공연실습소-생활관-20261010/서문.jpg, 실험 E09(터널 입구 자리, 문 앞 117.0 m)'; WG6 = 'S-MAP(자리 ±3 m, 문 앞 높이), 추정(칸 수·폭·높이: 사진에서 칸 높이를 4 m 로 보고 잰 비)'
for k, (a, b) in enumerate(((-7.0, -6.0), (-2.2, -1.2), (2.2, 3.2), (5.2, 6.2))):
    box('west', f'Z06-WESTGATE-PIER-{k + 1}', 'wall', wR(a, b, -0.2, 0.7), 116.5, 121.0, '서문 문 기둥(돌): 기둥 넷 = 칸 셋', WSRC, grade=WG6, basePlane='Z05-WEST-STREET', material='stone')
box('west', 'Z06-WESTGATE-LINTEL', 'wall', wR(-7.0, 6.2, -0.2, 0.7), 121.0, 123.6, '서문 문틀 위("SEOKYEONG UNIVERSITY WEST GATE" 글자가 있는 돌 면): 높이 2.6 m(눈대중). 그 위는 화단', WSRC, grade=WG6, basePlane='Z06-WESTGATE-PIER', material='stone')
box('west', 'Z06-WESTGATE-OPENING', 'canopy', wR(-6.0, 5.2, -0.1, 0.1), 117.0, 121.0, '서문 터널 입구: 옹벽 면의 뚫린 곳을 나타내는 어두운 판(세 칸). 터널 안(층·경사·갈림)은 모름이라 비우지 않았다', WSRC, grade=WG6, basePlane='Z05-WEST-STREET', material='opening')
