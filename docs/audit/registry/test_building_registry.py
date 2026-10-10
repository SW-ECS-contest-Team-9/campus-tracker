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
