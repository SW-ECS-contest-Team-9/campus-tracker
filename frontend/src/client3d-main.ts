// 사용자용 3D 캠퍼스 지도(client3d.html): 앱(iframe·react-native-webview)에 끼워 넣는 읽기 전용 페이지.
// 미리보기와 같은 모델링을 그대로 쓴다: 건물 외관(campus-map, building-appearance), 구조물·캠퍼스 바닥(structures-layer),
// 길 면(road-surface-layer), 층 따로 보기(level-view-layer). 편집·로그인·기기 등록 없음, 공개 읽기 API 만.
//
// 메시지 형식 v1 은 client3d-protocol.ts. 받는 곳: window 'message'(iframe 의 postMessage, react-native-webview 의
// injectJavaScript 로 부른 window.postMessage) 와 document 'message'(옛 Android WebView). 보내는 곳: 부모 창 postMessage,
// 그리고 window.ReactNativeWebView.postMessage(JSON 문자열).
// 출처 허용 목록: 빌드 때 VITE_CLIENT3D_ORIGINS="https://a,https://b" 를 주면 그 출처의 메시지만 받고 그 출처로만 보낸다.
// 비우면(기본) 모든 출처를 받는다(개발용). 쿼리 ?light=1 은 가벼운 모드(구조물·이름표 없음)로 시작.
import './client3d.css';
import { api, type SceneBuilding } from './api';
import { initCampusMap, type CampusSceneLayer } from './campus-map';
import { matchFloor, originAllowed, parseCommand, throttle, PROTOCOL_VERSION, type Command, type PageEvent, type Xyz } from './client3d-protocol';
import { BuildingFollow } from './client3d-follow';
import { LevelView } from './level-view-layer';
import { baseBuildingId, buildingFloors, type Floor, type LvPlace, type LvRoad } from './level-view';
import { SceneLayers, loadPublicLayerData } from './scene-layers';
import type { LayerData } from './scene-layer-data';
import { tmForward, tmInverse } from './tm';

const ALLOW = String(import.meta.env.VITE_CLIENT3D_ORIGINS ?? '');
const COLOR = { primary: '#4F46E5', route: '#2563EB', confirmed: '#0F766E', caution: '#B45309', text: '#142235', change: '#DB2777' };
const CAMERA = { pitchDeg: -50, headingDeg: -20, minHeightM: 12, maxRangeM: 1400, slackM: 150 };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nativeView = () => (window as any).ReactNativeWebView as { postMessage: (s: string) => void } | undefined;
const query = new URLSearchParams(location.search);
let light = query.get('light') === '1';
/** ?ui=min: 페이지 자체의 층 판을 숨김(앱이 층 고르기를 직접 보여 줄 때) */
const minimalUi = query.get('ui') === 'min';

type Unversioned<T> = T extends unknown ? Omit<T, 'v'> : never;
function emit(event: Unversioned<PageEvent>) {
  const msg = { v: PROTOCOL_VERSION, ...event } as PageEvent;
  nativeView()?.postMessage(JSON.stringify(msg));
  if (window.parent !== window) {
    const targets = ALLOW.split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of targets.length ? targets : ['*']) window.parent.postMessage(msg, t);
  }
  (window as any).__c3dEvents?.push(msg); // 시험용 기록(있을 때만)
}

const status = (text: string | null) => { const el = $('c3d-status'); el.hidden = !text; el.textContent = text ?? ''; };

/** 기본 점 그림(앱이 캐릭터를 주기 전): 파란 원. 페이지 자체에는 캐릭터 그림을 두지 않는다. */
function dot(color: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.beginPath(); g.arc(24, 24, 20, 0, Math.PI * 2); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(24, 24, 14, 0, Math.PI * 2); g.fill();
  return c.toDataURL();
}

async function boot() {
  const r = await initCampusMap('map').catch((err: Error) => err);
  if (r instanceof Error || !r.scene) { status(`3D 지도를 불러오지 못했습니다${r instanceof Error ? `: ${r.message}` : ''}`); emit({ type: 'error', error: 'scene-unavailable' }); return; }
  const C: any = (window as any).Cesium;
  const viewer: any = r.viewer, scene: CampusSceneLayer = r.scene, camera = viewer.camera;
  const buildings = () => scene.scene.buildings;
  let layerData: LayerData = { roads: [], areas: [] };
  let elevators: LvRoad[] = [];
  let places: (LvPlace & { category: string })[] = [];

  // ---------- 장면 ----------
  const layers = new SceneLayers(viewer, { grid: r.grid, scene, campusTint: r.setCampusTint, structures: { structures: !light, ground: true }, visible: { underground: false } });
  const ground = (x: number, y: number) => layers.structures.groundAt(x, y);
  scene.setShowLabels(!light);
  const roads = () => [...(layerData.roads as unknown as LvRoad[]), ...elevators];
  const level = new LevelView(viewer, { roads, areas: () => layerData.areas, buildings, places: () => places, groundAt: ground }, () => syncFloorPanel());
  const loads = [
    layers.loadStructures().catch((e) => console.error('structures', e)),
    loadPublicLayerData().then((d) => { layerData = d; layers.setData(d); }).catch((e) => console.error('roads', e)),
    api.elevators().then((x) => { elevators = x.roads as unknown as LvRoad[]; }).catch(() => undefined),
    api.places().then((x) => { places = x.places.map((p) => ({ id: p.id, name: p.name, category: p.category, buildingId: p.buildingId, x: p.geometry.coordinates[0], y: p.geometry.coordinates[1], z: p.geometry.coordinates[2] })); drawPlaces(); }).catch(() => undefined),
    level.load().catch((e) => console.error('zones', e)),
  ];

  // ---------- 카메라: 비스듬히 위에서, 캠퍼스 안, 최소 높이 ----------
  const ctl = viewer.scene.screenSpaceCameraController;
  ctl.minimumZoomDistance = 15;
  ctl.maximumZoomDistance = CAMERA.maxRangeM;
  ctl.enableLook = false;
  ctl.inertiaSpin = 0.7; ctl.inertiaTranslate = 0.7; ctl.inertiaZoom = 0.6;
  const b = r.grid.bounds, pad = CAMERA.slackM / 111_000;
  const box = { west: b.west - pad, east: b.east + pad, south: b.south - pad, north: b.north + pad };
  viewer.scene.preRender.addEventListener(() => {
    const c = camera.positionCartographic;
    const lon = C.Math.toDegrees(c.longitude), lat = C.Math.toDegrees(c.latitude);
    const cl = Math.min(Math.max(lon, box.west), box.east), ca = Math.min(Math.max(lat, box.south), box.north);
    const p = tmForward(ca, cl);
    const floor = ground(p.x, p.y) + CAMERA.minHeightM;
    const h = Math.min(Math.max(c.height, floor), floor + CAMERA.maxRangeM);
    if (cl !== lon || ca !== lat || Math.abs(h - c.height) > 0.01) {
      camera.setView({ destination: C.Cartesian3.fromDegrees(cl, ca, h), orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 } });
    }
  });
  const campusSphere = () => C.BoundingSphere.fromPoints(buildings().flatMap((bl) => bl.geometry.coordinates.flatMap((poly) => poly[0].map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat, bl.roofM)))));
  const home = (duration = 1) => {
    const s = campusSphere();
    const portrait = viewer.canvas.clientHeight > viewer.canvas.clientWidth;
    camera.flyToBoundingSphere(s, { duration, offset: new C.HeadingPitchRange(C.Math.toRadians(CAMERA.headingDeg), C.Math.toRadians(CAMERA.pitchDeg), s.radius * (portrait ? 2.5 : 1.9)) });
  };
  const lookAt = (x: number, y: number, z: number, range = 140) => {
    const g = tmInverse(x, y);
    camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(g.longitude, g.latitude, z), 10), { duration: 0.9, offset: new C.HeadingPitchRange(camera.heading, C.Math.toRadians(CAMERA.pitchDeg), range) });
  };
  home(0);
  $('c3d-home').addEventListener('click', () => { closeFloors(); home(); });

  const sendCamera = throttle(() => {
    const c = camera.positionCartographic;
    const p = tmForward(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
    emit({ type: 'cameraChanged', x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, heightM: Math.round(c.height * 10) / 10, headingDeg: Math.round(C.Math.toDegrees(camera.heading)), pitchDeg: Math.round(C.Math.toDegrees(camera.pitch)) });
  }, 300);
  camera.percentageChanged = 0.02;
  camera.changed.addEventListener(sendCamera);

  // ---------- 장소 점 ----------
  const placeDots = viewer.scene.primitives.add(new C.PointPrimitiveCollection());
  const placeLabels = viewer.scene.primitives.add(new C.LabelCollection());
  function drawPlaces() {
    placeDots.removeAll(); placeLabels.removeAll();
    for (const p of places) {
      const g = tmInverse(p.x, p.y), pos = C.Cartesian3.fromDegrees(g.longitude, g.latitude, p.z + 1.2);
      placeDots.add({ position: pos, pixelSize: 9, color: C.Color.fromCssColorString(COLOR.primary), outlineColor: C.Color.WHITE, outlineWidth: 2, id: { kind: 'place', id: p.id, name: p.name }, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 700) });
      if (p.category === 'landmark' || p.category === 'bus_stop') placeLabels.add({ position: pos, text: p.name, font: '600 13px system-ui, sans-serif', fillColor: C.Color.fromCssColorString(COLOR.text), outlineColor: C.Color.WHITE, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -14), verticalOrigin: C.VerticalOrigin.BOTTOM, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 450), id: { kind: 'place', id: p.id, name: p.name } });
    }
    placeLabels.show = !light;
  }

  // ---------- 건물의 층 ----------
  const blocksOf = (id: string) => buildings().filter((bl) => baseBuildingId(bl.buildingId) === id);
  const nameOf = (id: string) => blocksOf(id).find((bl) => bl.buildingId === id)?.name ?? blocksOf(id)[0]?.name ?? id;
  function floorsOf(id: string): Floor[] {
    const blocks = blocksOf(id);
    if (!blocks.length) return [];
    const main = blocks.find((bl) => bl.buildingId === id) ?? blocks[0];
    const rs = roads().filter((rd) => rd.buildingId && baseBuildingId(rd.buildingId) === id);
    return buildingFloors(blocks, main.appearance?.windows?.floorsM, rs, main.appearance?.windows?.floorNames);
  }
  const ring = (x: number, y: number, rg: number[][]) => { let inside = false; for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) { const [xi, yi] = rg[i], [xj, yj] = rg[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const buildingAt = (lon: number, lat: number) => { const bl = buildings().find((s: SceneBuilding) => s.geometry.coordinates.some((poly) => ring(lon, lat, poly[0]))); return bl ? baseBuildingId(bl.buildingId) : null; };

  // ---------- 층 판: 펼치기(level-view) 또는 그 자리에서 한 층만(나머지 건물 비침) ----------
  type FloorState = { building: string; floors: Floor[]; index: number | null; explode: boolean } | null;
  let floorState: FloorState = null;
  let floorPlate: any[] = [];
  let hereFloor: { building: string; index: number } | null = null;
  const clearPlate = () => { for (const e of floorPlate) viewer.entities.remove(e); floorPlate = []; scene.setOpacity(1); };
  function drawPlate(id: string, f: Floor) {
    clearPlate();
    scene.setOpacity(0.22); // 위층(과 다른 건물)은 비쳐 보이게
    for (const bl of blocksOf(id)) {
      if (f.m < bl.baseM - 2.5 || f.m > bl.roofM) continue;
      for (const poly of bl.geometry.coordinates) {
        const outer = poly[0].map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat, f.m + 0.05));
        floorPlate.push(viewer.entities.add({ polygon: { hierarchy: new C.PolygonHierarchy(outer), height: f.m, perPositionHeight: false, material: C.Color.fromCssColorString(COLOR.primary).withAlpha(0.35) } }));
        floorPlate.push(viewer.entities.add({ polyline: { positions: outer.concat([outer[0]]), width: 3, material: C.Color.fromCssColorString(COLOR.primary) } }));
      }
    }
    const ids = new Set(f.roadIds);
    for (const rd of roads().filter((x) => ids.has(x.id))) {
      floorPlate.push(viewer.entities.add({ polyline: { positions: rd.geometry.coordinates.map((c) => { const g = tmInverse(c[0], c[1]); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, c[2] + 0.15); }), width: 4, material: C.Color.WHITE } }));
    }
  }
  function setFloorView(id: string, index: number | null, explode: boolean, fly = true) {
    const floors = floorsOf(id);
    if (index !== null && (index < 0 || index >= floors.length)) index = null;
    floorState = { building: id, floors, index, explode };
    clearPlate();
    if (explode) {
      if (!level.active) level.setActive(true);
      level.showBuilding(id, index);
    } else {
      if (level.active) level.setActive(false, { fly: false });
      if (index !== null) drawPlate(id, floors[index]);
      if (fly) {
        const blocks = blocksOf(id), pts = blocks.flatMap((bl) => bl.geometry.coordinates.flatMap((poly) => poly[0]));
        const p = tmForward(pts.reduce((s, q) => s + q[1], 0) / pts.length, pts.reduce((s, q) => s + q[0], 0) / pts.length);
        lookAt(p.x, p.y, index !== null ? floors[index].m : (blocks[0].baseM + blocks[0].roofM) / 2, 200);
      }
    }
    renderFloorPanel();
    if (loc) drawMe();
    emit({ type: 'floorChanged', building: id, floor: index !== null ? floors[index].name : null, explode });
  }
  function closeFloors() {
    floorState = null;
    clearPlate();
    if (level.active) level.setActive(false);
    renderFloorPanel();
    if (loc) drawMe();
  }
  function syncFloorPanel() {
    // level-view 쪽에서 바뀜(구역을 띄움, Esc 로 끔): 펼치기 단추와 판을 맞춤
    $('c3d-explode').setAttribute('aria-pressed', String(level.active));
    if (!level.active && floorState?.explode) floorState = null;
    const u = level.unit;
    if (level.active && u?.kind === 'building') floorState = { building: u.id, floors: u.floors, index: u.focus, explode: true };
    if (level.active && u?.kind === 'zone') floorState = null;
    renderFloorPanel();
  }
  function renderFloorPanel() {
    const panel = $('c3d-floors');
    const u = level.unit;
    if (!floorState && level.active && u?.kind === 'zone') {
      panel.hidden = false;
      $('c3d-floors-title').textContent = u.zone.name;
      $('c3d-floors-sub').textContent = u.zone.layer === 'underground' ? '지하 구역 · 띄워 보는 중' : '구역 · 띄워 보는 중';
      $('c3d-floors-list').innerHTML = '';
      return;
    }
    panel.hidden = !floorState || minimalUi;
    if (!floorState) return;
    const { building, floors, index, explode } = floorState;
    $('c3d-floors-title').textContent = nameOf(building);
    $('c3d-floors-sub').textContent = index === null ? (explode ? '모든 층 펼침' : '층을 고르세요') : `보는 층: ${floors[index].name ?? `${floors[index].m.toFixed(1)} m`}${explode ? ' · 펼침' : ''}`;
    const list = $('c3d-floors-list');
    list.innerHTML = '';
    const add = (label: string, i: number | null) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.classList.toggle('on', i === index);
      btn.classList.toggle('here', i !== null && hereFloor?.building === building && hereFloor.index === i);
      btn.addEventListener('click', () => setFloorView(building, i, explode));
      list.append(btn);
    };
    add(explode ? '모든 층' : '건물 전체', null);
    for (let i = 0; i < floors.length; i++) add(floors[i].name ?? `${floors[i].m.toFixed(1)} m`, i);
    if (!floors.length) $('c3d-floors-sub').textContent = '층 자료 없음';
    list.querySelector<HTMLElement>('button.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  $('c3d-floors-close').addEventListener('click', closeFloors);
  $('c3d-explode').addEventListener('click', () => {
    if (level.active) { const keep = floorState?.explode ? floorState : null; level.setActive(false); if (keep) setFloorView(keep.building, keep.index, false, false); return; }
    if (floorState) setFloorView(floorState.building, floorState.index, true);
    else { level.setActive(true); status('펼칠 건물이나 구역을 누르세요'); setTimeout(() => status(null), 2500); }
  });

  // ---------- 누르기 ----------
  const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((m: any) => {
    const picked = viewer.scene.pick(m.position);
    const id = picked?.id as { kind?: string; buildingId?: string; id?: string; name?: string } | undefined;
    const pt = level.pickPoint(m.position);
    if (id?.kind === 'place' && id.id) {
      const p = places.find((x) => x.id === id.id);
      if (p) emit({ type: 'pick', kind: 'place', id: p.id, name: p.name, x: p.x, y: p.y, z: p.z });
      return;
    }
    if (level.active) {
      level.handleClick(m.position);
      if (id?.kind === 'building' && id.buildingId && pt) emit({ type: 'pick', kind: 'building', id: baseBuildingId(id.buildingId), name: nameOf(baseBuildingId(id.buildingId)), ...pt });
      return;
    }
    if (id?.kind === 'building' && id.buildingId) {
      const bid = baseBuildingId(id.buildingId);
      if (!floorState || floorState.building !== bid) { floorState = { building: bid, floors: floorsOf(bid), index: null, explode: false }; clearPlate(); renderFloorPanel(); }
      if (pt) emit({ type: 'pick', kind: 'building', id: bid, name: nameOf(bid), ...pt });
      return;
    }
    if (pt) emit({ type: 'pick', kind: 'point', ...pt });
  }, C.ScreenSpaceEventType.LEFT_CLICK);

  // ---------- 현재 위치 + 실내 따라가기(client3d-follow.ts) ----------
  // 건물 안이면 그 건물의 층을 펼치고 지금 층만 또렷하게, 카메라는 위치를 따라감. 다른 건물로 옮기면 앞 건물은 제자리로.
  // 사용자가 지도를 직접 움직이면 따라가기를 멈추고 "현재 위치로" 단추를 보인다.
  const images = { ok: dot(COLOR.route), uncertain: dot(COLOR.caution) };
  let me: { billboard: any; label: any; circle: any; ring: any } | null = null;
  let loc: { c: Extract<Command, { type: 'setLocation' }>; x: number; y: number; z: number; building: string | null; index: number; floorName: string | null } | null = null;
  const follow = new BuildingFollow();
  let following = true;
  const followBtn = $('c3d-follow');
  const setFollowing = (on: boolean) => { following = on; followBtn.hidden = on || !loc; };
  const clearMe = () => { if (me) for (const e of Object.values(me)) viewer.entities.remove(e); me = null; };
  /** 표시 자리: 그 건물이 펼쳐져 있으면 펼친 층 위, 아니면 제자리. */
  const shownAt = () => {
    if (!loc) return null;
    const u = level.unit;
    if (loc.building && loc.index >= 0 && level.active && u?.kind === 'building' && u.id === loc.building && level.liftedAt) { const q = level.liftedAt(loc.index, [loc.x, loc.y, loc.z]); return { x: q[0], y: q[1], z: q[2] }; }
    return { x: loc.x, y: loc.y, z: loc.z };
  };
  function drawMe() {
    clearMe();
    const at = shownAt();
    if (!loc || !at) return;
    const { c, floorName } = loc;
    const g0 = tmInverse(at.x, at.y), pos = C.Cartesian3.fromDegrees(g0.longitude, g0.latitude, at.z + 0.1);
    const unsure = c.state === 'uncertain';
    const color = C.Color.fromCssColorString(unsure ? COLOR.caution : COLOR.route);
    const img = c.markerUrl ?? (unsure ? images.uncertain : images.ok);
    const label = unsure ? '위치 확인 필요' : floorName ? `현재 추정 · ${floorName}` : '현재 위치';
    // 정확도 원: 반지름 = accuracyM(최소 2 m). 불확실이면 점선.
    const radius = Math.max(2, c.accuracyM);
    const circlePts = Array.from({ length: 65 }, (_, k) => { const a = (k / 64) * Math.PI * 2, g = tmInverse(at.x + radius * Math.cos(a), at.y + radius * Math.sin(a)); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, at.z + 0.2); });
    me = {
      circle: viewer.entities.add({ polygon: { hierarchy: new C.PolygonHierarchy(circlePts.slice(0, 64)), height: at.z + 0.15, material: color.withAlpha(unsure ? 0.1 : 0.16) } }),
      ring: viewer.entities.add({ polyline: { positions: circlePts, width: 3, material: unsure ? new C.PolylineDashMaterialProperty({ color, dashLength: 14 }) : color, depthFailMaterial: color.withAlpha(0.4) } }),
      billboard: viewer.entities.add({ position: pos, billboard: { image: img, width: 64, height: 64, verticalOrigin: C.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new C.NearFarScalar(80, 1.15, 1200, 0.8) } }),
      label: viewer.entities.add({ position: pos, label: { text: label, font: '700 13px system-ui, sans-serif', fillColor: C.Color.WHITE, showBackground: true, backgroundColor: color, backgroundPadding: new C.Cartesian2(7, 4), pixelOffset: new C.Cartesian2(0, 8), verticalOrigin: C.VerticalOrigin.TOP, disableDepthTestDistance: Number.POSITIVE_INFINITY } }),
    };
  }
  const goToMe = (range = 170) => { const at = shownAt(); if (at) lookAt(at.x, at.y, at.z, range); };
  function setLocation(c: Extract<Command, { type: 'setLocation' }>) {
    const p = tmForward(c.lat, c.lon);
    const sure = c.state === 'ok';
    const inside = c.building ?? buildingAt(c.lon, c.lat);
    const change = follow.update({ t: performance.now(), building: inside, state: c.state });
    // 불확실하면 건물·층을 바꾸지 않고(마지막 것 유지) 바닥 높이에 표시
    const building = sure ? follow.current ?? null : null;
    let z = sure ? c.z : null, index = -1, floorName: string | null = null;
    if (building && building === inside) {
      const floors = floorsOf(building);
      index = matchFloor(floors, c.floor, z);
      // 층을 모르면 그 자리 바닥에 가장 가까운 층(대개 들어온 층)
      if (index < 0 && floors.length) { const g = ground(p.x, p.y); index = floors.reduce((best, f, i) => (Math.abs(f.m - g) < Math.abs(floors[best].m - g) ? i : best), 0); }
      if (index >= 0) { floorName = floors[index].name; if (z === null) z = floors[index].m; }
    }
    if (z === null) z = ground(p.x, p.y);
    const prevIndex = loc?.building === building ? loc.index : -2;
    loc = { c, x: p.x, y: p.y, z, building: building && building === inside ? building : null, index, floorName };
    hereFloor = loc.building && index >= 0 ? { building: loc.building, index } : null;
    if (change) {
      if (change.to) setFloorView(change.to, index >= 0 ? index : null, true, following);
      else if (change.from) closeFloors();
    } else if (loc.building && index >= 0 && index !== prevIndex && level.active && level.unit?.kind === 'building' && level.unit.id === loc.building) {
      setFloorView(loc.building, index, true, following);
    }
    drawMe();
    renderFloorPanel();
    followBtn.hidden = following;
    if (following && !change?.to) goToMe();
  }
  followBtn.addEventListener('click', () => { setFollowing(true); if (loc?.building && loc.index >= 0) setFloorView(loc.building, loc.index, true); else goToMe(); });
  // 손으로 움직이면 따라가기 멈춤
  const stopFollow = () => { if (following && loc) setFollowing(false); };
  let downAt: { x: number; y: number } | null = null;
  handler.setInputAction((m: any) => { downAt = { x: m.position.x, y: m.position.y }; }, C.ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction(() => { downAt = null; }, C.ScreenSpaceEventType.LEFT_UP);
  handler.setInputAction((m: any) => { if (downAt && Math.hypot(m.endPosition.x - downAt.x, m.endPosition.y - downAt.y) > 8) stopFollow(); }, C.ScreenSpaceEventType.MOUSE_MOVE);
  for (const t of [C.ScreenSpaceEventType.PINCH_START, C.ScreenSpaceEventType.WHEEL, C.ScreenSpaceEventType.RIGHT_DOWN]) handler.setInputAction(stopFollow, t);

  // ---------- 경로 ----------
  let route: any[] = [];
  const clearRoute = () => { for (const e of route) viewer.entities.remove(e); route = []; };
  const cart = (p: Xyz, up = 0.6) => { const g = tmInverse(p[0], p[1]); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, p[2] + up); };
  function setRoute(c: Extract<Command, { type: 'setRoute' }>) {
    clearRoute();
    const color = C.Color.fromCssColorString(COLOR.route);
    route.push(viewer.entities.add({ polyline: { positions: c.points.map((p) => cart(p)), width: 10,
      material: new C.PolylineOutlineMaterialProperty({ color, outlineColor: C.Color.WHITE, outlineWidth: 2.5 }),
      depthFailMaterial: new C.ColorMaterialProperty(color.withAlpha(0.6)) } }));
    const end = (p: Xyz, css: string, text: string) => route.push(viewer.entities.add({ position: cart(p, 1), point: { pixelSize: 16, color: C.Color.fromCssColorString(css), outlineColor: C.Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text, font: '700 12px system-ui, sans-serif', fillColor: C.Color.WHITE, showBackground: true, backgroundColor: C.Color.fromCssColorString(css), pixelOffset: new C.Cartesian2(0, -16), verticalOrigin: C.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    end(c.points[0], COLOR.confirmed, '출발');
    end(c.points[c.points.length - 1], COLOR.primary, '도착');
    for (const f of c.floorChanges) end(f.at, COLOR.change, f.label ?? '층 이동');
    // 경로 전체가 보이게(따라가기는 멈추고 "현재 위치로" 단추를 보임)
    const sphere = C.BoundingSphere.fromPoints(c.points.map((p) => cart(p, 0)));
    camera.flyToBoundingSphere(sphere, { duration: 0.9, offset: new C.HeadingPitchRange(camera.heading, C.Math.toRadians(CAMERA.pitchDeg), Math.max(120, sphere.radius * 2.6)) });
    setFollowing(false);
  }

  // ---------- 메시지 ----------
  function run(c: Command) {
    switch (c.type) {
      case 'setLocation': return setLocation(c);
      case 'clearLocation': loc = null; hereFloor = null; follow.reset(); setFollowing(true); return clearMe();
      case 'setRoute': return setRoute(c);
      case 'clearRoute': return clearRoute();
      case 'focus': {
        if (c.building && blocksOf(c.building).length) {
          const floors = floorsOf(c.building), i = matchFloor(floors, c.floor, c.z);
          if (c.floor || c.z !== null) setFloorView(c.building, i >= 0 ? i : null, false, false);
        }
        return lookAt(c.x, c.y, c.z ?? ground(c.x, c.y));
      }
      case 'setFloor': {
        if (!blocksOf(c.building).length) return emit({ type: 'error', error: `모르는 건물: ${c.building}`, command: c.type });
        const i = c.floor === null ? null : matchFloor(floorsOf(c.building), c.floor);
        if (i === -1) emit({ type: 'error', error: `층 없음: ${c.building} ${c.floor}`, command: c.type });
        return setFloorView(c.building, i === -1 ? null : i, c.explode);
      }
      case 'setMarkerImages': images.ok = c.ok; images.uncertain = c.uncertain; return;
      case 'setMode': {
        light = c.light;
        layers.setStructuresVisible('structures', !light);
        scene.setShowLabels(!light);
        placeLabels.show = !light;
        return;
      }
    }
  }
  const receive = (e: MessageEvent) => {
    if (!originAllowed(e.origin ?? '', ALLOW, !!nativeView())) return;
    const parsed = parseCommand(e.data);
    if (!parsed.ok) { if (e.data && typeof e.data === 'object' && (e.data as { v?: unknown }).v === undefined && !(e.data as { type?: unknown }).type) return; emit({ type: 'error', error: parsed.error, command: parsed.command }); return; }
    try { run(parsed.command); } catch (err) { emit({ type: 'error', error: String((err as Error).message ?? err), command: parsed.command.type }); }
  };
  window.addEventListener('message', receive);
  document.addEventListener('message', receive as unknown as EventListener); // 옛 Android WebView

  await Promise.all(loads);
  status(null);
  if (import.meta.env.DEV) (window as any).__c3d = { tmInverse, tmForward, viewer, layers, level, scene, run, home, setFloorView };
  emit({ type: 'ready', buildings: level.buildingList(), light });
}

void boot();
