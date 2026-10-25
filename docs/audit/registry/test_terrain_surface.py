"""기단 -> 지형 surface 입력 (terrain_surface.py)."""
import json, pathlib, tempfile, unittest
from shapely.geometry import shape
import terrain_surface as ts


def plat(pid, ring, top, sn='name'):
    p = {'id': pid, 'kind': 'platform', 'type': 'platform', 'bottomM': 90.0, **({'topM': top} if not isinstance(top, dict) else {'topProfile': top})}
    if sn is not None: p['surfaceName'] = pid if sn == 'name' else sn
    return {'type': 'Feature', 'properties': p, 'geometry': {'type': 'Polygon', 'coordinates': [ring + [ring[0]]]}}


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


class TerrainSurface(unittest.TestCase):
    def build(self, feats):
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / 'x.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}), encoding='utf-8')
            doc = ts.document(ts.load_platforms(d))
        return {f['properties']['name']: f for f in doc['features']}

    def test_nested_platform_wins_even_when_lower(self):
        out = self.build([plat('WAY', rect(0, 0, 20, 10), 135.0), plat('LANE', rect(5, 2, 9, 6), 132.5)])
        self.assertAlmostEqual(shape(out['LANE']['geometry']).area, 16.0)
        self.assertAlmostEqual(shape(out['WAY']['geometry']).area, 200.0 - 16.0)
        self.assertEqual(out['LANE']['properties']['heightM'], 132.5)

    def test_edge_overlap_goes_to_the_higher_platform(self):
        out = self.build([plat('LOW', rect(0, 0, 10.5, 10), 100.0), plat('HIGH', rect(10, 0, 20, 10), 101.0)])
        self.assertAlmostEqual(shape(out['LOW']['geometry']).area, 100.0)
        self.assertAlmostEqual(shape(out['HIGH']['geometry']).area, 100.0)

    def test_profile_is_kept_and_described_or_missing_surface_names_are_left_out(self):
        prof = {'origin': [0, 0], 'direction': [1, 0], 'points': [[0, 100.0], [10, 101.0]]}
        out = self.build([plat('SLOPE', rect(0, 0, 10, 4), prof), plat('ROOF', rect(20, 0, 30, 4), 130.0, sn=None),
                          plat('NARROW', rect(40, 0, 41, 4), 120.0, sn='없음(폭이 좁음)')])
        self.assertEqual(sorted(out), ['SLOPE'])
        self.assertEqual(out['SLOPE']['properties']['profile'], prof)

    def test_a_platform_cut_in_two_gives_two_pieces(self):
        out = self.build([plat('BASE', rect(0, 0, 30, 10), 100.0), plat('CROSS', rect(10, -1, 20, 11), 101.0)])
        self.assertEqual(sorted(out), ['BASE', 'BASE#2', 'CROSS'])   # CROSS 는 BASE 안에 들지 않고 높다: BASE 가 둘로 나뉜다


if __name__ == '__main__':
    unittest.main()
