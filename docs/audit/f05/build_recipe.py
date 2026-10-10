"""F05: 새 운동장 경계(results.json)로 지형 조리법 입력을 다시 만든다. DB·서버 접근 없음. T06 파일은 그대로 둔다(되돌리기용).
사용법(이 폴더에서): python build_recipe.py
 출력: backend/data/terrain/recipes/f05-plateaus.geojson, f05-no-blend.geojson, f05-smooth-ground.json
 포장면 평탄면·포장면 쪽 번지지 않는 구역·차도 띠·표본 구역은 T06 것 그대로. 바뀌는 것은 운동장 다각형과 그 북쪽 벽 띠뿐이다.
"""
import json, math
OUT = '../../../backend/data/terrain/recipes/'
J = lambda f: json.load(open(f, encoding='utf8'))
ring = J('results.json')['ring']
plate = J(OUT + 't06-plateaus.geojson'); mask = J(OUT + 't06-no-blend.geojson'); recipe = J(OUT + 't06-smooth-ground.json')

def band(ring, i0, i1, out=9.0):   # T06 build_inputs.py 와 같은 계산: 경계의 i0~i1 꼭짓점 구간을 바깥으로 넓힌 띠
    pts = ring[:-1]; n = len(pts)
    sgn = 1 if sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n)) > 0 else -1
    off = []
    for i in range(i0, i1 + 1):
        a, b, c = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]; nx = ny = 0.0
        for (p, q) in ((a, b), (b, c)):
            if (i == i0 and (p, q) == (a, b)) or (i == i1 and (p, q) == (b, c)): continue
            L = math.hypot(q[0] - p[0], q[1] - p[1]); nx += sgn * (q[1] - p[1]) / L; ny += -sgn * (q[0] - p[0]) / L
        L = math.hypot(nx, ny); off.append([round(b[0] + out * nx / L, 2), round(b[1] + out * ny / L, 2)])
    chain = [list(pts[i]) for i in range(i0, i1 + 1)]
    return chain + off[::-1] + [chain[0]]

for f in plate['features']:
    if f['properties']['name'] == 'field':
        f['geometry']['coordinates'] = [ring]; f['properties']['reason'] = '운동장(F05 경계: S-MAP 평지 가장자리와 건물 외곽에 맞춘 곧은 변 22개). 바닥 148.9 m 는 사용자 확정(E06 측정).'
for f in mask['features']:
    if f['properties']['name'] == 'field-north-wall':
        f['geometry']['coordinates'] = [band(ring, 8, 12)]   # 꼭짓점 8~12 = 대일관 화단 벽 서쪽·꺾임·동쪽·상승관 계단 쪽 벽
        f['properties']['reason'] = '운동장 북쪽 변(F05 경계): 대일관 앞 흰 돌 화단 벽과 상승관 계단 쪽 벽(사용자 사진으로 확정). 바깥 지면이 1.5~3 m 높다.'
recipe['reason'] = 'F05: T06 조리법에서 운동장 다각형만 새 경계(곧은 변 22개, 8,455㎡)로 바꿈. 나머지(포장면 130.6 m, 차도 띠, 표본 구역)는 T06 과 같다.'
for s in recipe['steps']:
    for k in ('file', 'noBlend', 'keep'):
        if s.get(k) in ('t06-plateaus.geojson', 't06-no-blend.geojson'): s[k] = s[k].replace('t06-', 'f05-')
for name, d in (('f05-plateaus.geojson', plate), ('f05-no-blend.geojson', mask)):
    json.dump(d, open(OUT + name, 'w', encoding='utf8', newline='\n'), ensure_ascii=False)
json.dump(recipe, open(OUT + 'f05-smooth-ground.json', 'w', encoding='utf8', newline='\n'), ensure_ascii=False, indent=2)
print(json.dumps(recipe, ensure_ascii=False)); print(mask['features'][0]['geometry']['coordinates'])
