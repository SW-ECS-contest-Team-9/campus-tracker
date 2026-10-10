# Z04 build_inputs.py 의 뒷부분(같은 이름 공간에서 실행된다): 기단 피처, 상자, 파일 쓰기.
# ---------- 3. 이름 붙인 면(근거가 따로 있는 것): 안의 한 점으로 찾는다 ----------
NAMED = {  # (x, y): (이름, 등급, 근거)
 (201127, 557277): ('한림관·은주1관 사이 평평한 면(무엇인지 모름)', 'S-MAP', '건물 노트 한림관·은주관(136.3~136.4 m)'),
 (201150, 557150): ('풋살장(수인관 옥상)', '확정(풋살장이 수인관 옥상), S-MAP(높이)', '건물 노트 수인관, 사용자 핀 9개 132.0~132.2'),
 (201008, 557392): ('북악관 서쪽 옆길(GS25 문 앞)', '확정(GS25 문 = 북악관 지하 1층 입구), S-MAP(높이)', '건물 노트 북악관, 시험용 DB 길 ddb8a8f8·db3fe999'),
 (201182, 557324): ('대일관 뒷문 앞', '확정(뒷문 위치: 사용자 그림 13), S-MAP(높이)', '건물 노트 대일관(뒷문 앞 지면 152.0 m)'),
 (201122, 557250): ('은주1관 1층 입구 앞', '원천(입구(1) 표지: 1층), S-MAP(높이)', '건물 노트 은주관(입구(1) 지면 131.3 m)'),
 (201125, 557200): ('은주2관 1층 로비 입구 앞', '원천(입구(1) 표지: 1층 로비), S-MAP(높이)', '건물 노트 은주관(132.2 m)'),
}
ABBR = {'turnaround': 'TURN', 'upper-branch': 'UPPER', 'back-paths': 'BACK', 'cheongun': 'CHEONGUN', 'hyein': 'HYEIN', 'eunju': 'EUNJU', 'yudam9': 'YUDAM9', 'west': 'WEST', 'gate': 'GATE'}
def low_around(poly):
    zz, _, _ = M.inside(poly.buffer(4.0)); return float(np.nanmin(zz)) if len(zz) else None
def carries(poly): return (not poly.buffer(-1.4).is_empty) and poly.area >= 16   # 지형 격자(2 m)가 실을 수 있는 폭
feats = defaultdict(list); surf = []; summary = defaultdict(list); cnt = Counter()
def platform(zone, name, poly, top, terrain, material, grade, assumption, source, reason, bottom=None, bottomNote=None, label=None):
    pid = f'Z04-{ABBR[zone]}-{name}'; lo = top if not isinstance(top, dict) else min(p[1] for p in top['points'])
    if bottom is None:
        la = low_around(poly); bottom = round(min(lo, la if la is not None else lo) - 1.0, 1); bottomNote = '둘레 4 m 안 S-MAP 지면의 가장 낮은 값보다 1 m 아래(옆 기단의 윗면보다 아래로 내려 틈이 없게)'
    pr = {'id': 'Z04-PLATFORM-' + pid[4:], 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': grade, 'surfaceName': pid if terrain else '없음(폭이 좁아 지형에 싣지 않음)', 'bottomM': bottom, 'bottomNote': bottomNote,
          'material': material, 'assumption': assumption, 'source': source}
    if label: pr['label'] = label
    if isinstance(top, dict): pr['topProfile'] = top
    else: pr['topM'] = top
    gm = geom(poly); feats[zone].append({'type': 'Feature', 'properties': pr, 'geometry': gm})
    if terrain:
        sp = {'name': pid, 'srid': 5186, 'reason': reason, 'grade': grade, 'source': source}
        if isinstance(top, dict): sp['profile'] = top
        else: sp['heightM'] = top
        surf.append((lo, {'type': 'Feature', 'properties': sp, 'geometry': gm}))
    summary[zone].append({'id': pr['id'], 'label': label, 'top': top if not isinstance(top, dict) else [p[1] for p in top['points']], 'area': round(poly.area, 1), 'grade': grade, 'terrain': terrain})
for h in HAND:
    platform(h['zone'], h['name'], h['poly'], h['top'], h['terrain'] and carries(h['poly']), h['material'], h['grade'], h['assumption'], h['source'], h['reason'], h.get('bottom'), h.get('bottomNote'), h.get('label'))
OWNER = {}
for k, v in NAMED.items():   # 이름 붙인 점에서 3 m 안의 가장 가까운 기단
    d, a = min(((q['poly'].distance(Point(k)), q) for q in AUTO), key=lambda t: t[0])
    if d <= 3.0: OWNER[id(a)] = v
for a in sorted(AUTO, key=lambda q: (q['zone'], -q['poly'].area)):
    r = a['reg']; cnt[a['zone']] += 1; kind = r['kind']; name = f"{kind}{cnt[a['zone']]:02d}"; nm = OWNER.get(id(a))
    if kind == 'S':
        grade = 'S-MAP(높이 범위), 추정(가파른 곳을 높이 2 m 띠마다 한 단으로 나눔: 실제 단의 수·자리 모름), 추정(외곽)'
        ass = f"가파른 곳의 한 단: S-MAP 1 m 메시 {r['n']}칸({r['p10']}~{r['p90']} m)을 가운데값 {r['z']} m 한 높이로. 비탈·계단식 화단·옹벽이 섞인 자리로 보이나 구분할 근거가 없다"
        reason = f"Z04 {ZONES[a['zone']]} 가파른 곳의 단 {r['z']} m"
    elif kind == 'T':
        grade = (nm[1] if nm else 'S-MAP(윗면 높이)') + ', 추정(외곽 ±1.5 m)'
        ass = f"평탄면: S-MAP 1 m 메시의 평평한 칸 {r['n']}개(10~90 % {r['p10']}~{r['p90']} m)의 가운데값 {r['z']} m 를 한 높이로. 외곽은 그 칸 묶음에 둘레의 가파른 칸(벽·계단이 뭉개진 곳, 5 m 안)을 붙여 곧게 다듬은 것"
        reason = f"Z04 {ZONES[a['zone']]} 평탄면 {r['z']} m" + (f": {nm[0]}" if nm else '')
    else:
        rough = r['res'] > 0.35
        grade = (nm[1] if nm else 'S-MAP(윗면 높이)') + (f", 추정(평면 하나로 줄임: 맞춤 잔차 90 % {r['res']:.2f} m)" if rough else '') + ', 추정(외곽 ±1.5 m)'
        ass = f"경사면: S-MAP 1 m 메시 {r['n']}칸({r['p10']}~{r['p90']} m)에 맞춘 평면 하나, 경사 {r['slope']:.1f} %, 맞춤 잔차 90 % {r['res']:.2f} m" + ('. 실제는 화단·비탈·계단이 섞였을 수 있다(구분할 근거 없음)' if rough else '')
        reason = f"Z04 {ZONES[a['zone']]} 경사면 {r['p10']}~{r['p90']} m" + (f": {nm[0]}" if nm else '')
    platform(a['zone'], name, a['poly'], a['top'], carries(a['poly']), 'rock' if kind == 'S' or (kind == 'R' and r['res'] > 0.35) else 'paving', grade, ass, MESH + (', ' + nm[2] if nm else ''), reason, label=nm[0] if nm else None)
    a['id'] = 'Z04-PLATFORM-' + f"{ABBR[a['zone']]}-{name}"
BOX = defaultdict(list)
def box(zone, id, typ, poly, fromM, toM, assumption, source, grade='추정', basePlane='', **extra):
    poly = poly if isinstance(poly, Polygon) else Polygon(poly)
    BOX[zone].append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': geom(big(poly))})
def ground(x, y):
    """그 자리 기단 윗면 높이(없으면 None)."""
    p = Point(x, y)
    for h in HAND:
        if h['poly'].contains(p): return float(prof_z(h['top'], x, y)) if isinstance(h['top'], dict) else h['top']
    best = None
    for a in AUTO:
        if a['poly'].contains(p):
            v = float(prof_z(a['top'], x, y)) if isinstance(a['top'], dict) else a['top']; best = v if best is None else max(best, v)
    return best
if (HERE / 'boxes.py').exists(): exec((HERE / 'boxes.py').read_text(encoding='utf-8'))
for zone in ZONES:
    fs = feats[zone] + BOX[zone]
    dump(STR / f'z04-{zone}.geojson', {'type': 'FeatureCollection', 'name': f'z04-{zone}', 'crs': CRS, 'provenance': {'builder': 'docs/audit/z04/build_inputs.py', 'basePlanes': 'backend/data/terrain/recipes/z04-surface.geojson', 'schema': 'docs/audit/g02/STRUCTURES.md',
        'zone': ZONES[zone], 'note': '기단 윗면 높이는 S-MAP 1 m 메시·사용자 핀, 외곽은 ±1.5 m 추정. 상자 치수는 사진 눈대중이라 전부 estimated.'}, 'features': fs})
surf = [f for _, f in sorted(surf, key=lambda t: t[0])]   # 낮은 것부터: 겹치는 가장자리에서는 높은 기단이 이긴다
dump(REC / 'z04-surface.geojson', {'type': 'FeatureCollection', 'name': 'z04-surface', 'crs': CRS, 'features': surf})
z03 = json.loads((REC / 'z03-smooth-ground.json').read_text(encoding='utf-8'))
dump(REC / 'z04-smooth-ground.json', {'crs': 'EPSG:5186', 'protectBuildings': True,
  'reason': 'Z04: Z03 조리법에 캠퍼스 안 나머지 구역의 기단을 더함(회차 공간 포장면을 한 경사면으로, 차도 띠, 본관·한림관 사이, 뒤편, 청운관·혜인관·은주관 둘레, 유담관 9층 앞마당, 서쪽 옹벽 위, 정문). 지형 칸은 구조물 파일(frontend/public/structures/z04-*.geojson)의 기단 윗면에서 나온다. 기단끼리는 벽면으로 만난다.',
  'steps': z03['steps'] + [{'type': 'surface', 'file': 'z04-surface.geojson'}]})
allp = [h['poly'] for h in HAND] + [a['poly'] for a in AUTO]; cov = unary_union(allp + [DONE, FIELD])
inside = CAMPUS.difference(BLD_ALL)
dump(HERE / 'model.json', {'crs': 'EPSG:5186', 'plaza': {'profile': PLAZA_PROF, 'slopePct': r2(pl_slope), 'fitResidualP90M': r2(pl_res), 'atWayFoot': r2(prof_z(PLAZA_PROF, 201044.0, 557350.0)), 'atBukakStairFoot': r2(prof_z(PLAZA_PROF, 201041.7, 557360.5))},
  'coverage': {'campusOutsideBuildingsM2': round(inside.area), 'coveredByPlatformsM2': round(inside.intersection(cov).area), 'groundCellsWithoutPlatform': LEFT},
  'counts': {z: {'platform': len(feats[z]), 'extrude': len(BOX[z]), 'terrain': sum(s['terrain'] for s in summary[z])} for z in ZONES}, 'zones': {z: {'title': ZONES[z], 'platforms': summary[z]} for z in ZONES}})
for z in ZONES:
    T = [s for s in summary[z] if not isinstance(s['top'], list)]; print(z, 'platforms', len(feats[z]), 'boxes', len(BOX[z]), 'area', round(sum(s['area'] for s in summary[z])), 'flat heights', sorted({s['top'] for s in T})[:40])
print('plaza', PLAZA_PROF, 'slope %', round(pl_slope, 2), 'res', round(pl_res, 2), 'way foot', prof_z(PLAZA_PROF, 201044.0, 557350.0), 'bukak stair foot', prof_z(PLAZA_PROF, 201041.7, 557360.5))
print('coverage m2', round(inside.area), round(inside.intersection(cov).area), 'surfaces', len(surf))
