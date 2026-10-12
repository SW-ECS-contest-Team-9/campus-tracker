// 구조물·캠퍼스 바닥 층 전체를 끈다(그리기만)
const C = window.Cesium, top = VIEWER.scene.primitives; const kids = []; for (let i = 0; i < top.length; i++) kids.push(top.get(i));
const structures = kids.find((p) => p instanceof C.PrimitiveCollection && [...Array(p.length).keys()].some((i) => p.get(i) instanceof C.PolylineCollection));
structures.show = false; return structures.length;
