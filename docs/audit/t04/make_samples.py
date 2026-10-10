# T04: collect.py 결과(t04/samples.json)에서 통과한 구역만 골라 저장소용 표본 파일을 만든다.
#   python make_samples.py <t04/samples.json> <backend/data/terrain/samples/smap_samples_roads_5186.json> <구역,구역,...>
# 기존 smap_samples_5186.json 은 건드리지 않는다(그 파일 전체가 후보 id 의 해시 입력이라 한 글자만 바뀌어도 운동장·S06 후보 id 가 달라진다).
import json, sys
src, out, keep = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
S = json.load(open(src, encoding='utf-8'))
head = {
    'crs': 'EPSG:5186',
    'reason': 'T04: 차도(E09)가 지나는 구역의 S-MAP 지면 표본으로 2015 DEM 을 국소 보정',
    'note': 'S-MAP(서울시 3D 지도)은 독립 측량이 아니다. 제작년도·수직 기준·정확도 미확인. 이 구역에는 휴대폰 기록 같은 독립 근거가 없다. '
            'S-MAP 조회값의 재배포 허용 여부 미확인. 원자료는 작업 볼트 데이터/보완자료/3d-map-audit-20261009 의 t04, e05 폴더. '
            '고른 규칙은 docs/audit/t04/collect.py.',
    'sources': {'smap-3d-mesh-pick': 'S-MAP 3D 화면에서 2 m 격자로 읽은 표면 높이(지형 모델 칸만. 건물 칸과 붙은 칸, 포장면과 턱으로 끊긴 칸, 튀는 값 제외)'},
}
groups = []
for key in keep:
    a = S['areas'][key]; by = {}
    for x, y, z, f in a['points']: by.setdefault(f, []).append([x, y, round(z, 3)])
    for f, pts in sorted(by.items()):
        groups.append({'area': key, 'areaName': a['name'], 'source': 'smap-3d-mesh-pick', 'collected': '2026-10-10', 'originalFile': f, 'note': a['why'] + ' / ' + a['rule'], 'points': pts})
body = json.dumps(head, ensure_ascii=False, indent=1)[:-2] + ',\n "groups": [\n' + ',\n'.join(
    '  ' + json.dumps(g, ensure_ascii=False, separators=(',', ':')) for g in groups) + '\n ]\n}\n'
open(out, 'w', encoding='utf-8', newline='\n').write(body)
print(sum(len(g['points']) for g in groups), 'samples', len(groups), 'groups', len(body.encode('utf-8')), 'bytes')
