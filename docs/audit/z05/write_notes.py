"""Z05: 구역 노트 끝에 'Z05 에서 바뀐 것' 절을 쓴다(있으면 바꿔 쓴다). 내용은 model.json 과 구조물 파일에서.  python write_notes.py"""
import json, pathlib, re, collections
HERE = pathlib.Path(__file__).parent; NOTES = pathlib.Path(r'C:\campus-tracker-backend\데이터\모델링 개선\구역'); STR = HERE.parents[2] / 'frontend/public/structures'
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))
NOTE = {'turnaround': '북악관 앞 회차 공간과 본관 앞', 'upper-branch': '위쪽 갈래와 한림관 둘레', 'back-paths': '뒤편 산책로와 북악관 옆길', 'cheongun': '청운관 앞', 'hyein': '혜인관 둘레', 'eunju': '은주관 둘레와 풋살장', 'yudam9': '유담관 9층 쪽 앞마당과 본관 앞 차도', 'west': '서문과 서쪽 옹벽', 'gate': '정문'}
EXTRA = {
 'west': ['옹벽은 곧은 벽면 하나다: (201007.7, 557250) → (200983.5, 557426). 메시가 4 m 마디로 읽는 윗가장자리에 맞춘 선에서 1.5 m 바깥(추정 ±2 m).', '옹벽 위 화단 띠는 131.2 m 한 높이로 두었다. 메시는 133~135.4 m 로 읽지만 나무 수관으로 보았다(추정). 실제 화단 턱 높이는 모른다.', '서문 문틀을 옹벽 면에 붙이고 뚫린 곳을 어두운 판으로 표시했다. 터널 안은 여전히 모름.'],
 'gate': ['캠퍼스 남서쪽 아래의 공도를 한 경사면(93.8 → 106.9 m)으로 넣었다. 공연실습소가 이 길에 면한다. 캠퍼스 밖 남서·남쪽 지형은 S-MAP 지면 표본으로 낮췄다(전: 2~10 m 높았음).', '정문 안 포장은 한 경사면, 남서쪽 변이 공도 위 옹벽 면. 제1주차장 문틀을 차로 끝에 두었다(안쪽 빈 곳은 없음).'],
 'eunju': ['주 진입로(아래)와 위쪽 갈래(위) 사이는 옹벽 한 면이다(x 201099.5~201101, 벽 높이 0 → 14 m). 위는 위쪽 갈래 높이를 따르는 화단 띠. Z04 의 2 m 띠 단 12개를 대신한다.', '은주1관 서쪽의 "계단식 정원"(공식 사진)은 만들지 않았다: 단의 수·자리 모름. 131.8 m 한 높이의 띠로 두었다.', '은주2관 벽 앞 꺼진 틈은 145.0 m 한 높이의 곧은 띠.'],
 'back-paths': ['건물 뒤의 단은 평면 6개(북악관 뒤 둘, 문예관 뒤 139.4, 대일관 뒤 둘, 뒷문 앞 152.0). 그 바깥 숲 비탈은 경사면 둘(추정: 안쪽은 단 높이, 바깥은 24 m 밖의 지형 높이). 산책로 선은 넣지 않았다.', '북악관 입구(3) 앞 계단 17단과 참(134.1 m)을 넣었다(방향·단 수 추정).', '대일관 측면 계단은 만들지 않았다: 실제로 있는지 모른다(현장 요청 F4 그대로).'],
 'upper-branch': ['본관·한림관 사이 틈의 계단(Z04 추정 52단)을 뺐다(사용자 2026-10-11: 바깥 계단·비탈 없음). 틈은 바닥 127.2 m 와 북쪽의 벽면(위 135.3 m)으로. 벽면 자리(북좌표 557301)는 추정.'],
 'cheongun': ['운동장 쪽 열린 기둥부를 건물 블록에서 빼고(동 노트 → 보정 파일) 구조물로 세웠다: 앞줄 기둥 4, 층 판 3(153.1 / 156.65 / 160.2 m), 넓은 지붕 163.8 m, 좌우 계단 26단씩, 참. 1층 현관 153.1 m 는 S-MAP 값과 사진의 판 간격으로 읽은 추정.', '모르는 것: 기둥의 실제 자리·수(뒷줄), 판의 실제 높이, 난간·벽, 계단의 정확한 발치, 지하 1층 문의 자리, "청운관에서 내려오는 계단"(주석 A5)의 양 끝.'],
 'hyein': ['운동장 쪽 현관을 넣었다: 옆 벽 둘, 1층 바닥 153.1 m(= 149.0 + 층고 4.11, 추정), 붉은 지붕 덩어리, 오른쪽 계단 26단. 치수는 사진 눈대중.'],
 'yudam9': ['제2주차장 문틀을 사용자 표시 자리(201021.9, 557307.1, 문턱 127.9 m)에 두었다. 들어가는 방향은 차로 방향(추정).', '유담관 9층 높이의 남서쪽 테라스(129.2 m)와 분수 광장 북쪽 가장자리(114.1 m)를 평면으로.'],
 'turnaround': ['회차 공간 내리막의 서쪽 가장자리와 북악관 남서 벽 앞을 평면으로 메웠다.'],
}
for z, title in NOTE.items():
    ps = M['zones'][z]['platforms']; fc = json.loads((STR / f'z05-{z}.geojson').read_text(encoding='utf-8'))['features']
    boxes = collections.Counter(re.sub(r'-(S?\d+|PIER-\d|[LR]-S\d+|[NS])$', '', f['properties']['id']) for f in fc if f['properties']['kind'] == 'extrude')
    rows = [p for p in ps if p['kind'] == 'spec']; roads = sum(1 for p in ps if p['kind'] == 'hand')
    L = ['## Z05 에서 바뀐 것 (2026-10-11, Claude)', f'구조물 파일이 `frontend/public/structures/z05-{z}.geojson` 으로 바뀌었다(만드는 스크립트 `docs/audit/z05/build_inputs.py`). 위의 "기단 목록 (Z04 제작)"은 옛 것이다.',
         f'- 기단 {len(ps)}개(길 띠·이름 붙인 마당 {roads}, 손으로 정한 평면 {len(rows)}). 가파른 곳을 2 m 띠로 나눈 단은 없다. 평면끼리는 벽면 하나로 만난다.']
    L += ['- ' + t for t in EXTRA.get(z, [])]
    if rows:
        L += ['', '| 기단 | 무엇 | 윗면 (m) | 넓이 (㎡) | 재질 | 등급 |', '|---|---|---|---|---|---|']
        for p in sorted(rows, key=lambda p: -p['area']):
            if p['area'] < 40 and p['id'][-2] == '-': continue
            top = f"{p['top']}" if not isinstance(p['top'], list) else f"{p['top'][0]} → {p['top'][1]} (경사면)"; L.append(f"| {p['id'][13:]} | {p['what']} | {top} | {round(p['area'])} | {'화단·비탈' if p['material'] == 'planting' else p['material']} | {p['grade']} |")
    if boxes: L += ['', '상자: ' + ', '.join(f'{k} {v}개' for k, v in sorted(boxes.items()))]
    L += ['', '제작 기록: [[데이터/모델링 개선/실험/Z05 옹벽 한 면과 큰 평면]]']
    f = NOTES / (title + '.md'); t = f.read_text(encoding='utf-8'); t = re.split(r'\n## Z05 에서 바뀐 것', t)[0].rstrip() + '\n\n' + '\n'.join(L) + '\n'; f.write_text(t, encoding='utf-8', newline='\n'); print(title, len(ps), len(rows), sum(boxes.values()))
