// Readability settings shared by the views that show a lot at once (F08: the lifted 구획 / building / floor view of
// level-view-layer.ts; meant to be reused by the cross-section and the general map, F09). One place, no Cesium:
//   viewStyle()            the current settings
//   setViewStyle(patch)    change some of them (kept in localStorage, listeners are told)
//   onViewStyle(listener)  be told after every change; returns the function that stops it
// and the tables that turn a setting into numbers (LINE_PX, LABELS, OTHERS). A view reads the tables, never its own
// constants, so one choice of the user looks the same everywhere.

/** 선 굵기: 가늘게 / 보통 / 굵게. */
export type LineWeight = 'thin' | 'normal' | 'thick';
/** 이름표: 없음 / 주요(제목·층·이어지는 곳·장소) / 전체(+ 길 이름). */
export type LabelDensity = 'none' | 'main' | 'all';
/** 나머지(보고 있는 것 밖의 지도): 흐리게 / 숨김. */
export type OthersMode = 'dim' | 'hide';
export type ViewStyle = { line: LineWeight; labels: LabelDensity; others: OthersMode };

export const VIEW_STYLE_DEFAULT: ViewStyle = { line: 'normal', labels: 'main', others: 'dim' };
export const VIEW_STYLE_CHOICES: { [K in keyof ViewStyle]: { value: ViewStyle[K]; label: string }[] } = {
  line: [{ value: 'thin', label: '가늘게' }, { value: 'normal', label: '보통' }, { value: 'thick', label: '굵게' }],
  labels: [{ value: 'none', label: '없음' }, { value: 'main', label: '주요' }, { value: 'all', label: '전체' }],
  others: [{ value: 'dim', label: '흐리게' }, { value: 'hide', label: '숨김' }],
};
export const VIEW_STYLE_TITLES: Record<keyof ViewStyle, string> = { line: '선 굵기', labels: '이름표', others: '나머지' };

/**
 * Line widths in screen pixels per weight: `road` the centre line of a road of what is in focus, `outline` the firm
 * edge of a plate, `connector` stairs / ramps / elevators and the stubs into a neighbour, `faint` anything out of focus.
 */
export const LINE_PX: Record<LineWeight, { road: number; outline: number; connector: number; faint: number }> = {
  thin: { road: 2, outline: 1.5, connector: 2, faint: 1 },
  normal: { road: 4, outline: 2.5, connector: 3.5, faint: 1 },
  thick: { road: 7, outline: 4, connector: 6, faint: 1.5 },
};
/**
 * F09, the cut face of the cross-section (section-layer.ts), in screen pixels per weight: `cut` the firm outline of
 * what the plane cuts (slabs, voids, platforms, building walls, the ground line), `mark` the cross-mark of a road or
 * passage, `floor` a floor line inside a cut building, `grid` the height scale.
 */
export const SECTION_PX: Record<LineWeight, { cut: number; mark: number; floor: number; grid: number }> = {
  thin: { cut: 1.5, mark: 5, floor: 1, grid: 1 },
  normal: { cut: 2.5, mark: 8, floor: 1.5, grid: 1 },
  thick: { cut: 4, mark: 12, floor: 2.5, grid: 1 },
};
/**
 * F10, a session's track on what is lifted, in screen pixels per weight: `raw` the thin line through the raw location
 * samples, `dot` their dots, `fused` the fused path (drawn with a white outline of 2 px either side on top of this).
 */
export const TRACK_PX: Record<LineWeight, { raw: number; fused: number; dot: number }> = {
  thin: { raw: 1, fused: 2.5, dot: 3 },
  normal: { raw: 1.5, fused: 4, dot: 4.5 },
  thick: { raw: 2.5, fused: 7, dot: 6.5 },
};
/** F09: the editor's own road lines on the general map are this many times their usual width. */
export const MAP_LINE_SCALE: Record<LineWeight, number> = { thin: 0.65, normal: 1, thick: 1.5 };
/** F09: how much of what stands behind a cut still shows (0 = a plain wall); the cut face itself is never dimmed. */
export const SECTION_BACKDROP: Record<OthersMode, number> = { dim: 0.3, hide: 0 };
/** Which label kinds a density shows. `title`: what is lifted; `floor`: a floor of a building; `link`: where a connector or stub leads; `place`: places and areas; `road`: road names. */
export const LABELS: Record<LabelDensity, Record<'title' | 'floor' | 'link' | 'place' | 'road', boolean>> = {
  none: { title: false, floor: false, link: false, place: false, road: false },
  main: { title: true, floor: true, link: true, place: true, road: false },
  all: { title: true, floor: true, link: true, place: true, road: true },
};
/** Opacity left to what is not in focus: `veil` = how much of the map below a lifted unit still shows through, `plate` = a floor of an exploded building that is not the chosen one. */
export const OTHERS: Record<OthersMode, { veil: number; plate: number }> = {
  dim: { veil: 0.22, plate: 0.28 },
  hide: { veil: 0, plate: 0 },
};
/** Colours of the things a lifted view draws (also its legend). */
export const VIEW_COLORS = {
  vehicle: '#2b2f36', pedestrian: '#1d6fd6', stairs: '#e07a1f', elevator: '#8b3fc9', stub: '#5b6570', stubFill: '#9aa3ad', place: '#c2185b',
  outline: '#1f2937', leader: '#4b5563', plate: '#eef1f4', veil: '#eef0ec', label: '#111827',
  /** F09: the chosen floor of a fanned-out building, the aisle surface and the stalls of a parking level. */
  focus: '#0759c7', aisle: '#6a717b', stall: '#c8cdd4',
  /** F09, the cut face: indoor ways, the air of a cut void, floor lines of a cut building, what stands behind the cut. */
  indoor: '#6d4bc4', voidFill: '#fbfbf8', floorLine: '#8a4b12', backdrop: '#f4f2ec',
  /** F10: a session's raw location samples and its fused path (the editor's bright track colour) on what is lifted. */
  trackRaw: '#2fb344', trackFused: '#e11d8f',
};

/** The three choices as form controls (a view puts them in its panel; bindViewStyleControls makes them work). */
export function viewStyleControls(): string {
  const style = viewStyle();
  return (Object.keys(VIEW_STYLE_CHOICES) as (keyof ViewStyle)[]).map((k) => `<label>${VIEW_STYLE_TITLES[k]} <select data-style="${k}">${(VIEW_STYLE_CHOICES[k] as { value: string; label: string }[])
    .map((c) => `<option value="${c.value}"${style[k] === c.value ? ' selected' : ''}>${c.label}</option>`).join('')}</select></label>`).join('');
}

/** Changes of the controls inside `root` change the settings; the controls there follow changes made elsewhere. Returns the function that stops both. */
export function bindViewStyleControls(root: HTMLElement): () => void {
  const onChange = (e: Event) => { const el = e.target as HTMLSelectElement; if (el?.dataset?.style) setViewStyle({ [el.dataset.style]: el.value } as Partial<ViewStyle>); };
  root.addEventListener('change', onChange);
  const stop = onViewStyle((style) => { for (const el of root.querySelectorAll<HTMLSelectElement>('select[data-style]')) el.value = style[el.dataset.style as keyof ViewStyle]; });
  return () => { root.removeEventListener('change', onChange); stop(); };
}

const KEY = 'campus.viewStyle';
let current: ViewStyle | null = null;
const listeners = new Set<(style: ViewStyle) => void>();

/** A stored or partial value made whole: unknown keys and values fall back to the default. */
export function normalizeViewStyle(value: unknown): ViewStyle {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const pick = <K extends keyof ViewStyle>(k: K): ViewStyle[K] =>
    (VIEW_STYLE_CHOICES[k] as { value: string }[]).some((c) => c.value === v[k]) ? (v[k] as ViewStyle[K]) : VIEW_STYLE_DEFAULT[k];
  return { line: pick('line'), labels: pick('labels'), others: pick('others') };
}

export function viewStyle(): ViewStyle {
  if (!current) {
    let stored: unknown = null;
    try { stored = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null'); } catch { /* no storage: defaults */ }
    current = normalizeViewStyle(stored);
  }
  return current;
}

export function setViewStyle(patch: Partial<ViewStyle>) {
  current = normalizeViewStyle({ ...viewStyle(), ...patch });
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(current)); } catch { /* not kept */ }
  for (const listener of listeners) listener(current);
}

export function onViewStyle(listener: (style: ViewStyle) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
