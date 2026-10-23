"""R02: 오르막길 윗부분(s 60~110)을 지나는 시험용 DB 길의 꼭짓점을 (s, t) 로. DB 는 읽기만(docker psql)."""
import sys, json, subprocess, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'g02')); from common import xy_to_st
def q(sql): return subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
for l in q("select id, coalesce(name,''), structure, level_id, st_asgeojson(geom) from mobility.road_segments where status='DRAFT' and st_intersects(geom, st_buffer(st_makeline(st_setsrid(st_makepoint(201098,557325),5186), st_setsrid(st_makepoint(201146,557303),5186)), 9))"):
    i, n, st, lv, g = l.split('|', 4); c = json.loads(g)['coordinates']
    print(i[:8], st, lv, n[:50]); print('   ', [(round(float(a), 1), round(float(b), 1), round(p[2], 2)) for p in c for a, b in [xy_to_st(p[0], p[1])]])
