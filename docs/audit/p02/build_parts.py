"""P02: P01 이 남긴 차이를 구조물 상자로 고친다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/p02-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 전부 estimated. 근거 그림은 볼트의 데이터/보완자료/3d-map-audit-20261009/ 아래."""
import json, pathlib
import field
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
FEATS = []
def write():
    field.build(FEATS)
    out = {'type': 'FeatureCollection', 'name': 'p02-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'provenance': {'script': 'docs/audit/p02/build_parts.py', 'note': 'P01 이 남긴 차이(운동장 바닥 무늬 등). 전부 추정 치수'}, 'features': FEATS}
    ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]
    (STR / 'p02-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(len(FEATS), 'features')
if __name__ == '__main__': write()
