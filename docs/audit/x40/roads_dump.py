"""X40: 시험용 DB 길(DRAFT)을 상자 안만 json 으로(topdown.py 의 길 입력). DB 는 읽기만.   python -I -B roads_dump.py x0 y0 x1 y1 out.json"""
import json, subprocess, sys
x0, y0, x1, y1, out = sys.argv[1:6]
sql = ("select coalesce(json_agg(json_build_object('id', id, 'name', name, 'structure', structure, 'coordinates', (st_asgeojson(geom)::json)->'coordinates')), '[]') from mobility.road_segments "
       f"where status='DRAFT' and st_intersects(geom, st_makeenvelope({x0},{y0},{x1},{y1},5186))")
r = subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip()
open(out, 'w', encoding='utf-8').write(r); print(len(json.loads(r)))
