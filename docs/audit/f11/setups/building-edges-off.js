// 건물 모서리 선 묶음을 끈다
const C = window.Cesium, top = VIEWER.scene.primitives; const kids = []; for (let i = 0; i < top.length; i++) kids.push(top.get(i));
const structures = kids.find((p) => p instanceof C.PrimitiveCollection && [...Array(p.length).keys()].some((i) => p.get(i) instanceof C.PolylineCollection));
const e = kids.find((p) => p instanceof C.PolylineCollection); e.show = false; return e.length;
