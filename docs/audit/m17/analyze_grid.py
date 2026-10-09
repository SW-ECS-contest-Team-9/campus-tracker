# S-MAP 메시 표면 z 2m 격자(브라우저 픽 결과) 분석. 읽기: vault b64, yudam-gpkg.json. 출력: 인자 폴더.
import json, sys, os
V = sys.argv[1]  # vault claude-m17
NX, NY, X0, Y0, R = 52, 84, 200984, 557214, 2
z = [None] * (NX * NY)
for ln in open(os.path.join(V, "smap-surface-grid-2m.txt"), encoding="utf-8"):
    if ln.startswith("#") or not ln.strip(): continue
    j, sm, vals = ln.strip().split(":"); vals = [int(t) for t in vals.split(",")]
    assert len(vals) == NX and sum(vals) == int(sm), ("checksum", j)
    for i, t in enumerate(vals): z[int(j) * NX + i] = t / 10 if t > 0 else None
ring = json.load(open(os.path.join(os.path.dirname(__file__), "yudam-gpkg.json"), encoding="utf-8"))["buildings_3d"][0][0]
def inside(x, y, r=ring):
    c = False
    for (x1, y1), (x2, y2) in zip(r, r[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1): c = not c
    return c
def cls(v):
    if v is None: return "?"
    if v >= 160: return "T"   # 상부 타워 지붕(160~183)
    if v >= 145: return "L"   # 중간 지붕/저층부(145~160)
    if v >= 139: return "M"   # 141.9 등 소형 돌출
    return "g"                # 지상·옹벽(<139)
rows = []
cnt = {}
for j in range(NY - 1, -1, -1):
    s = ""
    for i in range(NX):
        x, y = X0 + R * i, Y0 + R * j; c = cls(z[j * NX + i]); ins = inside(x, y)
        s += c.upper() if ins else c.lower()
        cnt[(ins, c)] = cnt.get((ins, c), 0) + 1
    rows.append(f"{Y0 + R * j} {s}")
open(os.path.join(V, "surface-class-map.txt"), "w", encoding="utf-8").write(
  "# S-MAP 메시 표면 분류(2m). 대문자=GPKG 유담관 footprint 안, 소문자=밖. T>=160 타워지붕, L 145~160 중간지붕, M 139~145, G <139 지상/옹벽, ?=미취득\n# x0=200984 (열마다 +2m), 행 = y\n" + "\n".join(rows) + "\n")
print({f"{'in' if k[0] else 'out'}-{k[1]}": v for k, v in sorted(cnt.items())})
