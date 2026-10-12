# Z06: boxes.py 뒤에 같은 이름 공간에서 실행한다. 사진과 나란히 놓고 본 뒤 다시 만든 상자: 청운관 열린 기둥부(네모 평면), 혜인관 현관, 서문. 치수는 전부 사진 눈대중(추정)이다.
for _z in list(BOX):
    BOX[_z] = [f for f in BOX[_z] if not any(f['properties']['id'].startswith(p) for p in ('Z05-CHEONGUN-PORCH', 'Z05-HYEIN-PORCH', 'Z05-WESTGATE'))]
def frame(o, along, out):
    """벽 축 좌표계: o 에서 along 으로 s, 벽에서 바깥(out)으로 d. 돌려줌: R(s0, s1, d0, d1) = 그 네모, P(s, d) = 그 점."""
    o, a, n = np.array(o, float), unit(along), unit(out)
    return (lambda s0, s1, d0, d1: Polygon([o + a * s0 + n * d0, o + a * s1 + n * d0, o + a * s1 + n * d1, o + a * s0 + n * d1])), (lambda s, d: o + a * s + n * d)

# ---- 청운관 열린 기둥부: B15 에서 docs/audit/b15/porch.py 로 옮겼다(사진 11 에 맞춰 틀 폭 15.6 m, 계단은 오른쪽 한 줄, 첫 단 판이 안쪽 마당까지). 여기서는 Z05 상자만 걷는다 ----

# ---- 혜인관 운동장 쪽 현관: B13 에서 docs/audit/b13/build_parts.py 로 옮겼다(자리를 출입부 가운데로, 계단 양쪽, 줄무늬 가림벽). 여기서는 Z05 상자만 걷는다 ----

# ---- 서문: 사진처럼 넓은 문 세 칸(차량 두 칸 3.8·3.4 m + 좁은 칸 2.0 m), 그 위는 글자가 있는 돌 옹벽 면. Z05 는 2.9 m 두 칸이라 좁았다 ----
_w0 = np.array([wx(557399.5), 557399.5]); wR, wP = frame(_w0, WDIR, (-1.0, -0.1375))   # s = 옹벽 면을 따라 북으로, d = 공도 쪽
WSRC = '사용자-서문-공연실습소-생활관-20261010/서문.jpg, 실험 E09(터널 입구 자리, 문 앞 117.0 m)'; WG6 = 'S-MAP(자리 ±3 m, 문 앞 높이), 추정(칸 수·폭·높이: 사진에서 칸 높이를 4 m 로 보고 잰 비)'
for k, (a, b) in enumerate(((-7.0, -6.0), (-2.2, -1.2), (2.2, 3.2), (5.2, 6.2))):
    box('west', f'Z06-WESTGATE-PIER-{k + 1}', 'wall', wR(a, b, -0.2, 0.7), 116.5, 121.0, '서문 문 기둥(돌): 기둥 넷 = 칸 셋', WSRC, grade=WG6, basePlane='Z05-WEST-STREET', material='stone')
box('west', 'Z06-WESTGATE-LINTEL', 'wall', wR(-7.0, 6.2, -0.2, 0.7), 121.0, 123.6, '서문 문틀 위("SEOKYEONG UNIVERSITY WEST GATE" 글자가 있는 돌 면): 높이 2.6 m(눈대중). 그 위는 화단', WSRC, grade=WG6, basePlane='Z06-WESTGATE-PIER', material='stone')
box('west', 'Z06-WESTGATE-OPENING', 'canopy', wR(-6.0, 5.2, -0.1, 0.1), 117.0, 121.0, '서문 터널 입구: 옹벽 면의 뚫린 곳을 나타내는 어두운 판(세 칸). 터널 안(층·경사·갈림)은 모름이라 비우지 않았다', WSRC, grade=WG6, basePlane='Z05-WEST-STREET', material='opening')
