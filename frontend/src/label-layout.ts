// Where name tags go when there are many (F09). Pure functions in screen pixels (tested in test/label-layout.test.ts);
// the views (section-layer.ts, level-view-layer.ts, the editor's place tags) project their anchors and call these.
//   declutter()    which tags stay when they would cover each other (the more important one wins);
//   spread()       a column of tags pushed apart so none overlaps, each moved as little as possible;
//   mergeLevels()  one tag per height on a cut face (what lies at one level is named together);
//   place()        a tag moved off its anchor to a free spot nearby (drawn with a leader line), or dropped.

/** A tag on screen: left, top, width, height in pixels. */
export type Box = { x: number; y: number; w: number; h: number };

export const overlaps = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Width of a line of text at a font size: Hangul and other wide characters count as one em, the rest as 0.58. */
export function textWidth(text: string, fontPx = 12): number {
  let em = 0;
  for (const ch of text) em += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.58;
  return Math.ceil(em * fontPx);
}

/**
 * Which tags are shown: taken in order of priority (highest first, earlier first among equals); one that would touch a
 * tag already kept (within `gap` pixels) is hidden. `always` tags are kept whatever they cover (a selected thing).
 */
export function declutter(tags: (Box & { priority: number; always?: boolean })[], gap = 3): boolean[] {
  const shown = tags.map(() => false);
  const kept: Box[] = [];
  const order = tags.map((_, i) => i).sort((a, b) => Number(!!tags[b].always) - Number(!!tags[a].always) || tags[b].priority - tags[a].priority || a - b);
  for (const i of order) {
    if (!tags[i].always && kept.some((k) => overlaps(tags[i], k, gap))) continue;
    shown[i] = true;
    kept.push(tags[i]);
  }
  return shown;
}

/**
 * A column of tags of height `h` wanted at the tops `ys`: the tops they get so that none overlaps (at least `h + gap`
 * apart), kept inside min..max where that is possible, in the same order from top to bottom. Result in input order.
 */
export function spread(ys: number[], h: number, min: number, max: number, gap = 2): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b] || a - b);
  const out = order.map((i) => Math.max(min, ys[i]));
  for (let k = 1; k < out.length; k++) out[k] = Math.max(out[k], out[k - 1] + h + gap);
  if (out.length && out[out.length - 1] > max - h) {
    out[out.length - 1] = Math.max(min, max - h);
    for (let k = out.length - 2; k >= 0; k--) out[k] = Math.max(min, Math.min(out[k], out[k + 1] - h - gap));
    for (let k = 1; k < out.length; k++) out[k] = Math.max(out[k], out[k - 1] + h + gap); // more tags than room: they run past max rather than overlap
  }
  const result = ys.map(() => 0);
  order.forEach((i, k) => { result[i] = out[k]; });
  return result;
}

/** Something on a cut face at a height: `d` where it is along the cut, `name` what it is ('' = just a height). */
export type LevelItem = { z: number; d: number; name: string; priority: number };
export type Level = { z: number; names: string[]; /** The items of the level, the most important first. */ items: LevelItem[] };

/**
 * One entry per height: items whose heights round to the same `stepM` are one level. Its names are those of its
 * items, the most important first, each once. Levels come highest first.
 */
export function mergeLevels(items: LevelItem[], stepM = 0.1): Level[] {
  const groups = new Map<number, LevelItem[]>();
  for (const item of items) {
    const key = Math.round(item.z / stepM);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].sort((a, b) => b[0] - a[0]).map(([key, list]) => {
    const sorted = [...list].sort((a, b) => b.priority - a.priority);
    return { z: key * stepM, names: [...new Set(sorted.map((i) => i.name).filter(Boolean))], items: sorted };
  });
}

/** "141.4 m 운동장 지하 1층 통로 면 · 은주1관 4층 외 2": the height, then up to `max` names. */
export function levelText(level: Pick<Level, 'z' | 'names'>, max = 2): string {
  const names = level.names.slice(0, max).join(' · ');
  const more = level.names.length - max;
  return `${level.z.toFixed(1)} m${names ? ` ${names}` : ''}${more > 0 ? ` 외 ${more}` : ''}`;
}

/**
 * A free spot for a tag of size w × h whose anchor is at (ax, ay): first beside the anchor (right-above), then steps
 * further up, down and on the left side. null when every spot tried is taken or outside `bounds`. `moved` tells that
 * the tag left its anchor far enough to need a leader line.
 */
export function place(ax: number, ay: number, w: number, h: number, taken: Box[], bounds: Box, gap = 3): (Box & { moved: boolean }) | null {
  const tries: [number, number][] = [[6, -h - 2]];
  for (let k = 1; k <= 5; k++) tries.push([10, -h - 2 - k * (h + gap)], [10, k * (h + gap)], [-w - 10, -h - 2 - (k - 1) * (h + gap)], [-w - 10, k * (h + gap)]);
  for (const [dx, dy] of tries) {
    const box = { x: ax + dx, y: ay + dy, w, h };
    if (box.x < bounds.x || box.y < bounds.y || box.x + w > bounds.x + bounds.w || box.y + h > bounds.y + bounds.h) continue;
    if (taken.some((t) => overlaps(box, t, gap))) continue;
    return { ...box, moved: Math.abs(dy + h + 2) > 1 || dx < 0 };
  }
  return null;
}
