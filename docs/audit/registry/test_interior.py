"""사2 실내_구조 -> interiors.geojson (interior.py)."""
import unittest
import interior

HEAD = {'이름': '가관', '모델_id': {'서버_건물_id': '가관'},
        '층_바닥_높이': {'층': {'1층': {'값': 100.0}, '2층': {'값': 103.5}}},
        '실내_구조': {'기본값': {'복도_폭': 2.4, '계단_폭': 1.4, '승강기': [2.0, 2.0], '방향': 0},
                   '공간': [{'종류': '복도', '이름': '복도', '층': ['1층', '2층'], '선': [[0, 0], [10, 0]], '등급': '추정'},
                          {'종류': '승강기', '이름': '승강기', '층': ['1층'], '중심': [5, 5], '등급': '추정'}]}}


class Interior(unittest.TestCase):
    def test_band_and_box(self):
        out, bad = interior.from_note(HEAD)
        self.assertEqual(bad, [])
        self.assertEqual([f['properties']['kind'] for f in out], ['corridor', 'elevator'])
        self.assertEqual(out[0]['properties']['floorsM'], [100.0, 103.5])
        xs = [p[0] for p in out[0]['geometry']['coordinates'][0]]; ys = [p[1] for p in out[0]['geometry']['coordinates'][0]]
        self.assertEqual((min(xs), max(xs), min(ys), max(ys)), (-1.2, 11.2, -1.2, 1.2))   # 2.4 wide, ends grown by half
        self.assertEqual(sorted({tuple(p) for p in out[1]['geometry']['coordinates'][0]}), [(4.0, 4.0), (4.0, 6.0), (6.0, 4.0), (6.0, 6.0)])

    def test_unknown_floor_fails(self):
        head = {**HEAD, '실내_구조': {'공간': [{'종류': '복도', '이름': 'x', '층': ['4층'], '선': [[0, 0], [1, 0]], '폭': 2, '등급': '추정'}]}}
        out, bad = interior.from_note(head)
        self.assertEqual(out, [])
        self.assertIn('4층', bad[0])

    def test_named_floor_table(self):
        head = {'이름': '가관', '층_바닥_높이': {'가1관': {'층': {'1층': {'값': 100.0}}}, '가2관': {'층': {'1층': {'값': 101.0}}}},
                '실내_구조': {'공간': [{'종류': '복도', '이름': 'a', '층': ['1층'], '층_표': '가2관', '선': [[0, 0], [1, 0]], '폭': 2, '등급': '추정'}]}}
        out, bad = interior.from_note(head)
        self.assertEqual((bad, out[0]['properties']['floorsM']), ([], [101.0]))
        del head['실내_구조']['공간'][0]['층_표']
        out, bad = interior.from_note(head)
        self.assertEqual(out, [])
        self.assertIn('1층', bad[0])

    def test_named_table_goes_to_its_part(self):
        # 은주관: a space of the 2관 table belongs to the scene part whose 겉모습 창 uses that table (층 펼치기 does each part apart)
        head = {'이름': '가관', '층_바닥_높이': {'가1관': {'층': {'1층': {'값': 100.0}}}, '가2관': {'층': {'1층': {'값': 101.0}}}},
                '겉모습': [{'대상': ['가관', '가관#접합부'], '창': {'층_표': '가1관'}}, {'대상': ['가관#2관', '가관#끝'], '창': {'층_표': '가2관'}}],
                '실내_구조': {'공간': [{'종류': '복도', '이름': n, '층': ['1층'], '층_표': t, '선': [[0, 0], [1, 0]], '폭': 2, '등급': '추정'} for n, t in (('a', '가1관'), ('b', '가2관'))]}}
        out, bad = interior.from_note(head)
        self.assertEqual((bad, [f['properties']['building'] for f in out]), ([], ['가관', '가관#2관']))

    def test_scene_id_prefers_added_building(self):
        self.assertEqual(interior.scene_id({'이름': '다', '모델_id': {'서버_건물_id': '혜인관'}, '모델_추가': {'건물_id': '추가-다'}}), '추가-다')
        self.assertEqual(interior.scene_id({'이름': '라', '모델_id': {'서버_건물_id': '추가-라 (설명)'}}), '추가-라')


if __name__ == '__main__':
    unittest.main()
