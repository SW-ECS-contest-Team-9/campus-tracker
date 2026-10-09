# 읽기 전용: campus.gpkg 유담관 footprint 정점 추출 + SHA 확인
import sqlite3, struct, hashlib, json, sys
SRC = r"C:/campus-tracker/backend/data/scene/source/campus.gpkg"
sha = hashlib.sha256(open(SRC, "rb").read()).hexdigest()
assert sha == "26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13", sha
c = sqlite3.connect("file:" + SRC + "?mode=ro", uri=True)
def wkb_rings(b):
    flags = b[3]; env = (flags >> 1) & 7; off = 8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]
    w = b[off:]; bo = "<" if w[0] == 1 else ">"; typ = struct.unpack(bo + "I", w[1:5])[0]; p = 5
    def poly(p):
        nr = struct.unpack(bo + "I", w[p:p+4])[0]; p += 4; rings = []
        for _ in range(nr):
            n = struct.unpack(bo + "I", w[p:p+4])[0]; p += 4
            rings.append([list(struct.unpack(bo + "dd", w[p+16*i:p+16*i+16])) for i in range(n)]); p += 16 * n
        return rings, p
    if typ % 1000 == 3: return [poly(p)[0]]
    n = struct.unpack(bo + "I", w[p:p+4])[0]; p += 4; out = []
    for _ in range(n):
        p += 5; r, p = poly(p); out.append(r)
    return out
res = {"sha256": sha}
for t in ("buildings_3d", "source_buildings"):
    g = c.execute(f"select geom from {t} where fid=2").fetchone()[0]
    res[t] = wkb_rings(g)
row = c.execute("select name,height_m,height_source,ground_floors,base_m,roof_m,terrain_min,terrain_max,note from buildings_3d where fid=2").fetchone()
res["attrs"] = dict(zip(["name","height_m","height_source","ground_floors","base_m","roof_m","terrain_min","terrain_max","note"], row))
json.dump(res, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(res["attrs"], ensure_ascii=False)); print(len(res["buildings_3d"][0][0]), res["buildings_3d"] == res["source_buildings"])
