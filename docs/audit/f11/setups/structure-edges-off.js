// 구조물 테두리 선 묶음만 끈다
const C = window.Cesium, top = VIEWER.scene.primitives; const kids = []; for (let i = 0; i < top.length; i++) kids.push(top.get(i));
const structures = kids.find((p) => p instanceof C.PrimitiveCollection && [...Array(p.length).keys()].some((i) => p.get(i) instanceof C.PolylineCollection));
let n = 0; for (let i = 0; i < structures.length; i++) { const p = structures.get(i); if (p instanceof C.PolylineCollection) { p.show = false; n += p.length; } } return n;
