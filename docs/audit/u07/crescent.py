"""U07: 학교 지하도 지도(블로그-03, 816 화소)에서 운동장 지하 주차장 서쪽의 굽은 부채꼴 띠(층 사이 경사로 표시)의 외곽을 화소로 읽어 좌표로 옮긴다. DB·네트워크 접근 없음.   python crescent.py
방법: 표시 둘레를 8배로 키우고 배경보다 어두운 무채색 덩어리를 고른다. 줄마다 서쪽 끝 = 바깥 호, 동쪽 끝 = 안쪽 호. 바깥 호에 원을 맞추고(중심), 안쪽 호는 같은 중심에서의 평균 거리.
두 끝은 가는 꼬리 선의 끝까지다(채운 색은 남쪽으로 갈수록 옅어진다). 좌표는 ../u02/georef.json(800 화소 그림 02 에 맞춘 변환. 블로그-03 은 같은 그림의 816 화소본이라 화소에 800/816 을 곱한다).
쓰는 파일: crescent.json. 그림은 볼트에 있다(저장소에 넣지 않는다)."""
import json, pathlib
import numpy as np, cv2
from PIL import Image
HERE = pathlib.Path(__file__).parent
IMG = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/사용자-운동장지하-20261012/블로그-사진/블로그-03.jpg')
GEO = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(GEO['matrix'])
K = 8; X0, Y0, X1, Y1 = 392, 367, 438, 433
im = Image.open(IMG).convert('RGB'); F = 800 / im.width
a = np.asarray(im.crop((X0, Y0, X1, Y1)).resize(((X1 - X0) * K, (Y1 - Y0) * K), Image.BICUBIC)).astype(float); g = a.mean(2); bg = np.median(g)
m = ((g < bg - 7) & (a.max(2) - a.min(2) < 25)).astype(np.uint8) * 255
m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(m); i = max((k for k in range(1, n) if st[k, 0] > 60), key=lambda k: st[k, 4]); mm = lab == i
rows = [(y, np.where(mm[y])[0]) for y in range(mm.shape[0]) if mm[y].any()]
px800 = lambda p: (np.array([X0, Y0]) + (np.asarray(p, float) + 0.5) / K - 0.5) * F          # 키운 그림의 화소 → 800 화소 그림의 화소
world = lambda p: np.r_[px800(p), 1.0] @ MX
outer = np.array([world((r.min(), y)) for y, r in rows])
def circle(p):
    A = np.c_[2 * p, np.ones(len(p))]; s = np.linalg.lstsq(A, (p ** 2).sum(1), rcond=None)[0]; c = s[:2]; R = float(np.sqrt(s[2] + c @ c)); return c, R, float(np.sqrt(((np.hypot(*(p - c).T) - R) ** 2).mean()))
C, R_OUT, RMS_OUT = circle(outer)
bear = lambda p: float(np.degrees(np.arctan2(p[0] - C[0], p[1] - C[1])) % 360)   # 중심에서 본 방위(북 0, 동 90)
# 안쪽 호: 표시의 가운데 줄들(위쪽은 주차 칸 선이, 아래쪽은 바깥 호의 꼬리가 동쪽 끝에 섞인다)에서 줄의 동쪽 끝
ys = [y for y, _ in rows]; y_lo, y_hi = ys[0] + 0.38 * (ys[-1] - ys[0]), ys[0] + 0.66 * (ys[-1] - ys[0])
inner = np.array([world((r.max(), y)) for y, r in rows if y_lo <= y <= y_hi]); rin = np.hypot(*(inner - C).T); R_IN = float(np.median(rin)); RMS_IN = float(np.sqrt(((rin - R_IN) ** 2).mean()))
B_N, B_S = bear(outer[0]), bear(outer[-1])                                        # 북쪽 끝(꼬리 끝), 남쪽 끝(꼬리 끝)
arc = lambda R, b0, b1, k=40: [C + R * np.array([np.sin(np.radians(b)), np.cos(np.radians(b))]) for b in np.linspace(b0, b1, k)]
outline = arc(R_OUT, B_S, B_N) + arc(R_IN, B_N, B_S)
r2 = lambda v: round(float(v), 2)
PX = float(np.hypot(*MX[0]) + np.hypot(*MX[1])) / 2 * F                          # 블로그-03 의 한 화소(m)
out = {'image': IMG.name, 'method': '어두운 무채색 덩어리(배경 - 7), 8배 확대. 바깥 호에 원 맞춤, 안쪽 호는 같은 중심', 'centre': [r2(C[0]), r2(C[1])], 'outerRadiusM': r2(R_OUT), 'innerRadiusM': r2(R_IN), 'widthM': r2(R_OUT - R_IN), 'centreRadiusM': r2((R_OUT + R_IN) / 2),
       'bearingNorthEndDeg': r2(B_N), 'bearingSouthEndDeg': r2(B_S), 'spanDeg': r2(B_N - B_S), 'centreLineLengthM': r2(np.radians(B_N - B_S) * (R_OUT + R_IN) / 2), 'areaM2': r2(np.radians(B_N - B_S) / 2 * (R_OUT ** 2 - R_IN ** 2)),
       'northEnd': {'outer': [r2(v) for v in arc(R_OUT, B_N, B_N, 1)[0]], 'inner': [r2(v) for v in arc(R_IN, B_N, B_N, 1)[0]]}, 'southEnd': {'outer': [r2(v) for v in arc(R_OUT, B_S, B_S, 1)[0]], 'inner': [r2(v) for v in arc(R_IN, B_S, B_S, 1)[0]]},
       'residual': {'georefRmsM': GEO['residualM']['rms'], 'georefNearest': {k: GEO['residualM']['each'][k] for k in ('은주1관 북동', '한림관 원통 중심')}, 'outerCircleFitRmsM': r2(RMS_OUT), 'innerArcRmsM': r2(RMS_IN), 'pixelM': r2(PX), 'readingM': r2(PX)},
       'pixels800': {'centre': [r2(v) for v in (np.r_[C, 1.0] @ np.linalg.inv(np.c_[MX, [0, 0, 1]]))[:2]], 'northTip': [r2(v) for v in px800((rows[0][1].min(), rows[0][0]))], 'southTip': [r2(v) for v in px800((rows[-1][1].min(), rows[-1][0]))]},
       'outline': [[r2(x), r2(y)] for x, y in outline]}
(HERE / 'crescent.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({k: v for k, v in out.items() if k != 'outline'}, ensure_ascii=False, indent=1))
