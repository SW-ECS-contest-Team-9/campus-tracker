"""E09 차량 도로·주차장 입구 제안 만들기(읽기 전용, DB·서버 접속 없음).

  python docs/audit/e09/build.py <vault>/데이터/보완자료/3d-map-audit-20261009

입력: picks.json(S-MAP 화면 판독 원값), <audit>/e09/smap-elevation-raw.json(S-MAP 표고 조회 원문),
      <audit>/claude-live/roads-live-2.json·nodes-live-2.json(운영 스냅숏), <audit>/terrain-grid.f32(옛 서버 지형),
      <audit>/t01/dem-T01.f32(보정 후보), <audit>/e05/smap-mesh-*-2m.txt(S-MAP 메시 격자), backend/data/terrain/source/skuniv_places.json
출력: vehicle-roads-proposal.geojson, editor-ops.json, results.json (이 폴더), <audit>/e09/e09-plan.png
"""
import json, math, pathlib, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = pathlib.Path(__file__).parent
REPO = HERE.parents[2]
AUDIT = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(HERE.parent / 'e05'))
from tm5186 import to5186  # noqa: E402
from grids import Grid  # noqa: E402

P = json.loads((HERE / 'picks.json').read_text(encoding='utf-8'))
API = {r['name']: json.loads(r['raw'])['result'] for r in json.loads((AUDIT / 'e09/smap-elevation-raw.json').read_text(encoding='utf-8')) if r['status'] == 200}
roads = json.loads((AUDIT / 'claude-live/roads-live-2.json').read_text(encoding='utf-8'))['items']
nodes = json.loads((AUDIT / 'claude-live/nodes-live-2.json').read_text(encoding='utf-8'))['items']
meta = json.loads((AUDIT / 'terrain-grid-meta.json').read_text(encoding='utf-8'))
H, W, RES = meta['height'], meta['width'], meta['resolution']
OLD = np.fromfile(AUDIT / 'terrain-grid.f32', dtype='<f4').reshape(H, W)
T01 = np.fromfile(AUDIT / 't01/dem-T01.f32', dtype='<f4').reshape(H, W)
MESH = [Grid(AUDIT / f'e05/smap-mesh-{n}.txt') for n in ('yudam-2m', 'nw-2m', 'south-2m', 'ne-2m')]
TERRAIN_ID = 419430528


def ground(grid, x, y):  # backend dem.ts 와 같은 쌍선형 보간
    fx = (x - meta['originX']) / RES - 0.5; fy = (y - meta['originY']) / RES - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    return float(grid[iy, ix] * (1 - tx) * (1 - ty) + grid[iy, ix + 1] * tx * (1 - ty) + grid[iy + 1, ix] * (1 - tx) * ty + grid[iy + 1, ix + 1] * tx * ty)


def seq(*keys):
    return [(k, i, p) for k in keys for i, p in enumerate(P[k])]


def pts(items):
    return [p for _, _, p in items]


main = seq('mainGate', 'mainFountain', 'mainBend', 'mainS06C1R4', 'mainPlaza')
iN1 = next(i for i, (k, j, _) in enumerate(main) if (k, j) == ('mainGate', 3))      # 하단 주차장 차로 분기
iN2 = next(i for i, (k, j, _) in enumerate(main) if (k, j) == ('mainBend', 5))      # 본관·한림관 사이 지선 분기
iN3 = next(i for i, (k, j, _) in enumerate(main) if (k, j) == ('mainPlaza', 3))     # P1 분기
thr = [round(sum(c) / 2, 2) for c in zip(*P['p1ThresholdS07C1'])]                   # S07-C1 문턱선 가운데
SMAP_PICK = 'S-MAP 3D 화면 판독(2026-10-10, 차선·경계석을 눈으로 보고 찍음, 메시 표면 높이)'
SEG = [
    dict(id='V1', name='정문 진입로 (공도 분기 ~ 하단 주차장 차로 분기)', items=main[:iN1 + 1], roadClass='vehicle', structure='ordinary', widthM=None,
         widthNote='차로 2개 + 서쪽 정차 띠, 화면 판독 약 9~11 m(추정)', source=SMAP_PICK + ' + 학교 표지 정문(중심선 위 0.2 m) + 거리뷰 Y01(정문 가로 보, 정지선, 차단기)', grade='S-MAP',
         photo='streetview-yudam-approach-202602-01 (Y01), streetview-seogyeongro-202512 (S01)'),
    dict(id='V2', name='주 진입로 하부 (차단기 ~ 분수 광장 옆 ~ 유담관·한림관 굽이)', items=main[iN1:iN2 + 1], roadClass='vehicle', structure='ramp', widthM=7,
         widthNote='화면 판독 약 7~8 m(추정), 황색 중앙선', source=SMAP_PICK + ' + 사용자 분수 광장 항공 사진 2장(광장 가장자리 암석 화단 위로 차도, 황색 중앙선) + 거리뷰 Y01~Y03', grade='S-MAP',
         photo='사용자-유담관분수-북악관앞-20261010 항공 2장, streetview-yudam-approach-202602-01~03'),
    dict(id='V3', name='주 경사로 상부 = S06 (굽이 ~ 본관 남서 모서리 P1 분기)', items=main[iN2:iN3 + 1], roadClass='vehicle', structure='ramp', widthM=7,
         widthNote='화면 판독 약 7 m(추정). 본관 쪽 계단식 보도는 따로', source=SMAP_PICK + ' + CT-M16 S06-C1(같은 선, 최대 1.6 m 차) + 거리뷰 Y04~Y09·M01·M04·M05·M07', grade='S-MAP',
         photo='streetview-yudam-approach-202602-04~09, streetview-main-p1-202602-01·04·05·07'),
    dict(id='V4', name='본관 서쪽 회차 공간 (P1 분기 ~ 북악관 앞 버스 공간 남쪽 끝)', items=main[iN3:], roadClass='vehicle', structure='ordinary', widthM=None,
         widthNote='넓은 포장면(면으로 다룰 곳). 선은 진입 축만', source=SMAP_PICK + ' + 거리뷰 M06(노면 글자 "회차"·화살표, 멀리 버스) + B01(버스 공간) + 학교 표지 버스정류장 2곳', grade='S-MAP',
         photo='streetview-main-p1-202602-06 (M06), streetview-bukak-front-202512-01 (B01), 사용자 북악관 앞 사진'),
    dict(id='P-LOW', name='하단 주차장 차로 (정문 안쪽 서편, 표지판 "P2")', items=[main[iN1]] + seq('lowerPortalLane'), roadClass='vehicle', structure='ramp', widthM=None,
         widthNote='모름', source=SMAP_PICK + ' + 거리뷰 Y01("P2" 표지 아래 낮은 입구, 앞 횡단보도·STOP) + 학교 표지 "제1주차장 출입구"(끝점에서 5.5 m)', grade='S-MAP',
         photo='streetview-yudam-approach-202602-01 (Y01)', note='첫 구간(분기점~차로 첫 점 12.6 m)의 이음 모양은 추정. 끝점은 덮개 직전의 가장 낮은 메시 점이고 그 안쪽은 모름'),
    dict(id='P-UP', name='P1 주차장 차로 (본관 남서 모서리, 표지판 "P1")', items=[main[iN3]] + seq('p1Lane')[1:] + [('p1ThresholdS07C1mid', 0, thr)], roadClass='vehicle', structure='ramp', widthM=None,
         widthNote='모름', source=SMAP_PICK + ' + CT-M16 S07-C1 문턱선 + 거리뷰 M06("P1" 표지, 노면 글자 "주차장")·M01', grade='S-MAP',
         photo='streetview-main-p1-202602-06 (M06), -01 (M01)', note='문턱 높이 오차 ±1.5 m(메시가 화단 아래 내리막을 그리지 못함). 문턱 안쪽은 모름'),
    dict(id='U1', name='본관·한림관 사이 지선 ~ 은주관 서쪽 윗길', items=[main[iN2]] + seq('upperBranch')[1:] + seq('upperBranchSouth')[:4], roadClass='vehicle', structure='ramp', widthM=None,
         widthNote='화면 판독 약 5~8 m(추정), 남쪽에 빗금 주차 칸', source=SMAP_PICK + ' + 거리뷰 M02(갈라져 오르는 아스팔트, 노면 20)·M03(유리 건물 앞 계단으로 끝나는 가지)', grade='S-MAP',
         photo='streetview-main-p1-202602-02·03 (M02, M03)', note='upperBranch 끝(201109.6, 557237.6)과 upperBranchSouth 첫 점 사이 8 m는 넓은 포장면 안에서 이은 것(추정). 그 남쪽 25 m(수인관 북서 모서리까지)는 판독 높이와 조회 높이가 2 m 어긋나고 8 m 에 2.1 m 떨어져 제안에서 뺌. 끝이 어디로 들어가는지 모름. M03의 한림관 앞 가지는 넣지 않음'),
]


def analyse(coords):
    d = [0.0]
    for a, b in zip(coords, coords[1:]): d.append(d[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    worst = 0.0
    for i in range(len(coords)):
        for j in range(i + 1, len(coords)):
            if d[j] - d[i] >= 15:  # 15 m 이상 구간에서 본 가장 가파른 곳(높이 오차 0.5 m 가 8 m 구간에서는 6 %p 라 짧게 재지 않는다)
                worst = max(worst, abs(coords[j][2] - coords[i][2]) / (d[j] - d[i])); break
    return d, worst


def mesh_samples(coords, radius=6.0):
    n = 0
    for g in MESH:
        xs, ys = np.meshgrid(g.xs, g.ys)
        ok = (~np.isnan(g.z)) & (g.id == TERRAIN_ID)
        near = np.zeros_like(ok)
        for a, b in zip(coords, coords[1:]):
            ax, ay, bx, by = a[0], a[1], b[0], b[1]; L2 = (bx - ax) ** 2 + (by - ay) ** 2 or 1e-9
            t = np.clip(((xs - ax) * (bx - ax) + (ys - ay) * (by - ay)) / L2, 0, 1)
            near |= np.hypot(xs - ax - t * (bx - ax), ys - ay - t * (by - ay)) <= radius
        n += int((ok & near).sum())
    return n


outdoor = [r for r in roads if r['structure'] not in ('indoor_corridor', 'elevator')]
features, results_seg, ops = [], [], []
for s in SEG:
    coords = [[round(v, 2) for v in p] for p in pts(s['items'])]
    d, worst = analyse(coords)
    rise = coords[-1][2] - coords[0][2]
    api = [(API.get(f'{k}[{i}]') or {}).get('dem_z') for k, i, _ in s['items']]
    dz_api = [a - c[2] for a, c in zip(api, coords) if a is not None]
    old = [ground(OLD, c[0], c[1]) - c[2] for c in coords]; new = [ground(T01, c[0], c[1]) - c[2] for c in coords]
    dense = [(a[0] + (b[0] - a[0]) * t / 8, a[1] + (b[1] - a[1]) * t / 8, a[2] + (b[2] - a[2]) * t / 8) for a, b in zip(coords, coords[1:]) for t in range(9)]
    close = []
    for r in outdoor:
        rc = r['coordinates']; rd = [(a[0] + (b[0] - a[0]) * t / 8, a[1] + (b[1] - a[1]) * t / 8, a[2] + (b[2] - a[2]) * t / 8) for a, b in zip(rc, rc[1:]) for t in range(9)]
        best = min((math.hypot(p[0] - q[0], p[1] - q[1]), q[2] - p[2]) for p in dense for q in rd)
        if best[0] <= 5: close.append(dict(road=r['id'][:8], name=r['name'], roadClass=r['roadClass'], structure=r['structure'], minDistM=round(best[0], 1), existingMinusProposalZ=round(best[1], 2)))
    near = []
    for n in nodes:
        c = n['coordinate']
        best = min((math.hypot(c[0] - p[0], c[1] - p[1]), p[2]) for p in coords)
        if best[0] <= 6: near.append(dict(node=n['id'][:8], distM=round(best[0], 1), nodeZ=c[2], roadZ=best[1], dz=round(c[2] - best[1], 2),
                                         roads=[r['id'][:8] for r in roads if n['id'] in (r['fromNodeId'], r['toNodeId'])]))
    res = dict(id=s['id'], name=s['name'], lengthM=round(d[-1], 1), zStart=coords[0][2], zEnd=coords[-1][2], avgGradePct=round(100 * rise / d[-1], 1),
               maxGradePct15m=round(100 * worst, 1), over15pct=worst > 0.15, widthM=s['widthM'], widthNote=s['widthNote'], source=s['source'], grade=s['grade'], photo=s['photo'],
               note=s.get('note'), vertices=len(coords), smapApiMinusPick=dict(n=len(dz_api), min=round(min(dz_api), 2), max=round(max(dz_api), 2)) if dz_api else None,
               oldTerrainMinusRoad=dict(min=round(min(old), 2), median=round(float(np.median(old)), 2), max=round(max(old), 2), buriedOver1m=sum(v > 1 for v in old), floatingOver1m=sum(v < -1 for v in old)),
               t01MinusRoad=dict(min=round(min(new), 2), median=round(float(np.median(new)), 2), max=round(max(new), 2), buriedOver1m=sum(v > 1 for v in new), floatingOver1m=sum(v < -1 for v in new)),
               cachedMeshTerrainCellsWithin6m=mesh_samples(coords), existingNodesWithin6m=sorted(near, key=lambda a: a['distM']), existingOutdoorRoadsWithin5m=sorted(close, key=lambda a: a['minDistM']))
    results_seg.append(res)
    features.append(dict(type='Feature', properties={k: res[k] for k in ('id', 'name', 'lengthM', 'avgGradePct', 'maxGradePct15m', 'widthM', 'widthNote', 'source', 'grade', 'photo', 'note')} | dict(kind='vehicle-road', roadClass=s['roadClass'], structure=s['structure'], accuracyVerified=False, errXyM=1.5, errZM=0.5),
                         geometry=dict(type='LineString', coordinates=coords)))
    ops.append(dict(id='E09-' + s['id'], op='create_road', grade=s['grade'], args=dict(
        roadClass=s['roadClass'], name=f"{s['name']} (S-MAP 판독)", structure=s['structure'], vehicleAccess='allowed', pedestrianAccess='unknown',
        vehicleDirection='both', pedestrianDirection='unknown',  # B06: 사용자 확정 2026-10-10 '일방통행 없음' **({'widthM': s['widthM']} if s['widthM'] else {}),
        path=[dict(xy=c[:2], z=c[2]) for c in coords], zMode='explicit', densify=False)))

# 학교 표지와 주차장 입구
places = {p['장소명']: p for p in json.loads((REPO / 'backend/data/terrain/source/skuniv_places.json').read_text(encoding='utf-8'))}


def marker(name):
    x, y = to5186(float(places[name]['경도']), float(places[name]['위도'])); return [round(x, 1), round(y, 1)]


wall = [p for p in P['westGateRowY557397'] if 117.5 < p[2] < 126]  # 옹벽 면(메시가 급히 오르는 칸)
ENT = [
    dict(id='G-MAIN', name='정문', category='landmark', xy=marker('정문'), z=API['gate marker']['dem_z'], grade='원천(위치) / S-MAP(높이)',
         leadsTo='차도 위. 차단기는 북쪽 약 55 m(거리뷰 Y01, 위치 추정). B06 사용자 확정: 정문으로 차가 드나든다', unknown='차단기 정확한 자리'),
    dict(id='G-WEST', name='서문(후문) = 서문 주차장 출입구(추정)', category='parking', xy=[round(float(np.mean([p[0] for p in wall])), 1), 557399.5], z=API['westGate road']['dem_z'],
         grade='S-MAP(옹벽 면 x·앞 도로 높이) / 추정(벽을 따른 남북 위치, 두 표지가 같은 문이라는 것)',
         leadsTo='옹벽 밑 터널형 차량 출입구 두 칸(사용자 사진 서문.jpg). 옹벽 위는 식재 비탈 126~129 m, 그 뒤 북악관 앞 포장면 130.6~131.3 m(S-MAP) → 문 바닥이 약 14 m 아래',
         unknown='터널 안 배치·층·경사로, 다른 주차장과 이어지는지. B06 사용자 확정: 서문으로 차가 드나든다. 학교 표지 2개(서문 200967.8, 557401.5 / 서문 주차장 출입구 200969.0, 557402.8)는 옹벽 면에서 서쪽 약 13~15 m 공도 위'),
    dict(id='P-LOW', name='하단 주차장 입구 (사용자: 제1주차장 / 현장 표지판 P2 / 학교 표지 "제1주차장 출입구")', category='parking', xy=[round(v, 1) for v in P['lowerPortalLane'][-1][:2]], z=P['lowerPortalLane'][-1][2],
         grade='S-MAP(차로·덮개 직전 높이) / 원천(학교 표지 201096.7, 557150.7: 5.5 m 거리, 지면 106.1 m)',
         leadsTo='모름(어느 건물 몇 층인지 원천 없음)', unknown='B06: 사용자 확정 = 제1주차장 입구는 정문 바로 옆(사진 02: 오르막 차도 왼쪽 옹벽 아래 입구, 뒤에 유담관 기단부). 이 입구가 그 사진의 입구로 읽힌다(추정: 정문에서 44.5 m, 학교 표지에서 5.5 m). 거리뷰 Y01 의 표지판은 P2 로 읽혔다: 두 이름을 함께 적고 하나로 정하지 않는다. 안쪽 층·배치 모름. 실제 문턱은 덮개 아래라 S-MAP 에 안 보임'),
    dict(id='P-UP', name='표지판 P1 입구 (본관 남서 화단 아래. 어느 주차장인지 미정)', category='parking', xy=thr[:2], z=thr[2], grade='S-MAP(문턱선 CT-M16 S07-C1, 높이 ±1.5 m)',
         leadsTo='화단 아래로 내려감(거리뷰 M06). 본관 입구(2)가 "지하주차장과 본관 2층 연결"(원천)이고 그 표지 지면이 130.5 m → 북악관·본관 앞 포장면 아래 주차장으로 보임(추정)',
         unknown='지하 바닥 높이·배치, 서문 터널과 이어지는지. 학교 표지 "제2주차장 출입구"(201057.8, 557267.2)는 유담관 외곽 안(문턱에서 53 m)이라 이 문을 가리키는지 모름. B06 사용자 말: 제2주차장은 버스 정류장 근처이고 유담관 9층으로 가는 보행 길이 그 위를 지붕처럼 덮는다(위치 그림 없음). 이 입구는 버스정류장 표지에서 10~15 m 지만 그 제2주차장인지는 정하지 않는다(사용자: 이 일대 옹벽과 주차장 범위가 꼬여 있음, 더 물을 것)'),
    dict(id='P-M2', name='학교 표지 "제2주차장 출입구"', category='parking', xy=marker('제2주차장 출입구'), z=API['P2lot marker']['dem_z'], grade='원천(표지 위치만)',
         leadsTo='모름. 표지가 유담관 지붕 아래(S-MAP 건물 높이 값이 있는 칸)이고 S-MAP·거리뷰 Y02~Y08에서 차량 문이 확인되지 않음', unknown='실제 문 위치, P1 표지판 문과 같은지. B06 사용자 말(제2주차장 = 버스 정류장 근처, 유담관 9층 보행 길 아래)과 이 표지 자리(버스정류장에서 58~61 m)의 관계 모름', propose=False),
    dict(id='E-MAIN2', name='본관 입구(2)', category='building_entrance', xy=marker('본관 입구(2)'), z=API['main entrance(2) marker']['dem_z'], grade='원천(위치·설명) / S-MAP(지면)',
         leadsTo='지하주차장과 본관 2층(원천 문구). 보행 입구', unknown='문 바닥 높이, 주차장으로 내려가는 계단·승강기', buildingId='본관'),
    dict(id='BUS-2115', name='서경대본관 2115번 버스정류장', category='bus_stop', xy=marker('서경대본관 2115번 버스정류장'), z=API['bus 2115 marker']['dem_z'], grade='원천(위치) / S-MAP(높이)', leadsTo='회차 공간 남쪽', unknown='승하차 자리'),
    dict(id='BUS-1164', name='서경대본관 1164번 버스정류장', category='bus_stop', xy=marker('서경대본관 1164번 버스정류장'), z=API['bus 1164 marker']['dem_z'], grade='원천(위치) / S-MAP(높이)', leadsTo='회차 공간 남쪽', unknown='승하차 자리'),
]
for e in ENT:
    e['z'] = round(e['z'], 2)
    e['oldTerrain'] = round(ground(OLD, *e['xy']), 2); e['t01'] = round(ground(T01, *e['xy']), 2)
    features.append(dict(type='Feature', properties={k: v for k, v in e.items() if k not in ('xy', 'z')} | dict(kind='entrance-or-stop', accuracyVerified=False), geometry=dict(type='Point', coordinates=e['xy'] + [e['z']])))
    if e.get('propose', True):
        ops.append(dict(id='E09-PLACE-' + e['id'], op='create_place', grade=e['grade'], args=dict(name=e['name'], category=e['category'], description=f"E09 제안. 이어지는 곳: {e['leadsTo']}. 모름: {e['unknown']}",
                        **({'buildingId': e['buildingId']} if e.get('buildingId') else {}), position=dict(xy=e['xy'], z=e['z']))))

# 사용자 확정(2026-10-10): 문예관 옆 포장 오르막은 보행로(공사 차량만 제한적으로). 그 위에 놓인 운영 길의 차량 속성 정정
byid = {r['id'][:8]: r for r in roads}
for rid, why in (('c52095ad', '확정: 북악관 앞 회차 공간에서 문예관 옆으로 대일관 쪽에 오르는 포장길은 보행로'), ('8e71c240', '같은 길의 대일관 쪽 연장으로 보임(추정). 높이 141.73 m 평탄은 E07의 기준값 복사라 그대로 둠')):
    r = byid[rid]
    ops.append(dict(id='E09-FIX-' + rid, op='update_road', grade='확정' if rid == 'c52095ad' else '추정', why=why,
                    args=dict(id=r['id'], expectedRevision=r['revision'], attrs=dict(roadClass='pedestrian', vehicleAccess='restricted', pedestrianAccess='allowed'))))

# 기존 차량 길 목록과 S-MAP 지면 대조
existing = []
for r in roads:
    if r['roadClass'] != 'pedestrian' or r['vehicleAccess'] == 'allowed':
        c = r['coordinates']
        existing.append(dict(id=r['id'][:8], name=r['name'], roadClass=r['roadClass'], structure=r['structure'], vehicleAccess=r['vehicleAccess'], lengthM=r['lengthM'], updatedBy=r['updatedBy'],
                             z=[c[0][2], c[-1][2]], oldTerrain=[round(ground(OLD, *c[0][:2]), 2), round(ground(OLD, *c[-1][:2]), 2)],
                             smapGround=[(API.get(f"{r['id'][:8]}[0]") or {}).get('dem_z'), (API.get(f"{r['id'][:8]}[{len(c) - 1}]") or {}).get('dem_z')]))
# B07 사용자 확정(2026-10-10): 위 보행로보다 한 층 아래에 나란히 "지하 경사로 통로" = 지하 차도가 있다. 서문과 제2 지하주차장(버스 정류장 근처) 입구로
# 드나드는 차가 이 차도를 쓰고, 오르막 방향 오른쪽이 보행 구간이다. 본관 5층–한림관 3층 연결 데크는 이 길에서만 간다.
# 운영 길 951c157d 가 이 지하 차도의 일부라는 것은 추정(선의 근거는 여전히 없음). 선을 새로 만들지 않는다. 보행 금지로 저장된 속성만 확정과 어긋난다.
# B08 사용자 확정(2026-10-10): 본관 옆 붉은 띠는 보행 구간이고 양방향 차도는 그 옆, 폭 = 그림의 횡단보도 길이. 차는 제2주차장 입구와 서문에서 들어온다.
# 두 지하 공간은 지하에서 이어지지 않는다. 계산은 docs/audit/b08/b08.py. 951c157d 는 차도 선으로 두고(보행 금지 그대로) 이름·폭만, 8fde6a04 는 없앤다.
B08 = json.loads((HERE.parent / 'b08/results.json').read_text(encoding='utf-8'))
for o in B08['operations']:
    if o['kind'] == 'vehicle':
        ops.append(dict(id='E09-' + o['id'], op=o['op'], grade=o['grade'], why=o['why'], expectedPreState=o['pre'], rollback=o['rollback'], args=o.get('args') or dict(type='road', id=o['target'], expectedRevision=o['pre']['revision']),
                        **({'supersedes': o['supersedes']} if o.get('supersedes') else {})))
c5 = byid['c52095ad']['coordinates']
sep = [min(math.hypot(p[0] - q[0], p[1] - q[1]) for q in c5) for p in byid['951c157d']['coordinates']]

junctions = [dict(id='N1', at=main[iN1][2], joins=['V1', 'V2', 'P-LOW']), dict(id='N2', at=main[iN2][2], joins=['V2', 'V3', 'U1']), dict(id='N3', at=main[iN3][2], joins=['V3', 'V4', 'P-UP'])]
for j in junctions:
    ops.append(dict(id='E09-JOIN-' + j['id'], op='connect_roads', grade='S-MAP', args=dict(at=dict(xy=[round(v, 2) for v in j['at'][:2]], z=round(j['at'][2], 2)))))

total = sum(r['lengthM'] for r in results_seg)
(HERE / 'vehicle-roads-proposal.geojson').write_text(json.dumps(dict(type='FeatureCollection', name='e09-vehicle-roads-proposal', crs=dict(type='name', properties=dict(name='urn:ogc:def:crs:EPSG::5186')),
    provenance=dict(created='2026-10-10', updated='2026-10-10 B08 (지하 차도는 여전히 여기에 없다: 951c157d 는 운영 길이고 나머지 선은 모름. B07: 사용자 확정: 양방향, 정문·서문 차량 통행, 제1주차장 = 정문 옆. 지하 차도는 선을 모름이라 여기에 없다)', by='Claude', applied=False, note='제안. 운영 DB에 쓰지 않음. 평면은 S-MAP 화면 판독(오차 가정 1.5 m), 높이는 S-MAP 메시(독립 측량 아님). 지하·터널 안은 없음(모름). 여기 있는 것은 전부 지상 차도다.'), features=features), ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
(HERE / 'editor-ops.json').write_text(json.dumps(dict(title='E09 차량 도로·주차장 입구 편집 제안', applied=False, requiresUserApproval=True,
    basedOn=dict(snapshot='claude-live/roads-live-2.json (128 roads) / nodes-live-2.json (118 nodes)', coordinatePrecisionM=0.01),
    howToApply='편집기 MCP apply_changes 에 operations[].{op,args} 를 그대로 넘긴다. 먼저 dryRun=true. create_road 는 zMode explicit 이라 서버 지형과 무관한 절대 높이다. connect_roads 는 새 길들을 분기점에서 한 노드로 묶는다. update_road 의 expectedRevision 은 스냅숏 값이라 적용 전에 get_feature 로 다시 확인한다.',
    notProposed=['지하주차장 안, 서문 터널 안의 길(모름)', '서쪽 공도(서경로·보국문로16라길): 학교 길이 아니라 넣지 않음', '지하 차도의 새 선(951c157d 아래 끝 ~ 서문 터널, ~ 제2주차장 입구, 위 끝 너머): 선을 모른다. results.json 의 undergroundRoadB08.unresolvedLinks 에 양 끝만 적는다', '951c157d 의 이동·높이 변경: 하지 않는다(평면은 그림과 맞고, 높이는 어느 쪽도 측정이 아니다)', '지하 차도의 보행 구간·계단·횡단보도: 보행 제안 목록 docs/audit/b03/network.json (B08-2~5)', '회차 공간의 도는 궤적, 본관 쪽 계단식 보도'],
    operations=ops), ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
USER_B06 = dict(date='2026-10-10', grade='확정(사용자 말 그대로)', gates='정문·서문 둘 다 차가 드나든다', oneWay='일방통행 없음 -> create_road 의 vehicleDirection 을 both 로',
                lot1='제1주차장 입구는 정문 바로 옆(사진 02-제1주차장-정문옆.jpg)', lot2='제2주차장은 버스 정류장 근처이고 유담관 9층으로 들어가는 보행 길이 그 위를 지붕처럼 덮는다(사진·그림 없음, 위치 모름)',
                photo03='사진 03-지하경사로-입구.jpg 가 어느 입구인지는 미정(Claude 의 첫 해석은 사용자가 틀렸다고 함). 어느 E09 입구에도 대응시키지 않는다',
                undergroundPassage='사용자 말: 한림관 1층 로비로 가는 길 하나가 "지하 경사로 통로에서 들어가는 길", 북악관 B1(GS25 문)로 가는 길 하나가 "지하 경사길이 시작하는 부근에서 들어가는 방법". 통로의 선·문 위치 모름. 길을 만들지 않는다',
                bank='신한은행은 한림관이 아니라 학교 바깥 옹벽 길 바로 앞에 있다(건물·층 모름)')
B07 = json.loads((HERE.parent / 'b07/results.json').read_text(encoding='utf-8'))['corridor']
USER_B07 = dict(date='2026-10-10', grade='확정(사용자 말)', twoPaths='문예관·대일관 쪽과 본관·한림관 쪽 사이에 내리막길이 두 줄 나란히 있다. 위 = 문예관 3층 계단으로 이어지는 바깥 보행로, 한 층 아래 = "지하 경사로 통로"',
                undergroundRoad='"지하 경사로 통로"는 지하 차도다. 서문과 제2 지하주차장(버스 정류장 근처) 입구로 드나드는 차가 쓴다. 오르막 방향 오른쪽은 보행 구간',
                deck='본관 5층–한림관 3층 연결(실외 나무 데크)은 아래 길(지하 차도)에서만 갈 수 있다. B06 의 "한림관 1층 로비로 가는 둘째 길"은 이 연결을 가리킨 것(사용자: 10번이 5번이다)',
                drawing14='사용자 그림(사진 14, 범례 확정): 본관 북쪽 벽 옆에 지하 공간(붉은 두 줄), 그 회차 공간 쪽 끝에 계단, 거기서 북악관 쪽으로 횡단보도, 건너편에 통로(상자)와 계단, 북악관 남쪽 벽을 따라 지하 공간(붉은 선). 좌표는 docs/audit/b07/drawing14.json (평면 ±2 m, 추정)',
                withdrawn='"북악관 B1(GS25 문)로 가는 길은 지하 차도가 시작하는 부근"이라는 Claude 의 이해는 사용자가 틀렸다고 했다. 쓰지 않는다',
                surface='회차 공간에서 서문으로 가는 지상 차도가 없다는 E09 판정은 지상에 한해 그대로다. 지하로는 이어진다')
USER_B08 = dict(date='2026-10-10', grade='확정(사용자 말)', strip='본관 옆 긴 붉은 띠는 지하 차도의 보행 구간이다. 양방향 차도는 그 옆(북악관·문예관 쪽)이고 폭은 그림의 횡단보도 길이와 같다',
                entries='차는 제2주차장 입구와 서문 두 곳에서 그 지하 차도로 들어간다. 두 자리는 사용자가 S-MAP 화면에 표시(사용자-서문·제2주차장·수인관-20261010/01)', stairs='본관 쪽·북악관 쪽 계단은 둘 다 지상에서 아래로 내려간다',
                notLinked='본관 옆 지하 공간과 북악관 벽 쪽 지하 공간은 지하에서 이어지지 않는다. 지상 횡단보도로만 오간다', deck='본관 5층–한림관 3층 연결 데크는 아래 길(보행 구간)에서만 간다')
UG_B08 = dict(what='B07 의 undergroundRoadB07 을 고친다: 951c157d = 차도 선(추정), 붉은 띠 = 보행 구간(확정)', carriageway=dict(road='951c157d', crossing=B08['crossing'], fit=B08['fit951']),
              pedestrianStrip=dict(B08['strip'], note='보행 제안 B08-5 (docs/audit/b03/network.json). 차도 선과 잇지 않는다'), mainSideStair=B08['mainSideStair'], deck=B08['deck'],
              knownVehicleEntries=[dict(what='서문 터널 입구 두 칸', xy=[200984.0, 557399.5], z=117.0, grade='확정(여기로 들어온다) / 좌표·높이 S-MAP·사진(E09)'), dict(what='제2주차장 입구 = 표지판 P1 입구(E09 P-UP 끝)', xy=[201021.9, 557307.1], z=127.9, grade='확정(여기로 들어온다, 자리는 사용자 표시) / 좌표·문턱 S-MAP 판독(E09), 표시와 4.3 m 차(대응 추정)', lot2=B08['lot2'])], userDrawingGates=B08['gates'],
              unresolvedLinks=[u for u in B08['unresolvedLinks'] if u['id'] in ('U1', 'U2', 'U5')], noUndergroundLink=B08['noUndergroundLink'])
out = dict(created='2026-10-10', updated='2026-10-10 B08', userStatementsB06=USER_B06, userStatementsB07=USER_B07, userStatementsB08=USER_B08, undergroundRoadB08=UG_B08, undergroundRoadB07=dict(B07['undergroundRoad'], fit951=B07['fit951'], drawing14=json.loads((HERE.parent / 'b07/drawing14.json').read_text(encoding='utf-8'))['features']), totalLengthM=round(total, 1), mainLengthM=round(sum(r['lengthM'] for r in results_seg[:4]), 1), segments=results_seg, junctions=[dict(id=j['id'], xyz=[round(v, 2) for v in j['at']], joins=j['joins']) for j in junctions],
           entrances=ENT, existingVehicleRoads=existing, c951OnPedestrianPath=dict(planDistanceToC52095adM=[round(v, 2) for v in sep]),
           westGate=dict(wallFaceX=[round(p[0], 1) for p in wall], roadZ=API['westGate road']['dem_z'], plazaZ=[130.63, 131.26], markerToWallM=round(float(np.mean([p[0] for p in wall])) - 200967.8, 1)),
           inventory=dict(roads=len(roads), byClass={k: sum(r['roadClass'] == k for r in roads) for k in ('pedestrian', 'shared', 'vehicle')}, vehicleAllowed=sum(r['vehicleAccess'] == 'allowed' for r in roads),
                          widthSet=sum(r['widthM'] is not None for r in roads), extent=[min(p[0] for r in roads for p in r['coordinates']), min(p[1] for r in roads for p in r['coordinates']), max(p[0] for r in roads for p in r['coordinates']), max(p[1] for r in roads for p in r['coordinates'])]),
           smapSamples=dict(apiPoints=len(API), screenPicks=sum(len(v) for k, v in P.items() if isinstance(v, list))))
(HERE / 'results.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

# 확인 그림
fig, ax = plt.subplots(figsize=(9, 11))
for b in json.loads((AUDIT / 'building-outlines-5186.json').read_text(encoding='utf-8')):
    for poly in b['coordinates']:
        ring = np.array(poly[0]); ax.fill(ring[:, 0], ring[:, 1], color='#dddddd', ec='#888888', lw=0.6)
for r in outdoor:
    c = np.array(r['coordinates']); veh = r['roadClass'] != 'pedestrian'
    ax.plot(c[:, 0], c[:, 1], color='#d62728' if veh else '#1f77b4', lw=1.6 if veh else 0.8, alpha=0.9)
colors = dict(V1='#000000', V2='#000000', V3='#000000', V4='#000000', U1='#8c564b')
for f in features:
    g = f['geometry']; p = f['properties']
    if g['type'] == 'LineString':
        c = np.array(g['coordinates']); ax.plot(c[:, 0], c[:, 1], color=colors.get(p['id'], '#ff7f0e'), lw=2.6)
        m = c[len(c) // 2]; ax.annotate(f"{p['id']} {p['lengthM']:.0f} m, {p['avgGradePct']:+.0f}%", m[:2], xytext=(6, 0), textcoords='offset points', fontsize=7)
    else:
        ax.plot(g['coordinates'][0], g['coordinates'][1], 'o', color='#2ca02c', ms=6); ax.annotate(f"{p['id']} {g['coordinates'][2]:.1f} m", g['coordinates'][:2], xytext=(5, 4), textcoords='offset points', fontsize=7, color='#116611')
pw = np.array(P['publicRoadWest'] ); ax.plot(pw[:, 0], pw[:, 1], '--', color='#999999', lw=1); ax.annotate('public road (not proposed)', pw[0][:2], fontsize=6, color='#666666')
ax.set_aspect('equal'); ax.set_xlim(200950, 201250); ax.set_ylim(557085, 557425); ax.grid(alpha=0.3)
ax.set_title('E09 proposal (black/orange/brown = proposed vehicle roads, green = gates, parking entrances, bus stops)\nred = existing vehicle/shared roads, blue = existing outdoor pedestrian roads, grey = source footprints; EPSG:5186', fontsize=8)
fig.tight_layout(); fig.savefig(AUDIT / 'e09/e09-plan.png', dpi=130)
print('total', round(total, 1), 'm')
for r in results_seg:
    print(r['id'], r['lengthM'], r['zStart'], r['zEnd'], r['avgGradePct'], r['maxGradePct15m'], 'api', r['smapApiMinusPick'], 'old', r['oldTerrainMinusRoad'], 't01', r['t01MinusRoad'], 'mesh', r['cachedMeshTerrainCellsWithin6m'], [(n['road'], n['minDistM'], n['existingMinusProposalZ']) for n in r['existingOutdoorRoadsWithin5m']])
for e in ENT: print(e['id'], e['xy'], e['z'], e['oldTerrain'], e['t01'])
for e in existing: print(e)
print('951c vs c52095ad plan distance', sep, 'wall', out['westGate'])
