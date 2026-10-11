"""B13 혜인관: 운동장 쪽 벽을 축으로 한 좌표계. s = 벽을 따라 남서 끝에서 북동으로(0~87.5 m), d = 벽에서 건물 안쪽(남동)으로. 운동장 쪽은 d < 0."""
import numpy as np
RING = [(201264.35, 557244.73), (201220.43, 557169.41), (201200.72, 557180.92), (201246.03, 557255.84)]   # 장면의 혜인관 외곽(campus.gpkg source_fid 4)
A, B = np.array(RING[2]), np.array(RING[3]); U = (B - A) / np.hypot(*(B - A)); N = np.array([U[1], -U[0]]); LEN = float(np.hypot(*(B - A)))
def P(s, d): return A + U * s + N * d
def R(s0, s1, d0, d1): return [P(s0, d0), P(s1, d0), P(s1, d1), P(s0, d1)]
def SD(p): v = np.array(p[:2], float) - A; return float(v @ U), float(v @ N)
C = 46.5   # 운동장 쪽 출입부의 가운데(s). 근거는 derive.py 머리말
