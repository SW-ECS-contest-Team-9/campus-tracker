# Z05 build_inputs.py 의 뒷부분(같은 이름 공간에서 실행된다): 상자, 캠퍼스 밖 표본, 파일 쓰기.
BOX = defaultdict(list)
def box(zone, id, typ, poly, fromM, toM, assumption, source, grade='추정', basePlane='', **extra):
    poly = poly if isinstance(poly, Polygon) else Polygon(poly)
    BOX[zone].append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': geom(big(poly))})
if (HERE5 / 'boxes.py').exists(): exec((HERE5 / 'boxes.py').read_text(encoding='utf-8'))
# ---------- 캠퍼스 밖 남서·남쪽: S-MAP 지면 표본(2 m 간격). 캠퍼스 지도 건물에서 16 m 안은 뺀다(표본 단계는 건물 칸을 지키지 않는다) ----------
ALLP = unary_union([q['poly'] for q in PLATS]).buffer(0)
_ALLP_S = unary_union([q['poly'] for q in PLATS if q.get('terrainCut') is None]).buffer(0)   # Z10: 건물 옆에 붙인 기단(회전교차로) 안의 표본은 그대로 둔다. 빼면 그 건물(외국인 생활관) 밑의 지형 칸이 달라진다
far = ~contains_xy(BLD_ALL.buffer(16.0), XS, YS) & ~contains_xy(CAMPUS.buffer(1.0), XS, YS) & ~contains_xy(_ALLP_S.buffer(1.0), XS, YS)
sel = M.g & np.isfinite(Z) & far & (YS < 557246) & (XS < 201182) & (XS % 2 == 0) & (YS % 2 == 0)
pts = [[float(x), float(y), r2(z)] for x, y, z in zip(XS[sel], YS[sel], Z[sel])]
dump(REPO / 'backend/data/terrain/samples/smap_samples_z05_edge_5186.json', {'crs': 'EPSG:5186', 'reason': 'Z05: 캠퍼스 남서·남쪽 바깥(공연실습소·외국인 생활관·정문 앞 둘레)의 지형을 S-MAP 지면으로 국소 보정. 옛 지형이 2~10 m 높아 건물 밑동과 정문 앞을 가렸다',
  'note': 'S-MAP(서울시 3D 지도)은 독립 측량이 아니다. 건물 모델 칸은 뺐다. 캠퍼스 지도 건물에서 16 m 안, 캠퍼스 안, 기단 안은 뺐다. 원자료는 작업 볼트 데이터/보완자료/3d-map-audit-20261009/z04 (smap-mesh-z04-1m-*.txt)',
  'groups': [{'area': 'z05_edge_sw', 'source': 'smap-3d-mesh-pick', 'collected': '2026-10-11', 'originalFile': 'z04/smap-mesh-z04-1m-w0~e3.txt (2 m 간격으로 솎음)', 'points': pts}]})
if (HERE5.parent / 'z09' / 'blend.py').exists(): exec((HERE5.parent / 'z09' / 'blend.py').read_text(encoding='utf-8'))
# ---------- 파일 ----------
for old in list(STR.glob('z04-*.geojson')) + list(STR.glob('z05-*.geojson')): old.unlink()
for zone in ZONES:
    dump(STR / f'z05-{zone}.geojson', {'type': 'FeatureCollection', 'name': f'z05-{zone}', 'crs': CRS, 'provenance': {'builder': 'docs/audit/z05/build_inputs.py', 'basePlanes': 'backend/data/terrain/recipes/z05-surface.geojson', 'schema': 'docs/audit/g02/STRUCTURES.md',
        'zone': ZONES[zone], 'note': '기단은 손으로 정한 곧은 변의 큰 평면이다(평지 또는 한 경사면). 높이는 S-MAP 1 m 메시·사용자 핀, 외곽과 벽면 자리는 추정(±2 m). 상자 치수는 사진 눈대중이라 전부 estimated.'}, 'features': feats[zone] + BOX[zone]})
surf = [f for _, f in sorted(surf, key=lambda t: t[0])]   # 낮은 것부터: 겹치는 가장자리에서는 높은 기단이 이긴다
dump(REC / 'z05-surface.geojson', {'type': 'FeatureCollection', 'name': 'z05-surface', 'crs': CRS, 'features': surf})
z03 = json.loads((REC / 'z03-smooth-ground.json').read_text(encoding='utf-8'))
first = [s for s in z03['steps'] if s['type'] != 'surface']; rest = [s for s in z03['steps'] if s['type'] == 'surface']
dump(REC / 'z05-smooth-ground.json', {'crs': 'EPSG:5186', 'protectBuildings': True,
  'reason': 'Z05: Z03 조리법에 캠퍼스 안 나머지 구역의 기단을 더함(Z04 의 자동 기단·2 m 띠의 단을 손으로 정한 큰 평면과 옹벽 한 면으로 바꿈: 서쪽 옹벽과 아래 공도, 가운데 옹벽, 남서쪽 공도, 뒤편 단과 숲 비탈, 정문 안 포장). 캠퍼스 밖 남서·남쪽 지형은 S-MAP 지면 표본으로 낮춤. 지형 칸은 구조물 파일(frontend/public/structures/z05-*.geojson)의 기단 윗면에서 나온다.',
  'steps': first + [{'type': 'local-samples', 'files': ['../samples/smap_samples_z05_edge_5186.json'], 'areas': ['z05_edge_sw']}] + ([{'type': 'local-samples', 'files': ['../samples/z09_edge_blend_5186.json'], 'areas': ['z09_edge_blend']}] if BLEND_PTS else []) + rest + [{'type': 'surface', 'file': 'z05-surface.geojson'}]})
cov = unary_union([ALLP, DONE, FIELD]); inside = CAMPUS.difference(BLD_ALL)
e = RES[okc]; kinds = Counter(q['kind'] for q in PLATS)
dump(HERE5 / 'model.json', {'crs': 'EPSG:5186',
  'counts': {'platforms': len(PLATS), 'roadPieces': sum(1 for q in PLATS if q.get('road')), 'handOther': kinds['hand'] - sum(1 for q in PLATS if q.get('road')), 'planes': kinds['spec'], 'boxes': sum(len(v) for v in BOX.values()), 'terrainSurfaces': len(surf), 'edgeSamples': len(pts),
             'z04': {'platforms': 205, 'roadPieces': 55, 'handOther': 8, 'flat': 16, 'incline': 53, 'steepBands': 73, 'boxes': 104}},
  'coverage': {'campusOutsideBuildingsM2': round(inside.area), 'coveredByPlatformsM2': round(inside.intersection(cov).area)},
  'vsSmap1m': {'points': int(e.size), 'p50abs': r2(np.median(np.abs(e))), 'p90abs': r2(np.percentile(np.abs(e), 90))},
  'zones': {z: {'title': ZONES[z], 'platforms': summary[z], 'boxes': len(BOX[z])} for z in ZONES},
  'residuals': {q['id']: q['res'] for q in PLATS}})
print('platforms', len(PLATS), dict(kinds), 'boxes', sum(len(v) for v in BOX.values()), 'surfaces', len(surf), 'edge samples', len(pts))
print('coverage m2', round(inside.area), round(inside.intersection(cov).area), 'vs smap p50/p90', r2(np.median(np.abs(e))), r2(np.percentile(np.abs(e), 90)))
