"""V02 4(b)단계: 매끄러운 종단에서 차도 띠의 지형 표본을 만든다(차도 폭 + 좁은 갓길에서 가로로 평평).
   python make_samples.py <볼트 audit 폴더> <저장소 루트>
   출력: backend/data/terrain/samples/smap_samples_roadprofile_5186.json (새 파일. 기존 표본 파일은 건드리지 않는다),
         docs/audit/v02/check-points.json (지형-차도 대조용 점).
   구역(area):
     road_profile      본선 V1~V4 + P-LOW + P-UP 의 차도 띠
     road_profile_u1   윗길 U1 의 차도 띠(지형 검증이 없는 구간이라 따로 켜고 끌 수 있게)
     gate_road_rest / s06_rest / turnaround_rest   기존 표본(T04·E01) 가운데 차도 띠 표본에서 REST_M 넘게 떨어진 것(띠 옆 지면을 받친다. 띠와 겹치는 것은 종단 표본이 대신한다)"""
import sys, json, math, pathlib
import numpy as np
audit = pathlib.Path(sys.argv[1]); repo = pathlib.Path(sys.argv[2]); here = pathlib.Path(__file__).parent
prof = json.loads((here / 'profile.json').read_text(encoding='utf-8'))
summ = json.loads((here / 'road-summary.json').read_text(encoding='utf-8'))
outl = json.loads((audit / 'building-outlines-5186.json').read_text(encoding='utf-8'))
ALONG = 2.0; ACROSS = 1.5; SHOULDER = 1.0; REST_M = 2.5
BURN_SHOULDER = 1.5   # 띠를 지형 칸에 그대로 새길 때 차도 반폭에 더하는 폭(2 m 칸의 쌍선형 보간이 차도 가장자리까지 차도 높이가 되게)
HALF = {'V1': 3.5, 'V2': 3.5, 'V3': 3.5, 'V4a': 7.0, 'V4b': 7.0, 'P-LOW': 3.0, 'P-UP': 3.0, 'U1': 3.0}
# 반폭 근거: V1~V3 7 m(E09 화면 판독, 추정), V4 14 m(N02 가 저장한 폭), 나머지 표시 기본값 6 m. S-MAP 메시(2 m)로는 경계석이 안 보인다.


def inside(poly, x, y):
    n = len(poly); c = False; j = n - 1
    for i in range(n):
        xi, yi = poly[i][:2]; xj, yj = poly[j][:2]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
        j = i
    return c


POLYS = [(b['name'], b['coordinates'][0][0]) for b in outl]
def in_building(x, y): return any(inside(p, x, y) for _, p in POLYS)


SLICES = []


END_EXT = {'V1': (3.0, 0.0), 'P-LOW': (0.0, 3.0), 'P-UP': (0.0, 3.0), 'U1': (0.0, 3.0)}  # 다른 길로 이어지지 않는 끝은 끝 높이 그대로 3 m 더 새긴다(끝에서 칸 보간이 바깥 지형에 끌리지 않게)


def slices(xy, s, z, half, s_from, s_to, tag):
    """길 따라 1 m 조각(가로 사각형)과 그 가운데 높이. terrain-plateau 의 applyPlateau 를 조각마다 이어 돌리면 띠가 지형 칸에 새겨진다."""
    xy = np.array(xy); s = np.array(s); z = np.array(z); h = half + BURN_SHOULDER
    st = np.arange(s_from, s_to + 1e-6, 1.0)
    if st[-1] < s_to - 1e-6: st = np.r_[st, s_to]
    def edge(a):
        p = np.array([np.interp(a, s, xy[:, 0]), np.interp(a, s, xy[:, 1])])
        q0 = np.array([np.interp(max(a - .5, s[0]), s, xy[:, 0]), np.interp(max(a - .5, s[0]), s, xy[:, 1])]); q1 = np.array([np.interp(min(a + .5, s[-1]), s, xy[:, 0]), np.interp(min(a + .5, s[-1]), s, xy[:, 1])])
        t = (q1 - q0) / np.hypot(*(q1 - q0)); n = np.array([-t[1], t[0]]); return p - h * n, p + h * n
    for a, b in zip(st[:-1], st[1:]):
        l0, r0 = edge(a); l1, r1 = edge(b)
        ring = [[round(float(v), 2) for v in q] for q in (l0, r0, r1, l1, l0)]
        SLICES.append({'seg': tag, 's': round(float((a + b) / 2 - s_from), 2), 'z': round(float(np.interp((a + b) / 2, s, z)), 3), 'ring': ring})
    for which, ext in zip((0, 1), END_EXT.get(tag, (0, 0))):
        if not ext: continue
        a = s_from if which == 0 else s_to; l0, r0 = edge(a); t = np.array([-(r0 - l0)[1], (r0 - l0)[0]]); t = t / np.hypot(*t) * (ext if which == 0 else -ext)
        ring = [[round(float(v), 2) for v in q] for q in (l0, r0, r0 + t, l0 + t, l0)]
        SLICES.append({'seg': tag, 's': round(float(a - s_from), 2), 'z': round(float(np.interp(a, s, z)), 3), 'ring': ring, 'endExtension': True})


def section(xy, s, z, half, s_from, s_to, tag):
    slices(xy, s, z, half, s_from, s_to, tag)
    xy = np.array(xy); s = np.array(s); z = np.array(z)
    out, chk = [], []
    st = np.arange(s_from, s_to + 1e-6, ALONG)
    if st[-1] < s_to - 0.5: st = np.r_[st, s_to]
    offs = np.linspace(-(half + SHOULDER), half + SHOULDER, int(math.ceil(2 * (half + SHOULDER) / ACROSS)) + 1)
    for a in np.arange(s_from, s_to + 1e-6, 1.0):
        p = np.array([np.interp(a, s, xy[:, 0]), np.interp(a, s, xy[:, 1])])
        q0 = np.array([np.interp(max(a - .5, s[0]), s, xy[:, 0]), np.interp(max(a - .5, s[0]), s, xy[:, 1])]); q1 = np.array([np.interp(min(a + .5, s[-1]), s, xy[:, 0]), np.interp(min(a + .5, s[-1]), s, xy[:, 1])])
        t = (q1 - q0) / np.hypot(*(q1 - q0)); nrm = np.array([-t[1], t[0]]); zz = float(np.interp(a, s, z))
        for o in (-0.8 * half, 0.0, 0.8 * half):
            c = p + o * nrm
            if not in_building(*c): chk.append([round(float(c[0]), 2), round(float(c[1]), 2), round(zz, 3), tag, round(float(a - s_from), 1), round(float(o), 1)])
        if np.min(np.abs(st - a)) < 1e-6:
            for o in offs:
                c = p + o * nrm
                if not in_building(*c): out.append([round(float(c[0]), 2), round(float(c[1]), 2), round(zz, 2), abs(float(o)) <= half])
    return out, chk


js = summ['lines']['main']['junctionStationsM']; names = ['V1', 'V2', 'V3', 'V4a', 'V4b']
groups, checks, main_pts = [], [], []
m = prof['main']
for k, n in enumerate(names):
    pts, chk = section(m['xy'], m['s'], m['z'], HALF[n], js[k], js[k + 1], n)
    main_pts += pts; checks += chk
    groups.append(('road_profile', n, pts))
mx = np.array([[p[0], p[1]] for p in main_pts])
for n in ('P-LOW', 'P-UP', 'U1'):
    b = prof[n]; pts, chk = section(b['xy'], b['s'], b['z'], HALF[n], 0.0, b['s'][-1], n)
    # 갈래가 본선 띠와 겹치는 곳은 본선 표본이 맡는다
    keep = [p for p in pts if np.min(np.hypot(mx[:, 0] - p[0], mx[:, 1] - p[1])) >= 1.5]
    chk = [c for c in chk if np.min(np.hypot(mx[:, 0] - c[0], mx[:, 1] - c[1])) >= 1.5]
    checks += chk; groups.append(('road_profile_u1' if n == 'U1' else 'road_profile', n, keep))
allp = np.array([[p[0], p[1]] for _, _, pts in groups for p in pts])
rest = []
for f, areas in (('smap_samples_roads_5186.json', ('gate_road', 'turnaround')), ('smap_samples_5186.json', ('s06',))):
    d = json.loads((repo / 'backend/data/terrain/samples' / f).read_text(encoding='utf-8'))
    for g in d['groups']:
        if g['area'] not in areas: continue
        keep = [p for p in g['points'] if np.min(np.hypot(allp[:, 0] - p[0], allp[:, 1] - p[1])) > REST_M]
        if keep: rest.append({'area': g['area'] + '_rest', 'areaName': g.get('areaName', g['area']) + ' (차도 띠 밖)', 'source': g['source'], 'collected': g['collected'],
                              'originalFile': g['originalFile'], 'note': f'{f} 의 {g["area"]} 표본 {len(g["points"])}개 중 V02 차도 띠 표본에서 {REST_M} m 넘게 떨어진 {len(keep)}개(값 그대로)', 'points': keep})
out = {'crs': 'EPSG:5186',
       'reason': 'V02: 사용자 S-MAP 높이 핀을 가장 무겁게 써서 만든 매끄러운 차도 종단으로 차도 띠의 지형을 차도 높이에 맞춤',
       'note': '차도 띠 표본(road_profile, road_profile_u1)은 잰 값이 아니라 종단에서 만든 값이다: 가운데 선에서 가로로 평평, 차도 반폭 + 갓길 1 m, 길 따라 2 m·가로 1.5 m 간격. '
               '종단의 근거는 docs/audit/v02 (user-readings.json, profile.json). S-MAP 은 독립 측량이 아니고 제작년도·수직 기준 미확인. *_rest 는 기존 표본 파일의 값 그대로(겹치지 않는 것만).',
       'sources': {'v02-road-profile': 'V02 매끄러운 종단 z(s): 사용자 S-MAP 핀(가중 최대) + E09 화면 판독점 + S-MAP 2 m 메시. 1 m 간격 종단을 차도 폭으로 펼침',
                   'smap-3d-mesh-pick': 'S-MAP 3D 화면 2 m 격자(T04)', 'smap-elevation-query': 'S-MAP 표고 조회(E01)'},
       'groups': [{'area': a, 'areaName': '차도 띠 ' + n, 'source': 'v02-road-profile', 'collected': '2026-10-11', 'originalFile': 'docs/audit/v02/profile.json',
                   'note': f'{n}: 반폭 {HALF[n]} m + 갓길 {SHOULDER} m, 건물 외곽 안 제외', 'points': [p[:3] for p in pts]} for a, n, pts in groups] + rest}
(repo / 'backend/data/terrain/samples/smap_samples_roadprofile_5186.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
json.dump({'note': '[x, y, 차도 높이, 구간, 구간 안 거리 m, 가운데에서 옆으로 m]. 가운데와 반폭의 0.8 배 양옆, 1 m 간격', 'half': HALF, 'points': checks}, open(here / 'check-points.json', 'w', encoding='utf-8'), ensure_ascii=False)
json.dump({'note': '길 따라 1 m 조각. ring 은 EPSG:5186 닫힌 사각형, z 는 조각 가운데의 종단 높이. 반폭 = 차도 반폭 + %.1f m' % BURN_SHOULDER, 'half': HALF, 'burnShoulderM': BURN_SHOULDER, 'slices': SLICES}, open(here / 'ribbon-slices.json', 'w', encoding='utf-8'), ensure_ascii=False)
cnt = {}
for g in out['groups']: cnt[g['area']] = cnt.get(g['area'], 0) + len(g['points'])
# 이웃 수(6 m 안) 점검: 도구는 3개 미만이면 그 표본을 버린다
P = np.array([p for g in out['groups'] if g['area'].startswith('road_profile') for p in g['points']])
nb = [(np.hypot(P[:, 0] - p[0], P[:, 1] - p[1]) <= 6).sum() - 1 for p in P]
print(cnt, 'check points', len(checks), 'min neighbours within 6 m', min(nb))
