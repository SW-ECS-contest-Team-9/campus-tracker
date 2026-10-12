"""B14 상승관: S-MAP 0.5 m 메시에서 맞춘 건물 축. s = 긴 변을 따라 동쪽으로(가운데 0), d = 북쪽(숲 쪽) 벽에서 대일관 쪽으로 가로질러(가운데 0, 북쪽 벽 -4.6, 대일관 쪽 벽 +4.75)."""
import numpy as np
C = np.array([201210.58, 557316.03])                       # 메시의 상승관 칸(객체 173604866) 가운데
ANG = -23.04                                               # 긴 벽 방위(동에서 반시계 도). 북쪽 변 -23.18, 남쪽 변 -22.89 의 가운데
U = np.array([np.cos(np.radians(ANG)), np.sin(np.radians(ANG))]); N = np.array([U[1], -U[0]])
def W(s, d): return [round(float(v), 2) for v in C + s * U + d * N]
def SD(p): v = np.array(p[:2], float) - C; return float(v @ U), float(v @ N)
S_W, S_E_N, S_E_S, D_N, D_S = -18.2, 20.3, 15.8, -4.6, 4.75   # 서쪽 끝, 동쪽 끝(북쪽 변·남쪽 변: 동쪽 끝 벽은 청운관 벽과 나란히 비스듬하다), 북쪽 벽, 남쪽 벽
BLOCK_S = 11.8                                             # 이보다 동쪽은 지붕이 165.3 m 인 동쪽 끝 덩어리
DAEIL_FAR, DAEIL_STEP_S, DAEIL_END_S = 5.9, -1.5, 9.9      # 대일관 뒷벽: s < -1.5 는 d 5.9(틈 1.15 m), -1.5~9.9 는 상승관 벽에 닿음
RING = [W(S_W, D_N), W(S_E_N, D_N), W(S_E_S, D_S), W(S_W, D_S)]                    # 건물 전체
MAIN = [W(S_W, D_N), W(BLOCK_S, D_N), W(BLOCK_S, D_S), W(S_W, D_S)]; MAIN.append(MAIN[0])   # 본체(지붕 163.1)
EAST = [W(BLOCK_S, D_N), W(S_E_N, D_N), W(S_E_S, D_S), W(BLOCK_S, D_S)]; EAST.append(EAST[0])   # 동쪽 끝 덩어리(지붕 165.3)
RING.append(RING[0])
