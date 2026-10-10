"""T06: 포장면 공간 영역의 바닥 높이만 바꾸는 PUT 본문을 만든다(경계·이름·종류 그대로).
사용법: python area_body.py <areas.json: GET areas 응답> <영역 id> <새 높이> <out.json>"""
import json, sys
areas = json.load(open(sys.argv[1], encoding='utf8'))
a = next(x for x in areas if x['id'] == int(sys.argv[2]))
z = float(sys.argv[3])
ring = a['geometry']['coordinates'][0][:-1]
note = (a.get('note') or '') + ' T06(2026-10-11): 바닥 %.1f → %.1f m. 사용자 S-MAP 핀(포장면 12개 중앙 130.7 m)과 차도 종단 끝(130.53 m)에 맞춤. 지형도 이 높이로 평탄화.' % (a['elevationM'], z)
body = {'name': a['name'], 'kind': a['kind'], 'elevationM': z, 'buildingId': a.get('buildingId'), 'floor': a.get('floor'), 'note': note,
        'coordinates': ring, 'holes': [h[:-1] for h in a['geometry']['coordinates'][1:]], 'expectedRevision': a['revision']}
json.dump(body, open(sys.argv[4], 'w', encoding='utf8', newline='\n'), ensure_ascii=False)
print(a['id'], a['name'], a['elevationM'], '->', z, 'vertices', len(ring), 'note chars', len(note))
