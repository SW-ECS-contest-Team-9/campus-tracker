// 엔티티와 구조물 층을 함께 끈다
const C = window.Cesium, top = VIEWER.scene.primitives; const kids = []; for (let i = 0; i < top.length; i++) kids.push(top.get(i));
const structures = kids.find((p) => p instanceof C.PrimitiveCollection && [...Array(p.length).keys()].some((i) => p.get(i) instanceof C.PolylineCollection));
structures.show = false; const e = VIEWER.entities; e.show = false; Object.defineProperty(e, 'show', { get: () => false, set() {} }); return 1;
