"""Z02: 동 노트(대일관·상승관·청운관) 머리와 본문을 한 번 고친 스크립트(기록용. 다시 돌리면 이미 고쳐져 있어 멈춘다).
  python patch_notes.py   그다음 python docs/audit/registry/building_registry.py write / check"""
import pathlib
N = pathlib.Path(r'C:\campus-tracker-backend\데이터\모델링 개선\건물')
def patch(fn, pairs, tail):
    p = N / fn; s = p.read_text(encoding='utf-8')
    for a, b in pairs:
        assert s.count(a) == 1, (fn, a[:50], s.count(a))
        s = s.replace(a, b)
    p.write_text(s.rstrip('\n') + '\n' + tail, encoding='utf-8', newline='\n')

ANNEX = '[[[201195.62, 557327.77], [201221.91, 557315.41], [201218.54, 557306.02], [201216.83, 557307.19], [201216.71, 557306.86], [201191.55, 557318.68], [201195.62, 557327.77]]]'
patch('대일관.md', [
 ('  높이_출처: SMAP_MESH\n  층수: {값: 7,', '  높이_출처: SMAP_MESH\n  덮지_않는_곳: "The north strip of the east block (292 m2, roof 163.1 m) is 상승관, a separate building (user, 2026-10-11); it is drawn by the added entry 추가-상승관."\n  층수: {값: 7,'),
 ('"footprint": "unchanged; parts tile it (2165.8 of 2165.8 m2). The east annex is the strip within 9.95 m of the north edge of the east block (edge v8-v9)"',
  '"footprint": "unchanged; the main part covers 1873 of 2165.8 m2. The strip within 9.95 m of the north edge of the east block (edge v8-v9, 292 m2) is 상승관 (user, 2026-10-11) and is not drawn as 대일관"'),
 ('  - 이름: 동쪽 부속부 (동쪽 덩어리의 북쪽 띠, 약 29 x 10 m. 정체 미확인)\n    모델_반영: 예\n',
  '  - 이름: 동쪽 부속부 (동쪽 덩어리의 북쪽 띠, 약 29 x 10 m. 사용자 확정 2026-10-11로 상승관)\n    모델_반영: "아니오 (대일관이 아니라 상승관이다. 사용자 확정 2026-10-11. 상승관 노트의 건물 추가로 그린다)"\n'),
 ('    모델_반영: "아니오 (좌표가 없고 높이 158은 검토 레이어 값이라 등급이 추정이다)"',
  '    모델_반영: "아니오 (건물 부분이 아니라 구조물 파일 z02-daeil-front 의 상자로 넣었다: 원천 외곽 밖으로 나와 있고 아치 아래가 빈 공간이라서. Z02)"'),
 ('  - {이름: "대일관 입구(3)", 좌표: [201181.5, 557319.5], 층: "산책로에서 1층 복도로", 바닥_높이: 152.0,',
  '  - {이름: "대일관 입구(3) = 뒷문", 좌표: [201182.5, 557321.4], 좌표_비고: "학교 표지 (201181.5, 557319.5)는 외곽 2.4 m 안쪽이라 뒤쪽 벽 위로 옮김(±3 m). 사용자 그림 13의 대일관 뒷문", 층: "산책로에서 1층 복도로", 바닥_높이: 152.0,'),
], '''
## Z02 반영 (2026-10-11 추가)
- **동쪽 부속부는 상승관이다(사용자 확정).** 대일관의 부분에서 뺐다. 대일관은 본체 하나만 그리고, 그 띠(292 ㎡)는 상승관 노트의 건물 추가(`추가-상승관`)가 그린다. 서버 건물 id `대일관`은 그대로다.
- **현관 돌출부**는 건물 부분이 아니라 구조물 파일(`frontend/public/structures/z02-daeil-front.geojson`)의 상자로 넣었다. 까닭: 원천 외곽 밖으로 5 m 나와 있고(부분은 외곽 안이어야 한다), 아치 아래가 빈 공간이라 막힌 블록으로 그리면 틀리다. S-MAP 건물 모델에서 읽은 낮은 지붕: 벽을 따라 13.4 m, 벽에서 5.0 m, 처마 155.8 m, 용마루 158.0 m(등급 S-MAP). 벽돌 상자 폭 9.2 m, 아치 폭 3.0 m 둘은 사진 눈대중(추정).
- **현관 단** 151.0 m(추정 ±0.3), **현관 앞 넓은 계단** 13단, **높은 가장자리 길** 151.3 m(추정, 범위 151.0~151.8), **출구 옆 하행 계단** 34단(추정)도 같은 구조물 파일에 있다. 값과 근거는 [[데이터/모델링 개선/구역/대일관 정면과 운동장 북쪽 가장자리]]와 [[데이터/모델링 개선/실험/Z02 대일관 정면과 운동장 북쪽 가장자리 제작]].
- **뒷문(입구(3))**: 좌표를 뒤쪽 벽 위 (201182.5, 557321.4)로 옮겨 적었다(±3 m), 지면 152.0 m(S-MAP). 뒤편 땅은 시험용 지형에서 아직 옛 높이(141~148 m)라 길로 잇지 않았다.
- 정문 앞 벽은 가운데 구간(길이 14.5 m)이 1.8~2.1 m 앞으로 나와 있고(원천 외곽), 현관은 그 동쪽 끝에 걸쳐 있다.
''')

patch('상승관.md', [
 ('모델_보정: {종류: 없음, 비고: "B09: 지금 블록은 사용자가 그린 자리에서 북쪽으로 23.6 m 떨어져 있다(자리가 틀림). 그린 자리에는 S-MAP에 따로 된 지붕 덩어리가 없어 옮길 외곽·지붕 값이 없다. 숨길지 옮길지는 사용자 결정. 그때까지 그대로 둔다"}',
  '''모델_보정:
  종류: 숨김
  원천_이름: 상승관
  등급: 확정
  사유: "The GeoPackage polygon of 상승관 lies on bare ground behind 대일관 (S-MAP: 229 of 229 cells are ground, 148.1-148.9 m). The user confirmed (2026-10-11) that this block is to be removed and that 상승관 is the low building between 대일관 and 청운관; that building is drawn from the added entry 추가-상승관."
  근거: {"source": "user statement and drawings 2026-10-11 (12-SMAP, 13-SMAP); S-MAP 3D viewer mesh, 1 m grid (b09)", "collectedOn": "2026-10-11", "level": "user-confirmed fact, supported by source data", "independentSurvey": false, "mesh": "all 229 one-metre cells under the GeoPackage polygon are S-MAP ground (148.1-148.9 m); no building model there", "notCovered": "campus_buildings (the 2D campus map) still has the polygon at the wrong place"}
모델_추가:
  건물_id: "추가-상승관"
  높이_출처: SMAP_MESH
  근거: {"source": "S-MAP 3D viewer building model 173604866 (2 m grid, B02; 1 m grid, B09); user statement and drawings 2026-10-11", "collectedOn": "2026-10-11", "level": "which building is 상승관 is user-confirmed (the low building with the 우편취급국 label between 대일관 and 청운관); outline and roof are S-MAP source data (one provider), not field verified", "independentSurvey": false, "outline": "the strip of the 대일관 GeoPackage footprint within 9.95 m of the north edge of its east block (B02 derive.py, boundary read from the S-MAP grid, +-1 m; 292 m2). The S-MAP model 173604866 has 321 one-metre cells here", "roof": "flat block at 163.1 m, the median of the S-MAP model cells (p10-p90 163.1-163.1, 94 % within 1.5 m)", "notCovered": "floors, the entrance (south end towards the inner yard, estimated), ground behind the building (server DEM is old there)"}'''),
 ('상태: 지도가 틀림', '상태: 구현됨(시험용 DB)'),
 ('''    모델_반영: "아니오 (사용자 확인 필요: 자리는 사용자 그림으로 정해졌으나(대일관 동쪽 끝과 청운관 사이) 그 자리에 S-MAP의 따로 된 지붕 덩어리가 없어 외곽·지붕 값이 없다. 지금 블록은 그 자리에서 23.6 m 북쪽이다. 숨길지 옮길지 미정)"
    외곽: {값: "원천 외곽 그대로", 등급: 원천}
    지붕_형태: {값: "원천 외곽 자리에 S-MAP 건물 모델 없음(E05). 값 없음", 등급: 모름}
    지붕_높이: {값: "원천 외곽 자리에 S-MAP 건물 모델 없음(E05). 값 없음", 등급: 모름}''',
  f'''    모델_반영: 예
    외곽: {{좌표: {ANNEX}, 면적_m2: 292, 출처: "대일관 원천 외곽의 동쪽 덩어리 북쪽 띠(B02 derive.py, 경계는 S-MAP 2 m 격자에서 높이가 바뀌는 칸 사이 ±1 m). S-MAP 건물 객체 173604866 자리. 옛 대일관 동쪽 부속부 외곽 그대로", 등급: S-MAP}}
    지붕_형태: {{값: "평지붕(S-MAP 건물 객체 173604866)", 출처: "S-MAP 건물 모델 2 m 격자 (B02)", 등급: S-MAP}}
    지붕_높이: {{값: 163.1, 흩어짐: "10~90 % 163.1~163.1, 최대 168.4, 68칸, 1.5 m 안 94 %", 출처: "S-MAP 건물 모델 2 m 격자 중앙값 (B02 docs/audit/b02/results.json)", 등급: S-MAP}}'''),
 ('  - {이름: "상승관 입구", 좌표: [201200.5, 557294.2],',
  '  - {이름: "상승관 입구(마당 쪽, 추정)", 좌표: [201217.6, 557306.4], 층: "1층 로비", 바닥_높이: 153.1, 출처: "자리 = 사용자 그림 07·13의 상승 표시가 안쪽 마당 북쪽 끝을 가리킴 + 건물 남쪽 끝 벽 가운데(Z02). 높이 = 안쪽 마당 S-MAP 152.9~153.3", 등급: "추정(위치: 어느 벽인지 확인 못 함), S-MAP(높이)"}\n  - {이름: "상승관 입구(학교 표지, 자리가 대일관 안이라 쓰지 않음)", 좌표: [201200.5, 557294.2],'),
], '''
## Z02 반영 (2026-10-11 추가, 사용자 확정)
- 사용자 확정(2026-10-11): 상승관은 "우편취급국" 글자가 있는 낮은 건물 하나다. 대일관 뒤 맨땅 위의 블록은 지운다.
- 그래서 (1) 원천 도형(맨땅 위 블록)은 **숨김**, (2) 실제 건물은 **건물 추가** `추가-상승관`으로 넣었다. 외곽은 옛 "대일관 동쪽 부속부" 그대로(292 ㎡, S-MAP 건물 객체 173604866 자리), 지붕 163.1 m(S-MAP). 위 "못 정한 것 (가)(나)(다)"는 (나)로 풀렸다.
- 캠퍼스 지도 건물 자료(평면)에는 여전히 옛 자리의 도형이 있다. 장면(3D)에서만 고쳤다. 길이 가리키는 건물 id `상승관`은 그 평면 자료의 것이라 그대로 쓸 수 있다.
- 입구: 학교 표지 (201200.5, 557294.2)는 대일관 건물 안이라 쓰지 않는다. 안쪽 마당(153.1 m) 북쪽 끝, 건물 남쪽 끝 벽 (201217.6, 557306.4)으로 두었다(추정. 어느 벽에 문이 있는지 사진이 없다).
- 가는 길: 운동장 → 동쪽 끝 계단(13단 추정) → 작은 광장 151.0 m → 오른쪽 계단(13단 추정) → 안쪽 마당 153.1 m → 입구. 구조물은 [[데이터/모델링 개선/구역/대일관 정면과 운동장 북쪽 가장자리]].
- 층수는 모른다. 건물 뒤(북쪽) 땅은 시험용 지형에서 옛 높이라 바닥이 낮게 계산된다(S-MAP 지면 148.9~153.1).
''')

patch('청운관.md', [], '''
## Z02 반영 (2026-10-11 추가)
- 사용자 확정: 옆의 회색 지붕 덩어리와 초록 지붕 낮은 부분은 청운관이다. "북동 저층부"는 청운관에 그대로 둔다. 건물 자료는 바꾸지 않았다.
- 대일관과 닿지 않는다: 대일관 본체와 청운관 본체 사이 3.3 m, 그 사이는 안쪽 마당(153.1 m, 구조물 파일의 기단)이다.
- 열린 돌출부(기둥·층별 판)와 좌우 계단은 이번에도 넣지 않았다. 판 높이·기둥 자리·계단 끝의 근거가 사진 눈대중뿐이다. 지도는 여전히 163.8 m까지 막힌 블록이다.
- S-MAP은 돌출부 원천 외곽의 북서 모서리 안쪽(약 6 ㎡)을 153.1 m 땅으로 읽는다. 돌출부 아래 첫 단이 안쪽 마당과 같은 높이로 이어지는 것으로 보인다(추정).
- 청운관 1층 입구(운동장 높이 148.9 m)는 학교 표지 (201216.5, 557279.8) 자리가 블록 안이라 블록 앞 운동장 가장자리에 접속점을 두었다(Z02, 추정).
''')
print('ok')
