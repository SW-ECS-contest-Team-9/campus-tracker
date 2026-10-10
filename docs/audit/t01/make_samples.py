# T01: E01 표본(samples.json) 중 V2e 입력(운동장·사잇길·S06, use=true)만 골라 저장소용 표본 파일을 만든다.
# 사용법: python make_samples.py <e01/samples.json> <backend/data/terrain/samples/smap_samples_5186.json>
# x,y,z 를 0.001 m 로 반올림한다.
import json, sys
src, out = sys.argv[1], sys.argv[2]
DATE = {'smap-coordinate-checks.json': '2026-10-09', 'claude-m16/smap-elevation-raw-20261009.json': '2026-10-09',
        'claude-m17/smap-elevation-raw-m17.json': '2026-10-09', 'claude-m17/smap-surface-grid-2m.txt': '2026-10-09'}
KEY = {'운동장': 'field', '사잇길': 'corridor', 'S06': 's06'}
groups = {}
for s in json.load(open(src, encoding='utf-8'))['samples']:
    if not s['use'] or s['area'] == '기타': continue
    f = s['src']
    k = (s['area'], s['kind'], f)
    groups.setdefault(k, []).append([round(s['x'], 3), round(s['y'], 3), round(s['z'], 3)])
doc = {
    'crs': 'EPSG:5186',
    'reason': 'E01 V2e: 운동장·사잇길·S06 세 구역의 S-MAP 지면 표본으로 2015 DEM 을 국소 보정',
    'note': 'S-MAP(서울시 3D 지도)은 독립 측량이 아니다. 제작년도·수직 기준·정확도 미확인. '
            '수직 기준 직접 대조는 1점뿐이다(원 표고점 148.91 m 대 S-MAP 148.94 m, +0.03 m). '
            'S-MAP 조회값의 재배포 허용 여부 미확인. 원자료는 작업 볼트 데이터/보완자료/3d-map-audit-20261009 에 있다.',
    'sources': {
        'smap-elevation-query': 'S-MAP 표고 조회 응답의 dem_z (XY 만 보내 받은 지면 값, buld_z 가 있는 점은 제외)',
        'smap-3d-mesh-pick': 'S-MAP 3D 화면에서 2 m 격자로 읽은 표면 높이(지형 모델 칸만, 건물 칸과 붙은 칸·튀는 값 제외)',
    },
    'groups': [],
}
for (area, kind, f), pts in sorted(groups.items()):
    grp = {'area': KEY[area], 'areaName': area, 'source': 'smap-elevation-query' if kind == 'api' else 'smap-3d-mesh-pick',
           'collected': DATE.get(f, '2026-10-10'), 'originalFile': f}
    if 'field_flat' in f: grp['note'] = '원값 미보관. 선택 규칙 |z-148.92|<=0.12 로 고른 칸이라 148.92 로 둠(±0.12)'
    grp['points'] = pts
    doc['groups'].append(grp)
# 그룹마다 한 줄(점은 붙여 씀)
head = {k: v for k, v in doc.items() if k != 'groups'}
body = json.dumps(head, ensure_ascii=False, indent=1)[:-2] + ',\n "groups": [\n' + ',\n'.join(
    '  ' + json.dumps(g, ensure_ascii=False, separators=(',', ':')) for g in doc['groups']) + '\n ]\n}\n'
open(out, 'w', encoding='utf-8', newline='\n').write(body)
print(sum(len(g['points']) for g in doc['groups']), 'samples', len(doc['groups']), 'groups', len(body.encode('utf-8')), 'bytes')
