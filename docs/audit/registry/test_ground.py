"""아2 지표면 노트 -> a2-ground-surfaces.geojson (ground.py)."""
import json, pathlib, tempfile, unittest
import ground


def feat(props, ring):
    return {'type': 'Feature', 'properties': props, 'geometry': {'type': 'Polygon', 'coordinates': [ring + [ring[0]]]}}


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


class Ground(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        feats = [
            feat({'id': 'ROAD', 'kind': 'platform', 'material': 'paving', 'topM': 100.0, 'bottomM': 90.0}, rect(0, 0, 10, 10)),
            feat({'id': 'WALK', 'kind': 'platform', 'material': 'paving', 'topM': 100.05, 'bottomM': 90.0}, rect(10, 0, 14, 10)),
            feat({'id': 'HIGH', 'kind': 'platform', 'material': 'paving', 'topM': 101.0, 'bottomM': 90.0}, rect(0, 10, 10, 14)),
            feat({'id': 'SLOPE', 'kind': 'platform', 'material': 'paving', 'bottomM': 90.0,
                  'topProfile': {'origin': [0, 20], 'direction': [1, 0], 'points': [[0, 100.0], [10, 101.0]]}}, rect(0, 20, 10, 24)),
            feat({'id': 'STEP', 'kind': 'extrude', 'type': 'stair_step', 'fromM': 99.5, 'toM': 100.2}, rect(2, 2, 4, 4)),
            feat({'id': 'CANOPY', 'kind': 'extrude', 'type': 'canopy', 'fromM': 104.0, 'toM': 104.3}, rect(5, 5, 7, 7)),
        ]
        (d / 'x.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}), encoding='utf-8')
        self.platforms, self.boxes = ground.load_structures(d)

    def tearDown(self):
        self.tmp.cleanup()

    def run_note(self, faces):
        return ground.from_note({'지표면': {'면': faces}}, self.platforms, self.boxes)

    def test_face_cut_by_standing_box_not_by_canopy_and_curb_on_asphalt_side(self):
        faces, curbs, bad, d = self.run_note([{'id': 'A', '재질': '아스팔트', '기단': 'ROAD', '등급': '원천'}])
        self.assertEqual(bad, [])
        a = faces[0]['geom']
        # 100 m2 − step 4 − curb strip 0.2 × 10 along the walk (same height ±0.15); the higher platform gets none (wall), the canopy cuts nothing
        self.assertAlmostEqual(a.area, 100 - 4 - 2, places=1)
        self.assertEqual(len(curbs), 1)
        c = curbs[0]['geom']
        self.assertAlmostEqual(c.area, 2.0, places=2)
        self.assertAlmostEqual(c.bounds[0], 9.8, places=2)
        self.assertAlmostEqual(c.bounds[2], 10.0, places=2)
        doc = ground.document(faces, curbs, self.platforms, d)
        p = {f['properties']['id']: f['properties'] for f in doc['features']}
        self.assertEqual((p['A']['fromM'], p['A']['toM']), (100.0, 100.02))
        self.assertEqual((p['A-CURB']['fromM'], p['A-CURB']['toM']), (100.0, 100.06))
        self.assertEqual(p['A']['type'], 'surface'); self.assertEqual(p['A-CURB']['type'], 'curb')

    def test_sloping_platform_gives_lifted_profile(self):
        faces, curbs, bad, d = self.run_note([{'id': 'S', '재질': '타일', '기단': 'SLOPE', '등급': '추정'}])
        doc = ground.document(faces, curbs, self.platforms, d)
        p = doc['features'][0]['properties']
        self.assertEqual(p['topProfile']['points'], [[0.0, 100.02], [10.0, 101.02]])
        self.assertEqual(p['thicknessM'], 0.02)
        self.assertEqual(p['pattern'], 'slab')
        self.assertTrue(p['estimated'])
        self.assertEqual(curbs, [])

    def test_outline_wins_over_whole_platform_face(self):
        faces, curbs, bad, d = self.run_note([
            {'id': 'W', '재질': '보도블록', '기단': 'WALK', '등급': '추정'},
            {'id': 'T', '재질': '타일', '기단': 'WALK', '외곽': rect(10, 0, 14, 5), '등급': '추정'}])
        by = {f['id']: f['geom'] for f in faces}
        self.assertAlmostEqual(by['T'].area, 20.0, places=3)
        self.assertAlmostEqual(by['W'].area, 20.0, places=3)

    def test_problems(self):
        faces, curbs, bad, d = self.run_note([
            {'id': 'X', '재질': '대리석', '기단': 'ROAD', '등급': '추정'},
            {'id': 'Y', '재질': '타일', '기단': 'NONE', '등급': '추정'},
            {'id': 'Z', '재질': '타일', '기단': 'ROAD', '등급': '아마'}])
        self.assertEqual(faces, [])
        self.assertEqual(len(bad), 3)


if __name__ == '__main__':
    unittest.main()
