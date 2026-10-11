"""python -m unittest discover -s docs/audit/registry  (볼트 없이 돈다: 노트는 임시 폴더에 만든다)"""
import json, pathlib, sys, tempfile, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import building_registry as br

EV = '{"source": "s", "collectedOn": "2026-10-10", "level": "l", "independentSurvey": false}'
ROOF = f'''---
이름: 가관
모델_보정:
  종류: 지붕
  원천_이름: 가관
  높이_출처: SMAP_MESH
  층수: {{값: 15, 등급: 확정}}
  근거: {EV}
부분:
  - 이름: 본체
    모델_반영: 예
    외곽: {{값: "원천 외곽 그대로", 등급: 원천}}
    지붕_높이: {{값: 189.4, 등급: S-MAP}}
  - 이름: 낮은 날개
    모델_반영: "아니오 (경계 없음)"
    지붕_높이: {{값: 148.8, 등급: S-MAP}}
---
# 가관
본문의 --- 는 머리가 아니다.
'''
SQ = lambda x: f'[[[{x}, 0], [{x + 10}, 0], [{x + 10}, 10], [{x}, 10], [{x}, 0]]]'
PARTS = f'''---
이름: 나관
모델_보정: {{종류: 부분, 원천_이름: 나관, 높이_출처: SMAP_MESH, 근거: {EV}}}
부분:
  - 이름: 높은 쪽
    모델_반영: 예
    모델_부분: {{id: "높은쪽", 표지: "나관"}}
    외곽: {{좌표: {SQ(0)}, 등급: S-MAP}}
    지붕_높이: {{값: 30, 등급: "확정(사용자)"}}
  - 이름: 낮은 쪽
    모델_반영: 예
    모델_부분: {{id: "낮은쪽", 표지: null}}
    외곽: {{좌표: {SQ(10)}, 등급: S-MAP}}
    지붕_높이: {{값: 20.5, 등급: S-MAP}}
---
'''
HIDDEN = f'''---
이름: 다관
모델_보정: {{종류: 숨김, 원천_이름: 다관, 등급: 확정, 사유: "r", 근거: {EV}}}
부분:
  - 이름: 본체
    모델_반영: "아니오 (자리 모름)"
---
'''
NONE = '''---
이름: 라관
모델_보정: {종류: 없음}
부분:
  - 이름: 본체
    모델_반영: "아니오 (사용자 확인 필요)"
    지붕_높이: {값: 100, 등급: 추정}
---
'''
ADDED = f'''---
이름: 마관
모델_보정: {{종류: 없음}}
모델_추가: {{건물_id: "추가-마관", 높이_출처: SMAP_MESH, 층수: {{값: 5, 등급: 원천}}, 대장_id: 53636, 근거: {EV}}}
부분:
  - 이름: 본체
    모델_반영: 예
    외곽: {{좌표: {SQ(0)}, 등급: S-MAP}}
    지붕_높이: {{값: 107.0, 등급: S-MAP}}
---
'''


def folder(**notes):
    d = tempfile.mkdtemp()
    for k, v in notes.items(): pathlib.Path(d, f'{k}.md').write_text(v, encoding='utf-8')
    return d


class Registry(unittest.TestCase):
    def test_build_all_kinds(self):
        doc, problems = br.build(folder(가관=ROOF, 나관=PARTS, 다관=HIDDEN, 라관=NONE))
        self.assertEqual(problems, {})
        self.assertEqual(doc['buildings'], [{'name': '가관', 'roofM': 189.4, 'heightSource': 'SMAP_MESH', 'floors': 15, 'evidence': json.loads(EV)}])
        self.assertEqual(doc['hidden'], [{'name': '다관', 'reason': 'r', 'evidence': json.loads(EV)}])
        p = doc['parts'][0]
        self.assertEqual([(q['id'], q['name'], q['roofM']) for q in p['parts']], [('높은쪽', '나관', 30), ('낮은쪽', None, 20.5)])
        self.assertEqual(p['parts'][1]['polygon'][0][1], [20, 0])
        self.assertNotIn('floors', p)

    def test_partial_cover_and_terrace_come_only_from_the_note(self):
        note = PARTS.replace('근거: {', '덮지_않는_곳: "맨땅", 근거: {', 1).replace('모델_부분: {id: "낮은쪽", 표지: null}', '모델_부분: {id: "낮은쪽", 표지: null, 지면과_같은_지붕: "윗길과 같은 높이의 데크"}')
        doc, problems = br.build(folder(나관=note))
        self.assertEqual(problems, {})
        p = doc['parts'][0]
        self.assertEqual(p['uncovered'], '맨땅')
        self.assertEqual([q.get('terrace') for q in p['parts']], [None, '윗길과 같은 높이의 데크'])
        roof, problems = br.build(folder(가관=ROOF.replace('외곽: {값: "원천 외곽 그대로", 등급: 원천}', '모델_부분: {지면과_같은_지붕: "윗땅과 같은 높이의 옥상"}\n    외곽: {값: "원천 외곽 그대로", 등급: 원천}')))
        self.assertEqual((problems, roof['buildings'][0].get('terrace')), ({}, '윗땅과 같은 높이의 옥상'))   # a whole-building roof may say it too
        self.assertNotIn('terrace', br.build(folder(가관=ROOF))[0]['buildings'][0])
        plain, _ = br.build(folder(나관=PARTS))
        self.assertNotIn('uncovered', plain['parts'][0])
        self.assertTrue(all('terrace' not in q for q in plain['parts'][0]['parts']))
        d = br.diff(doc, json.loads(br.dumps(plain)))                 # a file without the two statements does not match the note
        self.assertTrue(any('uncovered' in m for m in d['나관']) and any('terrace' in m for m in d['나관']))

    def test_round_trip_and_diff(self):
        doc, _ = br.build(folder(가관=ROOF, 나관=PARTS, 다관=HIDDEN))
        text = br.dumps(doc)
        self.assertEqual(br.diff(doc, json.loads(text)), {})
        self.assertEqual(text, br.dumps(json.loads(text)))            # stable text
        self.assertIn('\n              [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]\n', text)   # one ring per line (its brackets are on the lines around it)
        stored = json.loads(text)
        stored['buildings'][0]['roofM'] = 190.0
        stored['parts'][0]['parts'][1]['polygon'][0][1] = [21, 0]
        stored['hidden'] = []
        stored['buildings'].append({'name': '마관', 'roofM': 1})
        d = br.diff(doc, stored)
        self.assertTrue(any('roofM' in m for m in d['가관']))
        self.assertTrue(any('외곽 좌표' in m for m in d['나관']))
        self.assertTrue(any('파일에는 없다' in m for m in d['다관']))
        self.assertTrue(any('노트에는 없다' in m for m in d['마관']))

    def test_added_building_beside_a_hidden_source_polygon(self):
        hidden_and_added = ADDED.replace('이름: 마관', '이름: 다관').replace('모델_보정: {종류: 없음}', f'모델_보정: {{종류: 숨김, 원천_이름: 다관, 등급: 확정, 사유: "r", 근거: {EV}}}')
        doc, problems = br.build(folder(마관=ADDED, 다관=hidden_and_added, 라관=NONE))
        self.assertEqual(problems, {})
        self.assertEqual(doc['added'][1], {'id': '추가-마관', 'name': '마관', 'roofM': 107.0, 'heightSource': 'SMAP_MESH', 'floors': 5, 'registerId': '53636',
                                           'polygon': [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]], 'evidence': json.loads(EV)})
        self.assertEqual([e['name'] for e in doc['hidden']], ['다관'])     # the misplaced source polygon stays hidden, the same note adds the real building
        self.assertEqual(doc['added'][0]['name'], '다관')
        self.assertEqual(doc['buildings'] + doc['parts'], [])
        text = br.dumps(doc)
        self.assertEqual(br.diff(doc, json.loads(text)), {})
        stored = json.loads(text); stored['added'][1]['polygon'][0][1] = [11, 0]; stored['added'][1]['roofM'] = 108; del stored['added'][0]
        d = br.diff(doc, stored)
        self.assertTrue(any('외곽 좌표' in m for m in d['마관']) and any('roofM' in m for m in d['마관']))
        self.assertTrue(any('건물 추가: 노트에는 있고 파일에는 없다' in m for m in d['다관']))
        bad = {
            'est_floors': ADDED.replace('층수: {값: 5, 등급: 원천}', '층수: {값: 5, 등급: 추정}'),      # a floor count read from a photo does not go in
            'est_roof': ADDED.replace('지붕_높이: {값: 107.0, 등급: S-MAP}', '지붕_높이: {값: 107.0, 등급: 추정}'),
            'no_outline': ADDED.replace(f'좌표: {SQ(0)}, ', ''),
            'no_id': ADDED.replace('건물_id: "추가-마관", ', ''),
            'not_in_model': ADDED.replace('모델_반영: 예', '모델_반영: "아니오 (사용자 결정 대기)"'),
            'on_a_source_polygon': ADDED.replace('모델_보정: {종류: 없음}', f'모델_보정: {{종류: 지붕, 원천_이름: 마관, 높이_출처: SMAP_MESH, 근거: {EV}}}'),
        }
        doc, problems = br.build(folder(**bad))
        self.assertEqual(set(problems), set(bad))
        self.assertEqual(doc['added'], [])

    def test_annex_outside_the_source_footprint_is_added_beside_the_roof_override(self):
        annex = f"""  - 이름: 저층부
    모델_반영: 예
    모델_부분: {{덧붙임: {{건물_id: "추가-가관저층부", 표지: "가관 저층부", 근거: {EV}}}}}
    외곽: {{좌표: {SQ(20)}, 등급: S-MAP}}
    지붕_높이: {{값: 148.8, 등급: S-MAP}}
---"""
        note = ROOF.replace('---\n# 가관', annex + '\n# 가관', 1)
        doc, problems = br.build(folder(가관=note))
        self.assertEqual(problems, {})
        self.assertEqual(doc['buildings'][0]['roofM'], 189.4)        # the source polygon keeps its one roof override
        self.assertEqual(doc['added'], [{'id': '추가-가관저층부', 'name': '가관 저층부', 'roofM': 148.8, 'heightSource': 'SMAP_MESH',
                                         'polygon': [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]], 'evidence': json.loads(EV)}])
        bad = {'same_label': note.replace('표지: "가관 저층부"', '표지: "가관"'), 'est_roof': note.replace('지붕_높이: {값: 148.8, 등급: S-MAP}\n---', '지붕_높이: {값: 148.8, 등급: 추정}\n---'),
               'no_evidence': note.replace(f', 근거: {EV}}}}}', '}}')}
        doc, problems = br.build(folder(**bad))
        self.assertEqual(set(problems), set(bad))
        self.assertEqual(doc['added'], [])

    def test_low_grades_and_missing_fields_are_refused(self):
        bad = {
            'est': ROOF.replace('지붕_높이: {값: 189.4, 등급: S-MAP}', '지붕_높이: {값: 189.4, 등급: 추정}'),
            'unknown': PARTS.replace('지붕_높이: {값: 20.5, 등급: S-MAP}', '지붕_높이: {값: 20.5, 등급: 모름}'),
            'floors': ROOF.replace('층수: {값: 15, 등급: 확정}', '층수: {값: 15, 등급: 추정}'),
            'noflag': NONE.replace('    모델_반영: "아니오 (사용자 확인 필요)"\n', ''),
            'noreason': NONE.replace('"아니오 (사용자 확인 필요)"', '아니오'),
            'yes_but_none': NONE.replace('"아니오 (사용자 확인 필요)"', '예'),
            'nokind': NONE.replace('모델_보정: {종류: 없음}\n', ''),
            'outline': PARTS.replace(f'외곽: {{좌표: {SQ(10)}, 등급: S-MAP}}', f'외곽: {{좌표: {SQ(10)}, 등급: 추정}}'),
            'yaml': ROOF.replace('이름: 가관', '이름: "가관'),
        }
        doc, problems = br.build(folder(**bad))
        self.assertEqual(set(problems), set(bad))
        self.assertEqual(doc['buildings'] + doc['hidden'] + doc['parts'], [])

    def test_b12_deep_eave_giant_order_and_wing(self):
        look = """층_바닥_높이:
  층: {1층: {값: 100.0, 등급: 추정}, 2층: {값: 104.0, 등급: 추정}}
겉모습:
  - 대상: ["본관"]
    벽: {값: 밝은 돌, 출처: 사진, 등급: 원천}
    지붕: {모양: 모임지붕, 재질: 기와, 처마_높이: 118.0, 마루_높이: 123.0, 처마_깊이: 1.5, 출처: 메시, 등급: S-MAP}
    큰_기둥: {발치: 102.0, 머리: 114.0, 보: 2.0, 열: [{자리: [201020.0, 557300.0], 기둥: 5}], 출처: 사진, 등급: 추정}
    날개:
      - {이름: 현관부, 외곽: [[201010.0, 557300.0], [201030.0, 557300.0], [201030.0, 557304.0]], 처마_높이: 110.0, 마루_높이: 112.0, 출처: 사진, 등급: 추정}
---"""
        head = lambda text: br.read_head(ROOF.replace('---', '', 1).replace('---', text, 1).join(['---', '']))
        got, bad = br.appearance.from_note(head(look))
        self.assertEqual(bad, [])
        self.assertEqual(got[0]['roof'], {'type': 'hipped', 'material': 'tile', 'eaveTopM': 118.0, 'ridgeM': 123.0, 'overhangM': 1.5})
        self.assertEqual(got[0]['order'], {'fromM': 102.0, 'toM': 114.0, 'beamM': 2.0, 'rows': [{'at': [201020.0, 557300.0], 'count': 5}]})
        self.assertEqual(got[0]['wings'], [{'polygon': [[201010.0, 557300.0], [201030.0, 557300.0], [201030.0, 557304.0]], 'roof': {'eaveTopM': 110.0, 'ridgeM': 112.0}, 'grade': '추정'}])
        self.assertTrue(br.appearance.from_note(head(look.replace('마루_높이: 123.0, ', '')))[1])        # the eave and the ridge come together
        self.assertTrue(br.appearance.from_note(head(look.replace('머리: 114.0', '머리: 103.0')))[1])      # columns shorter than 3 m
        self.assertTrue(br.appearance.from_note(head(look.replace('마루_높이: 112.0, 출처: 사진, 등급: 추정', '마루_높이: 112.0')))[1])   # a wing needs its evidence and grade

    def test_b13_wall_bands_and_irregular_panels(self):
        look = """층_바닥_높이:
  층: {1층: {값: 100.0, 등급: 추정}, 2층: {값: 104.0, 등급: 추정}, 3층: {값: 108.0, 등급: 추정}}
겉모습:
  - 대상: ["가관"]
    벽: {값: 금속판, 출처: 사진, 등급: 확정}
    창: {모양: 낱창, 출처: 사진, 등급: 추정}
    띠:
      - {부터_층: "2층", 까지_층: "3층", 값: 붉은 벽돌, 색: "#8f9296", 창: 작은 아치, 창_폭: 3.0, 출처: 사진, 등급: 확정}
      - {부터_높이: 110.0, 창: 없음, 출처: 사진, 등급: 추정}
    판: {색: ["#e0a02b"], 부터_층: "3층", 출처: 사진, 등급: "확정(노랑 판), 추정(자리)"}
---"""
        head = lambda text: br.read_head(ROOF.replace('---', '', 1).replace('---', text, 1).join(['---', '']))
        got, bad = br.appearance.from_note(head(look))
        self.assertEqual(bad, [])
        self.assertEqual(got[0]['bands'], [{'fromM': 104.0, 'toM': 108.0, 'grade': '확정', 'wall': 'brick', 'wallColor': '#8f9296', 'style': 'archrows', 'widthM': 3.0}, {'fromM': 110.0, 'grade': '추정', 'style': 'none'}])
        self.assertEqual(got[0]['panels'], {'colors': ['#e0a02b'], 'fromM': 108.0})
        self.assertEqual(got[0]['grades']['panels'], '확정(노랑 판), 추정(자리)')
        self.assertTrue(br.appearance.from_note(head(look.replace('창: 작은 아치', '창: 긴 아치')))[1])          # a band takes row styles only
        self.assertTrue(br.appearance.from_note(head(look.replace('부터_높이: 110.0, 창: 없음, ', '부터_높이: 110.0, ')))[1])   # a band changes something
        self.assertTrue(br.appearance.from_note(head(look.replace('까지_층: "3층"', '까지_층: "1층"')))[1])       # the top is above the bottom
        self.assertTrue(br.appearance.from_note(head(look.replace('색: ["#e0a02b"]', '색: []')))[1])              # panels need a colour

    def test_appearance_goes_to_the_file_with_window_rows_at_the_floor_table(self):
        look = """층_바닥_높이:
  층: {1층: {값: 100.0, 등급: 추정}, 2층: {값: 103.5, 등급: 추정}, 3층: {값: 107.0, 등급: 추정}, 5층: {값: 110.5, 등급: 추정}}
겉모습:
  - 대상: ["가관"]
    벽: {값: 붉은 벽돌, 출처: 사진, 등급: "원천(학교 사진)"}
    창: {모양: 낱창, 출처: 사진, 등급: 추정}
    지붕: {모양: 모임지붕, 재질: 기와, 오름: 3.0, 지붕창: true, 출처: 사진, 등급: 확정}
    특징: [{무엇: 굽은 정면, 출처: 사진, 등급: 추정, 그림: 아니오}]
---"""
        head = lambda text: br.read_head(ROOF.replace('---', '', 1).replace('---', text, 1).join(['---', '']))
        got, bad = br.appearance.from_note(head(look))
        self.assertEqual(bad, [])
        self.assertEqual(got, [{'id': '가관', 'wall': 'brick', 'windows': {'style': 'rows', 'floorsM': [100.0, 103.5, 107.0, 110.5], 'floorNames': ['1층', '2층', '3층', '5층']},
                                'roof': {'type': 'hipped', 'material': 'tile', 'riseM': 3.0, 'dormers': True},
                                'grades': {'wall': '원천(학교 사진)', 'windows': '추정', 'roof': '확정'},
                                'features': [{'what': '굽은 정면', 'evidence': '사진', 'grade': '추정', 'drawn': False}]}])
        self.assertTrue(br.appearance.from_note(head(look.replace('5층: {값: 110.5', '4층: {값: 110.5')))[1])      # there is no 4th floor
        self.assertFalse(br.appearance.from_note(head(look.replace('5층: {값: 110.5, 등급: 추정}', '4층: {값: 110.5, 등급: "수치 근거 + 사용자 조건부 승인"}')))[1])     # unless the row carries the user's conditional approval (U03)
        self.assertTrue(br.appearance.from_note(head(look.replace('등급: 확정}', '등급: 모름}')))[1])                # an unknown is not written down
        self.assertTrue(br.appearance.from_note(head(look.replace('값: 붉은 벽돌', '값: 나무')))[1])
        # Z07: one wall face in another material, tall columns, the long arch bay, lines up to the roof, the eave band
        z07 = look.replace('창: {모양: 낱창,', '창: {모양: 긴 아치, 지붕까지: true,').replace('오름: 3.0,', '오름: 3.0, 처마띠: 1.2,').replace(
            '    특징:', '    벽면:\n      - {방향: 26, 폭: 30, 값: 담쟁이, 출처: 사진, 등급: 확정}\n      - {방향: 남, 기둥: 4, 창: 없음, 출처: 사진, 등급: 추정}\n    특징:')
        got, bad = br.appearance.from_note(head(z07))
        self.assertEqual(bad, [])
        self.assertEqual(got[0]['windows'], {'style': 'bays', 'floorsM': [100.0, 103.5, 107.0, 110.5], 'floorNames': ['1층', '2층', '3층', '5층'], 'toRoof': True})
        self.assertEqual(got[0]['roof']['eaveBandM'], 1.2)
        self.assertEqual(got[0]['faces'], [{'azimuth': 26, 'grade': '확정', 'spread': 30, 'wall': 'ivy'}, {'azimuth': 180, 'grade': '추정', 'style': 'none', 'columns': 4}])
        self.assertTrue(br.appearance.from_note(head(z07.replace('방향: 남,', '방향: 위,')))[1])
        self.assertTrue(br.appearance.from_note(head(z07.replace('값: 담쟁이, 출처: 사진, 등급: 확정', '값: 담쟁이')))[1])   # a face needs its evidence and grade too
        # Z11: the building's own window size and paired windows
        z11 = look.replace('창: {모양: 낱창,', '창: {모양: 낱창, 폭: 1.2, 높이: 1.5, 간격: 4.4, 창턱: 0.9, 쌍: true,')
        got, bad = br.appearance.from_note(head(z11))
        self.assertEqual(bad, [])
        self.assertEqual(got[0]['windows'], {'style': 'rows', 'floorsM': [100.0, 103.5, 107.0, 110.5], 'floorNames': ['1층', '2층', '3층', '5층'], 'widthM': 1.2, 'heightM': 1.5, 'pitchM': 4.4, 'sillM': 0.9, 'paired': True})
        self.assertTrue(br.appearance.from_note(head(z11.replace('간격: 4.4', '간격: 2.0')))[1])   # two windows of 1.2 m do not fit in 2 m
        self.assertTrue(br.appearance.from_note(head(z11.replace('폭: 1.2', '폭: 넓게')))[1])

    def test_check_and_write_commands(self):
        d = folder(가관=ROOF, 나관=PARTS)
        out = pathlib.Path(d, 'o.json')
        self.assertEqual(br.main(['write', '--notes', d, '--overrides', str(out)]), 0)
        self.assertEqual(br.main(['check', '--notes', d, '--overrides', str(out)]), 0)
        out.write_text(out.read_text(encoding='utf-8').replace('189.4', '189.5'), encoding='utf-8')   # edited by hand
        self.assertEqual(br.main(['check', '--notes', d, '--overrides', str(out)]), 1)
        pathlib.Path(d, '가관.md').write_text(ROOF.replace('등급: S-MAP}\n  - 이름: 낮은', '등급: 추정}\n  - 이름: 낮은'), encoding='utf-8')
        self.assertEqual(br.main(['write', '--notes', d, '--overrides', str(out)]), 1)   # nothing written from a low grade
        self.assertIn('189.5', out.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
