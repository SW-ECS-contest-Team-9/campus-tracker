"""B2140: 공간 영역(통로 면) 둘을 새 이름(1주차장 지하 1층/2층)과 새 바닥(지하 2층 140.0)으로 고친다. 옛 이름으로 찾아 PUT.   python areas_rename.py OUT_PREFIX
(C:/campus-tracker-testdb/backend 에서. n02.ts 가 시험용 DB(127.0.0.1:5544)가 아니면 거부한다.)"""
import json, pathlib, subprocess, sys, tempfile
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent; U04 = HERE.parent / 'u04'; TMP = pathlib.Path(tempfile.gettempdir()) / 'b2140-area-body.json'
def rest(method, route, body=None):
    args = ['npx', 'tsx', '../docs/audit/n02/n02.ts', 'rest', method, route]
    if body is not None: TMP.write_text(json.dumps(body, ensure_ascii=False), encoding='utf-8'); args.append('@' + str(TMP).replace(chr(92), '/'))
    r = subprocess.run(args, capture_output=True, shell=sys.platform == 'win32'); out = r.stdout.decode('utf-8')
    try: return json.loads(out)
    except Exception: raise SystemExit(f'{method} {route}: {out[:400]} {r.stderr.decode("utf-8")[:400]}')
have = {a['name']: a for a in rest('GET', 'areas')}
OLDN = {'b1': ['운동장 지하 1층 주차장 통로 면', '1주차장 지하 1층 통로 면'], 'b2': ['운동장 지하 2층 주차장 통로 면', '1주차장 지하 2층 통로 면']}
for k in ('b1', 'b2'):
    body = json.loads((U04 / 'areas' / f'{k}.json').read_text(encoding='utf-8')); old = next(have[n] for n in OLDN[k] if n in have)
    res = rest('PUT', f"areas/{old['id']}", {**body, 'expectedRevision': old['revision']})
    if len(sys.argv) > 1: pathlib.Path(f'{sys.argv[1]}-{k}.json').write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print('고침', res['id'], old['name'], '→', res['name'], res['elevationM'], 'm')
