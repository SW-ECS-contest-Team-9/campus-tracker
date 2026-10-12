// 편집기 자체 엔티티(길 선·장소·꼭짓점)를 끈다. 화면 쪽에서 다시 켜지 못하게 막아 둔다
const e = VIEWER.entities; e.show = false; Object.defineProperty(e, 'show', { get: () => false, set() {} }); return e.values.length;
