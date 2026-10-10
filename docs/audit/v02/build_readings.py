"""V02 1·2단계: 사용자 S-MAP 높이 핀을 한 표로 모으고(여러 캡처에 찍힌 같은 핀은 하나로), 표면을 나누고, 자동 자료와 대조한다.
   python build_readings.py <볼트 audit 폴더> <저장소 루트> [--query]
   --query: S-MAP 표고 조회(읽기 전용, 1.2초 간격)를 사용자 점 자리에 보낸다. 응답 원문은 <audit>/v02/smap-elevation-raw.json (git 밖)."""
import sys, json, math, pathlib, time, datetime, urllib.request, urllib.parse, warnings
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from surface import Surface
warnings.filterwarnings('ignore')
audit = pathlib.Path(sys.argv[1]); repo = pathlib.Path(sys.argv[2]); here = pathlib.Path(__file__).parent
CARDS = ['SM07', 'SM09', 'SM11', 'SM15', 'P13']
IMG = {'SM07': 'smap-user-main-west-detail.png (SM-07; SM-06 과 같은 핀)', 'SM09': 'smap-user-main-building-both-sides.png (SM-09)', 'SM11': 'smap-user-eunju-court-pins.png (SM-11)',
       'SM15': 'smap-court-parallel-roads.png (SM-15; SM-05·SM-16 과 같은 핀)', 'P13': '사용자-출입구·주차장-20261010/13-SMAP-한림관-가는길-높이표시.webp'}
ERR = {'SM07': 2.5, 'SM09': 3.0, 'SM11': 2.5, 'SM15': 2.5, 'P13': 5.0}  # 캡처 한 장만으로 정한 자리의 오차 가정(m). 근거: 같은 핀을 두 캡처에서 구한 자리 차이

# ---- 1. 모으기: 값이 같고 8 m 안이면 같은 핀 ----
raw = []
for c in CARDS:
    G = json.loads((audit / 'v02' / f'georef-{c}.json').read_text(encoding='utf-8'))
    for p in G['pins']:
        if c == 'SM09' and p['u'] < 450 and p['v'] < 250: continue  # SM-09 화면 왼쪽 위 구석: 카메라를 맞춘 핀 무리에서 멀어 자리가 6~10 m 어긋난다(같은 핀이 SM-11·SM-15 에 있다)
        raw.append({'card': c, 'value': p['value'], 'x': p['x'], 'y': p['y'], 'uv': [p['u'], p['v']], 'note': p.get('note')})
groups = []
for r in raw:
    for g in groups:
        if g['value'] == r['value'] and math.hypot(g['x'] - r['x'], g['y'] - r['y']) <= 8 and r['card'] not in g['cards']:
            g['obs'].append(r); g['cards'].append(r['card'])
            g['x'] = float(np.mean([o['x'] for o in g['obs']])); g['y'] = float(np.mean([o['y'] for o in g['obs']])); break
    else:
        groups.append({'value': r['value'], 'x': r['x'], 'y': r['y'], 'obs': [r], 'cards': [r['card']]})

# ---- 2. 표면 나누기 ----
prop = json.loads((repo / 'docs/audit/e09/vehicle-roads-proposal.geojson').read_text(encoding='utf-8'))
SEG = {f['properties']['id']: np.array(f['geometry']['coordinates']) for f in prop['features'] if f['geometry']['type'] == 'LineString'}


def near(line, x, y):
    best = (1e9, 0, 0); s0 = 0
    for a, b in zip(line, line[1:]):
        d = b[:2] - a[:2]; L = float(np.hypot(*d)); t = max(0, min(1, float(((x - a[0]) * d[0] + (y - a[1]) * d[1]) / (L * L or 1))))
        q = a[:2] + t * d; dist = float(math.hypot(x - q[0], y - q[1]))
        if dist < best[0]: best = (dist, s0 + t * L, float(a[2] + t * (b[2] - a[2])))
        s0 += L
    return best  # 거리, 누적 거리, 그 자리 제안 높이


def classify(g):
    """화면에서 본 표면(Claude 가 캡처를 보고 정함)을 값·자리 규칙으로 적어 다시 돌려도 같게 한다."""
    v, x, y = g['value'], g['x'], g['y']
    d = {k: near(l, x, y) for k, l in SEG.items()}
    k = min(d, key=lambda k: d[k][0]); dist = d[k][0]
    if g['cards'] == ['P13']:  # 사진 13 은 자리 오차가 5 m 라 화면에서 본 대로 적는다
        if v == 121.4: return 'V3', '차도', '윗길 갈림 바로 앞 본선 차로(횡단보도와 과속방지턱 사이)'
        if v in (122.6, 124.4) or (v == 125.1 and d['U1'][0] < 3.5): return 'U1', '차도(윗길)', '윗길 들머리. 제안 중심선에서 %.1f m' % d['U1'][0]
        return None, '한림관·은주1관 앞(윗길 가장자리·입구 앞, 차도 아님)', '한림관 입구 앞'
    if y < 557100 and v < 107.0: return None, '공도 갈림(정문 밖)', '정문 남쪽 공도. 학교 차도 아님'
    if x < 201140 and y < 557200 and v <= 106.05 and d['P-LOW'][0] > 8: return None, '공도(서경로)', '차도 서쪽 아래 공도. 학교 차도 아님'
    if v < 104.7: return None, '공도(서경로)', '차도 서쪽 아래 공도 또는 캠퍼스 밖'
    if 130.0 <= v <= 131.3 and x < 201050 and y > 557320: return 'V4', '회차 공간 포장면', '버스·노면 표시가 보이는 포장면'
    if 113.8 <= v <= 114.3 and d['V2'][0] > 5: return None, '분수 광장', '광장 포장면'
    if 131.0 <= v <= 132.3 and 201114 < x < 201131 and 557193 < y < 557212:
        return 'U1-EXT', '차도(윗길에서 풋살장 쪽으로 이어지는 열)', 'E09 제안 U1 끝(130.8 m) 너머. 제안에 없는 구간'
    if v >= 132.9 or (v >= 131.9 and y < 557200 and x > 201121): return None, '풋살장·운동장·통로 등(차도 아님)', ''
    if k in ('V1', 'V2', 'V3') and dist <= 4.5: return k, '차도', '아스팔트 차로 위. 제안 중심선에서 %.1f m' % dist
    if k == 'P-LOW' and dist <= 4.5: return 'P-LOW', '차도(주차장 차로)', '하단 주차장 차로. 제안 중심선에서 %.1f m' % dist
    if d['P-LOW'][0] <= 30 and 105.5 <= v <= 111.5 and d['V2'][0] > 6 and y < 557175: return None, '하단 주차장 덮개 아래·광장 가장자리(차도 아님)', 'S-MAP 표고는 덮개 아래 땅 높이, 메시는 덮개 위'
    if k == 'U1' and dist <= 3.3: return 'U1', '차도(윗길)', '제안 중심선에서 %.1f m' % dist
    if 124.5 <= v <= 129.0 and 201040 < x < 201075 and 557284 < y < 557316 and d['V3'][0] > 4.5: return None, '본관 쪽 보도·계단식 보도(차도 아님)', 'V3 중심선에서 %.1f m' % d['V3'][0]
    if 125.0 <= v <= 128.2 and 201094 < x < 201120 and 557254 < y < 557285: return None, '한림관·은주1관 앞(윗길 가장자리·입구 앞, 차도 아님)', 'U1 중심선에서 %.1f m' % d['U1'][0]
    if k in ('V4', 'P-UP') and dist <= 6: return 'V4', '회차 공간 포장면', ''
    return None, '기타(차도 아님)', '가장 가까운 제안 구간 %s 에서 %.1f m' % (k, dist)


S = Surface(audit)
meta = json.loads((audit / 'terrain-grid-meta.json').read_text(encoding='utf-8-sig'))
def grid(f): return np.fromfile(f, dtype='<f4').reshape(meta['height'], meta['width'])
def dem(h, x, y):
    fx = (x - meta['originX']) / meta['resolution'] - 0.5; fy = (y - meta['originY']) / meta['resolution'] - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    return float(h[iy, ix] * (1 - tx) * (1 - ty) + h[iy, ix + 1] * tx * (1 - ty) + h[iy + 1, ix] * (1 - tx) * ty + h[iy + 1, ix + 1] * tx * ty)
OLD = grid(audit / 'terrain-grid.f32'); T04 = grid(audit / 't04/dem-all.f32')
t04s = json.loads((repo / 'backend/data/terrain/samples/smap_samples_roads_5186.json').read_text(encoding='utf-8'))
t04pts = np.array([p for g in t04s['groups'] for p in g['points']])
s06 = json.loads((repo / 'backend/data/terrain/samples/smap_samples_5186.json').read_text(encoding='utf-8'))
s06pts = np.array([p for g in s06['groups'] if g['area'] == 's06' for p in g['points']])
picks = json.loads((repo / 'docs/audit/e09/picks.json').read_text(encoding='utf-8'))
pk = np.array([p for k, v in picks.items() if isinstance(v, list) and v and isinstance(v[0], list) and len(v[0]) == 3 for p in v])

out = []
for g in sorted(groups, key=lambda g: (g['y'], g['x'])):
    seg, surf, why = classify(g)
    if surf == '공도(서경로)': continue  # 캠퍼스 밖 공도 열은 표에 넣지 않는다(개수만 적는다)
    sp = max([math.hypot(o['x'] - g['x'], o['y'] - g['y']) for o in g['obs']]) if len(g['obs']) > 1 else None
    err = round(max(1.5, sp), 1) if sp is not None else min(ERR[c] for c in g['cards'])
    x, y, v = round(g['x'], 2), round(g['y'], 2), g['value']
    r = {'id': 'U%03d' % len(out), 'value_m': v, 'x': x, 'y': y, 'xy_err_m': err, 'images': [IMG[c] for c in g['cards']], 'pixel': {o['card']: o['uv'] for o in g['obs']},
         'position_method': ('캡처 %d장의 카메라 맞춤 평균(장별 자리 차 최대 %.1f m)' % (len(g['obs']), 2 * sp)) if sp is not None else '캡처 1장의 카메라 맞춤',
         'surface': surf, 'segment': seg, 'surface_note': why, 'reading_note': next((o['note'] for o in g['obs'] if o['note']), None)}
    if seg in SEG:
        dist, s, zp = near(SEG[seg], x, y); r['e09'] = {'dist_m': round(dist, 2), 's_m': round(s, 1), 'proposal_z': round(zp, 2), 'user_minus_proposal': round(v - zp, 2)}
    dpk = np.hypot(pk[:, 0] - x, pk[:, 1] - y); j = int(np.argmin(dpk))
    if dpk[j] <= 4: r['e09_pick'] = {'dist_m': round(float(dpk[j]), 2), 'z': float(pk[j, 2]), 'user_minus_pick': round(v - float(pk[j, 2]), 2)}
    zm = float(S.at(x, y)); r['mesh_z'] = None if math.isnan(zm) else round(zm, 2)
    for name, pts in (('t04_sample', t04pts), ('s06_sample', s06pts)):
        dd = np.hypot(pts[:, 0] - x, pts[:, 1] - y); j = int(np.argmin(dd))
        if dd[j] <= 2.0: r[name] = {'dist_m': round(float(dd[j]), 2), 'z': float(pts[j, 2]), 'user_minus_sample': round(v - float(pts[j, 2]), 2)}
    r['terrain_old'] = round(dem(OLD, x, y), 2); r['terrain_t04_all'] = round(dem(T04, x, y), 2)
    out.append(r)
n_public = sum(1 for g in groups if classify(g)[1] == '공도(서경로)')

# ---- 3. S-MAP 표고 조회 ----
cache = audit / 'v02' / 'smap-elevation-raw.json'
Q = json.loads(cache.read_text(encoding='utf-8')) if cache.exists() else []
have = {(q['x'], q['y']): q for q in Q if q.get('status') == 200}
if '--query' in sys.argv:
    for r in out:
        if (r['x'], r['y']) in have: continue
        t = datetime.datetime.now().isoformat(timespec='seconds')
        try:
            req = urllib.request.Request('https://smap.seoul.go.kr/measure/getMeasureElevation3d.do', data=urllib.parse.urlencode({'x': r['x'], 'y': r['y']}).encode(),
                                         headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://smap.seoul.go.kr/'})
            with urllib.request.urlopen(req, timeout=20) as resp: body = resp.read().decode('utf-8', 'replace'); st = resp.status
        except Exception as e: body, st = repr(e), None
        q = {'name': r['id'], 'x': r['x'], 'y': r['y'], 'time': t, 'status': st, 'raw': body}; Q.append(q)
        if st == 200: have[(r['x'], r['y'])] = q
        time.sleep(1.2)
    cache.write_text(json.dumps(Q, ensure_ascii=False, indent=1), encoding='utf-8')
for r in out:
    q = have.get((r['x'], r['y']))
    if q:
        try:
            z = float(json.loads(q['raw'])['result']['dem_z']); r['smap_query_z'] = round(z, 2); r['user_minus_query'] = round(r['value_m'] - z, 2)
        except Exception: pass


def stat(v):
    v = [abs(a) for a in v if a is not None]
    return {'n': len(v), 'median_abs': round(float(np.median(v)), 2), 'p90_abs': round(float(np.percentile(v, 90)), 2), 'max_abs': round(max(v), 2)} if v else {'n': 0}


road = [r for r in out if r['segment']]
summary = {'total_campus_points': len(out), 'public_road_points_not_listed': n_public, 'carriageway_points': len(road), 'other_surface_points': len(out) - len(road),
           'by_segment': {k: sum(1 for r in road if r['segment'] == k) for k in sorted({r['segment'] for r in road})},
           'by_surface': {k: sum(1 for r in out if r['surface'] == k) for k in sorted({r['surface'] for r in out})},
           'xy_err_m': stat([r['xy_err_m'] for r in out]),
           'points_seen_in_two_or_more_images': sum(1 for r in out if len(r['images']) > 1),
           'agreement_carriageway': {'user_minus_e09_proposal_at_nearest_point': stat([r.get('e09', {}).get('user_minus_proposal') for r in road if r['segment'] in SEG]),
                                     'user_minus_e09_pick_within_4m': stat([r.get('e09_pick', {}).get('user_minus_pick') for r in road]),
                                     'user_minus_smap_query': stat([r.get('user_minus_query') for r in road]),
                                     'user_minus_mesh': stat([None if r['mesh_z'] is None else r['value_m'] - r['mesh_z'] for r in road]),
                                     'user_minus_t04_or_s06_sample_within_2m': stat([(r.get('t04_sample') or r.get('s06_sample') or {}).get('user_minus_sample') for r in road]),
                                     'user_minus_terrain_old': stat([r['value_m'] - r['terrain_old'] for r in road]),
                                     'user_minus_terrain_t04_all': stat([r['value_m'] - r['terrain_t04_all'] for r in road])},
           'agreement_all': {'user_minus_smap_query': stat([r.get('user_minus_query') for r in out]), 'user_minus_mesh': stat([None if r['mesh_z'] is None else r['value_m'] - r['mesh_z'] for r in out])},
           'disagree_over_0p5_vs_query': [{'id': r['id'], 'value': r['value_m'], 'query': r.get('smap_query_z'), 'surface': r['surface'], 'segment': r['segment'], 'xy': [r['x'], r['y']], 'xy_err_m': r['xy_err_m']}
                                          for r in out if abs(r.get('user_minus_query') or 0) > 0.5]}
EXTRA = {
 'notGeoreferenced': [
  {'image': '사용자-SMAP높이-20261010/사진-7-전체시점.png', 'value_m': 130.6, 'surface': '회차 공간 포장면(버스 옆)', 'why': '이 화면의 땅 핀이 2개뿐이라 카메라를 못 맞춤. SM-07 의 130.6 핀과 같은 값. 근거.md 의 사진7 전사에는 이 핀이 빠져 있다'},
  {'image': '사용자-SMAP높이-20261010/사진-2~4.png', 'value_m': [131.3, 148.8], 'surface': '문예관 옆 오르막(사용자 확정: 보행로)', 'why': '경사도 측정선의 시작·끝(평균 13.591 %). 차도가 아니라 이번 종단에 쓰지 않음'},
  {'image': '사용자-SMAP높이-20261010/사진-6.png, 사진-8-*.png', 'value_m': '151.3 151.6 148.9 / 141.4~150.2', 'surface': '대일관 앞 띠·운동장·사잇길(차도 아님)', 'why': '차도 밖. 이전 작업(user-smap-samples-5186.geojson)의 대응을 그대로 둔다'},
  {'image': '사용자-SMAP높이-20261010/사진-9-은주2관-상하부.png', 'value_m': [111.3, 109.8, 109.8], 'surface': '풋살장 아래 길(화면 아래쪽)', 'why': '핀 8개 중 5개가 풋살장 평탄면(132 m)이라 카메라가 정해지지 않음. SM-11·SM-15 의 차도 열(107.0~110.9)과 같은 길로 보임(추정)'}],
 'transcriptionDifferences': [
  {'card': 'SM-07-G02', 'earlier': '본관 가까운 열 126.3, 128.1, 128.8', 'now': '126.3, 127.7, 128.1, 128.8', 'note': '127.7 풍선이 126.3·128.1 뒤에 가려 있다. SM-09 전사에는 127.7 이 있다'},
  {'card': 'SM-15-G03', 'earlier': '가운데 열 106.8, 107.6, 107.0, 106.4, 105.9, 106.4, 107.8, 111.3, 114.1 (한 줄)', 'now': '값은 같다. 자리로 보면 한 줄이 아니다: 106.8 은 정문 밖 공도 갈림, 107.6·107.0·106.4 는 하단 주차장 차로, 105.9·106.4·107.8·111.3 은 주차장 덮개 아래 땅(메시는 덮개 위 110 m), 114.1 은 광장 가장자리'},
  {'card': '사진 13', 'earlier': '121.4 / 122.6 / 124.4 / 125.1 / 126.1 / …5.1 을 한림관 가는 길(윗길)의 한 줄로 봄', 'now': '값은 같다(마지막은 앞자리가 가려 125.1 로 추정). 121.4 는 윗길이 아니라 갈림 바로 앞 본선 차로, 126.1·(1)25.1 은 한림관 입구 앞'},
  {'card': '사진 7', 'earlier': '근거.md 전사에 회차 공간 130.6 m 핀 없음', 'now': '화면 왼쪽 아래 버스 옆에 130.6m 핀이 있다'},
  {'card': 'SM-11 고도 글자', 'earlier': '-', 'now': '화면 글자가 겹쳐 386 m 로 읽음(385 일 수 있음). 카메라 맞춤 결과에는 영향이 작다'}]}
cams = {c: {k: json.loads((audit / 'v02' / f'georef-{c}.json').read_text(encoding='utf-8'))[k] for k in ('camera', 'fit')} for c in CARDS}
json.dump({'title': 'V02 사용자 S-MAP 높이 핀(차도와 그 옆)', 'crs': 'EPSG:5186', 'created': '2026-10-11',
           'note': '값은 사용자가 S-MAP 화면에서 찍은 풍선의 숫자를 Claude 가 캡처에서 다시 읽은 것. 자리는 캡처마다 카메라(눈 위치·방향·시야각)를 되찾아 핀 바닥점을 옮긴 것(georef.py). 측량 아님.',
           'cameras': cams, 'summary': summary, **EXTRA, 'points': out}, open(here / 'user-readings.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False, indent=1))
