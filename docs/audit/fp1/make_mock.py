# Builds mock.js: a fetch override for the preview page (vite) that answers the backend API from local snapshots (no DB).
import base64, json, sys
VAULT = r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'
REPO = r'C:\campus-tracker-claude'
out = sys.argv[1]
scene = json.load(open(VAULT + r'\f09\a-40-scene-after.json', encoding='utf-8'))
meta = json.load(open(REPO + r'\docs\audit\m16\preview\data\terrain-grid-meta.json', encoding='utf-8'))
grid = base64.b64encode(open(REPO + r'\docs\audit\m16\preview\data\terrain-grid.f32', 'rb').read()).decode()
state = json.load(open(VAULT + r'\z13\da\state-after.json', encoding='utf-8'))
indoor = json.load(open(REPO + r'\docs\audit\s2\indoor-roads.json', encoding='utf-8'))
byid = {}
for r in state['roads'] + indoor:
    byid[r['id']] = {
        'id': r['id'], 'name': r.get('name'), 'roadClass': r.get('roadClass') or 'pedestrian', 'structure': r.get('structure') or 'ordinary',
        'vehicleAccess': r.get('vehicleAccess'), 'widthM': r.get('widthM'), 'levelId': r.get('levelId'), 'buildingId': r.get('buildingId'),
        'fromNodeId': r.get('fromNodeId') or r['id'] + ':a', 'toNodeId': r.get('toNodeId') or r['id'] + ':b',
        'geometry': {'type': 'LineString', 'coordinates': r['coordinates']},
    }
roads = [r for r in byid.values() if r['structure'] != 'elevator']
lifts = [r for r in byid.values() if r['structure'] == 'elevator']
data = {
    '/api/v1/scene': scene,
    '/api/v1/mobility/roads': {'roads': roads},
    '/api/v1/mobility/elevators': {'roads': lifts},
    '/api/v1/mobility/places': {'places': []},
    '/api/v1/mobility': {'corridors': [], 'openAreas': [], 'portals': []},
}
js = '''(() => {
  const DATA = %s, META = %s, GRID = "%s";
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url, location.href).pathname;
    if (!path.startsWith('/api/')) return real(input, init);
    if (path === '/api/v1/terrain/grid') {
      const bin = Uint8Array.from(atob(GRID), (c) => c.charCodeAt(0));
      return new Response(bin, { status: 200, headers: { 'X-Grid': JSON.stringify(META), 'Content-Type': 'application/octet-stream' } });
    }
    if (path in DATA) return new Response(JSON.stringify(DATA[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{"error":"mock: no DB"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
})();''' % (json.dumps(data, ensure_ascii=False), json.dumps(meta), grid)
open(out, 'w', encoding='utf-8').write(js)
print('roads', len(roads), 'lifts', len(lifts), 'buildings', len(scene['buildings']), 'bytes', len(js))
