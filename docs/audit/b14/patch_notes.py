"""B14: 동 노트 머리(상승관·대일관·청운관)를 parts.json 의 값으로 고친다(이미 고친 노트는 건너뛴다. 고치기 전 사본은 볼트 b14/노트-백업). 본문 절은 따로 덧붙인다.   python patch_notes.py"""
import json, pathlib, shutil
HERE = pathlib.Path(__file__).parent; NOTES = pathlib.Path(r'C:\campus-tracker-backend\데이터\모델링 개선\건물'); BAK = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\b14\노트-백업')
P = json.loads((HERE / 'parts.json').read_text(encoding='utf-8')); R = P['roof']; F = P['footprint']; GD = P['gapDaeilM']; GC = P['gapCheongunM']; L = P['cheongunLobe']
j = lambda o: json.dumps(o, ensure_ascii=False)
BAK.mkdir(exist_ok=True)
def patch(name, edits, lines=()):
    p = NOTES / name; t = p.read_text(encoding='utf-8')
    if not (BAK / name).exists(): shutil.copy(p, BAK / name)
    for old, new in edits:
        assert t.count(old) == 1, (name, old[:60], t.count(old)); t = t.replace(old, new)
    rows = t.split('\n')
    for prefix, new in lines:   # 그 머리말로 시작하는 줄 하나를 통째로 바꾼다(머리 안에서만)
        end = rows.index('---', 1); hit = [i for i in range(end) if rows[i].startswith(prefix)]; assert len(hit) == 1, (name, prefix, len(hit)); rows[hit[0]] = new
    p.write_text('\n'.join(rows), encoding='utf-8', newline='\n'); print(name, 'ok')
MESH = 'S-MAP 건물 모델 0.5 m 격자 (B14 docs/audit/b14/derive.py -> parts.json, 볼트 3d-map-audit-20261009/b14/smap-mesh-b14-sangseung-05m.txt)'
EV = {"source": "S-MAP 3D viewer building model 173604866, 0.5 m grid read 2026-10-12 (B14); user statements 2026-10-11 and 2026-10-12 with two S-MAP screenshots", "collectedOn": "2026-10-12", "level": "which building is 상승관 and that it stands almost without a gap to its neighbours are user-confirmed; outline and roofs are S-MAP source data (one provider), not field verified", "independentSurvey": False,
      "outline": f"four straight edges fitted to the 0.5 m cells of model 173604866 (bearing -23.04 deg, {P['frame']['lengthNorthM']} m along the north wall, {P['frame']['widthM']} m wide, east end wall oblique and parallel to 청운관): {F['meshCellsInside']} of {F['meshCells']} model cells are inside, {F['insideButNotMesh']} cells inside are not the model. This entry is the main box west of the east end block ({R['mainAreaM2']} m2)",
      "roof": f"flat roof at 163.1 m: {R['mainCells']} cells, p10-p90 {R['mainM'][0]}-{R['mainM'][2]}, all within 0.3 m. The parapet rim reads {R['parapetTopM'][1]} m and is drawn by the structure file b14-sangseung.geojson, not as roof",
      "gaps": f"to the rear wall of 대일관 (same grid): min {GD['min']} / median {GD['median']} / max {GD['max']} m over 29 m, touching along {GD['touchingM']} m; to 청운관 along its north-west wall: min {GC['alongMin']} / median {GC['alongMedian']} / max {GC['alongMax']} m",
      "replaces": "B02/Z02 outline (north strip of the 대일관 GeoPackage footprint, 292 m2, 2 m grid): same west end and north wall within 0.4 m, but 9 m too short at the east end",
      "notCovered": "floors, the entrance (wall facing the inner yard, estimated), wall material and windows (S-MAP screenshots only), ground heights under the building"}
EV_E = {"source": EV["source"], "collectedOn": "2026-10-12", "level": EV["level"], "independentSurvey": False,
        "outline": f"east end of the same S-MAP building model 173604866, east of the roof step at 11.8 m from the centre along the long axis ({R['eastBlockAreaM2']} m2); its east wall is oblique, parallel to the north-west wall of 청운관",
        "roof": f"flat at 165.3 m: {R['eastBlockCells']} cells, p10-p90 {R['eastBlockM'][0]}-{R['eastBlockM'][2]}. It is 2.3 m higher than the main roof and 0.6 m above the parapet rim (side view from the north in the S-MAP viewer, vault b14/smap-옆에서-북쪽면-동쪽끝덩어리가-더높음.jpg); reading it as a lower block from the oblique screenshots was wrong",
        "notCovered": "what the block is (stair or lift core, estimated)"}
main_part = [
 '  - 이름: 본체',
 '    모델_반영: 예',
 f'    외곽: {{좌표: {j([R["mainRing"]])}, 면적_m2: {round(R["mainAreaM2"])}, 출처: "{MESH}. 객체 173604866 의 칸에 곧은 변 넷을 맞춤(±0.5 m): 긴 벽 방위 -23.04도, 북쪽 벽 길이 {P["frame"]["lengthNorthM"]} m·폭 {P["frame"]["widthM"]} m 인 건물 전체({round(F["areaM2"])} ㎡, 칸 {F["meshCells"]}개 중 {F["meshCellsInside"]}개가 안) 가운데 지붕 단(동쪽 끝에서 8.5 m)의 서쪽", 등급: S-MAP}}',
 '    지붕_형태: {값: "평지붕, 둘레에 난간(난간 윗선 164.8 m)", 출처: "' + MESH + '. 사용자 S-MAP 화면 2장(사용자-상승관-SMAP-20261012)", 등급: S-MAP}',
 f'    지붕_높이: {{값: 163.1, 흩어짐: "10~90 % {R["mainM"][0]}~{R["mainM"][2]}, {R["mainCells"]}칸 모두 0.3 m 안", 출처: "{MESH}", 등급: S-MAP}}',
 '    지면_SMAP: {북: "' + f'{P["ground"]["north"][0]}~{P["ground"]["north"][2]} (숲 쪽 벽 앞 3 m)' + '", 남_대일관_사이_틈: "' + f'{GD["slitGroundM"][0]}~{GD["slitGroundM"][2]}' + '", 남동_안쪽_마당: "' + f'{P["ground"]["yardSouthOfEastBlock"][0]}~{P["ground"]["yardSouthOfEastBlock"][2]}' + '", 출처: "' + MESH + '", 등급: S-MAP, 비고: "숲 쪽 땅이 대일관 쪽보다 3.6~4.4 m 낮다. 건물이 단 차에 걸쳐 서 있다"}',
 '    층수: {값: 모름, 비고: "S-MAP 화면의 숲 쪽 벽에 창 줄 3~4개(판독)", 등급: 모름}',
 '  - 이름: 동쪽 끝 덩어리 (청운관 쪽 끝, 본체보다 2.3 m 높음)',
 '    모델_반영: 예',
 f'    모델_부분: {{덧붙임: {{건물_id: "추가-상승관동쪽끝", 표지: "상승관 동쪽 끝", 근거: {j(EV_E)}}}}}',
 f'    외곽: {{좌표: {j([R["eastBlockRing"]])}, 면적_m2: {round(R["eastBlockAreaM2"])}, 출처: "{MESH}. 같은 건물 객체의 동쪽 끝, 지붕 단의 동쪽. 동쪽 끝 벽은 청운관 북서 벽과 나란히 비스듬하다", 등급: S-MAP}}',
 '    지붕_형태: {값: "평지붕(난간 없음)", 출처: "' + MESH + '", 등급: S-MAP}',
 f'    지붕_높이: {{값: 165.3, 흩어짐: "10~90 % {R["eastBlockM"][0]}~{R["eastBlockM"][2]}, {R["eastBlockCells"]}칸", 출처: "{MESH}. 옆에서 본 S-MAP 화면(b14/smap-옆에서-북쪽면-동쪽끝덩어리가-더높음.jpg)에서도 본체 난간보다 높다", 등급: S-MAP}}']
look = [
 '겉모습:',
 '  - 대상: ["추가-상승관", "추가-상승관동쪽끝"]',
 '    벽: {값: 붉은 벽돌, 출처: "사용자-상승관-SMAP-20261012/01·02: S-MAP 화면의 벽이 어두운 벽돌색(화면이 어두워 재질은 못 가림). 양옆 대일관·청운관이 붉은 벽돌", 등급: 추정}',
 '    창: {모양: 낱창, 층수: 4, 아래_높이: 148.7, 위_높이: 163.1, 출처: "사용자-상승관-SMAP-20261012/01·02: 숲 쪽 벽에 창 줄 3~4개. 숲 쪽 지면 148.7 m(S-MAP)에서 지붕 163.1 m 까지 14.4 m 를 네 줄로 나눔. 층수는 모른다. 대일관 쪽은 땅이 152.3~153.1 m 라 아랫줄이 땅에 가린다", 등급: 추정}',
 '    지붕: {모양: 평지붕, 재질: 금속판, 출처: "사용자-서문·제2주차장·수인관-20261010/07-카카오위성-상승관-사용자표시.webp: 짙은 회색 지붕. S-MAP 화면 2장: 평지붕, 본체 둘레에 난간(난간은 구조물 파일 b14-sangseung 이 그린다)", 등급: "확정(짙은 평지붕), 재질은 추정"}',
 '    특징:',
 '      - {무엇: "우편취급국 글자", 출처: "사용자 확정 2026-10-11(글자가 있는 낮은 건물). S-MAP 표지일 뿐 어느 벽에 있는지 모름", 등급: 확정, 그림: 아니오}',
 '      - {무엇: "지붕 둘레 난간(윗선 164.8 m)", 출처: "S-MAP 0.5 m 격자 66칸 164.8 m, 사용자 S-MAP 화면 2장. 구조물 파일 b14-sangseung 이 그린다", 등급: S-MAP, 그림: 예}',
 '      - {무엇: "숲 쪽 벽 발치의 밝은 턱", 출처: "사용자 S-MAP 화면 2장: 건물 바깥쪽 발치를 따라 밝은 띠. 구조물 파일 b14-sangseung 이 그린다(폭·높이 추정)", 등급: 추정, 그림: 예}']
t = (NOTES / '상승관.md').read_text(encoding='utf-8'); rows = t.split('\n'); end = rows.index('---', 1)
if '추가-상승관동쪽끝' not in t:
    if not (BAK / '상승관.md').exists(): shutil.copy(NOTES / '상승관.md', BAK / '상승관.md')
    a = next(i for i in range(end) if rows[i] == '부분:'); b = next(i for i in range(end) if rows[i] == '출입구:'); c = next(i for i in range(end) if rows[i] == '겉모습:')
    (NOTES / '상승관.md').write_text('\n'.join(rows[:a + 1] + main_part + rows[b:c] + look + rows[end:]), encoding='utf-8', newline='\n')
    patch('상승관.md', [('  종류: 숨김
  원천_이름: 상승관
', '  종류: 숨김
  원천_이름: 상승관
  높이_출처: SMAP_MESH
')], [   # 높이_출처: 덧붙임(동쪽 끝 덩어리)이 쓴다

        ('상태:', '상태: 구현됨(시험용 DB)'),
        ('  근거: {"source": "S-MAP 3D viewer building model 173604866 (2 m grid', '  근거: ' + j(EV)),
        ('  - {이름: "상승관 입구(마당 쪽, 추정)"', f'  - {{이름: "상승관 입구(마당 쪽, 추정)", 좌표: {j(P["door"])}, 층: "1층 로비", 바닥_높이: 153.1, 출처: "자리 = 안쪽 마당(153.1 m)에 면한 벽은 동쪽 끝 덩어리의 대일관 쪽 벽 5.9 m 뿐이라(S-MAP 0.5 m 격자, B14) 그 벽 가운데에 둠. 사용자 그림 07·13의 상승 표시가 안쪽 마당 북쪽 끝을 가리킴. 높이 = 안쪽 마당 S-MAP 152.9~153.3. Z02 자리 (201217.6, 557306.4)에서 3.0 m 옮김", 등급: "추정(위치: 문이 이 벽에 있는지 확인 못 함. 메시·S-MAP 화면에 문이 보이지 않는다), S-MAP(높이)"}}')])
D_OLD = '[201190.98, 557317.42], [201195.62, 557327.77], [201191.55, 557318.68], [201216.71, 557306.86],'
D_NEW = '[201190.98, 557317.42], ' + ', '.join(j(p) for p in P['daeilBackWall']['ring']) + ', [201216.71, 557306.86],'
if D_OLD in (NOTES / '대일관.md').read_text(encoding='utf-8').split('모델_반영: 예')[1].split('모델_반영')[0]:
    patch('대일관.md', [
        ('[201173.51, 557330.86], [201171.77, 557326.43], ' + D_OLD, '[201173.51, 557330.86], [201171.77, 557326.43], ' + D_NEW),
        ('면적_m2: 1873, 출처: "B02 derive.py: 원천 외곽에서 동쪽 덩어리의 북쪽 띠(북쪽 변에서 9.95 m 안)를 떼어 냄. 경계는 S-MAP 2 m 격자에서 높이가 바뀌는 칸 사이(±1 m)", 등급: S-MAP}\n    지붕_형태: {값: "S-MAP 모델은 172.1', '면적_m2: 1875, 출처: "B02 derive.py: 원천 외곽에서 동쪽 덩어리의 북쪽 띠(상승관 자리)를 떼어 냄. 그 뒷벽(상승관 쪽 변)은 B14 에서 S-MAP 0.5 m 격자로 다시 읽음(docs/audit/b14/derive.py): 서쪽 16.7 m 는 상승관 벽에서 1.15 m 떨어지고, 동쪽 11.4 m 는 1.15 m 더 나와 상승관 벽에 닿는다(±0.5 m)", 등급: S-MAP}\n    지붕_형태: {값: "S-MAP 모델은 172.1'),
        ('The north strip of the east block (292 m2, roof 163.1 m) is 상승관, a separate building (user, 2026-10-11); it is drawn by the added entry 추가-상승관.', 'The north strip of the east block is 상승관, a separate building (user, 2026-10-11); it is drawn by the added entries 추가-상승관 and 추가-상승관동쪽끝 (S-MAP 0.5 m grid, B14). 대일관 ends at its rear wall there: 1.15 m from the 상승관 wall along the west 16.7 m, touching it along the east 11.4 m.'),
        ('the main part covers 1873 of 2165.8 m2. The strip within 9.95 m of the north edge of the east block (edge v8-v9, 292 m2) is 상승관 (user, 2026-10-11) and is not drawn as 대일관', 'the main part covers 1875 of 2165.8 m2. The north strip of the east block is 상승관 (user, 2026-10-11) and is not drawn as 대일관; the wall between them was re-read from the S-MAP 0.5 m grid on 2026-10-12 (B14, +-0.5 m)')])
C_ANCHOR = '  - 이름: 전체\n    모델_반영: "아니오 (서버 지형에서 읽은 값이고'
EV_L = {"source": "S-MAP 3D viewer building model 173670401 (청운관), 0.5 m grid read 2026-10-12 (B14)", "collectedOn": "2026-10-12", "level": "source data (one provider), not field verified; outline read from the grid (+-0.5 m)", "independentSurvey": False,
        "outline": f"the cells of the 청운관 model that lie outside the GeoPackage footprint in front of the first 5 m of the north-west wall of the low north-east part ({L['meshCellsInRing']} of {L['meshCellsOutsideSourceOutline']} such cells, {L['areaM2']} m2); it reaches the east end wall of 상승관",
        "roof": f"flat at 162.9 m ({L['flatCells']} cells, p10-p90 {L['roofM'][0]}-{L['roofM'][2]}), the level of the low north-east part",
        "notCovered": "what it is (a stair or service block, estimated); 대일관 and 청운관 are not connected (user, 2026-10-11) and nothing shows that this block connects 청운관 to 상승관 indoors"}
lobe = ['  - 이름: 북서 덧붙은 부분 (북동 저층부의 북서 벽 앞, 상승관 동쪽 끝 벽에 닿는 작은 덩어리)',
        '    모델_반영: 예',
        f'    모델_부분: {{덧붙임: {{건물_id: "추가-청운관북서낮은부분", 표지: "청운관 북서 낮은 부분", 근거: {j(EV_L)}}}}}',
        f'    외곽: {{좌표: {j([L["ring"]])}, 면적_m2: {round(L["areaM2"])}, 출처: "{MESH}. 청운관 객체(173670401) 칸 가운데 원천 외곽 밖에 있는 것. 원천 외곽 밖이라 덧붙임으로 넣는다", 등급: S-MAP}}',
        '    지붕_형태: {값: "평지붕", 출처: "' + MESH + '", 등급: S-MAP}',
        f'    지붕_높이: {{값: 162.9, 흩어짐: "10~90 % {L["roofM"][0]}~{L["roofM"][2]}, {L["flatCells"]}칸", 출처: "{MESH}", 등급: S-MAP}}']
if '추가-청운관북서낮은부분' not in (NOTES / '청운관.md').read_text(encoding='utf-8'):
    patch('청운관.md', [(C_ANCHOR, '\n'.join(lobe) + '\n' + C_ANCHOR)])
