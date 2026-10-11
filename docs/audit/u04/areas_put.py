"""U04: 통로 면 둘(areas/b1.json, b2.json)을 시험용 DB 의 공간 영역으로 넣는다: 같은 이름이 있으면 고치고(PUT) 없으면 만든다(POST).   python areas_put.py OUT_PREFIX
(C:/campus-tracker-testdb/backend 에서. n02.ts 가 시험용 DB(127.0.0.1:5544)가 아니면 거부한다.)"""
import json, pathlib, subprocess, sys, tempfile
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent; TMP = pathlib.Path(tempfile.gettempdir()) / 'u04-area-body.json'
def rest(method, route, body=None):
    args = ['npx', 'tsx', '../docs/audit/n02/n02.ts', 'rest', method, route]
    if body is not None: TMP.write_text(json.dumps(body, ensure_ascii=False), encoding='utf-8'); args.append('@' + str(TMP).replace('\\', '/'))
    r = subprocess.run(args, capture_output=True, shell=sys.platform == 'win32'); out = r.stdout.decode('utf-8')
    try: return json.loads(out)
    except Exception: raise SystemExit(f'{method} {route}: {out[:400]} {r.stderr.decode("utf-8")[:400]}')
have = {a['name']: a for a in rest('GET', 'areas')}
for k in ('b1', 'b2'):
    body = json.loads((HERE / 'areas' / f'{k}.json').read_text(encoding='utf-8')); old = have.get(body['name'])
    res = rest('PUT', f"areas/{old['id']}", {**body, 'expectedRevision': old['revision']}) if old else rest('POST', 'areas', body)
    if len(sys.argv) > 1: pathlib.Path(f'{sys.argv[1]}-{k}.json').write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print('고침' if old else '만듦', res['id'], res['name'], res['elevationM'], 'm', round(res['areaM2'], 1), '㎡, 구멍', len(res['geometry']['coordinates']) - 1)
