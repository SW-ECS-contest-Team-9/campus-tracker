"""Z05: 손으로 정한 길 띠와 마당(Z04 와 같은 근거). base.HAND 에 채운다."""
from base import *
HAND.append(dict(zone='turnaround', name='PLAZA', poly=PLAZA, top=PLAZA_PROF, material='paving', bottom=126.0, bottomNote='지하 차도·통로(128.5 m)보다 아래의 안전 깊이',
    grade='확정(회차 공간·북악관 현관 앞·본관 앞·오르막길이 끊김 없는 한 포장면: 사용자 그림 11), S-MAP(높이)', source=MESH + ', backend/data/terrain/recipes/f05-plateaus.geojson(외곽, T06), 사용자 핀 12개 130.2~131.2',
    assumption=f'외곽은 T06·F05 의 포장면 다각형 그대로. 윗면은 한 평면: 메시 {pl_n}칸에 맞춘 경사 {pl_slope:.1f} %, 맞춤 잔차 90 % {pl_res:.2f} m', reason=f'Z05 회차 공간 포장면: 한 경사면(경사 {pl_slope:.1f} %)'))
V4 = np.vstack([LINES['V4a'], LINES['V4b'][1:]])
ribbon('turnaround', 'V4', V4, 7.0, GR, V02, '본관 서쪽 회차 공간 내리막(V4, P1 갈림 ~ 포장면 남쪽 끝)', clip=CAMPUS.buffer(30).difference(PLAZA))
ribbon('yudam9', 'V3', LINES['V3'], 4.5, GR, V02, '본관 앞 차도 S06(V3, 굽이 ~ P1 갈림)')
ribbon('yudam9', 'PUP', LINES['P-UP'], 3.0, GR, V02, 'P1(제2주차장) 차로')
ribbon('upper-branch', 'U1', LINES['U1'], 3.25, GR + ', 사용자 높이 표시 121.4~126.1 m(그림 13)', V02 + ', 사용자-출입구·주차장-20261010/13-SMAP-한림관-가는길-높이표시.webp', '위쪽 갈래 차도(U1, 굽이 ~ 본관·한림관 사이 ~ 은주1관 서쪽)')
U1X = np.array([(201112.12, 557211.18, 130.92), (201116.32, 557208.17, 131.2), (201120.14, 557204.47, 131.7), (201124.53, 557200.64, 132.2), (201128.3, 557195.63, 132.2)])
ribbon('eunju', 'U1X', U1X, 3.0, 'S-MAP·사용자 핀 U030·U031·U033·U034(높이), 추정(선·폭. 차도인지 모름)', V02, '윗길 끝에서 풋살장 쪽으로 이어지는 포장(U1-EXT)')
ribbon('gate', 'V1', LINES['V1'], 6.0, GR, V02, '정문 진입로(V1, 공도 분기 ~ 주차장 차로 갈림)')
V2S = LINES['V2'][LINES['V2'][:, 1] <= 557181.5]
ribbon('gate', 'V2S', V2S, 5.0, GR, V02, '주 진입로 아래 구간(V2, 갈림 ~ 분수 광장 남쪽 끝. 그 북쪽은 Z03 차도 포장 띠)', clip=sbox(201000, 557000, 201300, 557180))
ribbon('gate', 'PLOW', LINES['P-LOW'], 3.0, GR, V02, '제1주차장(표지판 P2) 차로')
HSRC = MESH + ', 건물 노트 한림관(북쪽 모퉁이 133.8~141.2·가운데 135.1, 남동 평탄면 136.3~136.4, 서쪽 틈 130.3~135.2), 구역 노트 오르막길 A17'
_wgap = Polygon([(201096.5, 557290), (201103.5, 557290), (201104.5, 557300), (201104.5, 557313), (201099, 557313), (201097, 557300)])
_narc = sbox(201099, 557303, 201129, 557319).difference(_wgap); _eslot = sbox(201121, 557271, 201137, 557308).difference(_narc)
N_ROAD_PIECES = sum(1 for h in HAND if h.get('road'))
for nm, pl, top, gr, ass in (
  ('HANLIM-NARC', _narc, 135.3, 'S-MAP(한림관 벽 옆 낮은 값 134.2~135.9), 추정(한 높이로 봄, 범위)',
   '한림관 북쪽의 낮은 자리: 오르막길 가장자리(141~146 m) 아래 6~10 m. S-MAP 은 3~6 m 폭 비탈로 뭉개 읽는다(133.8~141.2). 벽 옆 낮은 값을 바닥으로 봄'),
  ('HANLIM-ESLOT', _eslot, 136.3, 'S-MAP(평탄면 136.3~136.4), 추정(범위)',
   '한림관과 은주1관 사이의 좁은 자리: 남쪽 끝에 S-MAP 평탄면 136.3 m. 북쪽은 135.0~137.7 로 읽힌다. 무엇인지는 모름')):
    HAND.append(dict(zone='upper-branch', name=nm, poly=big(pl.difference(DONE).difference(UNDER)), top=top, material='concrete', grade=gr, source=HSRC, assumption=ass, reason='Z05 한림관 둘레 낮은 통로: ' + nm))
HAND.append(dict(zone='upper-branch', name='HANLIM-1F', poly=big(sbox(201100.5, 557277.5, 201111.0, 557283.0).difference(UNDER)), top=127.2, material='paving',
    grade='확정(한림관 1층은 앞 길에서 계단 몇 개 위), S-MAP(126.9~127.5)', source=MESH + ', 건물 노트 한림관(1층 127.2 m), 05-한림관1층-가는길-네이버거리뷰-202506.webp',
    assumption='한림관 1층 로비 문 앞 단(계단 위): 127.2 m 한 높이. 범위는 S-MAP 평탄면(북좌표 557277~557282)과 건물 벽 사이(±1.5 m)', reason='Z05 한림관 1층 문 앞 단 127.2 m'))
HAND.append(dict(zone='yudam9', name='FORECOURT-9F', poly=big(sbox(201017.5, 557287.5, 201030.5, 557296.5).difference(UNDER)), top=129.2, material='paving',
    grade='확정(버스 정류장 쪽에서 들어간 자리가 유담관 9층), S-MAP(128.4~129.6)', source=MESH + ', 건물 노트 유담관(앞마당 x 201018~201030, 북좌표 557288~557296, 129.2 m)',
    assumption='유담관 9층 쪽 앞마당: 129.2 m 한 높이. 9층 문 자리는 모름', reason='Z05 유담관 9층 쪽 앞마당 129.2 m'))
